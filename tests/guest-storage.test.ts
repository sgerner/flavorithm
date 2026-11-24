import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenSync } from '../src/lib/client-sync.ts';
import { createInitialState, createNewUserState, defaultPreferences } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import { writePendingJournal } from '../src/lib/offline-sync.ts';
import {
	clearAccountStorage,
	clearGuestData,
	clearGuestKitchen,
	isLocalSessionExpiredResponse,
	migrateGuestKitchenOnSignup,
	quarantineLegacyKitchen,
	readCachedAccount,
	resolveLocalAuthTransition,
	resolveRegistrationGuestSeed,
	restoreExpiredSessionAccount,
	restoreGuestKitchen,
	sanitizeKitchenState,
	SESSION_EXPIRED_CODE,
	shouldPersistGuestKitchen,
	shouldScheduleAutoSync,
	teardownToGuestKitchen
} from '../src/lib/guest-storage.ts';
import {
	clearSampleData,
	hasSampleData,
	promoteSampleIngredient
} from '../src/lib/kitchen-workflows.ts';
import type { AppState, User } from '../src/lib/types.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backendModulePath: string = '../src/lib/server/db.ts';
const { validateAppState } = await import(backendModulePath);

function memoryStorage(values: Map<string, string>) {
	return {
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

test('legacy data is backed up separately and never becomes a guest kitchen', () => {
	const values = new Map([['flavorithm-kitchen', '{"private":"legacy"}']]);
	quarantineLegacyKitchen(memoryStorage(values));
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), '{"private":"legacy"}');
	assert.equal(values.has('flavorithm-kitchen'), false);
	assert.equal(values.has('flavorithm-guest-kitchen'), false);
});

test('quota errors and an older distinct backup never destroy the only legacy copy', () => {
	const values = new Map([['flavorithm-kitchen', 'new legacy snapshot']]);
	quarantineLegacyKitchen({
		...memoryStorage(values),
		setItem: () => {
			throw new Error('Quota exceeded');
		}
	});
	assert.equal(values.get('flavorithm-kitchen'), 'new legacy snapshot');
	values.set('flavorithm-legacy-kitchen-backup', 'older snapshot');
	quarantineLegacyKitchen(memoryStorage(values));
	assert.equal(values.get('flavorithm-kitchen'), 'new legacy snapshot');
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), 'older snapshot');
});

test('restoreGuestKitchen validates collections, normalizes unknown themes, and matches showStarter to flavorithm-started', () => {
	const custom: AppState = {
		...createInitialState(),
		pantry: [{ id: 'p-miso', name: 'white miso', quantity: 2, unit: 'tbsp', category: 'Pantry' }],
		meals: [
			{
				id: 'm-custom',
				date: '2026-11-22',
				slot: 'Dinner',
				recipeId: 'lemon-herb-chicken',
				servings: 4
			}
		],
		shopping: [{ id: 's-tofu', name: 'firm tofu', quantity: 2, unit: 'blocks', checked: false }],
		preferences: {
			...defaultPreferences,
			theme: 'unknown-custom-theme',
			dark: true,
			maxTime: 30
		}
	};
	const values = new Map<string, string>([
		['flavorithm-kitchen', '{"ambiguous":"legacy"}'],
		['flavorithm-guest-kitchen', JSON.stringify(custom)],
		['flavorithm-started', 'yes']
	]);
	const restored = restoreGuestKitchen(memoryStorage(values));
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), '{"ambiguous":"legacy"}');
	assert.equal(values.has('flavorithm-kitchen'), false);
	assert.equal(restored.showStarter, false);
	assert.equal(restored.kitchen.preferences.theme, 'nosh');
	assert.equal(restored.kitchen.preferences.dark, true);
	assert.equal(restored.kitchen.preferences.maxTime, 30);
	assert.deepEqual(restored.kitchen.pantry, custom.pantry);
	assert.deepEqual(restored.kitchen.meals, custom.meals);
	assert.deepEqual(restored.kitchen.shopping, custom.shopping);

	values.delete('flavorithm-started');
	const unstarted = restoreGuestKitchen(memoryStorage(values));
	assert.equal(unstarted.showStarter, true);
});

