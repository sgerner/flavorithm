import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import { createKitchenSync } from '../src/lib/client-sync.ts';
import { readPendingJournal } from '../src/lib/offline-sync.ts';
import {
	clearAccountStorage,
	readCachedAccount,
	resolveLocalAuthTransition,
	resolveRegistrationGuestSeed,
	restoreExpiredSessionAccount,
	teardownToGuestKitchen
} from '../src/lib/guest-storage.ts';
import type { AppState, User } from '../src/lib/types.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.FLAVORITHM_AUTH_MODE = 'local';

registerHooks({
	load(url, context, nextLoad) {
		if (url.endsWith('.svelte')) {
			const filename = fileURLToPath(url);
			const source = readFileSync(filename, 'utf8');
			const { js } = compile(source, { filename, generate: 'server' });
			return { format: 'module', shortCircuit: true, source: js.code };
		}
		return nextLoad(url, context);
	}
});

const backendPath: string = '../src/lib/server/db.ts';
const backend = await import(backendPath);
const authRoute = await import('../src/routes/api/auth/+server.ts');
const stateRoute = await import('../src/routes/api/state/+server.ts');
const syncStatusPath: string = '../src/lib/components/SyncStatus.svelte';
const { default: SyncStatus } = await import(syncStatusPath);

function createStorage(initial: Iterable<[string, string]> = []) {
	const values = new Map<string, string>(initial);
	return {
		values,
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}

function createServerClient() {
	let sessionToken: string | undefined;
	const cookies = {
		get: (name: string) => (name === 'flavorithm_session' ? sessionToken : undefined),
		set: (name: string, value: string) => {
			if (name === 'flavorithm_session') sessionToken = value;
		},
		delete: (name: string) => {
			if (name === 'flavorithm_session') sessionToken = undefined;
		}
	};
	const currentLocals = () => ({
		authMode: 'local' as const,
		user: backend.getUserFromSession(sessionToken)
	});

	return {
		expireSession() {
			if (sessionToken) backend.deleteSession(sessionToken);
		},
		async getAuth() {
			const response = await authRoute.GET({ locals: currentLocals() } as never);
			return { status: response.status, data: await response.json() };
		},
		async postAuth(body: Record<string, unknown>, ip = '127.0.0.1') {
			const response = await authRoute.POST({
				locals: currentLocals(),
				cookies,
				getClientAddress: () => ip,
				request: new Request('https://flavorithm.example/api/auth', {
					method: 'POST',
					headers: {
						origin: 'https://flavorithm.example',
						'content-type': 'application/json'
					},
					body: JSON.stringify(body)
				})
			} as never);
			return { status: response.status, data: await response.json() };
		},
		async getState() {
			const response = await stateRoute.GET({ locals: currentLocals() } as never);
			return {
				status: response.status,
				etag: response.headers.get('etag') || '',
				data: await response.json()
			};
		},
		async putState(body: Record<string, unknown>, etag: string | null) {
			const response = await stateRoute.PUT({
				locals: currentLocals(),
				request: new Request('https://flavorithm.example/api/state', {
					method: 'PUT',
					headers: {
						origin: 'https://flavorithm.example',
						'content-type': 'application/json',
						...(etag ? { 'if-match': etag } : { 'if-none-match': '*' })
					},
					body: JSON.stringify(body)
				})
			} as never);
			return {
				status: response.status,
				etag: response.headers.get('etag') || '',
				data: await response.json()
			};
		}
	};
}

function createClientHarness(
	server: ReturnType<typeof createServerClient>,
	storage = createStorage()
) {
	let user: User | null = null;
	let kitchen: AppState = createInitialState();
	let showStarter = true;
	let sessionExpired = false;
	let sessionExpiryNotified = false;
	let guestPersistenceReady = false;
	let online = true;
	let syncing = false;
	let stateEtag: string | null = null;
	let autoSyncCount = 0;
	let aiClears = 0;
	const notifications: string[] = [];
	let syncStatus = { pending: false, syncing: false, conflicts: [] as any[], error: '' };

	const notify = (message: string) => {
		notifications.push(message);
	};
	const markSessionExpired = (announce = false) => {
		if (!user) return;
		sessionExpired = true;
		if (announce && !sessionExpiryNotified) {
			sessionExpiryNotified = true;
			notify('Your session expired. Sign in again to sync edits saved on this device.');
		}
	};
	const announceSessionExpired = () => {
		if (!sessionExpired || sessionExpiryNotified) return;
		sessionExpiryNotified = true;
		notify('Your session expired. Sign in again to sync edits saved on this device.');
	};
	const clearSessionExpired = () => {
		sessionExpired = false;
		sessionExpiryNotified = false;
	};

	const kitchenSync = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => structuredClone(kitchen),
		setState: (next) => {
			kitchen = structuredClone(next);
		},
		onStatus: (status) => {
			syncStatus = status;
		},
		transport: (owner) => ({
			identity: { userId: owner.id, householdId: owner.householdId },
			get: async () => {
				if (!online) throw new Error('Offline');
				const res = await server.getState();
				if (res.status !== 200) {
					if (res.status === 401 && user) markSessionExpired(true);
					throw Object.assign(new Error(res.data.error || 'Could not load your kitchen.'), {
						status: res.status
					});
				}
				return {
					state: res.data.state || createNewUserState(),
					etag: res.etag,
					userId: res.data.userId,
					householdId: res.data.householdId
				};
			},
			put: async (state, etag) => {
				if (!online) throw new Error('Offline');
				const res = await server.putState(
					{
						state,
						expectedUserId: owner.id,
						expectedHouseholdId: owner.householdId
					},
					etag || null
				);
				if (res.status !== 200) {
					if (res.status === 401 && user) markSessionExpired(true);
					throw Object.assign(new Error(res.data.error || 'Could not sync your kitchen.'), {
						status: res.status
					});
				}
				return { state: res.data.state, etag: res.etag };
			}
		})
	});

	function runReactivePersistence() {
		const snapshot = JSON.stringify(kitchen);
		if (!user && !sessionExpired && guestPersistenceReady) {
			storage.setItem('flavorithm-guest-kitchen', snapshot);
		}
		if (user) kitchenSync.stage(JSON.parse(snapshot));
		if (user && !sessionExpired && !syncing && online) {
			autoSyncCount += 1;
		}
	}

	function restoreGuestSession(options: { preserveLastAccount?: boolean } = {}) {
		const guest = teardownToGuestKitchen({
			storage,
			preserveLastAccount: options.preserveLastAccount,
			clearAIConnectionState: () => {
				aiClears += 1;
			},
			clearSyncContext: () => kitchenSync.clearContext()
		});
		clearSessionExpired();
		user = null;
		stateEtag = null;
		kitchen = guest.kitchen;
		showStarter = guest.showStarter;
		runReactivePersistence();
	}

	function adoptKitchen(state: AppState) {
		if (user) {
			kitchenSync.initialize(structuredClone(user), state, stateEtag || '');
			storage.setItem('flavorithm-last-account', JSON.stringify(user));
		} else {
			kitchen = state;
		}
	}

	async function retrySync() {
		if (!online || !user || sessionExpired) return;
		await kitchenSync.sync();
	}

	async function mount() {
		guestPersistenceReady = false;
		restoreGuestSession({ preserveLastAccount: true });
		try {
			if (!online) throw new Error('Network unavailable');
			const auth = await server.getAuth();
			syncing = true;
			if (auth.data.user) {
				clearSessionExpired();
				user = auth.data.user;
				const saved = await server.getState();
				stateEtag = saved.data.state ? saved.etag : null;
				adoptKitchen(saved.data.state || createNewUserState());
				showStarter = false;
			} else {
				const expiredUser = restoreExpiredSessionAccount(storage);
				if (expiredUser) {
					user = expiredUser;
					markSessionExpired(true);
					kitchenSync.restore(expiredUser);
					showStarter = false;
				} else {
					restoreGuestSession();
				}
			}
			syncing = false;
		} catch {
			const cached = readCachedAccount(storage);
			if (cached) {
				user = cached;
				if (kitchenSync.restore(cached)) {
					showStarter = false;
				} else {
					restoreGuestSession({ preserveLastAccount: true });
				}
			}
			syncing = false;
		} finally {
			guestPersistenceReady = true;
			runReactivePersistence();
		}
	}

	async function refreshAuth() {
		const auth = await server.getAuth();
		const previousUser = user;
		const transition = resolveLocalAuthTransition({
			previousMode: 'local',
			nextMode: 'local',
			previousUser,
			nextUser: auth.data.user ?? null
		});
		if (transition.localSessionExpired) {
			markSessionExpired(false);
			runReactivePersistence();
			return auth.data;
		}
		if (transition.changedIdentity) {
			kitchenSync.clearContext();
			aiClears += 1;
		}
		user = auth.data.user ?? null;
		if (user) clearSessionExpired();
		if (transition.changedIdentity) {
			if (user) {
				const latest = await server.getState();
				stateEtag = latest.data.state ? latest.etag : null;
				adoptKitchen(latest.data.state || createNewUserState());
				showStarter = false;
			} else {
				restoreGuestSession();
			}
		}
		runReactivePersistence();
		return auth.data;
	}

	async function reconnectKitchen() {
		const previous = user;
		await refreshAuth();
		if (sessionExpired) {
			announceSessionExpired();
			return;
		}
		if (!user) return;
		if (previous?.id !== user.id || previous?.householdId !== user.householdId) {
			kitchenSync.clearContext();
		}
		const latest = await server.getState();
		stateEtag = latest.data.state ? latest.etag : null;
		adoptKitchen(latest.data.state || createNewUserState());
		await retrySync();
	}

	async function openSettings() {
		try {
			await refreshAuth();
		} catch {
			// Offline settings keeps cached state.
		}
		if (sessionExpired) announceSessionExpired();
	}

	async function authenticate(args: {
		action: 'login' | 'register';
		name?: string;
		email: string;
		password: string;
		ip?: string;
	}) {
		syncing = true;
		try {
			const previousUser = user;
			const wasSessionExpired = sessionExpired;
			if (previousUser && wasSessionExpired) {
				kitchenSync.stage(structuredClone(kitchen));
			}
			const guestKitchen =
				args.action === 'register'
					? resolveRegistrationGuestSeed(storage, structuredClone(kitchen), {
							sessionExpired: wasSessionExpired,
							user: previousUser
						})
					: null;
			const result = await server.postAuth(
				{
					action: args.action,
					...(args.name ? { name: args.name } : {}),
					email: args.email,
					password: args.password
				},
				args.ip
			);
			assert.ok(result.status === 200 || result.status === 201, result.data.error);
			if (
				previousUser &&
				(previousUser.id !== result.data.user.id ||
					previousUser.householdId !== result.data.user.householdId)
			) {
				kitchenSync.clearContext();
				aiClears += 1;
			}
			clearSessionExpired();
			user = result.data.user;
			const saved = await server.getState();
			stateEtag = saved.data.state ? saved.etag : null;
			if (guestKitchen) {
				adoptKitchen(saved.data.state || createNewUserState());
				kitchen = guestKitchen;
				kitchenSync.stage(guestKitchen);
			} else if (saved.data.state) {
				adoptKitchen(saved.data.state);
			} else {
				const initial = createNewUserState();
				const created = await server.putState({ state: initial }, null);
				stateEtag = created.etag;
				adoptKitchen(initial);
			}
			showStarter = false;
			syncing = false;
			await retrySync();
			runReactivePersistence();
		} finally {
			syncing = false;
		}
	}

	async function logout() {
		syncing = true;
		try {
			if (sessionExpired) {
				if (user) kitchenSync.stage(structuredClone(kitchen));
				await server.postAuth({ action: 'logout' });
			} else {
				if (user) {
					kitchenSync.stage(structuredClone(kitchen));
					await kitchenSync.sync();
					if (kitchenSync.snapshot()) {
						throw new Error('Pending kitchen changes must sync before logout.');
					}
				}
				await server.postAuth({ action: 'logout' });
			}
			restoreGuestSession();
		} finally {
			syncing = false;
		}
	}

	async function deleteAccount(password: string) {
		assert.ok(user && !sessionExpired, 'Active session required to delete account');
		syncing = true;
		try {
			const res = await server.postAuth({ action: 'deleteAccount', password });
			assert.equal(res.status, 200);
			clearAccountStorage(storage, user.id);
			restoreGuestSession();
		} finally {
			syncing = false;
		}
	}

	return {
		storage,
		notifications,
		get user() {
			return user;
		},
		get kitchen() {
			return kitchen;
		},
		get showStarter() {
			return showStarter;
		},
		get sessionExpired() {
			return sessionExpired;
		},
		get syncStatus() {
			return syncStatus;
		},
		get autoSyncCount() {
			return autoSyncCount;
		},
		get aiClears() {
			return aiClears;
		},
		set online(value: boolean) {
			online = value;
		},
		mutateKitchen(mutator: (draft: AppState) => void) {
			const next = structuredClone(kitchen);
			mutator(next);
			kitchen = next;
			runReactivePersistence();
		},
		retrySync,
		mount,
		refreshAuth,
		reconnectKitchen,
		openSettings,
		authenticate,
		logout,
		deleteAccount
	};
}

