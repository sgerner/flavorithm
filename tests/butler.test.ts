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
			{
				type: 'pantry.upsert',
				item: {
					id: 'bad-expiry',
					name: 'milk',
					quantity: 1,
					unit: 'l',
					category: 'Dairy',
					expires: '2026-02-30'
				}
			}
		])
	);
	assert.throws(() =>
		applyButlerCommands(current, [
			{
				type: 'pantry.upsert',
				item: {
					id: 'text-expiry',
					name: 'milk',
					quantity: 1,
					unit: 'l',
					category: 'Dairy',
					expires: 'tomorrow'
				}
			}
		])
	);
	const validPantry = applyButlerCommands(current, [
		{
			type: 'pantry.upsert',
			item: {
				id: 'blank-expiry',
				name: 'oats',
				quantity: 1,
				unit: 'kg',
				category: 'Pantry',
				expires: ''
			}
		},
		{
			type: 'pantry.upsert',
			item: {
				id: 'dated-expiry',
				name: 'milk',
				quantity: 1,
				unit: 'l',
				category: 'Dairy',
				expires: '2026-11-19'
			}
		}
	]);
	assert.equal(validPantry.state.pantry.find((item) => item.id === 'blank-expiry')?.expires, '');
	assert.equal(
		validPantry.state.pantry.find((item) => item.id === 'dated-expiry')?.expires,
		'2026-11-19'
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

test('weekly shopping enforces a today floor for overdue uncompleted meals in the week', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	recipe.ingredients = [{ name: 'carrot', quantity: 4, unit: 'each' }];
	current.pantry = [
		{
			id: 'expired-yesterday',
			name: 'carrot',
			quantity: 99,
			unit: 'each',
			category: 'Produce',
			expires: '2026-10-22'
		},
		{
			id: 'expires-today',
			name: 'carrot',
			quantity: 2,
			unit: 'each',
			category: 'Produce',
			expires: '2026-10-23'
		}
	];
	current.shopping = [];
	current.meals = [
		{
			id: 'overdue',
			recipeId: recipe.id,
			date: '2026-10-20',
			slot: 'Dinner',
			servings: recipe.servings
		},
		{
			id: 'today',
			recipeId: recipe.id,
			date: '2026-10-23',
			slot: 'Dinner',
			servings: recipe.servings
		}
	];
	const result = applyButlerCommands(
		current,
		[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
		new Date('2026-10-23T12:00:00Z')
	);
	assert.equal(result.state.shopping[0].quantity, 6);
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

test('butler pantry mutations and cross-week meal moves refresh active and target weekly lists', () => {
	const current = createInitialState();
	const omelette = structuredClone(current.recipes[0]);
	omelette.id = 'omelette';
	omelette.title = 'Omelette';
	omelette.servings = 2;
	omelette.ingredients = [
		{ name: 'eggs', quantity: 3, unit: 'each' },
		{ name: 'butter', quantity: 1, unit: 'tbsp' }
	];
	current.recipes = [omelette];
	current.pantry = [
		{ id: 'pantry-eggs', name: 'eggs', quantity: 3, unit: 'whole', category: 'Dairy & eggs' }
	];
	current.meals = [
		{
			id: 'tue-breakfast',
			date: '2026-10-20',
			slot: 'Breakfast',
			recipeId: 'omelette',
			servings: 2
		}
	];
	current.shopping = [];

	const now = new Date('2026-10-20T09:00:00Z');
	const initialWeek = applyButlerCommands(
		current,
		[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
		now
	).state;
	assert.deepEqual(
		initialWeek.shopping.map((item) => item.name),
		['butter']
	);

	// Deleting eggs from pantry immediately surfaces eggs in the active week:2026-10-19 list.
	const afterEggDelete = applyButlerCommands(
		initialWeek,
		[{ type: 'pantry.delete', id: 'pantry-eggs' }],
		now
	).state;
	assert.deepEqual(
		afterEggDelete.shopping.map((item) => ({ name: item.name, quantity: item.quantity })),
		[
			{ name: 'butter', quantity: 1 },
			{ name: 'eggs', quantity: 3 }
		]
	);

	// Moving the meal to next week clears week:2026-10-19 and populates previously empty week:2026-10-26.
	const afterMove = applyButlerCommands(
		afterEggDelete,
		[
			{
				type: 'meal.upsert',
				meal: {
					id: 'tue-breakfast',
					date: '2026-10-27',
					slot: 'Breakfast',
					recipeId: 'omelette',
					servings: 2
				}
			}
		],
		now
	).state;
	assert.equal(
		afterMove.shopping.some((item) => item.sourceKey === 'week:2026-10-19'),
		false
	);
	assert.deepEqual(
		afterMove.shopping
			.filter((item) => item.sourceKey === 'week:2026-10-26')
			.map((item) => item.name),
		['butter', 'eggs']
	);
});

test('pairing meal commands with explicit shopping edits or deletions preserves the shopping commands', () => {
	const current = createInitialState();
	const pasta = structuredClone(current.recipes[0]);
	pasta.id = 'pasta';
	pasta.servings = 2;
	pasta.ingredients = [
		{ name: 'olive oil', quantity: 2, unit: 'tbsp' },
		{ name: 'garlic', quantity: 3, unit: 'cloves' }
	];
	current.recipes = [pasta];
	current.pantry = [];
	current.meals = [];
	current.shopping = [];

	const now = new Date('2026-10-20T12:00:00Z');
	const scheduled = applyButlerCommands(
		current,
		[
			{
				type: 'meal.upsert',
				meal: {
					id: 'wed-dinner',
					date: '2026-10-21',
					slot: 'Dinner',
					recipeId: 'pasta',
					servings: 2
				}
			}
		],
		now
	).state;
	const oilItem = scheduled.shopping.find((item) => item.name === 'olive oil')!;
	const garlicItem = scheduled.shopping.find((item) => item.name === 'garlic')!;
	assert.ok(oilItem);
	assert.ok(garlicItem);

	const paired = applyButlerCommands(
		scheduled,
		[
			{
				type: 'meal.upsert',
				meal: {
					id: 'fri-dinner',
					date: '2026-10-23',
					slot: 'Dinner',
					recipeId: 'pasta',
					servings: 2
				}
			},
			{
				type: 'shopping.upsert',
				item: {
					id: oilItem.id,
					name: 'olive oil',
					quantity: 1,
					unit: 'cup',
					checked: false,
					sourceKey: oilItem.sourceKey
				}
			},
			{
				type: 'shopping.delete',
				id: garlicItem.id
			}
		],
		now
	).state;

	assert.equal(
		paired.shopping.some((item) => item.id === garlicItem.id),
		false
	);
	const updatedOil = paired.shopping.find((item) => item.id === oilItem.id);
	assert.ok(updatedOil);
	assert.equal(updatedOil.quantity, 1);
	assert.equal(updatedOil.unit, 'cup');
	assert.equal(updatedOil.customized, true);
});

test('ButlerResponseSchema JSON schema requires deductPantry on meal.complete and describes completion fields', () => {
	const schema = z.toJSONSchema(ButlerResponseSchema) as Record<string, any>;
	const variants: Record<string, any>[] =
		schema.properties?.commands?.items?.oneOf ?? schema.properties?.commands?.items?.anyOf ?? [];
	const completeVariant = variants.find(
		(variant) => variant.properties?.type?.const === 'meal.complete'
	);
	assert.ok(completeVariant);
	assert.ok(completeVariant.required?.includes('deductPantry'));
	assert.match(String(completeVariant.properties?.deductPantry?.description ?? ''), /pantry/i);
	assert.match(
		String(completeVariant.properties?.leftoverServings?.description ?? ''),
		/leftover/i
	);

	const upsertVariant = variants.find(
		(variant) => variant.properties?.type?.const === 'meal.upsert'
	);
	assert.ok(upsertVariant);
	assert.match(
		String(upsertVariant.properties?.meal?.properties?.completedAt?.description ?? ''),
		/meal\.complete/
	);
	assert.match(
		String(upsertVariant.properties?.meal?.properties?.leftoverServings?.description ?? ''),
		/leftover/i
	);

	const current = createInitialState();
	assert.throws(() =>
		applyButlerCommands(current, [{ type: 'meal.complete', id: current.meals[0].id }])
	);
});

test('meal.upsert strips completedAt and leftoverServings on uncompleted meals and clamps cooked leftover updates', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	const plannedId = current.meals[0].id;
	const strippedExisting = applyButlerCommands(current, [
		{
			type: 'meal.upsert',
			meal: {
				...current.meals[0],
				completedAt: '2026-10-23T19:00:00.000Z',
				leftoverServings: 2
			}
		}
	]).state;
	const updatedPlanned = strippedExisting.meals.find((meal) => meal.id === plannedId)!;
	assert.equal(updatedPlanned.completedAt, undefined);
	assert.equal(updatedPlanned.leftoverServings, undefined);

	const strippedNew = applyButlerCommands(current, [
		{
			type: 'meal.upsert',
			meal: {
				id: 'sneaky-complete',
				date: '2026-10-25',
				slot: 'Lunch',
				recipeId: recipe.id,
				servings: 3,
				completedAt: '2026-10-25T13:00:00.000Z',
				leftoverServings: 1
			}
		}
	]).state;
	const createdMeal = strippedNew.meals.find((meal) => meal.id === 'sneaky-complete')!;
	assert.equal(createdMeal.completedAt, undefined);
	assert.equal(createdMeal.leftoverServings, undefined);

	const completedAt = '2026-10-22T18:30:00.000Z';
	const cookedState = applyButlerCommands(
		current,
		[{ type: 'meal.complete', id: plannedId, deductPantry: false, leftoverServings: 2 }],
		new Date(completedAt)
	).state;

	// Omitted leftoverServings keeps existing count and preserves original completedAt
	const omittedLeftovers = applyButlerCommands(cookedState, [
		{
			type: 'meal.upsert',
			meal: {
				id: plannedId,
				date: '2026-10-24',
				slot: 'Dinner',
				recipeId: recipe.id,
				servings: 3,
				completedAt: '2026-10-24T20:00:00.000Z'
			}
		}
	]).state;
	const preservedMeal = omittedLeftovers.meals.find((meal) => meal.id === plannedId)!;
	assert.equal(preservedMeal.completedAt, completedAt);
	assert.equal(preservedMeal.leftoverServings, 2);

	// Explicit partial consumption updates leftovers
	const decremented = applyButlerCommands(omittedLeftovers, [
		{
			type: 'meal.upsert',
			meal: {
				...preservedMeal,
				leftoverServings: 1
			}
		}
	]).state;
	assert.equal(decremented.meals.find((meal) => meal.id === plannedId)?.leftoverServings, 1);

	// Explicit update above servings is clamped within servings
	const clamped = applyButlerCommands(decremented, [
		{
			type: 'meal.upsert',
			meal: {
				...preservedMeal,
				servings: 3,
				leftoverServings: 9
			}
		}
	]).state;
	assert.equal(clamped.meals.find((meal) => meal.id === plannedId)?.leftoverServings, 3);
	assert.equal(clamped.meals.find((meal) => meal.id === plannedId)?.completedAt, completedAt);
});

test('applyButlerCommands rejects duplicate pantry reductions alongside meal.complete with deductPantry true', () => {
	const current = createInitialState();
	const recipe = current.recipes[0];
	current.pantry = [
		{ id: 'garlic', name: 'garlic', quantity: 8, unit: 'cloves', category: 'Produce' },
		{ id: 'oil', name: 'olive oil', quantity: 1, unit: 'cup', category: 'Oils' },
		{ id: 'coffee', name: 'coffee beans', quantity: 200, unit: 'g', category: 'Pantry' }
	];
	current.meals = [
		{ id: 'tonight', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];

	// Reducing an existing recipe ingredient before meal.complete(deductPantry: true) fails
	assert.throws(
		() =>
			applyButlerCommands(current, [
				{
					type: 'pantry.upsert',
					item: { id: 'garlic', name: 'garlic', quantity: 5, unit: 'cloves', category: 'Produce' }
				},
				{ type: 'meal.complete', id: 'tonight', deductPantry: true }
			]),
		/already deducts recipe ingredients/
	);

	// Reducing via compatible unit conversion (1 cup -> 14 tbsp) fails
	assert.throws(
		() =>
			applyButlerCommands(current, [
				{
					type: 'pantry.upsert',
					item: {
						id: 'oil',
						name: 'extra virgin olive oil',
						quantity: 14,
						unit: 'tbsp',
						category: 'Oils'
					}
				},
				{ type: 'meal.complete', id: 'tonight', deductPantry: true }
			]),
		/already deducts recipe ingredients/
	);

	// Reducing or overwriting after meal.complete(deductPantry: true) also fails
	assert.throws(
		() =>
			applyButlerCommands(current, [
				{ type: 'meal.complete', id: 'tonight', deductPantry: true },
				{
					type: 'pantry.upsert',
					item: { id: 'garlic', name: 'garlic', quantity: 5, unit: 'cloves', category: 'Produce' }
				}
			]),
		/already deducts recipe ingredients/
	);

	// Deleting an existing recipe ingredient alongside meal.complete(deductPantry: true) fails
	assert.throws(
		() =>
			applyButlerCommands(current, [
				{ type: 'pantry.delete', id: 'garlic' },
				{ type: 'meal.complete', id: 'tonight', deductPantry: true }
			]),
		/already deducts recipe ingredients/
	);

	// Adding new stock, increasing existing stock, or reducing unrelated items still succeeds
	const allowed = applyButlerCommands(current, [
		{
			type: 'pantry.upsert',
			item: { id: 'garlic', name: 'garlic', quantity: 10, unit: 'cloves', category: 'Produce' }
		},
		{
			type: 'pantry.upsert',
			item: {
				id: 'new-potatoes',
				name: 'baby potatoes',
				quantity: 16,
				unit: 'oz',
				category: 'Produce'
			}
		},
		{
			type: 'pantry.upsert',
			item: { id: 'coffee', name: 'coffee beans', quantity: 150, unit: 'g', category: 'Pantry' }
		},
		{ type: 'meal.complete', id: 'tonight', deductPantry: true }
	]).state;
	assert.equal(allowed.pantry.find((item) => item.id === 'garlic')?.quantity, 7);
	assert.equal(allowed.pantry.find((item) => item.id === 'new-potatoes')?.quantity, 4);
	assert.equal(allowed.pantry.find((item) => item.id === 'coffee')?.quantity, 150);

	// Manual pantry reduction is permitted when deductPantry is false
	const manualOnly = applyButlerCommands(current, [
		{
			type: 'pantry.upsert',
			item: { id: 'garlic', name: 'garlic', quantity: 7, unit: 'cloves', category: 'Produce' }
		},
		{ type: 'meal.complete', id: 'tonight', deductPantry: false }
	]).state;
	assert.equal(manualOnly.pantry.find((item) => item.id === 'garlic')?.quantity, 7);
	assert.ok(manualOnly.meals[0].completedAt);
});

test('butler accepts manual provenance, preserves it across edits, and emits recipe-new ui effects', () => {
	const current = createInitialState();
	const manualRecipe = {
		...structuredClone(current.recipes[0]),
		id: 'handwritten-pie',
		title: 'Family Apple Pie',
		provenance: 'manual' as const,
		saved: true
	};
	const added = applyButlerCommands(current, [
		{ type: 'recipe.upsert', recipe: manualRecipe },
		{ type: 'ui', action: 'recipe-new' }
	]);
	assert.equal(
		added.state.recipes.find((item) => item.id === 'handwritten-pie')?.provenance,
		'manual'
	);
	assert.deepEqual(added.effects, [{ type: 'ui', action: 'recipe-new' }]);

	const editedWithoutProvenance = {
		...manualRecipe,
		servings: 6,
		provenance: undefined
	};
	const updated = applyButlerCommands(added.state, [
		{ type: 'recipe.upsert', recipe: editedWithoutProvenance },
		{
			type: 'recipe.upsert',
			recipe: {
				...editedWithoutProvenance,
				title: 'Spiced Family Apple Pie',
				provenance: 'ai-generated'
			}
		}
	]);
	const finalRecipe = updated.state.recipes.find((item) => item.id === 'handwritten-pie');
	assert.equal(finalRecipe?.provenance, 'manual');
	assert.equal(finalRecipe?.title, 'Spiced Family Apple Pie');
	assert.equal(finalRecipe?.nutritionStale, true);
});

test('recipe.delete retains checked recipe purchases and shopping.delete refreshes checked week scopes only', () => {
	const now = new Date('2026-10-23T12:00:00Z');
	const current = createInitialState();
	const recipe = current.recipes[0];
	recipe.ingredients = [
		{ name: 'carrot', quantity: 4, unit: 'each' },
		{ name: 'onion', quantity: 2, unit: 'each' }
	];
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
		{
			id: 'recipe-bought',
			name: 'olive oil',
			quantity: 1,
			unit: 'cup',
			checked: true,
			sourceKey: `recipe:${recipe.id}`
		},
		{
			id: 'recipe-needed',
			name: 'carrot',
			quantity: 4,
			unit: 'each',
			checked: false,
			sourceKey: `recipe:${recipe.id}`
		}
	];

	const afterRecipeDelete = applyButlerCommands(
		current,
		[{ type: 'recipe.delete', id: recipe.id }],
		now
	).state;
	assert.deepEqual(afterRecipeDelete.shopping, [
		{
			id: 'recipe-bought',
			name: 'olive oil',
			quantity: 1,
			unit: 'cup',
			checked: true,
			sourceKey: `recipe:${recipe.id}`
		}
	]);

	// Weekly shopping: generate week, dismiss unchecked onion, check carrot, then delete checked carrot
	const generated = applyButlerCommands(
		{ ...current, shopping: [] },
		[{ type: 'shopping.generate', weekStart: '2026-10-19' }],
		now
	).state;
	const onion = generated.shopping.find((item) => item.name === 'onion')!;
	const afterDismissOnion = applyButlerCommands(
		generated,
		[{ type: 'shopping.delete', id: onion.id }],
		now
	).state;
	assert.equal(
		afterDismissOnion.shopping.some((item) => item.name === 'onion'),
		false
	);

	const carrot = afterDismissOnion.shopping.find((item) => item.name === 'carrot')!;
	const withCheckedCarrot = applyButlerCommands(
		afterDismissOnion,
		[{ type: 'shopping.upsert', item: { ...carrot, checked: true } }],
		now
	).state;
	const afterDeleteCheckedCarrot = applyButlerCommands(
		withCheckedCarrot,
		[{ type: 'shopping.delete', id: carrot.id }],
		now
	).state;
	const refreshedCarrot = afterDeleteCheckedCarrot.shopping.find((item) => item.name === 'carrot');
	assert.ok(refreshedCarrot);
	assert.equal(refreshedCarrot.checked, false);
	assert.equal(refreshedCarrot.quantity, 4);
	assert.equal(refreshedCarrot.sourceKey, 'week:2026-10-19');
});