test('restoreGuestKitchen removes stale flavorithm-started and sets showStarter to true when missing or invalid', () => {
	for (const payload of [
		null,
		'{broken-json',
		'[]',
		JSON.stringify({ preferences: defaultPreferences }),
		JSON.stringify({ ...createInitialState(), pantry: ['not-an-object'] }),
		JSON.stringify({ ...createInitialState(), preferences: null })
	]) {
		const values = new Map<string, string>([['flavorithm-started', 'yes']]);
		if (payload !== null) values.set('flavorithm-guest-kitchen', payload);
		const restored = restoreGuestKitchen(memoryStorage(values));
		assert.equal(restored.showStarter, true);
		assert.equal(values.has('flavorithm-started'), false);
		assert.equal(restored.kitchen.pantry.length, 7);
		assert.equal(restored.kitchen.meals.length, 3);
	}

	// Verify why showStarter = true is critical: unbadged seedPantry stock (e.g. olive oil, eggs)
	// would otherwise be subtracted from shopping deficits without offering Start fresh.
	const fallback = restoreGuestKitchen(memoryStorage(new Map([['flavorithm-started', 'yes']])));
	assert.equal(fallback.showStarter, true);
	const recipeUsingOliveOil = fallback.kitchen.recipes.find((recipe) =>
		recipe.ingredients.some((ingredient) => /olive oil/i.test(ingredient.name))
	)!;
	const withSeedPantry = buildShoppingList([recipeUsingOliveOil], fallback.kitchen.pantry);
	const afterStartFresh = buildShoppingList([recipeUsingOliveOil], []);
	assert.ok(
		afterStartFresh.some((item) => /olive oil/i.test(item.name)) &&
			!withSeedPantry.some((item) => /olive oil/i.test(item.name))
	);
});

test('teardownToGuestKitchen clears AI and sync state while preserving custom guest entries', () => {
	const custom = createInitialState();
	custom.pantry = [
		{ id: 'p-leeks', name: 'leeks', quantity: 3, unit: 'whole', category: 'Produce' }
	];
	const values = new Map<string, string>([
		['flavorithm-guest-kitchen', JSON.stringify(custom)],
		['flavorithm-started', 'yes'],
		['flavorithm-last-account', '{"id":"u1","householdId":"h1","name":"Ada","email":"a@b.co"}']
	]);
	let aiCleared = 0;
	let syncCleared = 0;
	const guest = teardownToGuestKitchen({
		storage: memoryStorage(values),
		clearAIConnectionState: () => {
			aiCleared += 1;
		},
		clearSyncContext: () => {
			syncCleared += 1;
		}
	});
	assert.equal(aiCleared, 1);
	assert.equal(syncCleared, 1);
	assert.equal(values.has('flavorithm-last-account'), false);
	assert.equal(guest.showStarter, false);
	assert.deepEqual(guest.kitchen.pantry, custom.pantry);
});

test('restoreExpiredSessionAccount only restores cached accounts that have unsynced journal deltas', () => {
	const user: User = {
		id: 'user-1',
		householdId: 'home-1',
		name: 'Ada',
		email: 'ada@example.test'
	};
	const values = new Map<string, string>([['flavorithm-last-account', JSON.stringify(user)]]);
	const storage = memoryStorage(values);
	assert.deepEqual(readCachedAccount(storage), user);
	assert.equal(restoreExpiredSessionAccount(storage), null);

	const base = createInitialState();
	const local = structuredClone(base);
	local.pantry[0].quantity = 12;
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base,
		local,
		etag: 'v1',
		createdAt: 100,
		updatedAt: 120,
		writerId: 'tab-1',
		writeId: 'w-1'
	});
	assert.deepEqual(restoreExpiredSessionAccount(storage), user);
});

