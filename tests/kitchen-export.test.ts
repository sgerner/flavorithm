import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import * as svelte from 'svelte';

process.env.FLAVORITHM_DB_PATH = ':memory:';

const { createInitialState, createNewUserState } = await import('../src/lib/data.ts');
const { createKitchenSync } = await import('../src/lib/client-sync.ts');
const { writePendingJournal } = await import('../src/lib/offline-sync.ts');
const {
	ACCOUNT_EXPORT_MAX_ATTEMPTS,
	ACCOUNT_EXPORT_TIMEOUT_MS,
	KITCHEN_EXPORT_FILENAME,
	exportFallbackNotice,
	exportKitchenArchive,
	exportNoticeForSource,
	fetchAccountExportPayload,
	sanitizeKitchenState
} = await import('../src/lib/kitchen-export.ts');
const backend = await import('../src/lib/server/db.ts');
const exportRoute = await import('../src/routes/api/export/+server.ts');

import type { SyncConflict } from '../src/lib/offline-sync.ts';
import type { AppState, User } from '../src/lib/types.ts';

const nodeRequire = createRequire(import.meta.url);
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;
const noopComponent = () => {};
const iconProxy = new Proxy({}, { get: () => noopComponent });

const syncStatusServerJs = ts.transpileModule(
	compile(readFileSync('src/lib/components/SyncStatus.svelte', 'utf8'), {
		filename: 'src/lib/components/SyncStatus.svelte',
		generate: 'server'
	}).js.code,
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

function renderSyncStatusHtml(props: {
	kitchen: AppState;
	online: boolean;
	ready: boolean;
	pending: boolean;
	syncing: boolean;
	conflicts: SyncConflict[];
	error?: string;
}): string {
	const exports: { default?: any } = {};
	const modMap: Record<string, unknown> = {
		svelte,
		'svelte/internal/server': svelteServer,
		'svelte/internal/disclose-version': {},
		'@lucide/svelte': iconProxy,
		'#lib/motion.ts': { revealMotion: () => ({}) },
		'#lib/components/DisclosureButton.svelte': noopComponent
	};
	runInNewContext(syncStatusServerJs, {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			throw new Error(`Unexpected SyncStatus dependency ${id}`);
		},
		Map,
		Object,
		Array,
		String,
		Boolean,
		RegExp
	});
	return render(exports.default, {
		props: {
			...props,
			retry: () => {},
			resolve: () => {},
			exportPending: () => {}
		}
	}).body;
}

