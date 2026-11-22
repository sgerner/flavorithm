import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/lib/data.ts';
import { rankRecipes } from '../src/lib/discovery.ts';
import {
	normalizeName as normalizeDomainName,
	unitInfo as domainUnitInfo
} from '../src/lib/domain.ts';
import {
	completeMeal,
	completeRecipe,
	consumePantry,
	convertCompatibleQuantity,
	deleteShoppingItem,
	expiryStatus,
	normalizeIngredientName,
	reconcileShoppingList,
	restoreShoppingItem,
	transferPurchasedItemsToPantry
} from '../src/lib/kitchen-workflows.ts';
import { validateAppState } from '../src/lib/server/db.ts';
import type { AppState, Ingredient, Preferences, Recipe, ShoppingItem } from '../src/lib/types.ts';

function recipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'recipe',
		title: 'Test recipe',
		description: '',
		image: '',
		time: 20,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Italian',
		tags: [],
		ingredients: [],
		steps: [],
		nutrition: {
			calories: 0,
			fat: 0,
			saturatedFat: 0,
			sodium: 0,
			carbs: 0,
			fiber: 0,
			sugar: 0,
			protein: 0
		},
		...overrides
	};
}

function preferences(overrides: Partial<Preferences> = {}): Preferences {
	return {
		diet: '',
		allergies: '',
		maxTime: 0,
		complexity: '',
		cuisines: [],
		theme: 'light',
		dark: false,
		provider: '',
		model: '',
		...overrides
	};
}

function pantry(name: string, quantity: number, unit: string, expires?: string): Ingredient {
	return { id: `${name}-${unit}`, name, quantity, unit, category: 'Test', expires };
}

function shopping(
	id: string,
	name: string,
	quantity: number,
	unit: string,
	checked: boolean,
	sourceKey?: string
): ShoppingItem {
	return { id, name, quantity, unit, checked, ...(sourceKey ? { sourceKey } : {}) };
}

function state(overrides: Partial<AppState> = {}): AppState {
	return {
		pantry: [],
		recipes: [],
		meals: [],
		shopping: [],
		preferences: preferences(),
		...overrides
	};
}

test('converts compatible units and rejects cross-dimension conversions', () => {
	assert.ok(Math.abs((convertCompatibleQuantity(1, 'cup', 'tbsp') ?? 0) - 16) < 0.01);
	assert.ok(Math.abs((convertCompatibleQuantity(1, 'pint', 'cups') ?? 0) - 2) < 0.01);
	assert.ok(Math.abs((convertCompatibleQuantity(1, 'quart', 'fl oz') ?? 0) - 32) < 0.01);
	assert.equal(convertCompatibleQuantity(1, 'cup', 'g'), undefined);
	assert.equal(convertCompatibleQuantity(1, 'package', 'cup'), undefined);
	assert.equal(convertCompatibleQuantity(1, 'can', 'each'), undefined);
	assert.equal(normalizeIngredientName('green onions'), normalizeDomainName('green onions'));
	assert.deepEqual(domainUnitInfo('cups'), domainUnitInfo('cup'));
});