test('clearAccountStorage deletes user-scoped keys without touching guest or other accounts', () => {
	const values = new Map<string, string>([
		['flavorithm-confirmed:v1:user%3A1:home-1', '{"ok":true}'],
		['flavorithm-pending-journal:v1:user%3A1:home-1:tab-a', '{"pending":true}'],
		['flavorithm-voice:user:1', '{"provider":"groq"}'],
		['flavorithm-pending-journal:v1:user-2:home-2:tab-b', '{"other":true}'],
		['flavorithm-guest-kitchen', '{"guest":true}'],
		['flavorithm-started', 'yes'],
		['flavorithm-legacy-kitchen-backup', '{"legacy":true}']
	]);
	clearAccountStorage(memoryStorage(values), 'user:1');
	assert.equal(values.has('flavorithm-confirmed:v1:user%3A1:home-1'), false);
	assert.equal(values.has('flavorithm-pending-journal:v1:user%3A1:home-1:tab-a'), false);
	assert.equal(values.has('flavorithm-voice:user:1'), false);
	assert.equal(values.get('flavorithm-pending-journal:v1:user-2:home-2:tab-b'), '{"other":true}');
	assert.equal(values.get('flavorithm-guest-kitchen'), '{"guest":true}');
	assert.equal(values.get('flavorithm-started'), 'yes');
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), '{"legacy":true}');
});

test('resolveLocalAuthTransition and resolveRegistrationGuestSeed isolate expired household state', () => {
	const alice: User = {
		id: 'alice',
		householdId: 'home-a',
		name: 'Alice',
		email: 'a@example.test'
	};
	const bob: User = { id: 'bob', householdId: 'home-b', name: 'Bob', email: 'b@example.test' };

	assert.deepEqual(
		resolveLocalAuthTransition({
			previousMode: 'local',
			nextMode: 'local',
			previousUser: alice,
			nextUser: null
		}),
		{
			managedAuth: false,
			modeChanged: false,
			localSessionExpired: true,
			changedIdentity: false
		}
	);
	assert.deepEqual(
		resolveLocalAuthTransition({
			previousMode: 'local',
			nextMode: 'local',
			previousUser: alice,
			nextUser: bob
		}),
		{
			managedAuth: false,
			modeChanged: false,
			localSessionExpired: false,
			changedIdentity: true
		}
	);
	assert.deepEqual(
		resolveLocalAuthTransition({
			previousMode: 'oidc',
			nextMode: 'oidc',
			previousUser: alice,
			nextUser: null
		}),
		{
			managedAuth: true,
			modeChanged: false,
			localSessionExpired: false,
			changedIdentity: true
		}
	);

	const guestSaved = createInitialState();
	guestSaved.pantry = [
		{ id: 'guest-rice', name: 'basmati rice', quantity: 5, unit: 'cups', category: 'Grains' }
	];
	const householdState = createInitialState();
	householdState.pantry = [
		{ id: 'secret-truffle', name: 'black truffle', quantity: 2, unit: 'oz', category: 'Produce' }
	];
	const storage = memoryStorage(
		new Map([['flavorithm-guest-kitchen', JSON.stringify(guestSaved)]])
	);
	const seededDuringExpiry = resolveRegistrationGuestSeed(storage, householdState, {
		sessionExpired: true,
		user: alice
	});
	assert.deepEqual(seededDuringExpiry.pantry, guestSaved.pantry);
	assert.equal(
		seededDuringExpiry.pantry.some((item) => item.id === 'secret-truffle'),
		false
	);
});

test('clearGuestKitchen and clearGuestData remove only guest keys and tolerate storage errors', () => {
	const values = new Map([
		['flavorithm-guest-kitchen', '{"pantry":["eggs"]}'],
		['flavorithm-started', 'yes'],
		['flavorithm-last-account', '{"id":"user-1"}'],
		['flavorithm-legacy-kitchen-backup', '{"legacy":true}']
	]);
	clearGuestKitchen(memoryStorage(values));
	assert.equal(values.has('flavorithm-guest-kitchen'), false);
	assert.equal(values.get('flavorithm-started'), 'yes');

	values.set('flavorithm-guest-kitchen', '{"pantry":["milk"]}');
	clearGuestData(memoryStorage(values));
	assert.equal(values.has('flavorithm-guest-kitchen'), false);
	assert.equal(values.has('flavorithm-started'), false);
	assert.equal(values.get('flavorithm-last-account'), '{"id":"user-1"}');
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), '{"legacy":true}');

	assert.doesNotThrow(() =>
		clearGuestData({
			removeItem: () => {
				throw new Error('Storage restricted');
			}
		})
	);
});

