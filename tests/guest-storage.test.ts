import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenSync } from '../src/lib/client-sync.ts';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import {
	migrateGuestKitchenOnSignup,
	quarantineLegacyKitchen,
	sanitizeKitchenState
} from '../src/lib/guest-storage.ts';
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

test('sanitizeKitchenState preserves manual recipe provenance alongside web-import and ai-generated', () => {
	const state = structuredClone(createInitialState()) as AppState;
	state.recipes = [
		{ ...state.recipes[0], id: 'manual-1', provenance: 'manual', saved: true },
		{ ...state.recipes[0], id: 'web-1', provenance: 'web-import', saved: true },
		{ ...state.recipes[0], id: 'ai-1', provenance: 'ai-generated', saved: true }
	];
	const sanitized = sanitizeKitchenState(state);
	assert.deepEqual(
		sanitized.recipes.map((recipe) => recipe.provenance),
		['manual', 'web-import', 'ai-generated']
	);
	assert.ok(validateAppState(sanitized));
});
