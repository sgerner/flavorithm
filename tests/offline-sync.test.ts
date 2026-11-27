import test from 'node:test';
import assert from 'node:assert/strict';
import { createKitchenSync } from '../src/lib/client-sync.ts';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import {
	completeMeal,
	reconcileShoppingList,
	transferPurchasedItemsToPantry
} from '../src/lib/kitchen-workflows.ts';
import {
	clearPendingJournalRecords,
	isKitchenState,
	MAX_QUARANTINED_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	readQuarantinedJournal,
	syncPendingKitchenJournal,
	type PendingJournalRecord,
	writePending,
	writePendingJournal
} from '../src/lib/offline-sync.ts';
import { validateKitchenState } from '../src/lib/state-schema.ts';

test('offline snapshots are isolated by both account and household', () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
	const user = { id: 'a', householdId: 'home', name: 'A', email: 'a@example.test' };
	const base = createNewUserState();
	writePending(storage, {
		userId: user.id,
		householdId: user.householdId,
		base,
		local: base,
		etag: 'v1',
		updatedAt: 1
	});
	const journal = readPendingJournal(storage, user);
	assert.equal(journal.records.length, 1);
	assert.equal(journal.error, '');
	assert.equal(readPendingJournal(storage, { ...user, id: 'b' }).records.length, 0);
	assert.equal(readPendingJournal(storage, { ...user, householdId: 'other' }).records.length, 0);
	clearPendingJournalRecords(storage, user, journal.records);
	assert.equal(readPendingJournal(storage, user).records.length, 0);
});

test('three-way merge preserves independent edits, additions and deletions', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.recipes[0].title = 'My title';
	remote.recipes[0].description = 'Household description';
	local.pantry.push({ id: 'local', name: 'rice', quantity: 1, unit: 'cup', category: 'Pantry' });
	remote.pantry.push({ id: 'remote', name: 'beans', quantity: 2, unit: 'can', category: 'Pantry' });
	remote.recipes.splice(1, 1);
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.state.recipes[0].title, 'My title');
	assert.equal(result.state.recipes[0].description, 'Household description');
	assert.equal(result.state.pantry.length, 2);
	assert.equal(result.state.recipes.length, base.recipes.length - 1);
	assert.equal(base.pantry.length, 0);
});

test('competing edits and delete-versus-edit require an explicit choice', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	remote.preferences.maxTime = 60;
	remote.recipes.shift();
	local.recipes[0].title = 'Keep this recipe';
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.conflicts.length, 2);
	assert.equal(mergeKitchenStates(base, local, remote, 'local').state.preferences.maxTime, 20);
	assert.equal(
		mergeKitchenStates(base, local, remote, 'local').state.recipes.find(
			(recipe) => recipe.id === base.recipes[0].id
		)?.title,
		'Keep this recipe'
	);
	assert.equal(
		mergeKitchenStates(base, local, remote, 'remote').state.recipes.length,
		remote.recipes.length
	);
});

test('concurrent recipe deletion and meal addition never creates orphaned plans', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.meals.push({
		id: 'meal',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 2
	});
	remote.recipes.shift();
	const pending = mergeKitchenStates(base, local, remote);
	assert.ok(pending.conflicts.length);
	assert.equal(pending.state.meals[0]?.id, 'meal');
	assert.ok(pending.state.recipes.some((recipe) => recipe.id === pending.state.meals[0].recipeId));
	const resolved = mergeKitchenStates(base, local, remote, 'local').state;
	assert.ok(resolved.recipes.some((recipe) => recipe.id === resolved.meals[0].recipeId));
	assert.equal(mergeKitchenStates(base, local, remote, 'remote').state.meals.length, 0);
	const conflict = mergeKitchenStates(base, local, remote).conflicts.find((item) =>
		item.path.endsWith('.recipeId')
	);
	assert.equal(conflict?.local, `Meal planned; recipe available: ${base.recipes[0].title}`);
	assert.equal(conflict?.remote, 'Meal not planned; recipe removed');

	const oppositeLocal = structuredClone(base),
		oppositeRemote = structuredClone(base);
	oppositeLocal.recipes.shift();
	oppositeRemote.meals.push({
		id: 'remote-meal',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 2
	});
	const oppositeConflict = mergeKitchenStates(base, oppositeLocal, oppositeRemote).conflicts.find(
		(item) => item.path.endsWith('.recipeId')
	);
	assert.equal(oppositeConflict?.local, 'Meal not planned; recipe removed');
	assert.equal(
		oppositeConflict?.remote,
		`Meal planned; recipe available: ${base.recipes[0].title}`
	);
});