test('sanitizeKitchenState preserves valid states and clamps corrupt guest fields to server bounds', () => {
	const initial = createInitialState();
	assert.equal(JSON.stringify(sanitizeKitchenState(initial)), JSON.stringify(initial));
	const newUser = createNewUserState();
	assert.equal(JSON.stringify(sanitizeKitchenState(newUser)), JSON.stringify(newUser));

	const corrupted = {
		pantry: [
			{
				id: '',
				name: `  ${'o'.repeat(250)}  `,
				quantity: null,
				unit: '',
				category: 'c'.repeat(140),
				expires: ` ${'2026-12-01'.padEnd(80, 'x')} `
			},
			{
				id: 'neg',
				name: 'garlic',
				quantity: -12,
				unit: 'u'.repeat(60),
				category: 'Produce'
			},
			{
				id: 'huge',
				name: 'flour',
				quantity: 9_000_000,
				unit: 'g',
				category: 'Pantry'
			},
			{
				id: 'blank-name',
				name: '   ',
				quantity: 2,
				unit: 'cup',
				category: 'Pantry'
			},
			...Array.from({ length: 1_005 }, (_, i) => ({
				id: `extra-${i}`,
				name: `item-${i}`,
				quantity: 1,
				unit: 'piece',
				category: 'Pantry'
			}))
		],
		recipes: Array.from({ length: 260 }, (_, i) => ({
			id: `recipe-${i}`,
			title: i === 0 ? '   ' : `Recipe ${i}`,
			description: 'd'.repeat(12_000),
			image: i === 0 ? 'http://insecure.example.com/photo.jpg' : 'https://example.com/photo.jpg',
			time: i === 0 ? -15 : 500_000,
			servings: i === 0 ? 0 : 99_999,
			difficulty: 'e'.repeat(120),
			cuisine: 'f'.repeat(140),
			tags: Array.from({ length: 120 }, () => 't'.repeat(130)),
			ingredients: [
				{ name: '   ', quantity: 2, unit: 'cup' },
				{ name: 'n'.repeat(240), quantity: -4, unit: 'u'.repeat(60) },
				{ name: 'salt', quantity: 5_000_000, unit: 'g' }
			],
			steps: Array.from({ length: 210 }, () => 's'.repeat(10_500)),
			nutrition: {
				calories: null,
				fat: -5,
				saturatedFat: Number.NaN,
				sodium: 8_000_000,
				carbs: 40,
				fiber: Number.POSITIVE_INFINITY,
				sugar: -1,
				protein: 25
			},
			source: 'https://user:secret@example.com/private',
			importNotes: ['  ', 'a'.repeat(400)],
			rating: 9,
			saved: true
		})),
		meals: Array.from({ length: 1_010 }, (_, i) => ({
			id: `meal-${i}`,
			date: '2026-11-22'.padEnd(70, 'x'),
			slot: 'Dinner'.padEnd(130, 'x'),
			recipeId: 'recipe-0',
			servings: i === 0 ? null : 50_000,
			leftoverServings: i === 0 ? -3 : 40_000
		})),
		shopping: [
			{ id: 'blank', name: '   ', quantity: 1, unit: 'piece', checked: false },
			{
				id: 'milk',
				name: 'm'.repeat(240),
				quantity: null,
				unit: '',
				checked: 1,
				sourceKey: 'k'.repeat(250)
			},
			...Array.from({ length: 1_005 }, (_, i) => ({
				id: `shop-${i}`,
				name: `shop-${i}`,
				quantity: 2_000_000,
				unit: 'piece',
				checked: false
			}))
		],
		preferences: {
			diet: 'd'.repeat(250),
			allergies: 'a'.repeat(2_500),
			maxTime: Number.NaN,
			complexity: 'c'.repeat(130),
			cuisines: [
				'  ',
				'Italian',
				...Array.from({ length: 10 }, (_, i) => `c-${i}-${'x'.repeat(90)}`)
			],
			onboardingStatus: 'unknown',
			theme: '',
			dark: 'yes',
			provider: 'p'.repeat(130),
			model: 'm'.repeat(250),
			reasoning: {
				effort: 'INVALID EFFORT!',
				enabled: true,
				budgetTokens: 99_999.7
			},
			ratings: {
				'': 4,
				'recipe-0': 8,
				'recipe-1': -2,
				'recipe-2': null
			}
		}
	};

	const sanitized = sanitizeKitchenState(corrupted);
	assert.equal(sanitized.pantry.length, 1_000);
	assert.equal(sanitized.pantry[0].name.length, 200);
	assert.equal(sanitized.pantry[0].quantity, 0);
	assert.equal(sanitized.pantry[0].unit, 'piece');
	assert.equal(sanitized.pantry[1].quantity, 0);
	assert.equal(sanitized.pantry[1].unit.length, 40);
	assert.equal(sanitized.pantry[2].quantity, 1_000_000);
	assert.equal(sanitized.recipes.length, 250);
	assert.equal(sanitized.recipes[0].title, 'Untitled recipe');
	assert.equal(sanitized.recipes[0].image, '');
	assert.equal(sanitized.recipes[0].time, 0);
	assert.equal(sanitized.recipes[0].servings, 1);
	assert.equal(sanitized.recipes[0].nutrition.calories, 0);
	assert.equal(sanitized.recipes[0].nutrition.fat, 0);
	assert.equal(sanitized.recipes[0].nutrition.sodium, 1_000_000);
	assert.equal(sanitized.recipes[0].source, undefined);
	assert.equal(sanitized.recipes[0].rating, 5);
	assert.equal(sanitized.meals.length, 1_000);
	assert.equal(sanitized.meals[0].servings, 2);
	assert.equal(sanitized.meals[0].leftoverServings, 0);
	assert.equal(sanitized.meals[1].servings, 10_000);
	assert.equal(sanitized.meals[1].leftoverServings, 10_000);
	assert.equal(sanitized.shopping.length, 1_000);
	assert.equal(sanitized.shopping[0].quantity, 0);
	assert.equal(sanitized.shopping[0].unit, 'piece');
	assert.equal(sanitized.shopping[1].quantity, 1_000_000);
	assert.equal(sanitized.preferences.maxTime, 45);
	assert.equal(sanitized.preferences.cuisines?.length, 8);
	assert.equal(sanitized.preferences.reasoning?.effort, undefined);
	assert.equal(sanitized.preferences.reasoning?.budgetTokens, 32_768);
	assert.deepEqual(sanitized.preferences.ratings, { 'recipe-0': 5, 'recipe-1': 0 });

	const validated = validateAppState(sanitized);
	assert.ok(validated, 'validateAppState should accept any state produced by sanitizeKitchenState');
});