function memoryStorage() {
	const values = new Map<string, string>();
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

const fixedNow = new Date('2026-11-22T07:30:00.000Z');

test('guest export builds a complete envelope from client state without network calls or storage writes', async () => {
	const guestState = createInitialState();
	guestState.pantry.push({
		id: 'fresh-basil',
		name: 'Fresh basil',
		quantity: 2,
		unit: 'bunch',
		category: 'Produce'
	});
	const storage = memoryStorage();
	let networkCalls = 0;

	const result = await exportKitchenArchive({
		user: null,
		state: guestState,
		online: false,
		storage,
		now: fixedNow,
		fetchAccountExport: async () => {
			networkCalls += 1;
			throw new Error('Guests must never call /api/export');
		}
	});

	assert.equal(networkCalls, 0);
	assert.equal(storage.values.size, 0);
	assert.equal(result.filename, KITCHEN_EXPORT_FILENAME);
	assert.equal(result.notice, exportNoticeForSource('guest'));
	assert.match(result.notice, /guest/i);

	const parsed = JSON.parse(result.json) as Record<string, unknown>;
	assert.equal(parsed.exportedAt, fixedNow.toISOString());
	assert.equal(parsed.source, 'guest');
	assert.equal(parsed.hasPendingChanges, false);
	assert.equal('user' in parsed, false);
	assert.equal(
		(parsed.state as AppState).pantry.some((item) => item.id === 'fresh-basil'),
		true
	);
});

test('export serializer strips transient AI and voice API keys while keeping legitimate preferences', () => {
	const rawState = createInitialState();
	rawState.preferences.reasoning = { effort: 'high', enabled: true, budgetTokens: 4096 };
	rawState.preferences.ratings = { [rawState.recipes[0].id]: 5 };
	rawState.preferences.usePersonalAI = true;

	const pollutedState = {
		...rawState,
		apiKey: 'sk-live-secret-top-level',
		voiceApiKey: 'gsk-secret-voice-key',
		preferences: {
			...rawState.preferences,
			chatgptAccountId: 'host-chatgpt',
			provider: 'chatgpt',
			model: 'gpt-5',
			apiKey: 'sk-live-secret-nested',
			voiceApiKey: 'dg-secret-voice-nested',
			accessToken: 'oauth-token-should-not-export'
		}
	} as unknown as AppState;

	const sanitized = sanitizeKitchenState(pollutedState);
	const serialized = JSON.stringify(sanitized);

	assert.equal(serialized.includes('sk-live-secret'), false);
	assert.equal(serialized.includes('gsk-secret'), false);
	assert.equal(serialized.includes('dg-secret'), false);
	assert.equal(serialized.includes('oauth-token-should-not-export'), false);
	assert.equal(serialized.includes('host-chatgpt'), false);
	assert.equal(sanitized.preferences.usePersonalAI, true);
	assert.equal(sanitized.preferences.chatgptAccountId, undefined);
	assert.equal(sanitized.preferences.model, '');
	assert.deepEqual(sanitized.preferences.reasoning, {
		effort: 'high',
		enabled: true,
		budgetTokens: 4096
	});
	assert.equal(sanitized.preferences.ratings?.[rawState.recipes[0].id], 5);
});

test('offline signed-in export merges pending client edits and skips network calls', async () => {
	const user: User = {
		id: 'cook-offline',
		name: 'Offline Cook',
		email: 'offline@example.test',
		householdId: 'home-offline'
	};
	const storage = memoryStorage();
	const base = createNewUserState();
	base.pantry = [{ id: 'rice', name: 'Rice', quantity: 1, unit: 'kg', category: 'Grains' }];

	let currentState = structuredClone(base);
	const sync = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => {
			throw new Error('Offline test should not invoke transport');
		}
	});
	sync.initialize(user, base, 'etag-1');

	const edited = structuredClone(base);
	edited.pantry[0].quantity = 4;
	edited.shopping.push({
		id: 'olive-oil',
		name: 'Olive oil',
		quantity: 1,
		unit: 'bottle',
		checked: false
	});
	currentState = edited;
	sync.stage(edited);

	// Simulate another tab staging an independent queued edit in localStorage.
	const peerEdit = structuredClone(base);
	peerEdit.meals.push({
		id: 'friday-dinner',
		date: '2026-11-27',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 3
	});
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base,
		local: peerEdit,
		etag: 'etag-1',
		createdAt: 100,
		updatedAt: 100,
		writerId: 'peer-tab',
		writeId: 'peer-write-1'
	});

	let networkCalls = 0;
	const result = await exportKitchenArchive({
		user,
		state: currentState,
		online: false,
		pendingSnapshot: sync.snapshot(),
		storage,
		now: fixedNow,
		fetchAccountExport: async () => {
			networkCalls += 1;
			return null;
		}
	});

	assert.equal(networkCalls, 0);
	assert.equal(result.envelope.source, 'offline');
	assert.equal(result.fallbackReason, 'offline');
	assert.equal(result.envelope.hasPendingChanges, true);
	assert.deepEqual(result.envelope.user, user);
	assert.equal(result.envelope.state.pantry[0].quantity, 4);
	assert.equal(result.envelope.state.shopping[0]?.name, 'Olive oil');
	assert.equal(result.envelope.state.meals[0]?.id, 'friday-dinner');
	assert.equal(result.notice, exportFallbackNotice('offline'));
	assert.equal(storage.getItem('flavorithm-guest-kitchen'), null);
});