test('distinct completed meals sum pantry deductions, while manual equal edits conflict and retries stay idempotent', async () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'flour', quantity: 1, unit: 'cup' }];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 2, unit: 'cup', category: 'Pantry' }];
	base.meals = [
		{ id: 'meal-one', date: '2026-10-22', slot: 'Dinner', recipeId: recipe.id, servings: 2 },
		{ id: 'meal-two', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];
	const local = completeMeal(
		structuredClone(base),
		'meal-one',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00.000Z')
	);
	const remote = completeMeal(
		structuredClone(base),
		'meal-two',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-23T18:00:00.000Z')
	);
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.state.pantry[0].quantity, 0);
	assert.deepEqual(
		result.state.meals
			.filter((meal) => meal.completedAt)
			.map((meal) => meal.id)
			.sort(),
		['meal-one', 'meal-two']
	);
	let savedMealsSync = 0;
	const syncedMeals = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'home', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({ state: remote, etag: 'current', userId: 'a', householdId: 'home' }),
			put: async (state) => {
				savedMealsSync += 1;
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(syncedMeals.saved, true);
	assert.equal(savedMealsSync, 1);
	assert.equal(syncedMeals.state.pantry[0].quantity, 0);

	const manualLocal = structuredClone(base);
	manualLocal.pantry[0].quantity = 1;
	manualLocal.preferences.maxTime = 25;
	const manualRemote = structuredClone(base);
	manualRemote.pantry[0].quantity = 1;
	manualRemote.preferences.allergies = 'sesame';
	let writes = 0;
	const blocked = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: {
					userId: 'a',
					householdId: 'home',
					base,
					local: manualLocal,
					etag: 'old',
					updatedAt: 0
				},
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({
				state: manualRemote,
				etag: 'current',
				userId: 'a',
				householdId: 'home'
			}),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(blocked.saved, false);
	assert.equal(writes, 0);
	assert.ok(blocked.conflicts.some((item) => item.path === 'kitchen.pantry[flour].quantity'));

	const identicalRetry = mergeKitchenStates(base, local, structuredClone(local));
	assert.equal(identicalRetry.conflicts.length, 0);
	assert.equal(identicalRetry.state.pantry[0].quantity, 1);
});

test('merging a checked weekly purchase with a refreshed meal plan keeps the purchase and adds an unchecked shortage row', () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'olive oil', quantity: 1, unit: 'cup' }];
	base.meals = [
		{ id: 'tue-dinner', date: '2026-10-20', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];
	base.shopping = reconcileShoppingList(
		[],
		buildShoppingList([recipe], base.pantry, base.meals),
		'week:2026-10-19'
	);

	const local = structuredClone(base);
	local.shopping[0].checked = true;

	const remote = structuredClone(base);
	remote.meals[0].servings = 6;
	remote.shopping = reconcileShoppingList(
		remote.shopping,
		buildShoppingList([recipe], remote.pantry, remote.meals),
		'week:2026-10-19'
	);
	assert.equal(remote.shopping[0].id, local.shopping[0].id);
	assert.equal(remote.shopping[0].quantity, 3);

	const merged = mergeKitchenStates(base, local, remote);
	assert.equal(merged.conflicts.length, 0);
	const checkedRows = merged.state.shopping.filter((item) => item.checked);
	const uncheckedRows = merged.state.shopping.filter((item) => !item.checked);
	assert.equal(checkedRows.length, 1);
	assert.equal(checkedRows[0].quantity, 1);
	assert.equal(checkedRows[0].sourceKey, 'week:2026-10-19');
	assert.equal(uncheckedRows.length, 1);
	assert.equal(uncheckedRows[0].quantity, 2);
	assert.equal(uncheckedRows[0].sourceKey, 'week:2026-10-19');
	assert.notEqual(checkedRows[0].id, uncheckedRows[0].id);

	const transferredPantry = transferPurchasedItemsToPantry(
		merged.state.pantry,
		merged.state.shopping,
		() => 'oil-lot'
	);
	assert.equal(transferredPantry.length, 1);
	assert.equal(transferredPantry[0].quantity, 1);

	const cancelledRemote = structuredClone(base);
	cancelledRemote.meals = [];
	cancelledRemote.shopping = reconcileShoppingList(cancelledRemote.shopping, [], 'week:2026-10-19');
	const mergedWithRemovedPlan = mergeKitchenStates(base, local, cancelledRemote);
	assert.equal(mergedWithRemovedPlan.conflicts.length, 0);
	assert.equal(mergedWithRemovedPlan.state.shopping.length, 1);
	assert.equal(mergedWithRemovedPlan.state.shopping[0].checked, true);
	assert.equal(mergedWithRemovedPlan.state.shopping[0].quantity, 1);
});

test('incompatible edits to manual or recipe shopping items surface one item conflict', () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'rice', quantity: 1, unit: 'cup' }];
	const recipeRows = reconcileShoppingList(
		[],
		buildShoppingList([recipe], [], undefined),
		`recipe:${recipe.id}`
	);
	base.shopping = [
		{ id: 'manual-milk', name: 'milk', quantity: 1, unit: 'l', checked: false },
		...recipeRows
	];

	const local = structuredClone(base);
	local.shopping[0].checked = true;
	local.shopping[1].checked = true;

	const remote = structuredClone(base);
	remote.shopping[0].quantity = 500;
	remote.shopping[0].unit = 'ml';
	remote.shopping = reconcileShoppingList(
		remote.shopping,
		[{ id: 'next-rice', name: 'rice', quantity: 2, unit: 'cup', checked: false }],
		`recipe:${recipe.id}`
	);

	const merged = mergeKitchenStates(base, local, remote);
	assert.deepEqual(
		merged.conflicts.map((item) => item.path),
		['kitchen.shopping[manual-milk]', `kitchen.shopping[${recipeRows[0].id}]`]
	);
});

