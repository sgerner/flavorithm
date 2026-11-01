import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, seedRecipes } from '../src/lib/data.ts';
import { buildShoppingList, preferenceSummary } from '../src/lib/domain.ts';
import type { Ingredient, Meal, Recipe } from '../src/lib/types.ts';

function recipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'pasta',
		title: 'Herby pasta',
		description: '',
		image: '',
		time: 20,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Italian',
		tags: ['quick', 'vegetarian'],
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

function pantry(name: string, quantity: number, unit: string, expires?: string): Ingredient {
	return { id: `${name}-${unit}`, name, quantity, unit, category: 'Test', expires };
}

test('deduplicates common ingredient names and converts compatible units before subtracting pantry', () => {
	const recipes = [
		recipe({
			ingredients: [
				{ name: 'olive oil', quantity: 1, unit: 'cup' },
				{ name: 'green onions', quantity: 2, unit: 'whole' }
			]
		}),
		recipe({
			id: 'soup',
			ingredients: [
				{ name: 'extra virgin olive oil', quantity: 1, unit: 'tbsp' },
				{ name: 'scallions', quantity: 1, unit: 'piece' }
			]
		})
	];
	const result = buildShoppingList(recipes, [
		pantry('olive oil', 0.25, 'cup'),
		pantry('green onion', 1, 'each')
	]);
	const oil = result.find((item) => item.name === 'olive oil');
	const scallions = result.find((item) => item.name === 'green onions');
	assert.ok(oil);
	assert.equal(oil.unit, 'cup');
	assert.ok(Math.abs(oil.quantity - 0.81) < 0.01);
	assert.ok(scallions);
	assert.equal(scallions.quantity, 2);
	assert.equal(scallions.unit, 'each');
});

test('an explicit meal plan scales servings and excludes unplanned recipes', () => {
	const recipes = [
		recipe({ ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }] }),
		recipe({
			id: 'soup',
			title: 'Soup',
			ingredients: [{ name: 'lentils', quantity: 2, unit: 'cups' }]
		})
	];
	const meals: Meal[] = [
		{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: 'pasta', servings: 4 }
	];
	const result = buildShoppingList(recipes, [], meals);
	assert.deepEqual(
		result.map(({ name, quantity }) => ({ name, quantity })),
		[{ name: 'rice', quantity: 2 }]
	);
	assert.deepEqual(buildShoppingList(recipes, [], []), []);
});

test('shopping allocates pantry lots by meal date so expired leftovers do not cover later meals', () => {
	const tomatoRecipe = recipe({
		servings: 2,
		ingredients: [{ name: 'tomato', quantity: 50, unit: 'g' }]
	});
	const result = buildShoppingList(
		[tomatoRecipe],
		[
			pantry('tomato', 100, 'g', '2026-10-24'),
			{ ...pantry('tomatoes', 50, 'g'), expires: '2026-10-31' }
		],
		[
			{ id: 'later', date: '2026-10-26', slot: 'Dinner', recipeId: 'pasta', servings: 4 },
			{ id: 'earlier', date: '2026-10-22', slot: 'Dinner', recipeId: 'pasta', servings: 2 }
		]
	);

	assert.equal(result.length, 1);
	assert.equal(result[0].name, 'tomato');
	assert.equal(result[0].quantity, 50);
	assert.equal(result[0].unit, 'g');
});

test('a blank recipe serving baseline cannot use pantry stock to claim the recipe is covered', () => {
	const recipeWithBlankServings = recipe({
		servings: '' as unknown as number,
		ingredients: [{ name: 'egg', quantity: 2, unit: 'each' }]
	});
	const result = buildShoppingList([recipeWithBlankServings], [pantry('eggs', 2, 'each')]);

	assert.equal(result.length, 1);
	assert.equal(result[0].quantity, 2);
});

test('standard culinary volume units convert while package sizes remain unrelated', () => {
	const recipes = [recipe({ ingredients: [{ name: 'broth', quantity: 1, unit: 'quart' }] })];
	const covered = buildShoppingList(recipes, [pantry('broth', 2, 'pints')]);
	assert.deepEqual(covered, []);

	const packageSizeIsUnknown = buildShoppingList(recipes, [pantry('broth', 1, 'package')]);
	assert.equal(packageSizeIsUnknown.length, 1);
	assert.equal(packageSizeIsUnknown[0].quantity, 1);
	assert.equal(packageSizeIsUnknown[0].unit, 'qt');
});

test('unplanned and blank-date shopping requests check expiry against today', () => {
	const riceRecipe = recipe({
		ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }]
	});
	const expiredRice = [pantry('rice', 1, 'cup', '2026-10-21')];
	const now = new Date(2026, 9, 22, 12);
	const unplanned = buildShoppingList([riceRecipe], expiredRice, undefined, now);
	const blankDate = buildShoppingList(
		[riceRecipe],
		expiredRice,
		[{ id: 'dinner', date: '', slot: 'Dinner', recipeId: 'pasta', servings: 2 }],
		now
	);

	assert.equal(unplanned[0].quantity, 1);
	assert.equal(blankDate[0].quantity, 1);
});

test('pantry subtraction stays within the same measurement dimension', () => {
	const result = buildShoppingList(
		[recipe({ ingredients: [{ name: 'olive oil', quantity: 1, unit: 'cup' }] })],
		[pantry('olive oil', 10, 'g')]
	);
	assert.equal(result.length, 1);
	assert.equal(result[0].quantity, 1);
	assert.equal(result[0].unit, 'cup');
});

test('ratings produce a compact signal and unscored collections stay neutral', () => {
	assert.match(preferenceSummary([]), /No recipe ratings yet/);
	const summary = preferenceSummary([
		recipe({ title: 'Bright bowl', cuisine: 'Greek', tags: ['vegetarian', 'lemony'], rating: 5 }),
		recipe({ id: 'bland', title: 'Bland stew', rating: 2 })
	]);
	assert.match(summary, /Bright bowl/);
	assert.match(summary, /Greek/);
	assert.match(summary, /Bland stew/);
});

test('starter recipes have distinct Unsplash images, complete cooking directions, and fresh initial state', () => {
	assert.equal(seedRecipes.length, 8);
	assert.equal(new Set(seedRecipes.map((item) => item.image)).size, seedRecipes.length);
	for (const item of seedRecipes) {
		assert.match(item.image, /^https:\/\/images\.unsplash\.com\/photo-/);
		assert.ok(item.ingredients.length >= 8);
		assert.ok(item.steps.length >= 4);
		assert.ok(item.nutrition.calories > 0);
	}
	const first = createInitialState();
	const second = createInitialState();
	assert.equal(first.meals.length, 3);
	first.pantry[0].quantity += 1;
	assert.notEqual(first.pantry[0].quantity, second.pantry[0].quantity);
	assert.notEqual(first.recipes[0].ingredients, second.recipes[0].ingredients);
});