test('logout and deleteAccount preserve custom flavorithm-guest-kitchen entries and match showStarter', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-pantry-1', name: 'tahini', quantity: 1, unit: 'jar', category: 'Condiments' }
	];
	customGuest.meals = [
		{
			id: 'guest-meal-1',
			date: '2026-11-24',
			slot: 'Lunch',
			recipeId: 'lemon-chickpea-orzo',
			servings: 3
		}
	];
	customGuest.shopping = [
		{ id: 'guest-shop-1', name: 'pita bread', quantity: 6, unit: 'pieces', checked: false }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createClientHarness(server, storage);
	await app.mount();
	assert.equal(app.showStarter, false);
	assert.deepEqual(app.kitchen.pantry, customGuest.pantry);

	const password = 'A very strong test password 123!';
	await server.postAuth(
		{ action: 'register', name: 'Household Chef', email: 'chef1@example.test', password },
		'10.0.0.1'
	);
	await server.postAuth({ action: 'logout' }, '10.0.0.1');

	await app.authenticate({
		action: 'login',
		email: 'chef1@example.test',
		password,
		ip: '10.0.0.1'
	});
	app.mutateKitchen((draft) => {
		draft.pantry = [
			{ id: 'home-saffron', name: 'saffron', quantity: 2, unit: 'grams', category: 'Spices' }
		];
	});
	await app.retrySync();
	assert.equal(JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry[0].name, 'tahini');

	// Explicit logout restores custom guest pantry, meal, and shopping entries with showStarter = false.
	await app.logout();
	assert.equal(app.user, null);
	assert.equal(app.showStarter, false);
	assert.equal(storage.values.has('flavorithm-last-account'), false);
	assert.deepEqual(app.kitchen.pantry, customGuest.pantry);
	assert.deepEqual(app.kitchen.meals, customGuest.meals);
	assert.deepEqual(app.kitchen.shopping, customGuest.shopping);

	// Sign back in and deleteAccount: guest snapshot remains intact and account keys are purged.
	await app.authenticate({
		action: 'login',
		email: 'chef1@example.test',
		password,
		ip: '10.0.0.1'
	});
	await app.deleteAccount(password);
	assert.equal(app.user, null);
	assert.equal(app.showStarter, false);
	assert.deepEqual(app.kitchen.pantry, customGuest.pantry);
	assert.deepEqual(app.kitchen.meals, customGuest.meals);
	assert.deepEqual(app.kitchen.shopping, customGuest.shopping);
	assert.deepEqual(
		JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry,
		customGuest.pantry
	);
});