test('concurrent meal completion and rescheduling raises one meal conflict, clamps leftovers, and aligns pantry stock', () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 4;
	recipe.ingredients = [{ name: 'flour', quantity: 2, unit: 'cup' }];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 2, unit: 'cup', category: 'Pantry' }];
	base.meals = [
		{ id: 'meal-target', date: '2026-10-22', slot: 'Dinner', recipeId: recipe.id, servings: 4 }
	];

	const local = completeMeal(
		structuredClone(base),
		'meal-target',
		{ deductPantry: true, leftoverServings: 3 },
		new Date('2026-10-22T18:30:00.000Z')
	);
	const remote = structuredClone(base);
	remote.meals[0].date = '2026-10-29';
	remote.meals[0].servings = 2;

	const preview = mergeKitchenStates(base, local, remote);
	assert.equal(preview.conflicts.length, 1);
	assert.equal(preview.conflicts[0].path, 'kitchen.meals[meal-target]');
	assert.equal(preview.state.meals[0].completedAt, undefined);
	assert.equal(preview.state.meals[0].date, '2026-10-29');
	assert.equal(preview.state.meals[0].leftoverServings, undefined);
	assert.equal(preview.state.pantry[0].quantity, 2);

	const resolvedLocal = mergeKitchenStates(base, local, remote, 'local');
	assert.equal(resolvedLocal.state.meals[0].date, '2026-10-22');
	assert.ok(resolvedLocal.state.meals[0].completedAt);
	assert.equal(resolvedLocal.state.meals[0].leftoverServings, 3);
	assert.equal(resolvedLocal.state.pantry[0].quantity, 0);

	const resolvedRemote = mergeKitchenStates(base, local, remote, 'remote');
	assert.equal(resolvedRemote.state.meals[0].date, '2026-10-29');
	assert.equal(resolvedRemote.state.meals[0].completedAt, undefined);
	assert.equal(resolvedRemote.state.pantry[0].quantity, 2);

	const rejectedRemoteCompletion = mergeKitchenStates(base, remote, local, 'local');
	assert.equal(rejectedRemoteCompletion.state.meals[0].date, '2026-10-29');
	assert.equal(rejectedRemoteCompletion.state.meals[0].completedAt, undefined);
	assert.equal(rejectedRemoteCompletion.state.pantry[0].quantity, 2);

	const oversizedLeftovers = structuredClone(local);
	oversizedLeftovers.meals[0].servings = 2;
	oversizedLeftovers.meals[0].leftoverServings = 9;
	const clamped = mergeKitchenStates(base, oversizedLeftovers, base);
	assert.equal(clamped.state.meals[0].leftoverServings, 2);
});

test('post-merge weekly reconciliation updates shortages after distinct meal deductions while subtracting checked purchases', () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'flour', quantity: 1, unit: 'cup' }];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 2, unit: 'cup', category: 'Pantry' }];
	base.meals = [
		{ id: 'prev-a', date: '2026-10-15', slot: 'Dinner', recipeId: recipe.id, servings: 2 },
		{ id: 'prev-b', date: '2026-10-16', slot: 'Dinner', recipeId: recipe.id, servings: 2 },
		{ id: 'next-week', date: '2026-10-22', slot: 'Dinner', recipeId: recipe.id, servings: 5 }
	];
	const nextWeekMeals = base.meals.filter((meal) => meal.id === 'next-week');
	base.shopping = [
		{
			id: 'bought-flour',
			name: 'flour',
			quantity: 0.25,
			unit: 'cup',
			checked: true,
			sourceKey: 'week:2026-10-19'
		},
		...reconcileShoppingList(
			[
				{
					id: 'bought-flour',
					name: 'flour',
					quantity: 0.25,
					unit: 'cup',
					checked: true,
					sourceKey: 'week:2026-10-19'
				}
			],
			buildShoppingList([recipe], base.pantry, nextWeekMeals),
			'week:2026-10-19'
		).filter((item) => !item.checked)
	];
	assert.equal(base.shopping.find((item) => !item.checked)?.quantity, 0.25);

	const local = completeMeal(
		structuredClone(base),
		'prev-a',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-15T18:00:00.000Z')
	);
	const remote = completeMeal(
		structuredClone(base),
		'prev-b',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-16T18:00:00.000Z')
	);

	const merged = mergeKitchenStates(base, local, remote);
	assert.equal(merged.conflicts.length, 0);
	assert.equal(merged.state.pantry[0].quantity, 0);
	const checked = merged.state.shopping.find((item) => item.checked);
	const shortage = merged.state.shopping.find((item) => !item.checked);
	assert.equal(checked?.quantity, 0.25);
	assert.equal(shortage?.quantity, 2.25);
	assert.equal(shortage?.sourceKey, 'week:2026-10-19');

	const sharedBase = createNewUserState();
	sharedBase.recipes[0].servings = 2;
	sharedBase.recipes[0].ingredients = [{ name: 'flour', quantity: 1, unit: 'cup' }];
	sharedBase.pantry = [
		{ id: 'flour', name: 'flour', quantity: 1, unit: 'cup', category: 'Pantry' }
	];
	sharedBase.meals = [
		{
			id: 'tonight',
			date: '2026-10-15',
			slot: 'Dinner',
			recipeId: sharedBase.recipes[0].id,
			servings: 2
		}
	];
	const plannedBranch = structuredClone(sharedBase);
	plannedBranch.meals.push({
		id: 'planned-thu',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: sharedBase.recipes[0].id,
		servings: 2
	});
	plannedBranch.shopping = reconcileShoppingList(
		[],
		buildShoppingList(
			[sharedBase.recipes[0]],
			plannedBranch.pantry,
			plannedBranch.meals.filter((meal) => meal.id === 'planned-thu')
		),
		'week:2026-10-19'
	);
	assert.equal(plannedBranch.shopping.length, 0);
	const cookedBranch = completeMeal(
		structuredClone(sharedBase),
		'tonight',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-15T18:00:00.000Z')
	);
	const combined = mergeKitchenStates(sharedBase, plannedBranch, cookedBranch);
	assert.equal(combined.conflicts.length, 0);
	assert.equal(combined.state.pantry[0].quantity, 0);
	assert.equal(combined.state.shopping.length, 1);
	assert.equal(combined.state.shopping[0].quantity, 1);
	assert.equal(combined.state.shopping[0].sourceKey, 'week:2026-10-19');
});