test('shopping refresh is idempotent, accounts for checked purchases, and preserves other rows', () => {
	const key = 'recipe:pasta';
	const existing = [
		shopping('manual-bought', 'pepper', 1, 'tsp', true),
		shopping('manual', 'salt', 1, 'tsp', false),
		shopping('other-bought', 'beans', 1, 'can', true, 'plan:week-1'),
		shopping('other', 'rice', 2, 'cups', false, 'plan:week-1'),
		shopping('stale', 'olive oil', 4, 'cups', false, key),
		shopping('bought', 'extra virgin olive oil', 1, 'tbsp', true, key)
	];
	const desired = [shopping('new-oil', 'olive oil', 1, 'cup', false)];
	const refreshed = reconcileShoppingList(existing, desired, key);
	assert.deepEqual(
		refreshed.map((item) => item.id),
		['manual', 'other', 'stale', 'manual-bought', 'other-bought', 'bought']
	);
	assert.deepEqual(
		refreshed.map((item) => item.checked),
		[false, false, false, true, true, true]
	);
	const remainingOil = refreshed.find((item) => item.id === 'stale');
	assert.ok(remainingOil);
	assert.equal(remainingOil.sourceKey, key);
	assert.equal(remainingOil.checked, false);
	assert.ok(Math.abs(remainingOil.quantity - 0.94) < 0.01);
	assert.equal(remainingOil.id, 'stale');
	assert.deepEqual(reconcileShoppingList(refreshed, desired, key), refreshed);
	const concurrentA = reconcileShoppingList([], desired, key);
	const concurrentB = reconcileShoppingList([], [{ ...desired[0], id: 'generated-again' }], key);
	assert.equal(concurrentA[0].id, concurrentB[0].id);
	assert.notEqual(concurrentA[0].id, reconcileShoppingList([], desired, 'recipe:other')[0].id);

	const fullyCovered = reconcileShoppingList(
		[shopping('bought-all', 'olive oil', 1, 'cup', true, key)],
		desired,
		key
	);
	assert.equal(fullyCovered.length, 1);
});

test('a checked generated row keeps its id when a larger requirement creates a remaining row', () => {
	const key = 'recipe:rice';
	const oneCup = [shopping('request-one', 'rice', 1, 'cup', false)];
	const initial = reconcileShoppingList([], oneCup, key);
	const purchased = { ...initial[0], checked: true };
	const twoCups = [shopping('request-two', 'rice', 2, 'cups', false)];
	const refreshed = reconcileShoppingList([purchased], twoCups, key);
	assert.equal(refreshed.length, 2);
	assert.equal(new Set(refreshed.map((item) => item.id)).size, refreshed.length);
	assert.deepEqual(
		refreshed.map((item) => item.checked),
		[false, true]
	);
	assert.equal(refreshed[1].id, purchased.id);
	assert.equal(refreshed[0].quantity, 1);
	assert.notEqual(refreshed[0].id, purchased.id);

	const repeated = reconcileShoppingList(refreshed, twoCups, key);
	assert.deepEqual(repeated, refreshed);
	assert.equal(new Set(repeated.map((item) => item.id)).size, repeated.length);
	assert.equal(repeated[0].quantity, 1);
});

test('deleting checked week rows refreshes deficits, skips unchecked dismissals, and restores undo cleanly', () => {
	const now = new Date('2026-10-20T12:00:00Z');
	const weekKey = 'week:2026-10-19';
	const plannedRecipe = recipe({
		id: 'stew',
		servings: 2,
		ingredients: [
			{ name: 'carrot', quantity: 4, unit: 'each' },
			{ name: 'onion', quantity: 2, unit: 'each' }
		]
	});
	const baseState = state({
		recipes: [plannedRecipe],
		meals: [{ id: 'dinner', date: '2026-10-21', slot: 'Dinner', recipeId: 'stew', servings: 2 }]
	});

	// Generate initial weekly items: carrot (4) and onion (2)
	const initial = reconcileShoppingList(
		[],
		[
			shopping('req-carrot', 'carrot', 4, 'each', false),
			shopping('req-onion', 'onion', 2, 'each', false)
		],
		weekKey
	);
	const carrotRow = initial.find((item) => item.name === 'carrot')!;
	const onionRow = initial.find((item) => item.name === 'onion')!;

	// Dismissing an unchecked week:* row does not immediately regenerate the dismissed deficit
	const afterDismissOnion = deleteShoppingItem(
		{ ...baseState, shopping: initial },
		onionRow.id,
		now
	);
	assert.deepEqual(afterDismissOnion, [carrotRow]);

	// Restoring an unchecked dismissed row brings it back without resurrecting other dismissed rows
	const afterUndoOnion = restoreShoppingItem({ ...baseState, shopping: [] }, carrotRow, now);
	assert.deepEqual(afterUndoOnion, [carrotRow]);

	// Checking carrot and deleting it refreshes week:2026-10-19 so the 4-carrot deficit returns
	const checkedCarrot: ShoppingItem = { ...carrotRow, checked: true };
	const afterDeleteChecked = deleteShoppingItem(
		{ ...baseState, shopping: [checkedCarrot] },
		checkedCarrot.id,
		now
	);
	const regeneratedCarrot = afterDeleteChecked.find((item) => item.name === 'carrot');
	assert.ok(regeneratedCarrot);
	assert.equal(regeneratedCarrot.id, checkedCarrot.id);
	assert.equal(regeneratedCarrot.checked, false);
	assert.equal(regeneratedCarrot.quantity, 4);

	// Undoing that checked deletion restores the checked row and removes the colliding unchecked deficit
	const afterUndoChecked = restoreShoppingItem(
		{ ...baseState, shopping: afterDeleteChecked },
		checkedCarrot,
		now
	);
	assert.equal(new Set(afterUndoChecked.map((item) => item.id)).size, afterUndoChecked.length);
	assert.equal(afterUndoChecked.filter((item) => item.name === 'carrot').length, 1);
	assert.deepEqual(
		afterUndoChecked.find((item) => item.name === 'carrot'),
		checkedCarrot
	);
});

