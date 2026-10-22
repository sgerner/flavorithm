import test from 'node:test';
import assert from 'node:assert/strict';
import { rankRecipes } from '../src/lib/discovery.ts';
import {
	normalizeName as normalizeDomainName,
	unitInfo as domainUnitInfo
} from '../src/lib/domain.ts';
import {
	completeMeal,
	convertCompatibleQuantity,
	expiryStatus,
	normalizeIngredientName,
	reconcileShoppingList
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
	assert.equal(convertCompatibleQuantity(1, 'cup', 'g'), undefined);
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