test('online signed-in export merges confirmed account metadata while preserving pending local quantities over stale server values', async () => {
	const clientUser: User = {
		id: 'cook-online',
		name: 'Ada Cook',
		email: 'ada@example.test',
		householdId: 'home-online',
		emailVerified: false
	};
	const confirmedServerUser: User = {
		...clientUser,
		emailVerified: true
	};
	const storage = memoryStorage();
	const base = createNewUserState();
	base.pantry = [{ id: 'lentils', name: 'Lentils', quantity: 2, unit: 'cups', category: 'Grains' }];

	let currentState = structuredClone(base);
	const sync = createKitchenSync({
		storage,
		getUser: () => clientUser,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => {
			throw new Error('Unused transport');
		}
	});
	sync.initialize(clientUser, base, 'etag-v1');

	// User updates lentils quantity locally (pending sync).
	const localEdited = structuredClone(base);
	localEdited.pantry[0].quantity = 7;
	currentState = localEdited;
	sync.stage(localEdited);

	// Server still has stale quantity (2) for lentils, plus a household member's shopping addition.
	const serverState = structuredClone(base);
	serverState.pantry[0].quantity = 2;
	serverState.shopping = [
		{ id: 'lemons', name: 'Lemons', quantity: 4, unit: 'piece', checked: false }
	];

	const result = await exportKitchenArchive({
		user: clientUser,
		state: currentState,
		online: true,
		pendingSnapshot: sync.snapshot(),
		storage,
		now: fixedNow,
		fetchAccountExport: async () => ({
			exportedAt: '2026-11-22T07:29:50.000Z',
			user: confirmedServerUser,
			state: serverState
		})
	});

	assert.equal(result.envelope.source, 'account');
	assert.equal(result.envelope.hasPendingChanges, true);
	assert.equal(result.envelope.user?.emailVerified, true);
	assert.equal(result.envelope.state.pantry[0].quantity, 7);
	assert.equal(result.envelope.state.shopping[0]?.name, 'Lemons');
	assert.match(result.notice, /merged account/i);
});

test('online export with no pending snapshot, journal, or confirmed baseline uses server state instead of dropping it', async () => {
	const user: User = {
		id: 'cook-no-baseline',
		name: 'No Baseline Cook',
		email: 'nobaseline@example.test',
		householdId: 'home-no-baseline',
		emailVerified: true
	};
	const storage = memoryStorage();
	const localPlaceholderState = createNewUserState();
	assert.equal(localPlaceholderState.pantry.length, 0);
	assert.equal(localPlaceholderState.shopping.length, 0);

	const serverState = createNewUserState();
	serverState.pantry = [
		{ id: 'chickpeas', name: 'Chickpeas', quantity: 3, unit: 'can', category: 'Canned goods' }
	];
	serverState.shopping = [
		{ id: 'tahini', name: 'Tahini', quantity: 1, unit: 'jar', checked: false }
	];
	serverState.meals = [
		{
			id: 'tuesday-lunch',
			date: '2026-11-24',
			slot: 'Lunch',
			recipeId: serverState.recipes[0].id,
			servings: 2
		}
	];
	serverState.preferences.diet = 'Mediterranean';

	const result = await exportKitchenArchive({
		user,
		state: localPlaceholderState,
		online: true,
		pendingSnapshot: null,
		hasPendingSync: false,
		storage,
		now: fixedNow,
		fetchAccountExport: async () => ({
			exportedAt: '2026-11-22T07:29:55.000Z',
			user,
			state: serverState
		})
	});

	assert.equal(result.envelope.source, 'account');
	assert.equal(result.envelope.hasPendingChanges, false);
	assert.equal(result.envelope.state.pantry.length, 1);
	assert.equal(result.envelope.state.pantry[0].id, 'chickpeas');
	assert.equal(result.envelope.state.shopping[0]?.id, 'tahini');
	assert.equal(result.envelope.state.meals[0]?.id, 'tuesday-lunch');
	assert.equal(result.envelope.state.preferences.diet, 'Mediterranean');
	assert.equal(result.notice, exportNoticeForSource('account'));
});

test('online export merges provisional #121 edits staged before initial load completes onto server state', async () => {
	const user: User = {
		id: 'cook-provisional',
		name: 'Provisional Cook',
		email: 'provisional@example.test',
		householdId: 'home-provisional'
	};
	const storage = memoryStorage();
	let currentState = createNewUserState();
	const sync = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => {
			throw new Error('Unused transport');
		}
	});
	sync.prepare(user);
	sync.failLoad('Could not load your kitchen.');

	const provisionalEdit = structuredClone(currentState);
	provisionalEdit.pantry.push({
		id: 'shallots',
		name: 'Shallots',
		quantity: 5,
		unit: 'piece',
		category: 'Produce'
	});
	currentState = provisionalEdit;
	sync.stage(provisionalEdit);

	const serverState = createNewUserState();
	serverState.pantry.push({
		id: 'butter',
		name: 'Butter',
		quantity: 2,
		unit: 'stick',
		category: 'Dairy & eggs'
	});

	const result = await exportKitchenArchive({
		user,
		state: currentState,
		online: true,
		pendingSnapshot: sync.snapshot(),
		hasPendingSync: true,
		storage,
		now: fixedNow,
		fetchAccountExport: async () => ({
			user,
			state: serverState
		})
	});

	assert.equal(result.envelope.source, 'account');
	assert.equal(result.envelope.hasPendingChanges, true);
	assert.equal(
		result.envelope.state.pantry.some((item) => item.id === 'butter'),
		true
	);
	assert.equal(
		result.envelope.state.pantry.some((item) => item.id === 'shallots' && item.quantity === 5),
		true
	);
});

