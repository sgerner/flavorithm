import assert from 'node:assert/strict';
import test from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';

const { createInitialState, createNewUserState } = await import('../src/lib/data.ts');
const { createKitchenSync } = await import('../src/lib/client-sync.ts');
const { writePendingJournal } = await import('../src/lib/offline-sync.ts');
const {
	KITCHEN_EXPORT_FILENAME,
	exportKitchenArchive,
	exportNoticeForSource,
	sanitizeKitchenState
} = await import('../src/lib/kitchen-export.ts');
const backend = await import('../src/lib/server/db.ts');
const exportRoute = await import('../src/routes/api/export/+server.ts');

import type { AppState, User } from '../src/lib/types.ts';

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

	const pollutedState = {
		...rawState,
		apiKey: 'sk-live-secret-top-level',
		voiceApiKey: 'gsk-secret-voice-key',
		preferences: {
			...rawState.preferences,
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
	assert.equal(result.envelope.hasPendingChanges, true);
	assert.deepEqual(result.envelope.user, user);
	assert.equal(result.envelope.state.pantry[0].quantity, 4);
	assert.equal(result.envelope.state.shopping[0]?.name, 'Olive oil');
	assert.equal(result.envelope.state.meals[0]?.id, 'friday-dinner');
	assert.match(result.notice, /offline/i);
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

test('online signed-in export falls back locally on network failure or mismatched server identity', async () => {
	const user: User = {
		id: 'cook-fallback',
		name: 'Fallback Cook',
		email: 'fallback@example.test',
		householdId: 'home-fallback'
	};
	const state = createNewUserState();
	state.pantry = [
		{ id: 'garlic', name: 'Garlic', quantity: 6, unit: 'cloves', category: 'Produce' }
	];

	const networkFailed = await exportKitchenArchive({
		user,
		state,
		online: true,
		hasPendingSync: true,
		now: fixedNow,
		fetchAccountExport: async () => {
			throw new TypeError('Failed to fetch');
		}
	});

	assert.equal(networkFailed.envelope.source, 'offline');
	assert.equal(networkFailed.envelope.hasPendingChanges, true);
	assert.deepEqual(networkFailed.envelope.user, user);
	assert.equal(networkFailed.envelope.state.pantry[0].quantity, 6);
	assert.match(networkFailed.notice, /offline/i);

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
	assert.equal(mismatchedIdentity.envelope.user?.id, user.id);
	assert.equal(mismatchedIdentity.envelope.state.pantry[0].quantity, 6);
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
