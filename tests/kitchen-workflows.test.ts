import test from 'node:test';
import assert from 'node:assert/strict';
import { rankRecipes } from '../src/lib/discovery.ts';
import { applyButlerCommands } from '../src/lib/butler.ts';
import {
	normalizeName as normalizeDomainName,
	unitInfo as domainUnitInfo
} from '../src/lib/domain.ts';
import {
	completeMeal,
	convertCompatibleQuantity,
	deleteMeal,
	deleteRecipe,
	deleteShoppingItem,
	expiryStatus,
	normalizeIngredientName,
	recipeForEdit,
	recipeNeedsNutritionRefresh,
	reconcileShoppingList,
	restoreShoppingItem,
	saveEditedRecipe,
	transferPurchasedItemsToPantry,
	upsertMeal,
	upsertRecipe,
	weekStartForDate
} from '../src/lib/kitchen-workflows.ts';
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
		shopping('manual', 'salt', 1, 'tsp', false),
		shopping('other', 'rice', 2, 'cups', false, 'plan:week-1'),
		shopping('stale', 'olive oil', 4, 'cups', false, key),
		shopping('bought', 'extra virgin olive oil', 1, 'tbsp', true, key)
	];
	const desired = [shopping('new-oil', 'olive oil', 1, 'cup', false)];
	const refreshed = reconcileShoppingList(existing, desired, key);
	assert.deepEqual(
		refreshed.map((item) => item.id),
		['manual', 'other', 'bought', 'stale']
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
	assert.equal(refreshed.find((item) => item.checked)?.id, purchased.id);
	assert.equal(refreshed.find((item) => !item.checked)?.quantity, 1);
	assert.notEqual(refreshed.find((item) => !item.checked)?.id, purchased.id);

	const repeated = reconcileShoppingList(refreshed, twoCups, key);
	assert.deepEqual(repeated, refreshed);
	assert.equal(new Set(repeated.map((item) => item.id)).size, repeated.length);
	assert.equal(repeated.find((item) => !item.checked)?.quantity, 1);
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
	assert.equal(expiryStatus('2026-10-21', now), 'expired');
	assert.equal(expiryStatus('2026-10-22', now), 'soon');
	assert.equal(expiryStatus('2026-10-25', now), 'soon');
	assert.equal(expiryStatus('2026-10-26', now), 'fresh');
	assert.equal(expiryStatus('2026-02-30', now), 'unknown');
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

test('editing a recipe refreshes scheduled weeks and existing recipe scopes independently while keeping manual and checked rows', () => {
	const now = new Date('2026-10-22T12:00:00Z');
	const pasta = recipe({
		id: 'pasta',
		servings: 2,
		saved: true,
		ingredients: [{ name: 'olive oil', quantity: 2, unit: 'tbsp' }]
	});
	const initial = state({
		pantry: [pantry('olive oil', 1, 'tbsp')],
		recipes: [pasta],
		meals: [{ id: 'dinner', date: '2026-10-23', slot: 'Dinner', recipeId: 'pasta', servings: 4 }],
		shopping: [
			shopping('manual-salt', 'kosher salt', 1, 'box', false),
			shopping('other-recipe', 'lemon', 2, 'each', false, 'recipe:other'),
			shopping('week-bought', 'olive oil', 1, 'tbsp', true, 'week:2026-10-19'),
			shopping('week-open', 'olive oil', 2, 'tbsp', false, 'week:2026-10-19'),
			shopping('recipe-bought', 'olive oil', 1, 'tbsp', true, 'recipe:pasta')
		]
	});

	const edited = saveEditedRecipe(
		initial,
		{
			...pasta,
			servings: 4,
			rating: 5,
			ingredients: [
				{ name: 'olive oil', quantity: 6, unit: 'tbsp' },
				{ name: 'garlic', quantity: 4, unit: 'clove' }
			]
		},
		now
	);

	const updatedRecipe = edited.recipes[0];
	assert.equal(updatedRecipe.nutritionStale, true);
	assert.equal(updatedRecipe.saved, true);
	assert.equal(edited.preferences.ratings?.pasta, 5);

	// Planned meal for 4 servings needs 6 tbsp oil - 1 tbsp pantry - 1 tbsp checked = 4 tbsp, plus 4 garlic cloves.
	const weekItems = edited.shopping.filter((item) => item.sourceKey === 'week:2026-10-19');
	assert.equal(weekItems.find((item) => item.checked && item.name === 'olive oil')?.quantity, 1);
	assert.equal(weekItems.find((item) => !item.checked && item.name === 'olive oil')?.quantity, 4);
	assert.equal(weekItems.find((item) => !item.checked && item.name === 'garlic')?.quantity, 4);

	// Existing recipe:pasta scope uses edited recipe.servings (4) independently without cross-scope deduplication.
	const recipeItems = edited.shopping.filter((item) => item.sourceKey === 'recipe:pasta');
	assert.equal(recipeItems.find((item) => item.checked && item.name === 'olive oil')?.quantity, 1);
	assert.equal(recipeItems.find((item) => !item.checked && item.name === 'olive oil')?.quantity, 4);
	assert.equal(recipeItems.find((item) => !item.checked && item.name === 'garlic')?.quantity, 4);

	// Manual and other recipe scopes remain untouched.
	assert.ok(edited.shopping.some((item) => item.id === 'manual-salt'));
	assert.ok(edited.shopping.some((item) => item.id === 'other-recipe'));

	// Editing a recipe with no existing recipe:<id> scope does not create recipe:<id> rows.
	const withoutRecipeScope = upsertRecipe(
		state({ recipes: [pasta] }),
		{ ...pasta, servings: 4 },
		now
	);
	assert.equal(withoutRecipeScope.shopping.length, 0);
	assert.equal(recipeNeedsNutritionRefresh(pasta, { ...pasta, title: 'Renamed' }), false);
	assert.equal(recipeNeedsNutritionRefresh(pasta, { ...pasta, servings: 4 }), true);
});

test('unsaved recipes open for manual editing and save cleanly to the collection', () => {
	const unsaved = recipe({
		id: 'draft-risotto',
		title: 'Mushroom risotto',
		saved: false,
		ingredients: [{ name: 'arborio rice', quantity: 1, unit: 'cup' }],
		steps: ['Toast rice', 'Simmer with stock']
	});
	const initial = state({ recipes: [unsaved] });

	const draft = recipeForEdit(initial, 'draft-risotto');
	assert.ok(draft);
	assert.equal(draft.saved, false);
	draft.title = 'Herbed mushroom risotto';
	draft.ingredients[0].quantity = 2;
	assert.equal(initial.recipes[0].title, 'Mushroom risotto');
	assert.equal(initial.recipes[0].ingredients[0].quantity, 1);

	const savedState = saveEditedRecipe(initial, draft, new Date('2026-10-22T12:00:00Z'));
	assert.equal(savedState.recipes[0].saved, true);
	assert.equal(savedState.recipes[0].title, 'Herbed mushroom risotto');
	assert.equal(savedState.recipes[0].nutritionStale, true);
	assert.equal(recipeForEdit(initial, 'missing'), null);
});

test('UI workflows and Basil commands produce identical shopping and kitchen state across recipe and meal lifecycles', () => {
	const now = new Date('2026-10-22T12:00:00Z');
	const stew = recipe({
		id: 'stew',
		title: 'Bean stew',
		servings: 2,
		saved: true,
		ingredients: [
			{ name: 'carrot', quantity: 4, unit: 'each' },
			{ name: 'onion', quantity: 2, unit: 'each' }
		],
		steps: ['Simmer']
	});
	const base = state({
		pantry: [pantry('carrot', 1, 'each')],
		recipes: [stew],
		shopping: [
			shopping('manual', 'bread', 1, 'loaf', false),
			shopping('recipe-stew', 'carrot', 3, 'each', false, 'recipe:stew')
		]
	});

	// 1. Schedule a meal into an empty week.
	const scheduledMeal = {
		id: 'dinner-1',
		date: '2026-10-23',
		slot: 'Dinner' as const,
		recipeId: 'stew',
		servings: 2
	};
	const uiScheduled = upsertMeal(base, scheduledMeal, now);
	const basilScheduled = applyButlerCommands(
		base,
		[{ type: 'meal.upsert', meal: scheduledMeal }],
		now
	).state;
	assert.deepEqual(uiScheduled, basilScheduled);
	assert.equal(weekStartForDate('2026-10-23'), '2026-10-19');
	assert.ok(uiScheduled.shopping.some((item) => item.sourceKey === 'week:2026-10-19'));

	// 2. Edit the recipe (updates both week:2026-10-19 and recipe:stew).
	const revisedStew = {
		...stew,
		servings: 4,
		ingredients: [
			{ name: 'carrot', quantity: 6, unit: 'each' },
			{ name: 'celery', quantity: 2, unit: 'each' }
		]
	};
	const uiEdited = saveEditedRecipe(uiScheduled, revisedStew, now);
	const basilEdited = applyButlerCommands(
		basilScheduled,
		[{ type: 'recipe.upsert', recipe: { ...revisedStew, saved: true } }],
		now
	).state;
	assert.deepEqual(uiEdited, basilEdited);

	// 3. Move the planned meal to next week (clears old week, populates new week).
	const movedMeal = { ...scheduledMeal, date: '2026-10-28', servings: 4 };
	const uiMoved = upsertMeal(uiEdited, movedMeal, now);
	const basilMoved = applyButlerCommands(
		basilEdited,
		[{ type: 'meal.upsert', meal: movedMeal }],
		now
	).state;
	assert.deepEqual(uiMoved, basilMoved);
	assert.equal(
		uiMoved.shopping.some((item) => item.sourceKey === 'week:2026-10-19'),
		false
	);
	assert.ok(uiMoved.shopping.some((item) => item.sourceKey === 'week:2026-10-26'));

	// 4. Complete the meal (preserves completion if re-upserted, clears completed week's shopping).
	const uiCompleted = completeMeal(
		uiMoved,
		movedMeal.id,
		{ deductPantry: true, leftoverServings: 1 },
		now
	);
	const basilCompleted = applyButlerCommands(
		basilMoved,
		[{ type: 'meal.complete', id: movedMeal.id, deductPantry: true, leftoverServings: 1 }],
		now
	).state;
	assert.deepEqual(uiCompleted, basilCompleted);
	assert.equal(
		uiCompleted.shopping.some((item) => item.sourceKey === 'week:2026-10-26'),
		false
	);
	const preservedCompletion = upsertMeal(uiCompleted, { ...movedMeal, slot: 'Lunch' }, now);
	assert.equal(preservedCompletion.meals[0].completedAt, now.toISOString());
	assert.equal(preservedCompletion.meals[0].leftoverServings, 1);

	// 5. Add another meal then delete it vs delete the recipe.
	const secondMeal = {
		id: 'dinner-2',
		date: '2026-11-04',
		slot: 'Dinner' as const,
		recipeId: 'stew',
		servings: 4
	};
	const withSecond = upsertMeal(uiCompleted, secondMeal, now);
	assert.deepEqual(
		deleteMeal(withSecond, secondMeal.id, now),
		applyButlerCommands(withSecond, [{ type: 'meal.delete', id: secondMeal.id }], now).state
	);
	assert.deepEqual(
		deleteRecipe(withSecond, 'stew', now),
		applyButlerCommands(withSecond, [{ type: 'recipe.delete', id: 'stew' }], now).state
	);
});