test('online export treats null or malformed server state as an error and falls back to offline with a notice', async () => {
	const user: User = {
		id: 'cook-null-server',
		name: 'Null Server Cook',
		email: 'nullserver@example.test',
		householdId: 'home-null-server'
	};
	const localState = createNewUserState();
	localState.pantry = [
		{ id: 'oats', name: 'Rolled oats', quantity: 2, unit: 'cups', category: 'Grains' }
	];

	const nullServerResult = await exportKitchenArchive({
		user,
		state: localState,
		online: true,
		hasPendingSync: false,
		now: fixedNow,
		fetchAccountExport: async () => ({
			exportedAt: fixedNow.toISOString(),
			user,
			state: null
		})
	});

	assert.equal(nullServerResult.envelope.source, 'offline');
	assert.equal(nullServerResult.fallbackReason, 'invalid-server-state');
	assert.equal(nullServerResult.envelope.hasPendingChanges, false);
	assert.equal(nullServerResult.envelope.state.pantry[0]?.id, 'oats');
	assert.equal(nullServerResult.notice, exportFallbackNotice('invalid-server-state'));

	const malformedServerResult = await exportKitchenArchive({
		user,
		state: localState,
		online: true,
		hasPendingSync: true,
		now: fixedNow,
		fetchAccountExport: async () => ({
			exportedAt: fixedNow.toISOString(),
			user,
			state: {
				pantry: 'not-an-array',
				recipes: [],
				meals: [],
				shopping: [],
				preferences: {}
			} as unknown as AppState
		})
	});

	assert.equal(malformedServerResult.envelope.source, 'offline');
	assert.equal(malformedServerResult.fallbackReason, 'invalid-server-state');
	assert.equal(malformedServerResult.envelope.hasPendingChanges, true);
	assert.equal(malformedServerResult.envelope.state.pantry[0]?.id, 'oats');
	assert.equal(malformedServerResult.notice, exportFallbackNotice('invalid-server-state'));
});

test('online export keeps hasPendingChanges false when server is ahead of local confirmed baseline without local edits', async () => {
	const user: User = {
		id: 'cook-server-ahead',
		name: 'Server Ahead Cook',
		email: 'ahead@example.test',
		householdId: 'home-ahead'
	};
	const storage = memoryStorage();
	const baseline = createNewUserState();
	baseline.pantry = [
		{ id: 'tomatoes', name: 'Tomatoes', quantity: 2, unit: 'piece', category: 'Produce' }
	];

	let currentState = structuredClone(baseline);
	const sync = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => {
			throw new Error('Unused transport');
		}
	});
	sync.initialize(user, baseline, 'etag-base');

	const serverAhead = structuredClone(baseline);
	serverAhead.pantry[0].quantity = 8;
	serverAhead.shopping = [{ id: 'feta', name: 'Feta', quantity: 1, unit: 'block', checked: false }];

	const result = await exportKitchenArchive({
		user,
		state: currentState,
		online: true,
		pendingSnapshot: sync.snapshot(),
		hasPendingSync: false,
		storage,
		now: fixedNow,
		fetchAccountExport: async () => ({
			user,
			state: serverAhead
		})
	});

	assert.equal(result.envelope.source, 'account');
	assert.equal(result.envelope.hasPendingChanges, false);
	assert.equal(result.envelope.state.pantry[0].quantity, 8);
	assert.equal(result.envelope.state.shopping[0]?.id, 'feta');
});