test('undoing a checked split purchase reconciles -2 week rows and deducts or re-keys recipe collisions', () => {
	const now = new Date('2026-10-20T12:00:00Z');
	const weekKey = 'week:2026-10-19';
	const riceRecipe = recipe({
		id: 'risotto',
		servings: 2,
		ingredients: [{ name: 'rice', quantity: 2, unit: 'cup' }]
	});
	const splitInitial = reconcileShoppingList(
		[],
		[shopping('req-one', 'rice', 1, 'cup', false)],
		weekKey
	);
	const purchasedOne: ShoppingItem = { ...splitInitial[0], checked: true };
	const splitList = reconcileShoppingList(
		[purchasedOne],
		[shopping('req-two', 'rice', 2, 'cup', false)],
		weekKey
	);
	assert.equal(splitList.length, 2);

	const weekState = state({
		recipes: [riceRecipe],
		meals: [{ id: 'dinner', date: '2026-10-21', slot: 'Dinner', recipeId: 'risotto', servings: 2 }],
		shopping: splitList
	});

	// Deleting the checked 1-cup row updates the remaining -2 row to the full 2-cup deficit
	const afterSplitDelete = deleteShoppingItem(weekState, purchasedOne.id, now);
	assert.equal(afterSplitDelete.length, 1);
	assert.equal(afterSplitDelete[0].checked, false);
	assert.equal(afterSplitDelete[0].quantity, 2);

	// Undoing restores the 1-cup checked row and shrinks the -2 row back to 1 cup (not 3 cups total)
	const afterSplitUndo = restoreShoppingItem(
		{ ...weekState, shopping: afterSplitDelete },
		purchasedOne,
		now
	);
	assert.deepEqual(afterSplitUndo, splitList);
	assert.equal(new Set(afterSplitUndo.map((item) => item.id)).size, afterSplitUndo.length);

	// Recipe scope: partial checked purchase deleted, recipe re-shopped with colliding generated-* ID, then undone
	const recipeKey = 'recipe:pasta';
	const recipeInitial = reconcileShoppingList(
		[],
		[shopping('req-oil', 'olive oil', 2, 'cup', false)],
		recipeKey
	);
	const partialOil: ShoppingItem = { ...recipeInitial[0], quantity: 0.5, checked: true };
	const reshoppedOil = reconcileShoppingList(
		[],
		[shopping('req-oil', 'olive oil', 2, 'cup', false)],
		recipeKey
	);
	assert.equal(reshoppedOil[0].id, partialOil.id);

	const restoredPartial = restoreShoppingItem(state({ shopping: reshoppedOil }), partialOil, now);
	assert.equal(restoredPartial.length, 2);
	assert.equal(new Set(restoredPartial.map((item) => item.id)).size, 2);
	assert.deepEqual(
		restoredPartial.find((item) => item.checked),
		partialOil
	);
	assert.equal(restoredPartial.find((item) => !item.checked)?.quantity, 1.5);
	assert.equal(restoredPartial.find((item) => !item.checked)?.id, `${partialOil.id}-2`);

	// Edited bucket mismatch on colliding ID keeps both rows with unique IDs
	const editedChecked: ShoppingItem = {
		...recipeInitial[0],
		name: 'garlic',
		quantity: 3,
		unit: 'clove',
		checked: true
	};
	const restoredEdited = restoreShoppingItem(state({ shopping: reshoppedOil }), editedChecked, now);
	assert.equal(restoredEdited.length, 2);
	assert.equal(new Set(restoredEdited.map((item) => item.id)).size, 2);
	assert.deepEqual(
		restoredEdited.find((item) => item.checked),
		editedChecked
	);
	assert.equal(restoredEdited.find((item) => !item.checked)?.quantity, 2);

	// Guard: identical checked ID already present or restoring past 1,000 items leaves shopping unchanged
	const withCheckedDuplicate = [partialOil];
	assert.equal(
		restoreShoppingItem(state({ shopping: withCheckedDuplicate }), partialOil, now),
		withCheckedDuplicate
	);

	const fullShopping = Array.from({ length: 1_000 }, (_, index) =>
		shopping(`item-${index}`, 'apple', 1, 'each', false)
	);
	assert.equal(
		restoreShoppingItem(
			state({ shopping: fullShopping }),
			shopping('item-overflow', 'pear', 1, 'each', true),
			now
		),
		fullShopping
	);
});

