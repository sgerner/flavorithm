import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewUserState } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import {
	completeMeal,
	reconcileShoppingList,
	transferPurchasedItemsToPantry
} from '../src/lib/kitchen-workflows.ts';
import {
	clearPendingJournalRecords,
	mergeKitchenStates,
	readPendingJournal,
	syncPendingKitchenJournal,
	writePending
} from '../src/lib/offline-sync.ts';

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
