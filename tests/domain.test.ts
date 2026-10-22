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

function pantry(name: string, quantity: number, unit: string): Ingredient {
	return { id: `${name}-${unit}`, name, quantity, unit, category: 'Test' };
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