test('purchased shopping rows merge aliases and compatible units without changing an expiring lot', () => {
	const merged = transferPurchasedItemsToPantry(
		[pantry('olive oil', 0.25, 'cup')],
		[
			shopping('merge-tbsp', 'extra virgin olive oil', 1, 'tbsp', true),
			shopping('merge-tsp', 'olive oil', 1, 'tsp', true)
		],
		() => 'unused'
	);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].unit, 'cup');
	assert.ok(Math.abs(merged[0].quantity - 1 / 3) < 0.001);

	const result = transferPurchasedItemsToPantry(
		[pantry('olive oil', 0.25, 'cup', '2026-11-05')],
		[
			shopping('oil-tbsp', 'extra virgin olive oil', 1, 'tbsp', true),
			shopping('oil-tsp', 'olive oil', 1, 'tsp', true),
			shopping('oil-not-checked', 'olive oil', 1, 'cup', false),
			shopping('oil-package', 'olive oil', 1, 'package', true)
		],
		(() => {
			let id = 0;
			return () => `purchase-${++id}`;
		})()
	);

	assert.equal(result.length, 3);
	assert.equal(result[0].quantity, 0.25);
	assert.equal(result[0].expires, '2026-11-05');
	const purchasedOil = result.find((item) => item.unit === 'tbsp');
	assert.ok(purchasedOil);
	assert.equal(normalizeIngredientName(purchasedOil.name), 'olive oil');
	assert.ok(Math.abs(purchasedOil.quantity - 1.33) < 0.01);
	assert.equal(result.find((item) => item.unit === 'package')?.quantity, 1);
});

test('pantry transfers clamp negative or null baseline stock, cap quantities at 1,000,000, and bound array size', () => {
	const corruptedPantry: Ingredient[] = [
		pantry('flour', -3, 'cup'),
		pantry('sugar', null as unknown as number, 'cup'),
		pantry('rice', 999_999.5, 'cup')
	];
	const transferred = transferPurchasedItemsToPantry(
		corruptedPantry,
		[
			shopping('buy-flour', 'flour', 2, 'cups', true),
			shopping('buy-sugar', 'sugar', 1.5, 'cups', true),
			shopping('buy-rice', 'rice', 10, 'cups', true),
			shopping('buy-salt', 'salt', 2_500_000, 'g', true),
			shopping('buy-zero', 'pepper', 0, 'tsp', true),
			shopping('buy-blank', '   ', 2, 'tsp', true)
		],
		() => 'new-salt'
	);

	assert.equal(transferred.find((item) => item.name === 'flour')?.quantity, 2);
	assert.equal(transferred.find((item) => item.name === 'sugar')?.quantity, 1.5);
	assert.equal(transferred.find((item) => item.name === 'rice')?.quantity, 1_000_000);
	assert.equal(transferred.find((item) => item.name === 'salt')?.quantity, 1_000_000);
	assert.equal(
		transferred.find((item) => item.name === 'pepper'),
		undefined
	);

	const fullPantry = Array.from({ length: 1_000 }, (_, index) =>
		pantry(`item-${index}`, 1, 'piece')
	);
	const capped = transferPurchasedItemsToPantry(
		fullPantry,
		[
			shopping('merge-existing', 'item-0', 3, 'piece', true),
			shopping('overflow', 'brand-new-ingredient', 2, 'piece', true)
		],
		() => 'unused-overflow'
	);
	assert.equal(capped.length, 1_000);
	assert.equal(capped[0].quantity, 4);
	assert.equal(
		capped.some((item) => item.name === 'brand-new-ingredient'),
		false
	);
});

