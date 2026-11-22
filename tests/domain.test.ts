import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, seedRecipes } from '../src/lib/data.ts';
import { rankRecipes } from '../src/lib/discovery.ts';
import {
	buildShoppingList,
	normalizeName,
	parseCalendarDate,
	parseIngredientInput,
	parseIngredientLine,
	parseIngredientLines,
	preferenceSummary,
	unitInfo
} from '../src/lib/domain.ts';
import { completeMeal, transferPurchasedItemsToPantry } from '../src/lib/kitchen-workflows.ts';
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
		],
		new Date(2026, 9, 20, 12)
	);

	assert.equal(result.length, 1);
	assert.equal(result[0].name, 'tomato');
	assert.equal(result[0].quantity, 50);
	assert.equal(result[0].unit, 'g');
});

test('parseCalendarDate validates real calendar dates and keeps ISO date prefixes across timezones', () => {
	assert.deepEqual(parseCalendarDate('2026-10-22'), { year: 2026, month: 9, day: 22 });
	assert.deepEqual(parseCalendarDate('2024-02-29'), { year: 2024, month: 1, day: 29 });
	assert.deepEqual(parseCalendarDate('2026-11-19T00:00:00Z'), { year: 2026, month: 10, day: 19 });
	assert.deepEqual(parseCalendarDate('2026-11-19T23:59:59.000+05:30'), {
		year: 2026,
		month: 10,
		day: 19
	});
	assert.equal(parseCalendarDate('2026-02-29'), undefined);
	assert.equal(parseCalendarDate('2026-02-30'), undefined);
	assert.equal(parseCalendarDate('2026-02-30T00:00:00Z'), undefined);
	assert.equal(parseCalendarDate('2026-11-19T25:00:00Z'), undefined);
	assert.equal(parseCalendarDate('10/22/2026'), undefined);
	assert.equal(parseCalendarDate('soon'), undefined);
	assert.equal(parseCalendarDate(''), undefined);
});