test('signup migration sanitizes guest state for immediate sync and retains journal offline', async () => {
	const user: User = {
		id: 'new-user',
		householdId: 'new-home',
		name: 'Ada Lovelace',
		email: 'ada@example.test'
	};
	const dirtyGuest = structuredClone(createInitialState()) as AppState;
	dirtyGuest.pantry[0].quantity = null as unknown as number;
	dirtyGuest.pantry.push({
		id: 'oversized-sugar',
		name: 'sugar',
		quantity: 5_000_000,
		unit: 'g',
		category: 'Baking'
	});
	dirtyGuest.shopping.push({
		id: 'neg-milk',
		name: 'milk',
		quantity: -2,
		unit: 'l',
		checked: false
	});

	let serverState = createNewUserState();
	let serverEtag = 'v1';
	let online = false;
	let currentState = structuredClone(dirtyGuest);
	let syncError = '';
	const storageValues = new Map<string, string>();
	const storage = memoryStorage(storageValues);

	const syncController = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: (status) => {
			syncError = status.error;
		},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				if (!online) throw new Error('Offline');
				return {
					state: structuredClone(serverState),
					etag: serverEtag,
					userId: user.id,
					householdId: user.householdId
				};
			},
			put: async (candidate, ifMatch) => {
				if (!online) throw new Error('Offline');
				const validated = validateAppState(candidate);
				if (!validated) {
					throw Object.assign(new Error('State data is invalid or too large'), { status: 400 });
				}
				if (ifMatch && ifMatch !== serverEtag) {
					throw Object.assign(new Error('Precondition failed'), { status: 412 });
				}
				serverState = structuredClone(validated);
				serverEtag = 'v2';
				return { state: structuredClone(serverState), etag: serverEtag };
			}
		})
	});

	const offlineMigration = await migrateGuestKitchenOnSignup({
		guestState: dirtyGuest,
		loadInitialState: async () => {
			throw new Error('Offline during signup');
		},
		adoptBaseline: (baseline, etag) => {
			syncController.initialize(user, baseline, etag);
		},
		stage: (next) => {
			currentState = structuredClone(next);
			syncController.stage(next);
		},
		sync: () => syncController.sync(),
		hasPendingFailure: () => Boolean(syncError || syncController.snapshot())
	});

	assert.equal(offlineMigration.synced, false);
	assert.equal(offlineMigration.state.pantry[0].quantity, 0);
	assert.equal(
		offlineMigration.state.pantry.find((item) => item.id === 'oversized-sugar')?.quantity,
		1_000_000
	);
	assert.equal(offlineMigration.state.shopping[0].quantity, 0);
	assert.ok(syncController.snapshot(), 'sanitized guest edits remain queued in the local journal');
	assert.ok(
		[...storageValues.keys()].some((key) => key.startsWith('flavorithm-pending-journal:')),
		'pending journal entry is persisted to storage'
	);

	// Reconnect and verify the queued sanitized guest kitchen uploads without HTTP 400.
	online = true;
	syncController.initialize(user, serverState, serverEtag);
	await syncController.sync();
	assert.equal(syncError, '');
	assert.equal(syncController.snapshot(), null);
	assert.equal(
		serverState.pantry.find((item) => item.id === 'oversized-sugar')?.quantity,
		1_000_000
	);
	assert.equal(serverState.pantry[0].quantity, 0);

	// Also verify direct online signup migration succeeds immediately.
	const onlineStorage = memoryStorage(new Map());
	let onlineServerState = createNewUserState();
	let onlineError = '';
	const onlineSync = createKitchenSync({
		storage: onlineStorage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: (status) => {
			onlineError = status.error;
		},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(onlineServerState),
				etag: 'v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (candidate) => {
				const validated = validateAppState(candidate);
				if (!validated) {
					throw Object.assign(new Error('State data is invalid or too large'), { status: 400 });
				}
				onlineServerState = structuredClone(validated);
				return { state: structuredClone(onlineServerState), etag: 'v2' };
			}
		})
	});

	const onlineMigration = await migrateGuestKitchenOnSignup({
		guestState: dirtyGuest,
		loadInitialState: async () => ({ state: onlineServerState, etag: 'v1' }),
		adoptBaseline: (baseline, etag) => onlineSync.initialize(user, baseline, etag),
		stage: (next) => onlineSync.stage(next),
		sync: () => onlineSync.sync(),
		hasPendingFailure: () => Boolean(onlineError || onlineSync.snapshot())
	});
	assert.equal(onlineMigration.synced, true);
	assert.equal(onlineSync.snapshot(), null);
	assert.equal(
		onlineServerState.pantry.find((item) => item.id === 'oversized-sugar')?.quantity,
		1_000_000
	);
});

