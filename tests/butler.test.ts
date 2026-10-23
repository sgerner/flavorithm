import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createInitialState } from '../src/lib/data.ts';
import { applyButlerCommands, ButlerResponseSchema } from '../src/lib/butler.ts';

test('butler proposals apply atomically and validate references', () => {
	const current = createInitialState();
	const original = structuredClone(current);
	assert.throws(() =>
		applyButlerCommands(current, [
			{ type: 'preferences.update', preferences: { diet: 'vegetarian' } },
			{
				type: 'meal.upsert',
				meal: {
					id: 'missing',
					date: '2026-10-23',
					slot: 'Dinner',
					recipeId: 'missing',
					servings: 2
				}
			}
		])
	);
	assert.deepEqual(current, original);
});
test('butler can create recipes, schedule meals, generate shopping and consume pantry', () => {
	const current = createInitialState();
	current.recipes = [];
	current.meals = [];
	current.shopping = [];
	current.pantry = [];
	const nutrition = {
		calories: 10,
		fat: 0,
		saturatedFat: 0,
		sodium: 0,
		carbs: 0,
		fiber: 0,
		sugar: 0,
		protein: 0
	};
	const result = applyButlerCommands(
		current,
		[
			{
				type: 'recipe.upsert',
				recipe: {
					id: 'soup',
					title: 'Soup',
					description: 'Warm',
					image: '',
					time: 10,
					servings: 2,
					difficulty: 'Easy',
					cuisine: 'British',
					tags: [],
					ingredients: [{ name: 'carrot', quantity: 4, unit: 'each' }],
					steps: ['Cook'],
					nutrition
				}
			},
			{
				type: 'pantry.upsert',
				item: { id: 'carrots', name: 'carrot', quantity: 2, unit: 'each', category: 'Produce' }
			},
			{
				type: 'meal.upsert',
				meal: { id: 'dinner', date: '2026-10-23', slot: 'Dinner', recipeId: 'soup', servings: 2 }
			},
			{ type: 'shopping.generate' },
			{ type: 'recipe.open', id: 'soup' },
			{ type: 'meal.complete', id: 'dinner', deductPantry: true, leftoverServings: 1 }
		],
		new Date('2026-10-23T12:00:00Z')
	);
	assert.equal(result.state.shopping.length, 0);
	assert.equal(result.state.pantry[0].quantity, 0);
	assert.equal(result.state.meals[0].leftoverServings, 1);
	assert.equal(result.effects[0].type, 'recipe.open');
	assert.equal(current.recipes.length, 0);
});
test('recipe deletion cleans meal references and ratings', () => {
	const current = createInitialState();
	const id = current.recipes[0].id;
	current.meals = [{ id: 'meal', recipeId: id, date: '2026-10-23', slot: 'Dinner', servings: 2 }];
	current.preferences.ratings = { [id]: 5 };
	const result = applyButlerCommands(current, [{ type: 'recipe.delete', id }]);
	assert.equal(result.state.meals.length, 0);
	assert.equal(result.state.preferences.ratings?.[id], undefined);
});
test('unsupported actions, unsafe images, invalid calendar dates and preference keys fail', () => {
	const current = createInitialState();
	assert.throws(() => applyButlerCommands(current, [{ type: 'ui', action: 'execute' }]));
	assert.throws(() =>
		applyButlerCommands(current, [
			{ type: 'preferences.update', preferences: { __unknown: 'value' } }
		])
	);
	assert.throws(() =>
		applyButlerCommands(current, [
			{
				type: 'meal.upsert',
				meal: {
					id: 'bad',
					date: '2026-02-31',
					slot: 'Dinner',
					recipeId: current.recipes[0].id,
					servings: 1
				}
			}
		])
	);
	assert.throws(() =>
		applyButlerCommands(current, [
			{ type: 'recipe.upsert', recipe: { ...current.recipes[0], image: 'javascript:alert(1)' } }
		])
	);
	assert.doesNotThrow(() => z.toJSONSchema(ButlerResponseSchema));
});

