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

test('ButlerResponseSchema produces expected JSON Schema and rejects non-finite numbers and invalid datetimes', () => {
	const schema = z.toJSONSchema(ButlerResponseSchema) as Record<string, any>;
	assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
	assert.equal(schema.type, 'object');
	assert.deepEqual(schema.required, ['reply', 'commands']);
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.reply, {
		type: 'string',
		minLength: 1,
		maxLength: 12000
	});
	assert.equal(schema.properties.commands.type, 'array');
	assert.equal(schema.properties.commands.maxItems, 50);

	const variants = schema.properties.commands.items.oneOf as Array<Record<string, any>>;
	assert.equal(variants.length, 14);

	const recipeUpsert = variants.find((item) => item.properties.type.const === 'recipe.upsert')!;
	assert.deepEqual(recipeUpsert.properties.recipe.properties.servings, {
		type: 'number',
		minimum: 1,
		maximum: 10000
	});
	assert.deepEqual(recipeUpsert.properties.recipe.properties.nutrition.properties.calories, {
		type: 'number',
		minimum: 0,
		maximum: 1000000
	});

	const mealUpsert = variants.find((item) => item.properties.type.const === 'meal.upsert')!;
	assert.deepEqual(mealUpsert.properties.meal.properties.servings, {
		type: 'number',
		minimum: 1,
		maximum: 10000
	});
	const completedAtSchema = mealUpsert.properties.meal.properties.completedAt;
	assert.equal(completedAtSchema.type, 'string');
	assert.equal(completedAtSchema.format, 'date-time');
	assert.equal(new RegExp(completedAtSchema.pattern).test('2026-10-22T12:00:00Z'), true);
	assert.equal(new RegExp(completedAtSchema.pattern).test('2026-10-22 12:00:00'), false);

	const preferencesUpdate = variants.find(
		(item) => item.properties.type.const === 'preferences.update'
	)!;
	assert.deepEqual(preferencesUpdate.properties.preferences.properties.maxTime, {
		type: 'number',
		minimum: 0,
		maximum: 100000
	});
	assert.equal(preferencesUpdate.properties.preferences.additionalProperties, false);

	assert.equal(
		ButlerResponseSchema.safeParse({
			reply: 'Planned dinner.',
			commands: [
				{
					type: 'meal.upsert',
					meal: {
						id: 'dinner',
						date: '2026-10-23',
						slot: 'Dinner',
						recipeId: 'soup',
						servings: 2,
						completedAt: '2026-10-23T18:30:00.000Z'
					}
				}
			]
		}).success,
		true
	);
	assert.equal(
		ButlerResponseSchema.safeParse({
			reply: 'Bad timestamp.',
			commands: [
				{
					type: 'meal.upsert',
					meal: {
						id: 'dinner',
						date: '2026-10-23',
						slot: 'Dinner',
						recipeId: 'soup',
						servings: 2,
						completedAt: '2026-10-23 18:30:00'
					}
				}
			]
		}).success,
		false
	);
	for (const badValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.equal(
			ButlerResponseSchema.safeParse({
				reply: 'Non-finite pantry quantity.',
				commands: [
					{
						type: 'pantry.upsert',
						item: {
							id: 'salt',
							name: 'Salt',
							quantity: badValue,
							unit: 'tsp',
							category: 'Spices'
						}
					}
				]
			}).success,
			false
		);
	}
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

test('standalone meal.upsert populates shopping for empty weeks and updates both weeks when moving a meal', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [
		{ name: 'carrot', quantity: 4, unit: 'each' },
		{ name: 'garlic', quantity: 2, unit: 'cloves' }
	];
	current.pantry = [
		{ id: 'carrots', name: 'carrot', quantity: 1, unit: 'each', category: 'Produce' }
	];
	current.meals = [];
	current.shopping = [{ id: 'manual', name: 'coffee', quantity: 1, unit: 'bag', checked: false }];
	const now = new Date('2026-10-22T12:00:00Z');

	const scheduled = applyButlerCommands(
		current,
		[
			{
				type: 'meal.upsert',
				meal: {
					id: 'friday-dinner',
					date: '2026-10-23',
					slot: 'Dinner',
					recipeId: recipe.id,
					servings: 2
				}
			}
		],
		now
	).state;
	const firstWeek = scheduled.shopping.filter((item) => item.sourceKey === 'week:2026-10-19');
	assert.deepEqual(
		firstWeek.map(({ name, quantity, unit }) => ({ name, quantity, unit })),
		[
			{ name: 'carrot', quantity: 3, unit: 'each' },
			{ name: 'garlic', quantity: 2, unit: 'clove' }
		]
	);

	// Mark 1 carrot purchased in week:2026-10-19, then move the meal to next week (2026-10-26).
	scheduled.shopping = scheduled.shopping.map((item) =>
		item.sourceKey === 'week:2026-10-19' && item.name === 'carrot'
			? { ...item, quantity: 1, checked: true }
			: item
	);
	const moved = applyButlerCommands(
		scheduled,
		[
			{
				type: 'meal.upsert',
				meal: {
					id: 'friday-dinner',
					date: '2026-10-28',
					slot: 'Dinner',
					recipeId: recipe.id,
					servings: 4
				}
			}
		],
		now
	).state;

	assert.deepEqual(
		moved.shopping
			.filter((item) => item.sourceKey === 'week:2026-10-19')
			.map(({ name, checked, quantity }) => ({ name, checked, quantity })),
		[{ name: 'carrot', checked: true, quantity: 1 }]
	);
	assert.deepEqual(
		moved.shopping
			.filter((item) => item.sourceKey === 'week:2026-10-26')
			.map(({ name, quantity, unit }) => ({ name, quantity, unit })),
		[
			{ name: 'carrot', quantity: 7, unit: 'each' },
			{ name: 'garlic', quantity: 4, unit: 'clove' }
		]
	);
	assert.ok(moved.shopping.some((item) => item.id === 'manual'));
});

test('recipe.upsert refreshes scheduled week and existing recipe scopes, and recipe.open supports unsaved edit mode', () => {
	const current = createInitialState();
	const target = structuredClone(current.recipes[0]);
	target.saved = false;
	target.servings = 2;
	target.ingredients = [{ name: 'tomato', quantity: 2, unit: 'each' }];
	current.recipes = [target];
	current.pantry = [];
	current.meals = [
		{ id: 'tue', date: '2026-10-20', slot: 'Dinner', recipeId: target.id, servings: 4 }
	];
	current.shopping = [
		{
			id: 'recipe-tomato',
			name: 'tomato',
			quantity: 2,
			unit: 'each',
			checked: false,
			sourceKey: `recipe:${target.id}`
		}
	];
	const now = new Date('2026-10-20T12:00:00Z');

	const result = applyButlerCommands(
		current,
		[
			{
				type: 'recipe.upsert',
				recipe: {
					...target,
					ingredients: [{ name: 'tomato', quantity: 3, unit: 'each' }]
				}
			},
			{ type: 'recipe.open', id: target.id, mode: 'edit' }
		],
		now
	);

	assert.equal(
		result.state.shopping.find((item) => item.sourceKey === 'week:2026-10-19')?.quantity,
		6
	);
	assert.equal(
		result.state.shopping.find((item) => item.sourceKey === `recipe:${target.id}`)?.quantity,
		3
	);
	assert.deepEqual(result.effects, [{ type: 'recipe.open', id: target.id, mode: 'edit' }]);
});