test('sync retries a changing ETag without losing independent remote edits', async () => {
	const base = createNewUserState(),
		local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	let writes = 0;
	const result = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'h', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'h' },
			get: async () => ({ state: remote, etag: `v${writes}`, userId: 'a', householdId: 'h' }),
			put: async (state, etag) => {
				assert.equal(etag, `v${writes}`);
				writes += 1;
				if (writes === 1) {
					remote.preferences.allergies = 'peanuts';
					throw Object.assign(new Error('Changed'), { status: 412 });
				}
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(result.state.preferences.maxTime, 20);
	assert.equal(result.state.preferences.allergies, 'peanuts');
	assert.equal(writes, 2);
});

test('sync never writes unresolved conflicts', async () => {
	const base = createNewUserState(),
		local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	remote.preferences.maxTime = 60;
	let writes = 0;
	const result = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'h', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'h' },
			get: async () => ({ state: remote, etag: 'new', userId: 'a', householdId: 'h' }),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(result.saved, false);
	assert.equal(writes, 0);
	assert.equal(result.conflicts.length, 1);
});

test('sync rejects pending snapshots from another account or household before any request', async () => {
	const base = createNewUserState();
	let reads = 0;
	let writes = 0;
	const transport = {
		identity: { userId: 'b', householdId: 'new-home' },
		get: async () => {
			reads += 1;
			return {
				state: base,
				etag: 'current',
				userId: 'b',
				householdId: 'new-home'
			};
		},
		put: async (state: typeof base) => {
			writes += 1;
			return { state, etag: 'saved' };
		}
	};
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'old-home',
							base,
							local: base,
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				transport
			),
		{ status: 409 }
	);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
});

test('sync rejects a GET response for another identity before writing', async () => {
	const base = createNewUserState();
	let writes = 0;
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'home',
							base,
							local: structuredClone(base),
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				{
					identity: { userId: 'a', householdId: 'home' },
					get: async () => ({
						state: base,
						etag: 'current',
						userId: 'a',
						householdId: 'other-home'
					}),
					put: async (state) => {
						writes += 1;
						return { state, etag: 'saved' };
					}
				}
			),
		{ status: 409 }
	);
	assert.equal(writes, 0);
});

test('sync rechecks its identity after GET before PUT', async () => {
	const base = createNewUserState();
	const identity = { userId: 'a', householdId: 'home' };
	let writes = 0;
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'home',
							base,
							local: structuredClone(base),
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				{
					identity,
					get: async () => {
						identity.userId = 'b';
						return {
							state: base,
							etag: 'current',
							userId: 'a',
							householdId: 'home'
						};
					},
					put: async (state) => {
						writes += 1;
						return { state, etag: 'saved' };
					}
				}
			),
		{ status: 409 }
	);
	assert.equal(writes, 0);
});