test('tearing down without a valid guest snapshot restores createInitialState with showStarter = true', async () => {
	const server = createServerClient();
	const storage = createStorage([['flavorithm-started', 'yes']]);
	const app = createClientHarness(server, storage);
	const password = 'A very strong test password 123!';
	await server.postAuth(
		{ action: 'register', name: 'No Guest User', email: 'noguest@example.test', password },
		'10.0.0.2'
	);
	await app.authenticate({
		action: 'login',
		email: 'noguest@example.test',
		password,
		ip: '10.0.0.2'
	});
	assert.equal(app.showStarter, false);

	// Simulate browser without a valid flavorithm-guest-kitchen snapshot and stale flavorithm-started.
	storage.removeItem('flavorithm-guest-kitchen');
	storage.setItem('flavorithm-started', 'yes');
	await app.logout();
	assert.equal(app.showStarter, true);
	assert.equal(storage.values.has('flavorithm-started'), false);
	assert.equal(app.kitchen.pantry.length, createInitialState().pantry.length);
});

test('local session expiry pauses auto-sync, keeps last-account, notifies once, restores offline/online, and merges edits after re-login', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-only', name: 'maple syrup', quantity: 1, unit: 'bottle', category: 'Pantry' }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createClientHarness(server, storage);
	await app.mount();

	const password = 'A very strong test password 123!';
	await server.postAuth(
		{ action: 'register', name: 'Ada Lovelace', email: 'ada@example.test', password },
		'10.0.0.3'
	);
	await app.authenticate({
		action: 'login',
		email: 'ada@example.test',
		password,
		ip: '10.0.0.3'
	});
	app.mutateKitchen((draft) => {
		draft.pantry = [
			{ id: 'p-flour', name: 'bread flour', quantity: 4, unit: 'cups', category: 'Baking' }
		];
	});
	await app.retrySync();
	const accountUser = structuredClone(app.user!);

	// Expire server session before openSettings and reconnectKitchen.
	server.expireSession();
	await app.openSettings();
	assert.equal(app.sessionExpired, true);
	assert.deepEqual(app.user, accountUser);
	assert.equal(app.kitchen.pantry[0].quantity, 4);
	assert.ok(storage.getItem('flavorithm-last-account'));
	assert.equal(app.notifications.length, 1);

	// Subsequent reconnectKitchen keeps household state and does not notify a second time.
	await app.reconnectKitchen();
	assert.equal(app.notifications.length, 1);
	assert.equal(app.sessionExpired, true);

	// Editing pantry, meal, and shopping items during sessionExpired stages to journal and pauses auto-sync.
	const syncCountBefore = app.autoSyncCount;
	app.mutateKitchen((draft) => {
		draft.pantry[0].quantity = 9;
		draft.meals.push({
			id: 'expired-meal-1',
			date: '2026-11-25',
			slot: 'Dinner',
			recipeId: 'lemon-herb-chicken',
			servings: 2
		});
		draft.shopping.push({
			id: 'expired-shop-1',
			name: 'lemons',
			quantity: 4,
			unit: 'whole',
			checked: false
		});
	});
	assert.equal(app.autoSyncCount, syncCountBefore);
	assert.equal(app.syncStatus.pending, true);
	const journalRecords = readPendingJournal(storage, accountUser).records;
	assert.equal(journalRecords.length, 1);
	assert.ok(
		[...storage.values.keys()].some((key) => key.startsWith('flavorithm-pending-journal:v1:'))
	);
	assert.deepEqual(
		JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry,
		customGuest.pantry
	);

	// SyncStatus renders expired-session banner and Sign in button.
	const rendered = render(SyncStatus, {
		props: {
			kitchen: app.kitchen,
			online: true,
			pending: app.syncStatus.pending,
			syncing: false,
			conflicts: [],
			sessionExpired: app.sessionExpired,
			signIn: () => {},
			retry: () => {},
			resolve: () => {},
			exportPending: () => {}
		}
	});
	assert.match(rendered.body, /Session expired/);
	assert.match(rendered.body, /<button class="primary">Sign in<\/button>/);

	// Reloading offline after local session expiry restores cached household baseline and pending journal.
	const offlineReload = createClientHarness(server, storage);
	offlineReload.online = false;
	await offlineReload.mount();
	assert.deepEqual(offlineReload.user, accountUser);
	assert.equal(offlineReload.kitchen.pantry[0].quantity, 9);
	assert.equal(offlineReload.kitchen.meals.length, 1);
	assert.equal(offlineReload.kitchen.shopping.length, 1);

	// Reloading online while still expired restores flavorithm-last-account in sessionExpired = true mode.
	const onlineExpiredReload = createClientHarness(server, storage);
	await onlineExpiredReload.mount();
	assert.equal(onlineExpiredReload.sessionExpired, true);
	assert.deepEqual(onlineExpiredReload.user, accountUser);
	assert.equal(onlineExpiredReload.kitchen.pantry[0].quantity, 9);
	assert.deepEqual(
		JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry,
		customGuest.pantry
	);

	// Re-login clears sessionExpired, merges offline edits, and syncs them to /api/state.
	await onlineExpiredReload.authenticate({
		action: 'login',
		email: 'ada@example.test',
		password,
		ip: '10.0.0.3'
	});
	assert.equal(onlineExpiredReload.sessionExpired, false);
	assert.equal(onlineExpiredReload.syncStatus.pending, false);
	assert.equal(readPendingJournal(storage, accountUser).records.length, 0);
	const serverState = await server.getState();
	assert.equal(serverState.status, 200);
	assert.equal(serverState.data.state.pantry[0].quantity, 9);
	assert.equal(serverState.data.state.meals[0].id, 'expired-meal-1');
	assert.equal(serverState.data.state.shopping[0].id, 'expired-shop-1');
});

