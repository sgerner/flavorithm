import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, seedRecipes } from '../src/lib/data.ts';
import {
	buildShoppingList,
	formatRecipeQuantity,
	parseCalendarDate,
	preferenceSummary
} from '../src/lib/domain.ts';
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

test('shopping unit selection is invariant to recipe order and downscales small remainders within unit systems', () => {
	const cupRecipe = recipe({
		id: 'cup-oil',
		ingredients: [{ name: 'olive oil', quantity: 1, unit: 'cup' }]
	});
	const tbspRecipe = recipe({
		id: 'tbsp-oil',
		ingredients: [{ name: 'olive oil', quantity: 1, unit: 'tbsp' }]
	});
	const pantryOil = [pantry('olive oil', 0.25, 'cup')];
	const cupFirst = buildShoppingList([cupRecipe, tbspRecipe], pantryOil);
	const tbspFirst = buildShoppingList([tbspRecipe, cupRecipe], pantryOil);
	assert.deepEqual(tbspFirst, cupFirst);
	assert.equal(cupFirst[0]?.unit, 'cup');
	assert.equal(cupFirst[0]?.quantity, 0.8125);

	const gramPantryDeficit = buildShoppingList(
		[recipe({ ingredients: [{ name: 'flour', quantity: 1, unit: 'kg' }] })],
		[pantry('flour', 996, 'g')]
	);
	assert.equal(gramPantryDeficit.length, 1);
	assert.equal(gramPantryDeficit[0].quantity, 4);
	assert.equal(gramPantryDeficit[0].unit, 'g');

	const kilogramOnlyDeficit = buildShoppingList(
		[recipe({ ingredients: [{ name: 'flour', quantity: 1, unit: 'kg' }] })],
		[pantry('flour', 0.996, 'kg')]
	);
	assert.equal(kilogramOnlyDeficit.length, 1);
	assert.equal(kilogramOnlyDeficit[0].quantity, 4);
	assert.equal(kilogramOnlyDeficit[0].unit, 'g');

	const customaryMassDeficit = buildShoppingList(
		[recipe({ ingredients: [{ name: 'butter', quantity: 1, unit: 'lb' }] })],
		[pantry('butter', 0.99, 'lb')]
	);
	assert.equal(customaryMassDeficit.length, 1);
	assert.equal(customaryMassDeficit[0].unit, 'oz');
	assert.equal(customaryMassDeficit[0].quantity, 0.16);

	const metricVolumeDeficit = buildShoppingList(
		[recipe({ ingredients: [{ name: 'milk', quantity: 1, unit: 'l' }] })],
		[pantry('milk', 0.98, 'l')]
	);
	assert.equal(metricVolumeDeficit.length, 1);
	assert.equal(metricVolumeDeficit[0].unit, 'ml');
	assert.equal(metricVolumeDeficit[0].quantity, 20);
});

test('clamps sub-0.00001 base floating-point drift while preserving 1 mg deficits', () => {
	const gallonRecipe = [recipe({ ingredients: [{ name: 'broth', quantity: 1, unit: 'gal' }] })];
	assert.deepEqual(buildShoppingList(gallonRecipe, [pantry('broth', 256, 'tbsp')]), []);

	const milligramDeficit = buildShoppingList(
		[recipe({ ingredients: [{ name: 'saffron', quantity: 1, unit: 'kg' }] })],
		[pantry('saffron', 0.999999, 'kg')]
	);
	assert.equal(milligramDeficit.length, 1);
	assert.equal(milligramDeficit[0].quantity, 1);
	assert.equal(milligramDeficit[0].unit, 'mg');
});

test('formats scaled recipe quantities cleanly including sub-0.1 values like scaled 0.01 kg', () => {
	assert.equal(formatRecipeQuantity((0.01 * 1) / 4), '0.0025');
	assert.equal(formatRecipeQuantity((0.01 * 1) / 6), '0.0017');
	assert.equal(formatRecipeQuantity((0.01 * 1) / 2), '0.005');
	assert.equal(formatRecipeQuantity(0.01), '0.01');
	assert.equal(formatRecipeQuantity(0.1), '0.1');
	assert.equal(formatRecipeQuantity(1 / 3), '0.33');
	assert.equal(formatRecipeQuantity(2), '2');
	assert.equal(formatRecipeQuantity(0), '0');
	assert.equal(formatRecipeQuantity(5e-7), '0.0000005');
	assert.equal(formatRecipeQuantity(Number.NaN), '—');
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