test('readPendingJournal quarantines unreadable or invalid slots under isolated keys and keeps valid edits', () => {
	const values = new Map<string, string>();
	const storage = {
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
	const userA = { id: 'user:a', householdId: 'home:a', name: 'A', email: 'a@example.test' };
	const userOtherHome = { ...userA, householdId: 'home:b' };
	const base = createNewUserState();
	const validLocal = structuredClone(base);
	validLocal.pantry.push({
		id: 'olive-oil',
		name: 'olive oil',
		quantity: 1,
		unit: 'bottle',
		category: 'Pantry'
	});
	writePendingJournal(storage, {
		userId: userA.id,
		householdId: userA.householdId,
		base,
		local: validLocal,
		etag: 'v1',
		createdAt: 10,
		updatedAt: 20,
		writerId: 'tab-valid',
		writeId: 'w1'
	});
	writePendingJournal(storage, {
		userId: userOtherHome.id,
		householdId: userOtherHome.householdId,
		base,
		local: validLocal,
		etag: 'v1',
		createdAt: 10,
		updatedAt: 20,
		writerId: 'tab-other-home',
		writeId: 'w2'
	});

	const prefixA = `flavorithm-pending-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:`;
	const quarantineA = `flavorithm-quarantined-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:`;
	storage.setItem(`${prefixA}tab-corrupt`, '{broken-json');

	const invalidLocal = structuredClone(base);
	(invalidLocal.pantry as unknown[]).push({
		id: 'bad',
		name: 'salt',
		quantity: null,
		unit: 'tsp',
		category: 'Spices'
	});
	storage.setItem(
		`${prefixA}tab-invalid`,
		JSON.stringify({
			userId: userA.id,
			householdId: userA.householdId,
			base,
			local: invalidLocal,
			etag: 'v1',
			updatedAt: 25,
			writerId: 'tab-invalid'
		})
	);
	storage.setItem(
		`${prefixA}tab-mismatch`,
		JSON.stringify({
			userId: userA.id,
			householdId: userA.householdId,
			base,
			local: validLocal,
			etag: 'v1',
			updatedAt: 30,
			writerId: 'different-writer'
		})
	);

	const loaded = readPendingJournal(storage, userA);
	assert.equal(loaded.records.length, 1);
	assert.equal(loaded.records[0].writerId, 'tab-valid');
	assert.match(loaded.error, /quarantined/);
	assert.equal(storage.getItem(`${prefixA}tab-corrupt`), null);
	assert.equal(storage.getItem(`${prefixA}tab-invalid`), null);
	assert.equal(storage.getItem(`${prefixA}tab-mismatch`), null);
	assert.equal(storage.getItem(`${quarantineA}tab-corrupt`), '{broken-json');
	assert.ok(storage.getItem(`${quarantineA}tab-invalid`)?.includes('"quantity":null'));
	assert.ok(storage.getItem(`${quarantineA}tab-mismatch`)?.includes('different-writer'));

	const otherHomeLoaded = readPendingJournal(storage, userOtherHome);
	assert.equal(otherHomeLoaded.records.length, 1);
	assert.equal(otherHomeLoaded.error, '');
	assert.equal(
		[...values.keys()].some((k) =>
			k.startsWith(
				`flavorithm-quarantined-journal:v1:${encodeURIComponent(userOtherHome.id)}:${encodeURIComponent(userOtherHome.householdId)}:`
			)
		),
		false
	);
});

test('isKitchenState shares the server appState schema without drift', async () => {
	process.env.FLAVORITHM_DB_PATH ??= ':memory:';
	const { validateAppState } = await import('../src/lib/server/db.ts');

	const starter = createInitialState();
	starter.recipes[0].sampleSaved = true;
	starter.preferences.usePersonalAI = true;
	assert.equal(isKitchenState(starter), true);
	assert.deepEqual(validateAppState(starter), starter);

	const valid = createNewUserState();
	valid.recipes.push({
		...starter.recipes[0],
		id: 'cover-recipe',
		image: `/api/recipe-covers/${'a'.repeat(64)}`,
		importNotes: ['a'.repeat(300)],
		sampleSaved: false
	});
	valid.pantry.push({
		id: 'sample-pantry',
		name: 'garlic',
		quantity: 3,
		unit: 'clove',
		category: 'Produce',
		sample: true
	});
	valid.shopping.push({
		id: 'sample-shop',
		name: 'lemons',
		quantity: 2,
		unit: 'piece',
		checked: false
	});
	valid.meals.push(
		{
			id: 'sample-meal',
			date: '2026-04-01',
			slot: 'Dinner',
			recipeId: 'cover-recipe',
			servings: 2,
			sample: true
		},
		{
			id: 'completed-meal',
			date: '2026-04-02',
			slot: 'Dinner',
			recipeId: 'cover-recipe',
			servings: 2,
			completedAt: '2026-04-02T18:00:00.000Z',
			pantryDeductions: [{ pantryId: 'sample-pantry', name: 'garlic', quantity: 2, unit: 'clove' }]
		}
	);
	valid.preferences.reasoning = { effort: 'xhigh', enabled: true, budgetTokens: 1024 };
	assert.equal(isKitchenState(valid), true);
	assert.deepEqual(validateAppState(valid), valid);
	assert.deepEqual(validateKitchenState(valid), valid);

	const badDeductionQuantity = structuredClone(valid);
	badDeductionQuantity.meals[1].pantryDeductions = [
		{ pantryId: 'sample-pantry', name: 'garlic', quantity: -1, unit: 'clove' }
	];
	assert.equal(isKitchenState(badDeductionQuantity), false);
	assert.equal(validateAppState(badDeductionQuantity), null);

	const badDeductionId = structuredClone(valid);
	badDeductionId.meals[1].pantryDeductions = [
		{ pantryId: '', name: 'garlic', quantity: 1, unit: 'clove' }
	];
	assert.equal(isKitchenState(badDeductionId), false);
	assert.equal(validateAppState(badDeductionId), null);

	const badCover = structuredClone(valid);
	badCover.recipes[0].image = `/recipe-covers/${'a'.repeat(64)}`;
	assert.equal(isKitchenState(badCover), false);
	assert.equal(validateAppState(badCover), null);

	const badNote = structuredClone(valid);
	badNote.recipes[0].importNotes = ['a'.repeat(301)];
	assert.equal(isKitchenState(badNote), false);
	assert.equal(validateAppState(badNote), null);

	const badEffort = structuredClone(valid);
	badEffort.preferences.reasoning = { effort: 'x-high' };
	assert.equal(isKitchenState(badEffort), false);
	assert.equal(validateAppState(badEffort), null);

	for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const badNumber = structuredClone(valid);
		badNumber.recipes[0].nutrition.calories = nonFinite;
		assert.equal(isKitchenState(badNumber), false);
		assert.equal(validateAppState(badNumber), null);
	}
});

test('quarantine slots bound suffix and payload growth and expose entries for backup recovery', () => {
	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'user-q', householdId: 'home-q', name: 'Q', email: 'q@example.test' };
	const pendingPrefix = `flavorithm-pending-journal:v1:${user.id}:${user.householdId}:`;
	const quarantinePrefix = `flavorithm-quarantined-journal:v1:${user.id}:${user.householdId}:`;

	for (let round = 1; round <= MAX_QUARANTINED_JOURNAL_ENTRIES + 4; round += 1) {
		storage.setItem(`${pendingPrefix}same-slot`, JSON.stringify({ round, broken: true }));
		const loaded = readPendingJournal(storage, user);
		assert.match(loaded.error, /quarantined/);
	}

	const oversizedPayload = `{"corrupt":"${'x'.repeat(300_000)}"}`;
	storage.setItem(`${pendingPrefix}huge-slot`, oversizedPayload);
	readPendingJournal(storage, user);

	const quarantinedKeys = [...values.keys()].filter((entry) => entry.startsWith(quarantinePrefix));
	assert.ok(quarantinedKeys.length <= MAX_QUARANTINED_JOURNAL_ENTRIES);
	for (const keyName of quarantinedKeys) {
		const suffix = keyName.slice(quarantinePrefix.length);
		assert.doesNotMatch(suffix, /:\d{10,}$/);
	}

	const entries = readQuarantinedJournal(storage, user);
	assert.equal(entries.length, quarantinedKeys.length);
	const huge = entries.find((entry) => entry.slot.startsWith('huge-slot'));
	assert.ok(huge);
	assert.equal(huge.raw, oversizedPayload);
	assert.equal(storage.getItem(`${pendingPrefix}huge-slot`), null);
	assert.deepEqual(huge.parsed, JSON.parse(oversizedPayload));
	const parsedEntry = entries.find((entry) => entry.parsed !== undefined);
	assert.ok(parsedEntry);
});