test('completing a meal deducts compatible pantry quantities once and never goes below zero', () => {
	const plannedRecipe = recipe({
		id: 'soup',
		ingredients: [
			{ name: 'olive oil', quantity: 2, unit: 'tbsp' },
			{ name: 'egg', quantity: 2, unit: 'each' },
			{ name: 'flour', quantity: 1, unit: 'cup' }
		]
	});
	const input = state({
		pantry: [
			pantry('olive oil', 1, 'cup'),
			pantry('eggs', 1, 'piece'),
			pantry('flour', 0.25, 'cup')
		],
		recipes: [plannedRecipe],
		meals: [{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: 'soup', servings: 2 }]
	});
	const completed = completeMeal(
		input,
		'dinner',
		{ deductPantry: true, leftoverServings: 1 },
		new Date('2026-10-22T18:30:00.000Z')
	);
	assert.notEqual(completed, input);
	assert.equal(completed.meals[0].completedAt, '2026-10-22T18:30:00.000Z');
	assert.equal(completed.meals[0].leftoverServings, 1);
	assert.ok(
		Math.abs((completed.pantry.find((item) => item.name === 'olive oil')?.quantity ?? 0) - 0.875) <
			0.01
	);
	assert.equal(completed.pantry.find((item) => item.name === 'eggs')?.quantity, 0);
	assert.equal(completed.pantry.find((item) => item.name === 'flour')?.quantity, 0);
	assert.equal(input.pantry[0].quantity, 1);
	assert.equal(
		completeMeal(completed, 'dinner', { deductPantry: true, leftoverServings: 0 }),
		completed
	);
});

test('completion consumes soonest-expiring usable lots first and skips expired lots', () => {
	const plannedRecipe = recipe({
		id: 'sauce',
		ingredients: [{ name: 'tomato', quantity: 100, unit: 'g' }]
	});
	const input = state({
		pantry: [
			pantry('tomatoes', 100, 'g', '2026-10-21'),
			pantry('tomato', 20, 'g', '2026-10-22'),
			pantry('tomato', 40, 'g', '2026-10-28'),
			pantry('tomato', 50, 'g')
		],
		recipes: [plannedRecipe],
		meals: [{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: 'sauce', servings: 2 }]
	});
	const completed = completeMeal(
		input,
		'dinner',
		{ deductPantry: true, leftoverServings: 4 },
		new Date(2026, 9, 22)
	);
	assert.equal(completed.pantry[0].quantity, 100);
	assert.equal(completed.pantry[1].quantity, 0);
	assert.equal(completed.pantry[2].quantity, 0);
	assert.equal(completed.pantry[3].quantity, 10);
	assert.equal(completed.meals[0].leftoverServings, 2);
});