test('overdue meals enforce a today floor while keeping today-expiring, ISO, and blank lots usable', () => {
	const tomatoRecipe = recipe({
		servings: 2,
		ingredients: [{ name: 'tomato', quantity: 50, unit: 'g' }]
	});
	const now = new Date(2026, 9, 22, 12);

	const expiredAndInvalidSkipped = buildShoppingList(
		[tomatoRecipe],
		[
			pantry('tomato', 50, 'g', '2026-10-21'),
			{ ...pantry('tomato', 50, 'g'), id: 'invalid-feb', expires: '2026-02-30' },
			{ ...pantry('tomato', 50, 'g'), id: 'invalid-text', expires: 'next week' }
		],
		[{ id: 'overdue', date: '2026-10-20', slot: 'Dinner', recipeId: 'pasta', servings: 2 }],
		now
	);
	assert.equal(expiredAndInvalidSkipped.length, 1);
	assert.equal(expiredAndInvalidSkipped[0].quantity, 50);

	const todayFloorAllocation = buildShoppingList(
		[tomatoRecipe],
		[
			{ ...pantry('tomato', 50, 'g'), id: 'today-lot', expires: '2026-10-22' },
			{ ...pantry('tomato', 25, 'g'), id: 'blank-lot', expires: '' }
		],
		[
			{ id: 'future', date: '2026-10-25', slot: 'Dinner', recipeId: 'pasta', servings: 2 },
			{ id: 'overdue', date: '2026-10-20', slot: 'Dinner', recipeId: 'pasta', servings: 2 }
		],
		now
	);
	assert.equal(todayFloorAllocation.length, 1);
	assert.equal(todayFloorAllocation[0].quantity, 25);

	const isoUtcSameDay = buildShoppingList(
		[tomatoRecipe],
		[pantry('tomato', 50, 'g', '2026-11-19T00:00:00Z')],
		[{ id: 'same-day', date: '2026-11-19', slot: 'Dinner', recipeId: 'pasta', servings: 2 }],
		new Date(2026, 10, 19, 20)
	);
	assert.deepEqual(isoUtcSameDay, []);

	const invalidNow = buildShoppingList(
		[tomatoRecipe],
		[pantry('tomato', 50, 'g', '2000-01-01')],
		undefined,
		new Date(Number.NaN)
	);
	assert.equal(invalidNow.length, 1);
	assert.equal(invalidNow[0].quantity, 50);
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

test('parses typed quantities, fractions, culinary units, and unitless entries', () => {
	assert.deepEqual(parseIngredientInput('2 cups jasmine rice'), {
		name: 'jasmine rice',
		quantity: 2,
		unit: 'cup',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('1 1/2 tbsp of olive oil'), {
		name: 'olive oil',
		quantity: 1.5,
		unit: 'tbsp',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('½ tsp kosher salt'), {
		name: 'kosher salt',
		quantity: 0.5,
		unit: 'tsp',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('200g pasta'), {
		name: 'pasta',
		quantity: 200,
		unit: 'g',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('12 fl. oz. chicken broth'), {
		name: 'chicken broth',
		quantity: 12,
		unit: 'fl oz',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('1 large head broccoli'), {
		name: 'broccoli',
		quantity: 1,
		unit: 'head',
		hasExplicitQuantity: true,
		hasExplicitUnit: true
	});
	assert.deepEqual(parseIngredientInput('2 eggs'), {
		name: 'eggs',
		quantity: 2,
		unit: 'each',
		hasExplicitQuantity: true,
		hasExplicitUnit: false
	});
	assert.deepEqual(parseIngredientInput('2% milk'), {
		name: '2% milk',
		quantity: 1,
		unit: 'each',
		hasExplicitQuantity: false,
		hasExplicitUnit: false
	});
	assert.deepEqual(unitInfo(''), unitInfo('each'));
});

test('parseIngredientLines parses fractions, connectors, categories, and trailing-name unit rules', () => {
	const parsed = parseIngredientLines(
		[
			'3 item avocado [Produce]',
			'2 tablespoons olive oil',
			'500 grams chicken breast',
			'2 cups of basmati rice',
			'1/2 cup milk',
			'1 1/2 cups flour',
			'2 eggs'
		].join('\n')
	);

	assert.deepEqual(parsed, [
		{ name: 'avocado', quantity: 3, unit: 'each', category: 'Produce' },
		{ name: 'olive oil', quantity: 2, unit: 'tbsp', category: 'Pantry' },
		{ name: 'chicken breast', quantity: 500, unit: 'g', category: 'Pantry' },
		{ name: 'basmati rice', quantity: 2, unit: 'cup', category: 'Pantry' },
		{ name: 'milk', quantity: 0.5, unit: 'cup', category: 'Pantry' },
		{ name: 'flour', quantity: 1.5, unit: 'cup', category: 'Pantry' },
		{ name: 'eggs', quantity: 2, unit: 'each', category: 'Pantry' }
	]);

	assert.deepEqual(parseIngredientLine('½ tsp kosher salt'), {
		name: 'kosher salt',
		quantity: 0.5,
		unit: 'tsp',
		category: 'Pantry'
	});
	assert.deepEqual(parseIngredientLine('1½ cups of rolled oats [Grains]'), {
		name: 'rolled oats',
		quantity: 1.5,
		unit: 'cup',
		category: 'Grains'
	});
	assert.deepEqual(parseIngredientLine('1-1/2 bunches cilantro [Produce]'), {
		name: 'cilantro',
		quantity: 1.5,
		unit: 'bunch',
		category: 'Produce'
	});
	assert.deepEqual(parseIngredientLine('1 large head of broccoli'), {
		name: 'broccoli',
		quantity: 1,
		unit: 'head',
		category: 'Pantry'
	});
	assert.deepEqual(parseIngredientLine('2 fluid ounces lemon juice'), {
		name: 'lemon juice',
		quantity: 2,
		unit: 'fl oz',
		category: 'Pantry'
	});
	assert.deepEqual(parseIngredientLine('2 green onions'), {
		name: 'green onions',
		quantity: 2,
		unit: 'each',
		category: 'Pantry'
	});
	assert.deepEqual(parseIngredientLine('2 cupcakes'), {
		name: 'cupcakes',
		quantity: 2,
		unit: 'each',
		category: 'Pantry'
	});
	assert.deepEqual(parseIngredientLines('spinach, 200g pasta; 2 eggs [Dairy, eggs]'), [
		{ name: 'spinach', quantity: 1, unit: 'each', category: 'Pantry' },
		{ name: 'pasta', quantity: 200, unit: 'g', category: 'Pantry' },
		{ name: 'eggs', quantity: 2, unit: 'each', category: 'Dairy, eggs' }
	]);
	assert.equal(parseIngredientLine('   '), undefined);
	assert.equal(parseIngredientLine('[Produce]'), undefined);
	assert.equal(parseIngredientLine('0 eggs'), undefined);
	assert.equal(parseIngredientLine('1/0 cup milk'), undefined);
});

test('parseIngredientLine recognizes all 77 registered unit aliases', () => {
	const allAliases = [
		'g',
		'gram',
		'grams',
		'kg',
		'kilogram',
		'kilograms',
		'mg',
		'milligram',
		'milligrams',
		'oz',
		'ounce',
		'ounces',
		'lb',
		'lbs',
		'pound',
		'pounds',
		'ml',
		'milliliter',
		'milliliters',
		'millilitre',
		'millilitres',
		'l',
		'liter',
		'liters',
		'litre',
		'litres',
		'tsp',
		'teaspoon',
		'teaspoons',
		'tbsp',
		'tablespoon',
		'tablespoons',
		'cup',
		'cups',
		'fl oz',
		'fl. oz',
		'fluid oz',
		'fluid ounce',
		'fluid ounces',
		'pt',
		'pint',
		'pints',
		'qt',
		'quart',
		'quarts',
		'gal',
		'gallon',
		'gallons',
		'ea',
		'each',
		'item',
		'items',
		'piece',
		'pieces',
		'whole',
		'egg',
		'eggs',
		'small',
		'medium',
		'large',
		'bunch',
		'bunches',
		'clove',
		'cloves',
		'head',
		'heads',
		'small head',
		'medium head',
		'large head',
		'slice',
		'slices',
		'can',
		'cans',
		'pinch',
		'pinches',
		'dash',
		'dashes'
	];
	assert.equal(allAliases.length, 77);
	for (const alias of allAliases) {
		const parsed = parseIngredientLine(`2 ${alias} test ingredient`);
		assert.ok(parsed, `expected ${alias} to parse`);
		assert.equal(parsed.quantity, 2);
		assert.equal(parsed.unit, unitInfo(alias).display);
		assert.equal(parsed.name, 'test ingredient');
	}
});

test('quick-add, dictated, and scanned lines match in rankRecipes, buildShoppingList, and completeMeal', () => {
	const quickAddText = '2 tablespoons extra virgin olive oil, 1 1/2 cups of basmati rice';
	const dictatedText = '500 grams boneless chicken breast, 2 bunches fresh parsley';
	const visionItems = [
		{ name: 'avocadoes', quantity: 3, unit: 'items', category: 'Produce' },
		{ name: 'roma tomatoes', quantity: 4, unit: 'each', category: 'Produce' }
	];
	const scannedText = visionItems
		.map((i) => `${i.quantity} ${unitInfo(i.unit).display} ${i.name} [${i.category}]`)
		.join('\n');

	const combinedInput = [[quickAddText, dictatedText].filter(Boolean).join(', '), scannedText].join(
		'\n'
	);
	const parsed = parseIngredientLines(combinedInput);
	const stockedPantry = transferPurchasedItemsToPantry(
		[],
		parsed.map((item, idx) => ({
			id: `add-${idx}`,
			name: item.name,
			quantity: item.quantity,
			unit: item.unit,
			category: item.category,
			checked: true
		})),
		(() => {
			let n = 0;
			return () => `lot-${++n}`;
		})()
	);

	assert.equal(
		stockedPantry.find((item) => normalizeName(item.name) === 'avocado')?.category,
		'Produce'
	);
	assert.equal(
		stockedPantry.find((item) => normalizeName(item.name) === 'olive oil')?.category,
		'Pantry'
	);

	const stockedBowl = recipe({
		id: 'stocked-bowl',
		title: 'Chicken avocado rice bowl',
		ingredients: [
			{ name: 'chicken breast', quantity: 400, unit: 'g' },
			{ name: 'basmati rice', quantity: 1, unit: 'cup' },
			{ name: 'avocado', quantity: 2, unit: 'whole' },
			{ name: 'tomato', quantity: 2, unit: 'pieces' },
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' },
			{ name: 'parsley', quantity: 1, unit: 'bunch' }
		]
	});
	const unstockedStew = recipe({
		id: 'unstocked-stew',
		title: 'Beef barley stew',
		ingredients: [
			{ name: 'beef chuck', quantity: 500, unit: 'g' },
			{ name: 'pearl barley', quantity: 1, unit: 'cup' }
		]
	});

	const initial = createInitialState();
	const ranked = rankRecipes(
		[unstockedStew, stockedBowl],
		stockedPantry,
		initial.preferences,
		new Date('2026-10-22T12:00:00Z')
	);
	assert.equal(ranked[0].id, 'stocked-bowl');

	const shopping = buildShoppingList(
		[stockedBowl],
		stockedPantry,
		undefined,
		new Date('2026-10-22T12:00:00Z')
	);
	assert.deepEqual(shopping, []);

	const afterCooking = completeMeal(
		{
			...initial,
			pantry: stockedPantry,
			recipes: [stockedBowl],
			meals: [
				{ id: 'm1', date: '2026-10-22', slot: 'Dinner', recipeId: 'stocked-bowl', servings: 2 }
			]
		},
		'm1',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00Z')
	);
	assert.equal(
		afterCooking.pantry.find((i) => normalizeName(i.name) === 'chicken breast')?.quantity,
		100
	);
	assert.equal(
		afterCooking.pantry.find((i) => normalizeName(i.name) === 'basmati rice')?.quantity,
		0.5
	);
	assert.equal(afterCooking.pantry.find((i) => normalizeName(i.name) === 'avocado')?.quantity, 1);
	assert.equal(afterCooking.pantry.find((i) => normalizeName(i.name) === 'olive oil')?.quantity, 1);
	assert.equal(afterCooking.pantry.find((i) => normalizeName(i.name) === 'parsley')?.quantity, 1);
});