test('legacy stored recipes in journal base or server state heal without blocking valid edits', async () => {
	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'legacy-u', householdId: 'legacy-h', name: 'L', email: 'l@example.test' };
	const legacyBase = createInitialState();
	legacyBase.recipes[0].image = 'http://legacy.example/soup.jpg';
	legacyBase.recipes[0].importNotes = ['n'.repeat(340)];
	(legacyBase.preferences as Record<string, unknown>).connectionId = 'host-chatgpt';
	legacyBase.preferences.reasoning = { effort: 'invalid-legacy' };

	const validLocal = structuredClone(legacyBase);
	validLocal.pantry.push({
		id: 'chickpeas',
		name: 'chickpeas',
		quantity: 2,
		unit: 'can',
		category: 'Pantry'
	});
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base: legacyBase,
		local: validLocal,
		etag: 'v1',
		createdAt: 1,
		updatedAt: 2,
		writerId: 'tab-legacy',
		writeId: 'w-legacy'
	});

	const loaded = readPendingJournal(storage, user);
	assert.equal(loaded.error, '');
	assert.equal(loaded.records.length, 1);
	assert.equal(isKitchenState(loaded.records[0].pending.local), true);

	const remoteWithLegacy = structuredClone(legacyBase);
	remoteWithLegacy.shopping.push({
		id: 'bread',
		name: 'sourdough',
		quantity: 1,
		unit: 'loaf',
		checked: false
	});

	let uploaded: unknown = null;
	const synced = await syncPendingKitchenJournal(loaded.records, {
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: remoteWithLegacy,
			etag: 'v2',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state) => {
			const validated = validateKitchenState(state);
			assert.ok(validated);
			uploaded = validated;
			return { state: validated, etag: 'v3' };
		}
	});
	assert.equal(synced.saved, true);
	assert.ok(uploaded);
	assert.equal(synced.state.recipes[0].image, '');
	assert.equal(synced.state.recipes[0].importNotes?.[0].length, 300);
	assert.equal(
		synced.state.pantry.some((item) => item.id === 'chickpeas'),
		true
	);
	assert.equal(
		synced.state.shopping.some((item) => item.id === 'bread'),
		true
	);
});

test('prefer syncs pin If-Match to reviewedEtag and halt without PUT when GET returns a newer ETag', async () => {
	const base = createNewUserState();
	base.pantry = [
		{ id: 'milk', name: 'milk', quantity: 1, unit: 'carton', category: 'Dairy' },
		{ id: 'eggs', name: 'eggs', quantity: 12, unit: 'piece', category: 'Dairy' }
	];
	const local = structuredClone(base);
	local.pantry[0].quantity = 2;
	local.pantry[1].quantity = 6;
	const remoteAtEtag3 = structuredClone(base);
	remoteAtEtag3.pantry[0].quantity = 4;
	remoteAtEtag3.pantry[1].quantity = 0;

	const record: PendingJournalRecord = {
		writerId: 'tab-1',
		pending: {
			userId: 'a',
			householdId: 'home',
			base,
			local,
			etag: 'etag-1',
			updatedAt: 1,
			writerId: 'tab-1'
		},
		keys: []
	};
	let puts = 0;
	const localChoiceResult = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({
				state: structuredClone(remoteAtEtag3),
				etag: 'etag-3',
				userId: 'a',
				householdId: 'home'
			}),
			put: async (state) => {
				puts += 1;
				return { state, etag: 'etag-4' };
			}
		},
		'local',
		'etag-2'
	);
	assert.equal(puts, 0);
	assert.equal(localChoiceResult.saved, false);
	assert.equal(localChoiceResult.staleEtag, true);
	assert.equal(localChoiceResult.etag, 'etag-3');
	assert.deepEqual(localChoiceResult.conflicts.map((item) => item.path).sort(), [
		'kitchen.pantry[eggs].quantity',
		'kitchen.pantry[milk].quantity'
	]);

	const journalResult = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({
				state: structuredClone(remoteAtEtag3),
				etag: 'etag-3',
				userId: 'a',
				householdId: 'home'
			}),
			put: async (state) => {
				puts += 1;
				return { state, etag: 'etag-4' };
			}
		},
		'remote',
		'etag-2'
	);
	assert.equal(puts, 0);
	assert.equal(journalResult.saved, false);
	assert.equal(journalResult.staleEtag, true);
	assert.equal(journalResult.etag, 'etag-3');
	assert.equal(journalResult.conflicts.length, 2);
});