test('completion skips malformed expiry dates while consuming ISO and blank expiry lots', () => {
	const plannedRecipe = recipe({
		id: 'sauce',
		ingredients: [{ name: 'tomato', quantity: 60, unit: 'g' }]
	});
	const input = state({
		pantry: [
			{ ...pantry('tomato', 100, 'g'), id: 'bad-feb', expires: '2026-02-30' },
			{ ...pantry('tomato', 100, 'g'), id: 'bad-text', expires: 'next-week' },
			pantry('tomato', 20, 'g', '2026-10-22T00:00:00Z'),
			{ ...pantry('tomato', 50, 'g'), id: 'blank-expires', expires: '' }
		],
		recipes: [plannedRecipe],
		meals: [{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: 'sauce', servings: 2 }]
	});
	const completed = completeMeal(
		input,
		'dinner',
		{ deductPantry: true, leftoverServings: 0 },
		new Date(2026, 9, 22, 20)
	);
	assert.equal(completed.pantry[0].quantity, 100);
	assert.equal(completed.pantry[1].quantity, 100);
	assert.equal(completed.pantry[2].quantity, 0);
	assert.equal(completed.pantry[3].quantity, 10);
});

test('completion preserves small quantities in large pantry units and handles invalid dates', () => {
	const plannedRecipe = recipe({
		id: 'spice',
		ingredients: [{ name: 'salt', quantity: 1, unit: 'g' }]
	});
	const input = state({
		pantry: [pantry('salt', 1, 'kg')],
		recipes: [plannedRecipe],
		meals: [{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: 'spice', servings: 2 }]
	});
	const invalidNow = new Date(Number.NaN);
	const completed = completeMeal(
		input,
		'dinner',
		{ deductPantry: true, leftoverServings: 1 },
		invalidNow
	);
	assert.ok(Math.abs((completed.pantry[0].quantity ?? 0) - 0.999) < 0.000001);
	assert.ok(Number.isFinite(new Date(completed.meals[0].completedAt ?? '').getTime()));
	assert.equal(expiryStatus('2026-10-25', invalidNow), 'unknown');
});

test('expiry uses local calendar dates and treats the next three days as soon', () => {
	const now = new Date(2026, 9, 22, 23, 45);
	assert.equal(expiryStatus(undefined, now), 'unknown');
	assert.equal(expiryStatus('', now), 'unknown');
	assert.equal(expiryStatus('2026-10-21', now), 'expired');
	assert.equal(expiryStatus('2026-10-22', now), 'soon');
	assert.equal(expiryStatus('2026-10-25', now), 'soon');
	assert.equal(expiryStatus('2026-10-26', now), 'fresh');
	assert.equal(expiryStatus('2026-02-30', now), 'unknown');
	assert.equal(expiryStatus('not-a-date', now), 'unknown');
	assert.equal(expiryStatus('2026-11-19T00:00:00Z', new Date(2026, 10, 19, 23, 45)), 'soon');
	assert.equal(expiryStatus('2026-11-19T23:59:59Z', new Date(2026, 10, 20, 0, 15)), 'expired');
});

test('recipe ranking learns ratings and boosts compatible pantry ingredients nearing expiry', () => {
	const favorite = recipe({
		id: 'favorite',
		title: 'Greek lemon bowl',
		cuisine: 'Greek',
		tags: ['bright', 'vegetarian'],
		time: 15,
		difficulty: 'Easy',
		rating: 5
	});
	const disliked = recipe({
		id: 'disliked',
		title: 'Hot curry',
		cuisine: 'Indian',
		tags: ['spicy'],
		time: 60,
		difficulty: 'Hard',
		rating: 1
	});
	const lemonRecipe = recipe({
		id: 'lemon',
		title: 'Lemony greens',
		cuisine: 'Greek',
		tags: ['bright', 'vegetarian'],
		time: 15,
		ingredients: [{ name: 'lemon', quantity: 2, unit: 'each' }]
	});
	const curryRecipe = recipe({
		id: 'curry',
		title: 'Spiced lentils',
		cuisine: 'Indian',
		tags: ['spicy'],
		time: 60,
		difficulty: 'Hard',
		ingredients: [{ name: 'lentil', quantity: 1, unit: 'cup' }]
	});
	const pantryItems = [
		pantry('lemons', 2, 'pieces', '2026-10-24'),
		pantry('lentils', 1, 'cup', '2026-10-21')
	];
	const ranked = rankRecipes(
		[curryRecipe, lemonRecipe, disliked, favorite],
		pantryItems,
		preferences({ cuisines: ['Greek'], maxTime: 25 }),
		new Date(2026, 9, 22)
	);
	assert.equal(ranked[0].id, 'lemon');
	assert.ok(
		ranked.findIndex((item) => item.id === 'lemon') <
			ranked.findIndex((item) => item.id === 'curry')
	);
	assert.ok(
		ranked.findIndex((item) => item.id === 'curry') <
			ranked.findIndex((item) => item.id === 'disliked')
	);
});