test('signing out or registering during sessionExpired isolates prior journals and never leaks household data into guest storage', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-tea', name: 'earl grey tea', quantity: 1, unit: 'tin', category: 'Beverages' }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createClientHarness(server, storage);
	await app.mount();

	const password = 'A very strong test password 123!';
	await server.postAuth(
		{ action: 'register', name: 'Old Owner', email: 'old-owner@example.test', password },
		'10.0.0.4'
	);
	await app.authenticate({
		action: 'login',
		email: 'old-owner@example.test',
		password,
		ip: '10.0.0.4'
	});
	const oldOwner = structuredClone(app.user!);

	server.expireSession();
	await app.refreshAuth();
	assert.equal(app.sessionExpired, true);
	app.mutateKitchen((draft) => {
		draft.pantry = [
			{ id: 'private-caviar', name: 'caviar', quantity: 2, unit: 'tins', category: 'Seafood' }
		];
	});

	// Registering a new account during sessionExpired seeds from restoreGuestKitchen and keeps oldOwner's journal isolated.
	await app.authenticate({
		action: 'register',
		name: 'New Owner',
		email: 'new-owner@example.test',
		password,
		ip: '10.0.0.4'
	});
	assert.equal(app.sessionExpired, false);
	assert.equal(app.user?.email, 'new-owner@example.test');
	assert.deepEqual(app.kitchen.pantry, customGuest.pantry);
	assert.equal(
		app.kitchen.pantry.some((item) => item.id === 'private-caviar'),
		false
	);
	assert.equal(readPendingJournal(storage, oldOwner).records.length, 1);
	assert.deepEqual(
		JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry,
		customGuest.pantry
	);

	// Expiring New Owner and explicitly signing out isolates New Owner's journal and restores the guest kitchen cleanly.
	const newOwner = structuredClone(app.user!);
	server.expireSession();
	await app.reconnectKitchen();
	assert.equal(app.sessionExpired, true);
	app.mutateKitchen((draft) => {
		draft.shopping = [
			{ id: 'new-owner-shop', name: 'coffee beans', quantity: 1, unit: 'bag', checked: false }
		];
	});
	await app.logout();
	assert.equal(app.user, null);
	assert.equal(app.sessionExpired, false);
	assert.deepEqual(app.kitchen.pantry, customGuest.pantry);
	assert.deepEqual(app.kitchen.shopping, []);
	assert.equal(readPendingJournal(storage, oldOwner).records.length, 1);
	assert.equal(readPendingJournal(storage, newOwner).records.length, 1);
	assert.deepEqual(
		JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry,
		customGuest.pantry
	);
});