test('prefer syncs skip 412 retries and recompute conflicts against the latest server state', async () => {
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 20;
	local.preferences.allergies = 'sesame';
	const reviewedRemote = structuredClone(base);
	reviewedRemote.preferences.maxTime = 60;
	const newerRemote = structuredClone(reviewedRemote);
	newerRemote.preferences.allergies = 'peanuts';

	const record: PendingJournalRecord = {
		writerId: 'tab-1',
		pending: {
			userId: 'a',
			householdId: 'home',
			base,
			local,
			etag: 'etag-1',
			updatedAt: 1,
			writerId: 'tab-1'
		},
		keys: []
	};
	let gets = 0;
	const putEtags: string[] = [];
	const result = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => {
				gets += 1;
				return gets === 1
					? {
							state: structuredClone(reviewedRemote),
							etag: 'etag-2',
							userId: 'a',
							householdId: 'home'
						}
					: {
							state: structuredClone(newerRemote),
							etag: 'etag-3',
							userId: 'a',
							householdId: 'home'
						};
			},
			put: async (_state, etag) => {
				putEtags.push(etag);
				throw Object.assign(new Error('Precondition Failed'), { status: 412 });
			}
		},
		'remote',
		'etag-2'
	);
	assert.deepEqual(putEtags, ['etag-2']);
	assert.equal(result.saved, false);
	assert.equal(result.staleEtag, true);
	assert.equal(result.etag, 'etag-3');
	assert.deepEqual(result.conflicts.map((item) => item.path).sort(), [
		'kitchen.preferences.allergies',
		'kitchen.preferences.maxTime'
	]);
});

test('mergePendingKitchenJournal anchors cross-tab conflict remote values to server state and preserves disjoint edits', () => {
	const base = createNewUserState();
	base.preferences.maxTime = 45;
	const tabA = structuredClone(base);
	tabA.preferences.maxTime = 25;
	tabA.pantry.push({ id: 'rice', name: 'rice', quantity: 2, unit: 'cup', category: 'Pantry' });
	const tabB = structuredClone(base);
	tabB.preferences.maxTime = 70;
	tabB.shopping.push({
		id: 'lemons',
		name: 'lemons',
		quantity: 3,
		unit: 'piece',
		checked: false
	});
	const remote = structuredClone(base);
	remote.pantry.push({ id: 'beans', name: 'beans', quantity: 1, unit: 'can', category: 'Pantry' });

	const records: PendingJournalRecord[] = [
		{
			writerId: 'tab-a',
			pending: {
				userId: 'a',
				householdId: 'home',
				base,
				local: tabA,
				etag: 'etag-1',
				createdAt: 1,
				updatedAt: 1,
				writerId: 'tab-a'
			},
			keys: []
		},
		{
			writerId: 'tab-b',
			pending: {
				userId: 'a',
				householdId: 'home',
				base,
				local: tabB,
				etag: 'etag-1',
				createdAt: 2,
				updatedAt: 2,
				writerId: 'tab-b'
			},
			keys: []
		}
	];

	const preview = mergePendingKitchenJournal(records, remote);
	assert.deepEqual(preview.conflicts, [
		{
			path: 'kitchen.preferences.maxTime',
			local: 70,
			remote: 45
		}
	]);
	assert.equal(preview.state.preferences.maxTime, 45);

	const chooseHousehold = mergePendingKitchenJournal(records, remote, 'remote');
	assert.equal(chooseHousehold.state.preferences.maxTime, 45);
	assert.deepEqual(chooseHousehold.state.pantry.map((item) => item.id).sort(), ['beans', 'rice']);
	assert.deepEqual(
		chooseHousehold.state.shopping.map((item) => item.id),
		['lemons']
	);

	const chooseMine = mergePendingKitchenJournal(records, remote, 'local');
	assert.equal(chooseMine.state.preferences.maxTime, 70);
	assert.deepEqual(chooseMine.state.pantry.map((item) => item.id).sort(), ['beans', 'rice']);
	assert.deepEqual(
		chooseMine.state.shopping.map((item) => item.id),
		['lemons']
	);

	const serverChanged = structuredClone(remote);
	serverChanged.preferences.maxTime = 60;
	const tripleConflict = mergePendingKitchenJournal(records, serverChanged);
	assert.deepEqual(tripleConflict.conflicts, [
		{
			path: 'kitchen.preferences.maxTime',
			local: 70,
			remote: 60
		}
	]);
});