test('account export HTTP loader uses 30s timeout, retries slow or 5xx responses, and shows distinct timeout notice when exhausted', async () => {
	assert.equal(ACCOUNT_EXPORT_TIMEOUT_MS, 30_000);
	assert.equal(ACCOUNT_EXPORT_MAX_ATTEMPTS, 2);

	const user: User = {
		id: 'cook-slow',
		name: 'Slow Household Cook',
		email: 'slow@example.test',
		householdId: 'home-slow'
	};
	const serverState = createNewUserState();
	serverState.pantry = [
		{ id: 'parmesan', name: 'Parmesan', quantity: 1, unit: 'wedge', category: 'Dairy & eggs' }
	];

	// First attempt times out, second attempt succeeds -> full account export!
	let retryCalls = 0;
	const recovered = await exportKitchenArchive({
		user,
		state: createNewUserState(),
		online: true,
		now: fixedNow,
		fetcher: (async (_input, init) => {
			retryCalls += 1;
			assert.equal(init?.redirect, 'manual');
			assert.equal(Boolean(init?.signal), true);
			if (retryCalls === 1) {
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			}
			return Response.json({ exportedAt: fixedNow.toISOString(), user, state: serverState });
		}) as typeof fetch
	});

	assert.equal(retryCalls, 2);
	assert.equal(recovered.envelope.source, 'account');
	assert.equal(recovered.envelope.state.pantry[0]?.id, 'parmesan');

	// Both attempts hang past timeoutMs -> falls back to local device state with distinct timeout notice!
	let timeoutCalls = 0;
	const localFallbackState = createNewUserState();
	localFallbackState.pantry = [
		{ id: 'flour', name: 'Flour', quantity: 5, unit: 'cups', category: 'Pantry' }
	];
	const timedOut = await exportKitchenArchive({
		user,
		state: localFallbackState,
		online: true,
		timeoutMs: 25,
		maxAttempts: 2,
		now: fixedNow,
		fetcher: (async (_input, init) => {
			timeoutCalls += 1;
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(init.signal?.reason ?? new DOMException('Timed out', 'TimeoutError'));
				});
			});
		}) as typeof fetch
	});

	assert.equal(timeoutCalls, 2);
	assert.equal(timedOut.envelope.source, 'offline');
	assert.equal(timedOut.fallbackReason, 'timeout');
	assert.equal(timedOut.envelope.state.pantry[0]?.id, 'flour');
	assert.equal(timedOut.notice, exportFallbackNotice('timeout'));
	assert.match(timedOut.notice, /took too long/i);
	assert.doesNotMatch(timedOut.notice, /^offline device kitchen data/i);
});

test('online export distinguishes expired session (401 or redirect) from network failure and offline mode', async () => {
	const user: User = {
		id: 'cook-auth-expired',
		name: 'Expired Session Cook',
		email: 'expired@example.test',
		householdId: 'home-expired'
	};
	const state = createNewUserState();
	state.pantry = [
		{ id: 'garlic', name: 'Garlic', quantity: 6, unit: 'cloves', category: 'Produce' }
	];

	let authCalls = 0;
	const expired401 = await exportKitchenArchive({
		user,
		state,
		online: true,
		hasPendingSync: true,
		now: fixedNow,
		fetcher: (async () => {
			authCalls += 1;
			return Response.json({ error: 'Authentication required' }, { status: 401 });
		}) as typeof fetch
	});

	// Expired sessions should not waste a retry and must never be labelled "Offline device kitchen data".
	assert.equal(authCalls, 1);
	assert.equal(expired401.envelope.source, 'offline');
	assert.equal(expired401.fallbackReason, 'session-expired');
	assert.equal(expired401.envelope.hasPendingChanges, true);
	assert.equal(expired401.notice, exportFallbackNotice('session-expired'));
	assert.match(expired401.notice, /session expired/i);
	assert.doesNotMatch(expired401.notice, /offline device kitchen data/i);

	// Auth redirect (302 / opaqueredirect) also maps to session-expired without retry.
	let redirectCalls = 0;
	await assert.rejects(
		() =>
			fetchAccountExportPayload((async () => {
				redirectCalls += 1;
				return new Response(null, { status: 302, headers: { location: '/auth/login' } });
			}) as typeof fetch),
		(err: { reason?: string }) => err.reason === 'session-expired'
	);
	assert.equal(redirectCalls, 1);

	// Online network failure retries and reports unreachable server rather than session expiry or offline mode.
	let networkCalls = 0;
	const networkFailed = await exportKitchenArchive({
		user,
		state,
		online: true,
		hasPendingSync: true,
		now: fixedNow,
		fetcher: (async () => {
			networkCalls += 1;
			throw new TypeError('Failed to fetch');
		}) as typeof fetch
	});

	assert.equal(networkCalls, 2);
	assert.equal(networkFailed.envelope.source, 'offline');
	assert.equal(networkFailed.fallbackReason, 'network-error');
	assert.equal(networkFailed.notice, exportFallbackNotice('network-error'));
	assert.notEqual(networkFailed.notice, expired401.notice);
	assert.notEqual(networkFailed.notice, exportFallbackNotice('offline'));

	// Mismatched server identity is rejected with invalid-server-state notice.
	const mismatchedIdentity = await exportKitchenArchive({
		user,
		state,
		online: true,
		hasPendingSync: false,
		now: fixedNow,
		fetchAccountExport: async () => ({
			user: {
				id: 'different-user',
				name: 'Intruder',
				email: 'intruder@example.test',
				householdId: 'different-home'
			},
			state: createNewUserState()
		})
	});

	assert.equal(mismatchedIdentity.envelope.source, 'offline');
	assert.equal(mismatchedIdentity.fallbackReason, 'invalid-server-state');
	assert.equal(mismatchedIdentity.envelope.user?.id, user.id);
	assert.equal(mismatchedIdentity.envelope.state.pantry[0].quantity, 6);
});