test('weekly shopping ignores cooked meals and expired pantry and shares the UI scope', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	recipe.ingredients = [{ name: 'carrot', quantity: 4, unit: 'each' }];
	current.pantry = [
		{
			id: 'expired',
			name: 'carrot',
			quantity: 99,
			unit: 'each',
			category: 'Produce',
			expires: '2026-10-01'
		}
	];
	current.shopping = [];
	current.meals = [
		{
			id: 'needed',
			recipeId: recipe.id,
			date: '2026-10-23',
			slot: 'Dinner',
			servings: recipe.servings
		},
		{
			id: 'cooked',
			recipeId: recipe.id,
			date: '2026-10-22',
			slot: 'Dinner',
			servings: recipe.servings,
			completedAt: '2026-10-22T12:00:00Z'
		},
		{
			id: 'future',
			recipeId: recipe.id,
			date: '2026-11-20',
			slot: 'Dinner',
			servings: recipe.servings
		}
	];
	const result = applyButlerCommands(
		current,
		[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
		new Date('2026-10-23T12:00:00Z')
	);
	assert.equal(result.state.shopping[0].quantity, 4);
	assert.equal(result.state.shopping[0].sourceKey, 'week:2026-10-19');
	assert.deepEqual(
		applyButlerCommands(
			result.state,
			[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
			new Date('2026-10-23T12:00:00Z')
		).state.shopping,
		result.state.shopping
	);
});
test('recipe edits preserve nutrition staleness and synchronize ratings', () => {
	const current = createInitialState();
	const recipe = structuredClone(current.recipes[0]);
	recipe.servings += 1;
	recipe.rating = 4;
	recipe.nutritionStale = false;
	const result = applyButlerCommands(current, [{ type: 'recipe.upsert', recipe }]);
	assert.equal(result.state.recipes.find((item) => item.id === recipe.id)?.nutritionStale, true);
	assert.equal(result.state.preferences.ratings?.[recipe.id], 4);
});
test('storage overflow and fractional serving proposals fail atomically', () => {
	const current = createInitialState();
	current.pantry = Array.from({ length: 1000 }, (_, index) => ({
		id: String(index),
		name: 'carrot',
		quantity: 1,
		unit: 'each',
		category: 'Produce'
	}));
	assert.throws(
		() =>
			applyButlerCommands(current, [
				{
					type: 'pantry.upsert',
					item: { id: 'overflow', name: 'onion', quantity: 1, unit: 'each', category: 'Produce' }
				}
			]),
		/storage limit/
	);
	assert.equal(current.pantry.length, 1000);
	assert.throws(() =>
		applyButlerCommands(current, [
			{
				type: 'meal.upsert',
				meal: {
					id: 'fraction',
					date: '2026-10-23',
					slot: 'Dinner',
					recipeId: current.recipes[0].id,
					servings: 0.5
				}
			}
		])
	);
});

test('recipe deletion refreshes generated shopping while retaining manual items', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	recipe.ingredients = [{ name: 'carrot', quantity: 4, unit: 'each' }];
	current.pantry = [];
	current.meals = [
		{
			id: 'meal',
			recipeId: recipe.id,
			date: '2026-10-23',
			slot: 'Dinner',
			servings: recipe.servings
		}
	];
	current.shopping = [
		{ id: 'manual', name: 'tea', quantity: 1, unit: 'box', checked: false },
		{
			id: 'recipe-generated',
			name: 'carrot',
			quantity: 4,
			unit: 'each',
			checked: false,
			sourceKey: `recipe:${recipe.id}`
		}
	];
	const now = new Date('2026-10-23T12:00:00Z');
	const generated = applyButlerCommands(
		current,
		[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
		now
	).state;
	assert.equal(generated.shopping.length, 3);
	const result = applyButlerCommands(generated, [{ type: 'recipe.delete', id: recipe.id }], now);
	assert.deepEqual(result.state.shopping, [
		{ id: 'manual', name: 'tea', quantity: 1, unit: 'box', checked: false }
	]);
});