test('recipe ranking keeps the original order for equal scores', () => {
	const first = recipe({ id: 'first' });
	const second = recipe({ id: 'second' });
	assert.deepEqual(rankRecipes([first, second], [], preferences()), [first, second]);
});

test('learned time affinity favors candidates near a single rated favorite', () => {
	const far = recipe({ id: 'far', time: 120 });
	const near = recipe({ id: 'near', time: 20 });
	const favorite = recipe({ id: 'favorite-time', time: 20, rating: 5 });
	const ranked = rankRecipes(
		[far, near, favorite],
		[],
		preferences({ maxTime: 1000 }),
		new Date(2026, 9, 22)
	);
	assert.ok(
		ranked.findIndex((item) => item.id === 'near') < ranked.findIndex((item) => item.id === 'far')
	);
});

test('transferPurchasedItemsToPantry preserves categories on new lots and merges item/bunch aliases into unexpired stock', () => {
	const existing = [
		{ ...pantry('avocado', 1, 'whole', '2026-10-24'), category: 'Produce' },
		{ ...pantry('cilantro', 1, 'bunch'), category: 'Herbs' }
	];
	const transferred = transferPurchasedItemsToPantry(
		existing,
		[
			{ ...shopping('scan-avocado', 'avocados', 2, 'items', true), category: 'Produce' },
			{ ...shopping('scan-cilantro', 'cilantro', 1, 'bunches', true), category: 'Produce' },
			shopping('manual-flour', 'flour', 1.5, 'cups', true)
		],
		(() => {
			let n = 0;
			return () => `new-lot-${++n}`;
		})()
	);

	assert.equal(transferred.length, 4);
	// Expiring avocado lot stays untouched; new unexpired avocado lot keeps Produce category.
	assert.equal(transferred[0].quantity, 1);
	assert.equal(transferred[0].expires, '2026-10-24');
	const newAvocado = transferred.find((item) => item.id === 'new-lot-1');
	assert.ok(newAvocado);
	assert.equal(newAvocado.unit, 'each');
	assert.equal(newAvocado.quantity, 2);
	assert.equal(newAvocado.category, 'Produce');

	// Unexpired cilantro bunch merges compatible bunches without duplicating lots.
	const cilantro = transferred.find((item) => item.name === 'cilantro');
	assert.ok(cilantro);
	assert.equal(cilantro.quantity, 2);
	assert.equal(cilantro.unit, 'bunch');
	assert.equal(cilantro.category, 'Herbs');

	// Manual lines without category default to Pantry.
	const flour = transferred.find((item) => item.name === 'flour');
	assert.ok(flour);
	assert.equal(flour.category, 'Pantry');
	assert.equal(flour.unit, 'cup');
});

test('recipe ranking skips malformed expiry dates, keeps blank lots usable, and guards invalid now', () => {
	const invalidMatch = recipe({
		id: 'invalid-lot',
		ingredients: [{ name: 'spinach', quantity: 1, unit: 'cup' }]
	});
	const blankMatch = recipe({
		id: 'blank-lot',
		ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }]
	});
	const isoSoonMatch = recipe({
		id: 'iso-soon-lot',
		ingredients: [{ name: 'avocado', quantity: 1, unit: 'each' }]
	});
	const ranked = rankRecipes(
		[invalidMatch, blankMatch, isoSoonMatch],
		[
			pantry('spinach', 1, 'cup', '2026-02-30'),
			{ ...pantry('spinach', 1, 'cup'), id: 'spinach-bad-text', expires: 'soonish' },
			pantry('rice', 1, 'cup', ''),
			pantry('avocado', 1, 'each', '2026-11-19T00:00:00Z')
		],
		preferences(),
		new Date(2026, 10, 19, 20)
	);
	assert.deepEqual(
		ranked.map((item) => item.id),
		['iso-soon-lot', 'blank-lot', 'invalid-lot']
	);

	const fallbackRanked = rankRecipes(
		[invalidMatch, blankMatch],
		[pantry('spinach', 1, 'cup', '2000-01-01'), pantry('rice', 1, 'cup', '')],
		preferences(),
		new Date(Number.NaN)
	);
	assert.deepEqual(
		fallbackRanked.map((item) => item.id),
		['blank-lot', 'invalid-lot']
	);
});