test('SyncStatus renders Back up my changes for pending edits, conflicts, or loaded errors, and hides it for unloaded zero-edit failures', () => {
	const kitchen = createNewUserState();

	const pendingHtml = renderSyncStatusHtml({
		kitchen,
		online: true,
		ready: true,
		pending: true,
		syncing: false,
		conflicts: []
	});
	assert.match(pendingHtml, /Back up my changes/);

	const conflictHtml = renderSyncStatusHtml({
		kitchen,
		online: true,
		ready: true,
		pending: true,
		syncing: false,
		conflicts: [{ path: 'kitchen.pantry[rice].quantity', local: 4, remote: 1 }]
	});
	assert.equal(conflictHtml.split('Back up my changes').length - 1, 1);

	const loadedBaselineErrorHtml = renderSyncStatusHtml({
		kitchen,
		online: true,
		ready: true,
		pending: false,
		syncing: false,
		conflicts: [],
		error: 'The confirmed kitchen could not be saved for offline use.'
	});
	assert.match(loadedBaselineErrorHtml, /Back up my changes/);

	const unloadedNoPendingHtml = renderSyncStatusHtml({
		kitchen,
		online: true,
		ready: false,
		pending: false,
		syncing: false,
		conflicts: [],
		error: 'Could not load your kitchen.'
	});
	assert.doesNotMatch(unloadedNoPendingHtml, /Back up my changes/);
	assert.match(unloadedNoPendingHtml, /Retry sync/);
});

test('server GET /api/export enforces HTTP 401 for guests and returns confirmed state for signed-in users', async () => {
	const unauthenticated = await exportRoute.GET({ locals: {} } as never);
	assert.equal(unauthenticated.status, 401);
	assert.deepEqual(await unauthenticated.json(), { error: 'Authentication required' });

	const registered = await backend.registerUser(
		'Server Export User',
		'server-export@example.test',
		'very secure export password'
	);
	const authenticated = await exportRoute.GET({ locals: { user: registered.user } } as never);
	assert.equal(authenticated.status, 200);
	assert.match(
		authenticated.headers.get('content-disposition') || '',
		/attachment; filename="flavorithm-data\.json"/
	);
	const body = (await authenticated.json()) as {
		exportedAt: string;
		user: User;
		state: AppState;
	};
	assert.equal(body.user.id, registered.user.id);
	assert.equal(Array.isArray(body.state.recipes), true);
});

test('exportKitchenArchive and SyncStatus preserve quarantined journal entries in backups', async () => {
	const user: User = {
		id: 'quarantine-cook',
		name: 'Quarantine Cook',
		email: 'quarantine@example.test',
		householdId: 'quarantine-home'
	};
	const storage = memoryStorage();
	storage.setItem(
		`flavorithm-pending-journal:v1:${user.id}:${user.householdId}:corrupt-slot`,
		'{"broken":true'
	);

	const kitchen = createNewUserState();
	const offlineBackup = await exportKitchenArchive({
		user,
		state: kitchen,
		online: false,
		storage,
		now: fixedNow
	});
	const parsed = JSON.parse(offlineBackup.json) as {
		source: string;
		quarantined?: Array<{ slot: string; raw: string }>;
	};
	assert.equal(parsed.source, 'offline');
	assert.equal(parsed.quarantined?.length, 1);
	assert.equal(parsed.quarantined?.[0]?.slot, 'corrupt-slot');
	assert.equal(parsed.quarantined?.[0]?.raw, '{"broken":true');

	const quarantinedUnloadedHtml = renderSyncStatusHtml({
		kitchen,
		online: false,
		ready: false,
		pending: false,
		syncing: false,
		conflicts: [],
		error: 'A saved offline journal entry could not be read safely and was quarantined.'
	});
	assert.match(quarantinedUnloadedHtml, /Back up my changes/);
});
