import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import { rankPantryRecipes, rankRecipes } from '../src/lib/discovery.ts';
import {
	buildShoppingList,
	normalizeName as normalizeDomainName,
	unitInfo as domainUnitInfo
} from '../src/lib/domain.ts';
import {
	backfillSampleData,
	clearSampleData,
	completeMeal,
	convertCompatibleQuantity,
	deleteShoppingItem,
	expiryStatus,
	filterPantryItems,
	hasSampleData,
	listPantryCategories,
	normalizeIngredientName,
	normalizePantryDraft,
	promoteSampleBookmark,
	promoteSampleIngredient,
	promoteSampleMeal,
	reconcileShoppingList,
	restockDepletedPantryItems,
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

test('reconcileShoppingList preserves sequential tbsp offsets and 0.000001 precision across refreshes', () => {
	const key = 'week:2026-10-19';
	const desiredGallon = buildShoppingList(
		[
			recipe({
				servings: 2,
				ingredients: [{ name: 'broth', quantity: 1, unit: 'gal' }]
			})
		],
		[]
	);
	const afterOneTbsp = reconcileShoppingList(
		[shopping('tbsp-1', 'broth', 1, 'tbsp', true, key)],
		desiredGallon,
		key
	);
	const remainingAfterOne = afterOneTbsp.find((item) => !item.checked);
	assert.ok(remainingAfterOne);
	assert.equal(remainingAfterOne.unit, 'gal');
	assert.equal(remainingAfterOne.quantity, 0.996094);
	assert.deepEqual(reconcileShoppingList(afterOneTbsp, desiredGallon, key), afterOneTbsp);

	const afterTwoTbsp = reconcileShoppingList(
		[
			shopping('tbsp-1', 'broth', 1, 'tbsp', true, key),
			shopping('tbsp-2', 'broth', 1, 'tbsp', true, key)
		],
		desiredGallon,
		key
	);
	const remainingAfterTwo = afterTwoTbsp.find((item) => !item.checked);
	assert.ok(remainingAfterTwo);
	assert.equal(remainingAfterTwo.unit, 'gal');
	assert.equal(remainingAfterTwo.quantity, 0.992188);
	assert.ok(remainingAfterTwo.quantity < remainingAfterOne.quantity);

	const after255Tbsp = reconcileShoppingList(
		[shopping('tbsp-255', 'broth', 255, 'tbsp', true, key)],
		desiredGallon,
		key
	);
	const remainingLastTbsp = after255Tbsp.find((item) => !item.checked);
	assert.ok(remainingLastTbsp);
	assert.equal(remainingLastTbsp.unit, 'tbsp');
	assert.equal(remainingLastTbsp.quantity, 1);

	const after256Tbsp = reconcileShoppingList(
		[shopping('tbsp-256', 'broth', 256, 'tbsp', true, key)],
		desiredGallon,
		key
	);
	assert.equal(
		after256Tbsp.some((item) => !item.checked),
		false
	);

	const microOffsetAdditions = buildShoppingList(
		[recipe({ ingredients: [{ name: 'salt', quantity: 1, unit: 'kg' }] })],
		[pantry('salt', 1, 'g')]
	);
	const microRefreshed = reconcileShoppingList([], microOffsetAdditions, key);
	assert.equal(microRefreshed[0]?.unit, 'kg');
	assert.equal(microRefreshed[0]?.quantity, 0.999);

	const downscaledRemainder = reconcileShoppingList(
		[shopping('bought-flour', 'flour', 0.996, 'kg', true, key)],
		[shopping('desired-flour', 'flour', 1, 'kg', false)],
		key
	);
	const remainingFlour = downscaledRemainder.find((item) => !item.checked);
	assert.ok(remainingFlour);
	assert.equal(remainingFlour.unit, 'g');
	assert.equal(remainingFlour.quantity, 4);

	const recipeScopeKey = 'recipe:bread';
	const recipeFlour = reconcileShoppingList(
		[],
		[shopping('req-flour', 'flour', 1, 'kg', false)],
		recipeScopeKey
	);
	const restoredDownscaled = restoreShoppingItem(
		state({ shopping: recipeFlour }),
		{ ...recipeFlour[0], quantity: 0.996, checked: true },
		new Date('2026-10-20T12:00:00Z')
	);
	const restoredRemainingFlour = restoredDownscaled.find((item) => !item.checked);
	assert.ok(restoredRemainingFlour);
	assert.equal(restoredRemainingFlour.unit, 'g');
	assert.equal(restoredRemainingFlour.quantity, 4);
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

	const fractionalLeftover = completeMeal(
		input,
		'dinner',
		{ deductPantry: false, leftoverServings: 1.234 },
		new Date(2026, 9, 22)
	);
	assert.equal(fractionalLeftover.meals[0].leftoverServings, 1.23);
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

test('user purchases never merge into sample pantry lots and merge into user-owned lots', () => {
	const initial = createInitialState();
	let nextId = 0;
	const afterFirstPurchase = transferPurchasedItemsToPantry(
		initial.pantry,
		[shopping('buy-oil-1', 'extra virgin olive oil', 2, 'tbsp', true)],
		() => `user-lot-${++nextId}`
	);
	assert.equal(afterFirstPurchase.length, initial.pantry.length + 1);
	const sampleOil = afterFirstPurchase.find((item) => item.id === 'pantry-olive-oil');
	const userOil = afterFirstPurchase.find((item) => item.id === 'user-lot-1');
	assert.ok(sampleOil?.sample);
	assert.equal(sampleOil.quantity, 0.5);
	assert.ok(userOil);
	assert.equal(userOil.sample, undefined);
	assert.equal(userOil.quantity, 2);
	assert.equal(userOil.unit, 'tbsp');

	const afterSecondPurchase = transferPurchasedItemsToPantry(
		afterFirstPurchase,
		[shopping('buy-oil-2', 'olive oil', 1, 'tbsp', true)],
		() => `user-lot-${++nextId}`
	);
	assert.equal(afterSecondPurchase.length, afterFirstPurchase.length);
	assert.equal(afterSecondPurchase.find((item) => item.id === 'user-lot-1')?.quantity, 3);

	const cleaned = clearSampleData({ ...initial, pantry: afterSecondPurchase });
	assert.deepEqual(
		cleaned.pantry.map((item) => ({ id: item.id, quantity: item.quantity, unit: item.unit })),
		[{ id: 'user-lot-1', quantity: 3, unit: 'tbsp' }]
	);
});

test('selective cleanup removes only sample records and snapshot-guarded Undo restores them', () => {
	const guest = createInitialState();
	guest.pantry = transferPurchasedItemsToPantry(
		guest.pantry,
		[shopping('real-pasta', 'orzo', 1, 'cup', true)],
		() => 'user-orzo'
	);
	guest.meals.push({
		id: 'user-wed-dinner',
		date: guest.meals[0].date,
		slot: 'Breakfast',
		recipeId: 'maple-chili-tofu',
		servings: 3
	});
	guest.shopping.push(shopping('manual-tea', 'green tea', 1, 'box', false));
	const userBookmark = guest.recipes.find((item) => item.id === 'maple-chili-tofu')!;
	userBookmark.saved = true;
	const ratedStarter = guest.recipes.find((item) => item.id === 'lemon-herb-chicken')!;
	ratedStarter.rating = 5;
	guest.preferences.ratings = { 'lemon-herb-chicken': 5 };

	assert.equal(hasSampleData(guest), true);
	const previousSnapshot = structuredClone(guest);
	const cleaned = clearSampleData(guest);
	const appliedJson = JSON.stringify(cleaned);

	assert.equal(hasSampleData(cleaned), false);
	assert.deepEqual(
		cleaned.pantry.map((item) => item.id),
		['user-orzo']
	);
	assert.deepEqual(
		cleaned.meals.map((meal) => meal.id),
		['user-wed-dinner']
	);
	assert.deepEqual(
		cleaned.shopping.map((item) => item.id),
		['manual-tea']
	);
	assert.deepEqual(
		cleaned.recipes.filter((item) => item.saved).map((item) => item.id),
		['maple-chili-tofu']
	);
	assert.equal(cleaned.recipes.find((item) => item.id === 'lemon-herb-chicken')?.rating, 5);
	assert.equal(cleaned.preferences.ratings?.['lemon-herb-chicken'], 5);

	// Snapshot-guarded Undo restores removed sample records when unchanged, and refuses after edits.
	let activeKitchen = structuredClone(cleaned);
	if (JSON.stringify(activeKitchen) === appliedJson)
		activeKitchen = structuredClone(previousSnapshot);
	assert.equal(hasSampleData(activeKitchen), true);
	assert.equal(activeKitchen.pantry.length, 8);
	assert.equal(activeKitchen.meals.length, 4);
	assert.equal(activeKitchen.recipes.filter((item) => item.saved).length, 4);

	let mutatedKitchen = structuredClone(cleaned);
	mutatedKitchen.shopping.push(shopping('later-item', 'milk', 1, 'l', false));
	const undoAllowed = JSON.stringify(mutatedKitchen) === appliedJson;
	assert.equal(undoAllowed, false);
});

test('editing or completing sample records promotes them so cleanup keeps them', () => {
	const guest = createInitialState();
	guest.pantry = guest.pantry.map((item) =>
		item.id === 'pantry-eggs' ? promoteSampleIngredient({ ...item, quantity: 6 }) : item
	);
	guest.meals = guest.meals.map((meal) =>
		meal.id === 'meal-week-tue' ? promoteSampleMeal({ ...meal, servings: 4 }) : meal
	);
	guest.recipes = guest.recipes.map((item) =>
		item.id === 'sesame-salmon-bowls' ? promoteSampleBookmark({ ...item, saved: true }) : item
	);
	const afterCook = completeMeal(
		guest,
		'meal-week-thu',
		{ deductPantry: false, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00Z')
	);

	const cleaned = clearSampleData(afterCook);
	assert.deepEqual(
		cleaned.pantry.map((item) => ({ id: item.id, quantity: item.quantity })),
		[{ id: 'pantry-eggs', quantity: 6 }]
	);
	assert.deepEqual(
		cleaned.meals.map((meal) => meal.id),
		['meal-week-tue', 'meal-week-thu']
	);
	assert.deepEqual(
		cleaned.recipes.filter((item) => item.saved).map((item) => item.id),
		['sesame-salmon-bowls']
	);
});

test('legacy backfill tags only exact pantry and bookmark seeds and preserves ambiguous meals', () => {
	const legacy = createInitialState();
	for (const item of legacy.pantry) delete item.sample;
	for (const meal of legacy.meals) delete meal.sample;
	for (const item of legacy.recipes) delete item.sampleSaved;

	// Simulate guest edits prior to sample metadata support.
	legacy.pantry.find((item) => item.id === 'pantry-garlic')!.quantity = 3;
	legacy.pantry.find((item) => item.id === 'pantry-olive-oil')!.name = 'avocado oil';
	legacy.pantry.push({
		id: 'custom-basil',
		name: 'basil',
		quantity: 1,
		unit: 'bunch',
		category: 'Produce'
	});
	const movedMeal = legacy.meals.find((meal) => meal.id === 'meal-week-sat')!;
	const movedDate = new Date(`${movedMeal.date}T12:00:00Z`);
	movedDate.setUTCDate(movedDate.getUTCDate() + 7);
	movedMeal.date = movedDate.toISOString().slice(0, 10);
	legacy.recipes.find((item) => item.id === 'tomato-butter-beans')!.servings = 4;
	legacy.recipes.find((item) => item.id === 'sesame-salmon-bowls')!.description += ' User note.';

	const backfilled = backfillSampleData(legacy);
	assert.equal(backfilled.pantry.filter((item) => item.sample).length, 5);
	assert.equal(backfilled.pantry.find((item) => item.id === 'pantry-garlic')?.sample, undefined);
	assert.equal(backfilled.pantry.find((item) => item.id === 'pantry-olive-oil')?.sample, undefined);
	assert.equal(backfilled.pantry.find((item) => item.id === 'custom-basil')?.sample, undefined);
	assert.equal(backfilled.meals.filter((meal) => meal.sample).length, 0);
	assert.equal(backfilled.meals.find((meal) => meal.id === 'meal-week-sat')?.date, movedMeal.date);
	assert.equal(backfilled.recipes.filter((item) => item.sampleSaved).length, 1);
	assert.equal(
		backfilled.recipes.find((item) => item.id === 'tomato-butter-beans')?.sampleSaved,
		undefined
	);
	assert.equal(
		backfilled.recipes.find((item) => item.id === 'sesame-salmon-bowls')?.sampleSaved,
		undefined
	);

	const cleaned = clearSampleData(backfilled);
	assert.deepEqual(
		cleaned.pantry.map((item) => item.id),
		['pantry-olive-oil', 'pantry-garlic', 'custom-basil']
	);
	assert.deepEqual(
		cleaned.meals.map((meal) => meal.id),
		legacy.meals.map((meal) => meal.id)
	);
	assert.equal(cleaned.recipes.find((item) => item.id === 'tomato-butter-beans')?.saved, true);
	assert.equal(cleaned.recipes.find((item) => item.id === 'sesame-salmon-bowls')?.saved, true);
});

test('registration cleanup strips untouched sample items, validates schemas, and refreshes weekly shopping', () => {
	const untouchedGuest = createInitialState();
	assert.ok(validateAppState(untouchedGuest));
	const cleanUntouched = clearSampleData(untouchedGuest);
	assert.deepEqual(cleanUntouched, createNewUserState());
	assert.ok(validateAppState(cleanUntouched));

	// Legacy snapshots without sample properties remain schema-valid too.
	assert.ok(validateAppState(createNewUserState()));

	// Guest schedules a real meal in the starter week and generates that week's shopping list.
	const now = new Date(2026, 10, 18, 12);
	const weekStart = '2026-11-16';
	const activeGuest = createInitialState();
	activeGuest.meals = [
		{
			id: 'meal-week-tue',
			date: '2026-11-17',
			slot: 'Dinner',
			recipeId: 'lemon-herb-chicken',
			servings: 2,
			sample: true
		},
		{
			id: 'user-orzo-dinner',
			date: '2026-11-19',
			slot: 'Dinner',
			recipeId: 'lemon-chickpea-orzo',
			servings: 2
		}
	];
	activeGuest.shopping = [
		shopping('manual-berries', 'blueberries', 1, 'pint', false),
		...reconcileShoppingList(
			[],
			buildShoppingList(activeGuest.recipes, activeGuest.pantry, activeGuest.meals, now),
			`week:${weekStart}`
		)
	];
	// Before cleanup, sample chickpeas and olive oil masked the user meal's chickpea/olive oil needs,
	// and sample chicken meal added boneless chicken thighs.
	assert.equal(
		activeGuest.shopping.some((item) => normalizeIngredientName(item.name) === 'chickpea'),
		false
	);
	assert.equal(
		activeGuest.shopping.some((item) => normalizeIngredientName(item.name) === 'chicken thigh'),
		true
	);

	const registeredState = clearSampleData(activeGuest, now);
	assert.ok(validateAppState(registeredState));
	assert.equal(hasSampleData(registeredState), false);
	assert.equal(
		registeredState.shopping.some((item) => item.id === 'manual-berries'),
		true
	);
	assert.equal(
		registeredState.shopping.some((item) => normalizeIngredientName(item.name) === 'chicken thigh'),
		false
	);
	assert.equal(
		registeredState.shopping.some((item) => normalizeIngredientName(item.name) === 'chickpea'),
		true
	);
	assert.equal(
		registeredState.shopping.some((item) => normalizeIngredientName(item.name) === 'olive oil'),
		true
	);
});

test('normalizePantryDraft clamps quantities, trims unit to 40 chars, and normalizes optional expiry', () => {
	assert.deepEqual(
		normalizePantryDraft({
			quantity: null,
			unit: '  cups  ',
			category: '  Grains  ',
			expires: '   '
		}),
		{
			quantity: 0,
			unit: 'cups',
			category: 'Grains'
		}
	);
	assert.deepEqual(
		normalizePantryDraft({
			quantity: '',
			unit: '',
			category: '',
			expires: ' 2026-12-01 '
		}),
		{
			quantity: 0,
			unit: 'piece',
			category: 'Pantry',
			expires: '2026-12-01'
		}
	);
	assert.equal(
		normalizePantryDraft({
			quantity: -12.5,
			unit: 'g',
			category: 'Spices',
			expires: ''
		}).quantity,
		0
	);
	assert.equal(
		normalizePantryDraft({
			quantity: 2_500_000,
			unit: 'g',
			category: 'Spices',
			expires: ''
		}).quantity,
		1_000_000
	);
	const longUnit = normalizePantryDraft({
		quantity: 1.5,
		unit: `  ${'u'.repeat(55)}  `,
		category: `  ${'c'.repeat(120)}  `,
		expires: ''
	});
	assert.equal(longUnit.quantity, 1.5);
	assert.equal(longUnit.unit.length, 40);
	assert.equal(longUnit.category.length, 100);
});

test('filterPantryItems and listPantryCategories combine search text, category, and expiry filters', () => {
	const now = new Date(2026, 10, 21, 12, 0);
	const items: Ingredient[] = [
		{
			id: 'oil',
			name: 'olive oil',
			quantity: 0.5,
			unit: 'cup',
			category: 'Oils & condiments'
		},
		{
			id: 'spinach',
			name: 'baby spinach',
			quantity: 2,
			unit: 'cups',
			category: 'Produce',
			expires: '2026-11-23'
		},
		{
			id: 'milk',
			name: 'whole milk',
			quantity: 1,
			unit: 'qt',
			category: 'Dairy & eggs',
			expires: '2026-11-18'
		},
		{
			id: 'rice',
			name: 'jasmine rice',
			quantity: 2,
			unit: 'cups',
			category: 'Grains',
			expires: '2027-06-01'
		}
	];

	const categories = listPantryCategories(items);
	assert.deepEqual(
		categories.map((entry) => entry.label),
		['Dairy & eggs', 'Grains', 'Oils & condiments', 'Produce']
	);
	assert.equal(
		listPantryCategories(items, 'Spices').find((entry) => entry.key === 'spices')?.count,
		0
	);

	assert.deepEqual(
		filterPantryItems(items, { query: 'condiment', category: 'all', expiry: 'all' }, now).map(
			(item) => item.id
		),
		['oil']
	);
	assert.deepEqual(
		filterPantryItems(items, { query: '', category: 'Produce', expiry: 'soon' }, now).map(
			(item) => item.id
		),
		['spinach']
	);
	assert.deepEqual(
		filterPantryItems(items, { query: 'rice', category: 'Grains', expiry: 'expired' }, now),
		[]
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

test('restockDepletedPantryItems moves selected or all zero-quantity rows while keeping stored name and unit', () => {
	const initialPantry = [
		pantry('chickpeas', 0, 'can (15 oz)'),
		pantry('baby spinach', 0, 'cups', '2026-10-23'),
		pantry('olive oil', 0.5, 'cup')
	];
	let nextId = 0;
	const createId = () => `restock-${++nextId}`;

	const single = restockDepletedPantryItems(initialPantry, [], ['chickpeas-can (15 oz)'], createId);
	assert.equal(single.restockedCount, 1);
	assert.equal(single.addedCount, 1);
	assert.deepEqual(
		single.pantry.map((item) => item.name),
		['baby spinach', 'olive oil']
	);
	assert.deepEqual(single.shopping, [
		{
			id: 'restock-1',
			name: 'chickpeas',
			quantity: 1,
			unit: 'can (15 oz)',
			checked: false
		}
	]);
	assert.equal('sourceKey' in single.shopping[0], false);
	assert.equal(initialPantry.length, 3);

	const bulk = restockDepletedPantryItems(initialPantry, [], undefined, createId);
	assert.equal(bulk.restockedCount, 2);
	assert.equal(bulk.addedCount, 2);
	assert.deepEqual(
		bulk.pantry.map((item) => item.name),
		['olive oil']
	);
	assert.deepEqual(
		bulk.shopping.map(({ name, quantity, unit, checked }) => ({ name, quantity, unit, checked })),
		[
			{ name: 'chickpeas', quantity: 1, unit: 'can (15 oz)', checked: false },
			{ name: 'baby spinach', quantity: 1, unit: 'cups', checked: false }
		]
	);
});

test('restockDepletedPantryItems deduplicates compatible unchecked entries and survives scoped refreshes', () => {
	const existingShopping: ShoppingItem[] = [
		shopping('week-beans', 'garbanzo beans', 2, 'can (15 oz)', false, 'week:2026-10-19'),
		shopping('bought-oil', 'extra virgin olive oil', 1, 'tbsp', true, 'recipe:pasta'),
		shopping('oil-pack', 'olive oil', 1, 'package', false)
	];
	const depletedPantry = [
		pantry('chickpeas', 0, 'can (15 oz)'),
		pantry('olive oil', 0, 'cup'),
		pantry('tomato', 0, 'g', '2026-10-22'),
		pantry('tomatoes', 0, 'oz', '2026-10-25')
	];
	let nextId = 0;
	const result = restockDepletedPantryItems(
		depletedPantry,
		existingShopping,
		undefined,
		() => `restock-${++nextId}`
	);

	assert.equal(result.pantry.length, 0);
	assert.equal(result.restockedCount, 4);
	assert.equal(result.addedCount, 2);
	assert.equal(result.shopping.length, 5);
	assert.deepEqual(result.shopping[0], existingShopping[0]);
	assert.equal(result.shopping.at(-1)?.id, 'bought-oil');
	const addedOil = result.shopping.find((item) => item.id === 'restock-1');
	assert.deepEqual(addedOil, {
		id: 'restock-1',
		name: 'olive oil',
		quantity: 1,
		unit: 'cup',
		checked: false
	});
	const addedTomato = result.shopping.find((item) => item.id === 'restock-2');
	assert.deepEqual(addedTomato, {
		id: 'restock-2',
		name: 'tomato',
		quantity: 1,
		unit: 'g',
		checked: false
	});

	const refreshedWeek = reconcileShoppingList(
		result.shopping,
		[shopping('next-rice', 'jasmine rice', 1, 'cup', false)],
		'week:2026-10-19'
	);
	assert.ok(refreshedWeek.some((item) => item.id === 'restock-1' && item.sourceKey === undefined));
	assert.ok(refreshedWeek.some((item) => item.id === 'restock-2' && item.sourceKey === undefined));
});

test('rankPantryRecipes filters to positive pantry matches and supports targeted expiring ingredients', () => {
	const now = new Date(2026, 9, 22);
	const chickpeaOrzo = recipe({
		id: 'orzo',
		title: 'Chickpea spinach orzo',
		ingredients: [
			{ name: 'chickpeas', quantity: 1, unit: 'can (15 oz)' },
			{ name: 'baby spinach', quantity: 2, unit: 'cups' }
		]
	});
	const hummus = recipe({
		id: 'hummus',
		title: 'Quick hummus',
		ingredients: [
			{ name: 'chickpeas', quantity: 1, unit: 'can (15 oz)' },
			{ name: 'tahini', quantity: 2, unit: 'tbsp' }
		]
	});
	const wiltedGreens = recipe({
		id: 'greens',
		title: 'Wilted spinach',
		ingredients: [{ name: 'spinach', quantity: 2, unit: 'cups' }]
	});
	const lentilSoup = recipe({
		id: 'lentils',
		title: 'Red lentil soup',
		ingredients: [{ name: 'lentils', quantity: 1, unit: 'cup' }]
	});
	const custard = recipe({
		id: 'custard',
		title: 'Baked custard',
		ingredients: [{ name: 'milk', quantity: 1, unit: 'cup' }]
	});

	const expiringSpinach = pantry('baby spinach', 2, 'cups', '2026-10-24');
	const stockedChickpeas = pantry('chickpeas', 1, 'can (15 oz)');
	const depletedLentils = pantry('lentils', 0, 'cup');
	const expiredMilk = pantry('milk', 1, 'cup', '2026-10-20');
	const malformedSpinach = pantry('spinach', 2, 'cups', '2026-02-30');
	const pantryItems = [
		expiringSpinach,
		stockedChickpeas,
		depletedLentils,
		expiredMilk,
		malformedSpinach
	];
	const allRecipes = [lentilSoup, custard, hummus, wiltedGreens, chickpeaOrzo];

	const fromPantry = rankPantryRecipes(allRecipes, pantryItems, preferences(), undefined, now);
	assert.deepEqual(
		fromPantry.map((item) => item.id),
		['greens', 'orzo', 'hummus']
	);

	const useSpinachFirst = rankPantryRecipes(
		allRecipes,
		pantryItems,
		preferences(),
		[expiringSpinach],
		now
	);
	assert.deepEqual(
		useSpinachFirst.map((item) => item.id),
		['greens', 'orzo']
	);

	assert.deepEqual(
		rankPantryRecipes(
			allRecipes,
			[depletedLentils, expiredMilk, malformedSpinach],
			preferences(),
			undefined,
			now
		),
		[]
	);
});

test('filterPantryItems excludes zero-quantity rows from Expiring soon while keeping them in All ingredients', () => {
	const now = new Date(2026, 10, 21, 12, 0);
	const items: Ingredient[] = [
		{
			id: 'spinach-depleted',
			name: 'baby spinach',
			quantity: 0,
			unit: 'cups',
			category: 'Produce',
			expires: '2026-11-22'
		},
		{
			id: 'rice-stocked',
			name: 'jasmine rice',
			quantity: 2,
			unit: 'cups',
			category: 'Grains',
			expires: '2026-11-22'
		}
	];

	assert.deepEqual(
		filterPantryItems(items, { query: '', category: 'all', expiry: 'soon' }, now).map(
			(item) => item.id
		),
		['rice-stocked']
	);
	assert.deepEqual(
		filterPantryItems(items, { query: '', category: 'all', expiry: 'all' }, now).map(
			(item) => item.id
		),
		['spinach-depleted', 'rice-stocked']
	);
});