test('signup preparation sanitizes guest state while preserving sample flags for selective cleanup', async () => {
	const guest = createInitialState();
	guest.pantry = guest.pantry.map((item) =>
		item.id === 'pantry-eggs' ? promoteSampleIngredient({ ...item, quantity: 6 }) : item
	);
	guest.pantry.push({
		id: 'oversized-oats',
		name: '  rolled oats  ',
		quantity: 5_000_000,
		unit: 'g',
		category: 'Grains'
	});

	const sanitizedBeforeCleanup = sanitizeKitchenState(guest);
	assert.equal(hasSampleData(sanitizedBeforeCleanup), true);
	const prepared = clearSampleData(sanitizedBeforeCleanup);
	assert.equal(hasSampleData(prepared), false);

	let syncedState = createNewUserState();
	const migrated = await migrateGuestKitchenOnSignup({
		guestState: prepared,
		loadInitialState: async () => ({ state: syncedState, etag: 'v1' }),
		adoptBaseline: () => {},
		stage: (next) => {
			syncedState = next;
		},
		sync: async () => {},
		hasPendingFailure: () => false
	});

	assert.equal(migrated.synced, true);
	assert.ok(validateAppState(syncedState));
	assert.deepEqual(
		syncedState.pantry.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity })),
		[
			{ id: 'pantry-eggs', name: 'eggs', quantity: 6 },
			{ id: 'oversized-oats', name: 'rolled oats', quantity: 1_000_000 }
		]
	);
	assert.deepEqual(syncedState.meals, []);
	assert.ok(syncedState.recipes.every((recipe) => !recipe.saved && !recipe.sampleSaved));
});

