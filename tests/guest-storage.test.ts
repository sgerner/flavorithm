import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, defaultPreferences } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import { writePendingJournal } from '../src/lib/offline-sync.ts';
import {
	clearAccountStorage,
	quarantineLegacyKitchen,
	readCachedAccount,
	resolveLocalAuthTransition,
	resolveRegistrationGuestSeed,
	restoreExpiredSessionAccount,
	restoreGuestKitchen,
	teardownToGuestKitchen
} from '../src/lib/guest-storage.ts';
import type { AppState, User } from '../src/lib/types.ts';

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