test('consumePantry scales by servings while skipping expired stock and incompatible units', () => {
	const initial = createInitialState();
	const beans = initial.recipes.find((item) => item.id === 'tomato-butter-beans')!;
	const now = new Date('2026-10-22T18:30:00.000Z');
	const pantryWithExpired = [...initial.pantry, pantry('baby spinach', 5, 'cups', '2026-10-20')];
	const remaining = consumePantry(pantryWithExpired, beans, 4, now);
	// 4 servings of 2-serving recipe => 2 tbsp olive oil (0.125 cup) deducted from 0.5 cup -> 0.375 cup
	assert.equal(remaining.find((item) => item.id === 'pantry-olive-oil')?.quantity, 0.375);
	// 4 cups needed; non-expired 2 cups consumed to 0 while expired 5 cups untouched
	assert.equal(remaining.find((item) => item.id === 'pantry-spinach')?.quantity, 0);
	assert.equal(remaining.find((item) => item.expires === '2026-10-20')?.quantity, 5);
	// garlic in pantry is 'head' vs recipe 'cloves' (incompatible dimension), so untouched
	assert.equal(remaining.find((item) => item.id === 'pantry-garlic')?.quantity, 1);
	assert.deepEqual(consumePantry(initial.pantry, beans, 0, now), initial.pantry);
});

test('completeRecipe records an Unscheduled completed meal, deducts stock, and respects the 1,000-meal limit', () => {
	const initial = createInitialState();
	const now = new Date(2026, 9, 22, 19, 15, 0);
	const completed = completeRecipe(
		initial,
		'tomato-butter-beans',
		{
			servings: 4,
			deductPantry: true,
			leftoverServings: 6,
			createId: () => 'spontaneous-beans'
		},
		now
	);
	assert.equal(completed.meals.length, initial.meals.length + 1);
	const entry = completed.meals.find((meal) => meal.id === 'spontaneous-beans');
	assert.ok(entry);
	assert.equal(entry.slot, 'Unscheduled');
	assert.equal(entry.date, '2026-10-22');
	assert.equal(entry.recipeId, 'tomato-butter-beans');
	assert.equal(entry.servings, 4);
	assert.equal(entry.leftoverServings, 4);
	assert.equal(entry.completedAt, now.toISOString());
	assert.equal(completed.pantry.find((item) => item.id === 'pantry-olive-oil')?.quantity, 0.375);
	assert.equal(completed.pantry.find((item) => item.id === 'pantry-spinach')?.quantity, 0);
	assert.ok(validateAppState(completed));

	const withoutDeduction = completeRecipe(
		initial,
		'tomato-butter-beans',
		{ deductPantry: false, leftoverServings: 1 },
		now
	);
	assert.deepEqual(withoutDeduction.pantry, initial.pantry);
	assert.equal(completeRecipe(initial, 'missing-recipe', {}, now), initial);
	assert.equal(completeRecipe(initial, 'tomato-butter-beans', { servings: 0 }, now), initial);

	const fullMeals = state({
		recipes: initial.recipes,
		meals: Array.from({ length: 1_000 }, (_, index) => ({
			id: `meal-${index}`,
			date: '2026-10-22',
			slot: 'Dinner',
			recipeId: 'tomato-butter-beans',
			servings: 2
		}))
	});
	assert.throws(
		() => completeRecipe(fullMeals, 'tomato-butter-beans', { deductPantry: true }, now),
		/storage limit/
	);
});