test('extracted session-expiry decision helpers distinguish session_expired 401s from provider/unmarked 401s and gate persistence/auto-sync', () => {
	const user: User = {
		id: 'u-expiry',
		name: 'Ada',
		email: 'ada@example.test',
		householdId: 'hh-expiry'
	};

	assert.equal(
		isLocalSessionExpiredResponse({
			status: 401,
			managedAuth: false,
			user,
			data: { error: 'Authentication required', code: SESSION_EXPIRED_CODE }
		}),
		true
	);
	assert.equal(
		isLocalSessionExpiredResponse({
			status: 401,
			managedAuth: false,
			user,
			data: { error: 'Connect a ChatGPT account before using your plan.' }
		}),
		false
	);
	assert.equal(
		isLocalSessionExpiredResponse({
			status: 409,
			managedAuth: false,
			user,
			data: { error: 'Connect a ChatGPT account before using your plan.', code: 'provider_auth' }
		}),
		false
	);
	assert.equal(
		isLocalSessionExpiredResponse({
			status: 401,
			managedAuth: true,
			user,
			data: { error: 'Authentication required', code: SESSION_EXPIRED_CODE }
		}),
		false
	);
	assert.equal(
		isLocalSessionExpiredResponse({
			status: 401,
			managedAuth: false,
			user: null,
			data: { error: 'Authentication required', code: SESSION_EXPIRED_CODE }
		}),
		false
	);

	assert.equal(
		shouldPersistGuestKitchen({
			managedAuth: false,
			user: null,
			sessionExpired: false,
			guestPersistenceReady: true
		}),
		true
	);
	assert.equal(
		shouldPersistGuestKitchen({
			managedAuth: false,
			user: null,
			sessionExpired: true,
			guestPersistenceReady: true
		}),
		false
	);
	assert.equal(
		shouldPersistGuestKitchen({
			managedAuth: false,
			user,
			sessionExpired: false,
			guestPersistenceReady: true
		}),
		false
	);

	assert.equal(
		shouldScheduleAutoSync({
			user,
			sessionExpired: false,
			pendingSync: true,
			syncing: false,
			syncErrors: '',
			online: true
		}),
		true
	);
	assert.equal(
		shouldScheduleAutoSync({
			user,
			sessionExpired: true,
			pendingSync: true,
			syncing: false,
			syncErrors: '',
			online: true
		}),
		false
	);
});

test('kitchenSync.restore always returns true when pending journal records exist even without a confirmed baseline', () => {
	const user: User = {
		id: 'u-journal-only',
		name: 'Grace',
		email: 'grace@example.test',
		householdId: 'hh-journal-only'
	};
	const values = new Map<string, string>();
	const storage = memoryStorage(values);
	const base = createNewUserState();
	const local = createNewUserState();
	local.pantry = [
		{ id: 'journal-lentils', name: 'red lentils', quantity: 2, unit: 'bags', category: 'Grains' }
	];
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		writerId: 'writer-1',
		base,
		local,
		etag: null,
		createdAt: 100,
		updatedAt: 200,
		writeId: 'write-1'
	});

	let restoredState = createNewUserState();
	const sync = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => restoredState,
		setState: (next) => {
			restoredState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: createNewUserState(),
				etag: 'v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (candidate) => ({ state: candidate, etag: 'v2' })
		})
	});

	assert.equal(sync.restore(user), true);
	assert.deepEqual(restoredState.pantry, local.pantry);
});