test('clamping pantry drift during meal deduction raises a conflict instead of silently disagreeing with stock', async () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'flour', quantity: 1.5, unit: 'cup' }];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 2, unit: 'cup', category: 'Pantry' }];
	base.meals = [
		{ id: 'meal-one', date: '2026-10-22', slot: 'Dinner', recipeId: recipe.id, servings: 2 },
		{ id: 'meal-two', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];

	// 1. Completed meal deducts 1.5 cups locally while household manually reduces flour to 1 cup:
	//    1 - 1.5 = -0.5 clamps to 0, so merge surfaces a pantry quantity conflict.
	const cookedLocal = completeMeal(
		structuredClone(base),
		'meal-one',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00.000Z')
	);
	const reducedRemote = structuredClone(base);
	reducedRemote.pantry[0].quantity = 1;

	const manualDrift = mergeKitchenStates(base, cookedLocal, reducedRemote);
	assert.deepEqual(manualDrift.conflicts, [
		{
			path: 'kitchen.pantry[flour].quantity',
			local: 0.5,
			remote: 1
		}
	]);
	assert.equal(manualDrift.state.pantry[0].quantity, 0);
	assert.equal(
		mergeKitchenStates(base, cookedLocal, reducedRemote, 'local').state.pantry[0].quantity,
		0.5
	);
	assert.equal(
		mergeKitchenStates(base, cookedLocal, reducedRemote, 'remote').state.pantry[0].quantity,
		1
	);

	let writes = 0;
	let server = structuredClone(reducedRemote);
	const transport = {
		identity: { userId: 'a', householdId: 'home' },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v2',
			userId: 'a',
			householdId: 'home'
		}),
		put: async (state: typeof server) => {
			writes += 1;
			server = structuredClone(state);
			return { state: structuredClone(server), etag: 'v3' };
		}
	};
	const record: PendingJournalRecord = {
		writerId: 'tab-1',
		pending: {
			userId: 'a',
			householdId: 'home',
			base,
			local: cookedLocal,
			etag: 'v1',
			updatedAt: 1
		},
		keys: []
	};
	const halted = await syncPendingKitchenJournal([record], transport);
	assert.equal(halted.saved, false);
	assert.equal(writes, 0);
	assert.deepEqual(halted.conflicts, [
		{
			path: 'kitchen.pantry[flour].quantity',
			local: 0.5,
			remote: 1
		}
	]);

	const resolvedLocal = await syncPendingKitchenJournal([record], transport, 'local', 'v2');
	assert.equal(resolvedLocal.saved, true);
	assert.equal(writes, 1);
	assert.equal(server.pantry[0].quantity, 0.5);

	// 2. Two concurrent completed meals whose combined deductions (1.5 + 1.5 = 3) exceed stock (2):
	const cookedRemote = completeMeal(
		structuredClone(base),
		'meal-two',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-23T18:00:00.000Z')
	);
	const overConsumed = mergeKitchenStates(base, cookedLocal, cookedRemote);
	assert.deepEqual(overConsumed.conflicts, [
		{
			path: 'kitchen.pantry[flour].quantity',
			local: 0.5,
			remote: 0.5
		}
	]);
	assert.equal(overConsumed.state.pantry[0].quantity, 0);

	// 3. Concurrent pantry deletion vs meal deduction raises an item conflict, whereas single-branch
	//    completion + restock deletion merges cleanly with zero conflicts.
	const deletedRemote = structuredClone(base);
	deletedRemote.pantry = [];
	const deletedConflict = mergeKitchenStates(base, cookedLocal, deletedRemote);
	assert.equal(deletedConflict.conflicts.length, 1);
	assert.equal(deletedConflict.conflicts[0].path, 'kitchen.pantry[flour]');
	assert.equal(
		mergeKitchenStates(base, cookedLocal, deletedRemote, 'local').state.pantry[0]?.quantity,
		0.5
	);
	assert.equal(
		mergeKitchenStates(base, cookedLocal, deletedRemote, 'remote').state.pantry.length,
		0
	);

	const singleBranchDepleted = structuredClone(base);
	singleBranchDepleted.pantry[0].quantity = 1.5;
	const cookedAndDepleted = completeMeal(
		singleBranchDepleted,
		'meal-one',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00.000Z')
	);
	cookedAndDepleted.pantry = [];
	const singleBranchMerged = mergeKitchenStates(
		singleBranchDepleted,
		cookedAndDepleted,
		structuredClone(singleBranchDepleted)
	);
	assert.equal(singleBranchMerged.conflicts.length, 0);
	assert.equal(singleBranchMerged.state.pantry.length, 0);
});

test('mergeKitchenStates preserves omitted leftoverServings on completed meals so initialize retires acknowledged journals without a PUT', async () => {
	const base = createNewUserState();
	base.recipes = [
		{
			...createInitialState().recipes[0],
			id: 'soup',
			title: 'Tomato Soup',
			servings: 2,
			ingredients: [{ name: 'tomato', quantity: 2, unit: 'cup' }],
			saved: true
		}
	];
	base.meals = [
		{
			id: 'cooked-no-leftovers',
			date: '2026-10-22',
			slot: 'Dinner',
			recipeId: 'soup',
			servings: 2
		},
		{ id: 'cooked-clamped', date: '2026-10-23', slot: 'Dinner', recipeId: 'soup', servings: 2 },
		{ id: 'planned', date: '2026-10-24', slot: 'Dinner', recipeId: 'soup', servings: 2 }
	];

	const remote = structuredClone(base);
	remote.meals[0].completedAt = '2026-10-22T18:00:00.000Z';

	const local = structuredClone(remote);
	local.meals[1].completedAt = '2026-10-23T18:00:00.000Z';
	local.meals[1].leftoverServings = 9;
	local.meals[2].leftoverServings = 1;

	const normalized = mergeKitchenStates(base, local, remote);
	assert.equal(normalized.conflicts.length, 0);
	assert.equal('leftoverServings' in normalized.state.meals[0], false);
	assert.equal(normalized.state.meals[0].leftoverServings, undefined);
	assert.equal(normalized.state.meals[1].leftoverServings, 2);
	assert.equal('leftoverServings' in normalized.state.meals[2], false);

	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'u1', householdId: 'h1', name: 'Cook', email: 'cook@example.test' };
	const acknowledgedRemote = structuredClone(base);
	acknowledgedRemote.meals = [
		{
			id: 'cooked-no-leftovers',
			date: '2026-10-22',
			slot: 'Dinner',
			recipeId: 'soup',
			servings: 2,
			completedAt: '2026-10-22T18:00:00.000Z'
		}
	];
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		writerId: 'tab-ack',
		writeId: 'write-1',
		base: structuredClone(base),
		local: structuredClone(acknowledgedRemote),
		etag: 'v1',
		createdAt: 1,
		updatedAt: 2
	});

	let currentState = createNewUserState();
	let latestPending = true;
	let puts = 0;
	const sync = createKitchenSync({
		storage,
		sessionStorage: null,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = next;
		},
		onStatus: (status) => {
			latestPending = status.pending;
		},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(acknowledgedRemote),
				etag: 'v2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				puts += 1;
				return { state: structuredClone(state), etag: 'v3' };
			}
		})
	});

	sync.initialize(user, structuredClone(acknowledgedRemote), 'v2');
	assert.equal(readPendingJournal(storage, user).records.length, 0);
	assert.equal(latestPending, false);
	await sync.sync();
	assert.equal(puts, 0);
	assert.equal('leftoverServings' in currentState.meals[0], false);
});
