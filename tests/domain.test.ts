import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, seedPantry, seedRecipes } from '../src/lib/data.ts';
import {
	buildShoppingList,
	matchRecipePantry,
	normalizeName,
	preferenceSummary,
	unitInfo
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

test('normalizes regular plurals and prep modifiers while keeping uncountables and compound identities distinct', () => {
	const pairs: Array<[string, string]> = [
		['shallots', 'shallot'],
		['green bean', 'green beans'],
		['cherry tomato', 'cherry tomatoes'],
		['salmon fillet', 'salmon fillets'],
		['red onions', 'red onion'],
		['yellow onions', 'yellow onion'],
		['flatbreads', 'flatbread'],
		['fresh cilantro', 'cilantro'],
		['fresh ginger', 'ginger'],
		['baby kale', 'kale'],
		['minced garlic', 'garlic']
	];
	for (const [left, right] of pairs) {
		assert.equal(normalizeName(left), normalizeName(right), `${left} should match ${right}`);
	}

	assert.notEqual(normalizeName('rice'), normalizeName('rice vinegar'));
	assert.notEqual(normalizeName('butter'), normalizeName('butternut squash'));
	assert.notEqual(normalizeName('red onion'), normalizeName('yellow onion'));
	assert.equal(normalizeName('hummus'), 'hummus');
	assert.equal(normalizeName('couscous'), 'couscous');
	assert.equal(normalizeName('asparagus'), 'asparagus');
	assert.equal(normalizeName('molasses'), 'molasses');
	assert.equal(normalizeName('rolled oats'), 'rolled oats');
});

test('maps item units and parenthetical cans while separating size, head, and clove dimensions', () => {
	assert.deepEqual(unitInfo('item'), { dimension: 'count', factor: 1, display: 'each' });
	assert.deepEqual(unitInfo('items'), { dimension: 'count', factor: 1, display: 'each' });
	assert.deepEqual(unitInfo('can (15 oz)'), { dimension: 'count:can', factor: 1, display: 'can' });
	assert.deepEqual(unitInfo('cans (14.5 oz)'), {
		dimension: 'count:can',
		factor: 1,
		display: 'can'
	});

	const distinctUnits = ['each', 'small', 'medium', 'large', 'head', 'clove', 'can', 'oz'];
	const dimensions = distinctUnits.map((unit) => unitInfo(unit).dimension);
	assert.equal(new Set(dimensions).size, distinctUnits.length);
});

test('shared pantry matcher excludes zero, expired, substring-only, and incompatible stock across starter recipes', () => {
	const now = new Date(2026, 9, 22, 12);
	const starterCounts = Object.fromEntries(
		seedRecipes.map((item) => [item.id, matchRecipePantry(item, seedPantry, now).matchedCount])
	);
	assert.deepEqual(starterCounts, {
		'lemon-herb-chicken': 1,
		'sesame-salmon-bowls': 2,
		'tomato-butter-beans': 2,
		'lemon-chickpea-orzo': 3,
		'maple-chili-tofu': 1,
		'roasted-veg-farro': 1,
		'chicken-shawarma-wraps': 0,
		'coconut-red-lentil-dal': 1
	});

	const noisyPantry: Ingredient[] = [
		pantry('rice', 2, 'cups'),
		pantry('butter', 4, 'tbsp'),
		pantry('garlic', 1, 'head'),
		pantry('olive oil', 0, 'cup'),
		pantry('olive oil', 200, 'g'),
		pantry('baby spinach', 2, 'cups', '2026-10-20')
	];
	const countsWithNoisyStock = Object.fromEntries(
		seedRecipes.map((item) => [item.id, matchRecipePantry(item, noisyPantry, now).matchedCount])
	);
	assert.deepEqual(countsWithNoisyStock, {
		'lemon-herb-chicken': 1,
		'sesame-salmon-bowls': 0,
		'tomato-butter-beans': 0,
		'lemon-chickpea-orzo': 0,
		'maple-chili-tofu': 0,
		'roasted-veg-farro': 0,
		'chicken-shawarma-wraps': 0,
		'coconut-red-lentil-dal': 0
	});
});

test('shopping generation deducts normalized plurals, modifiers, item units, and canned stock without head-to-clove conversion', () => {
	const targetRecipes = seedRecipes.filter((item) =>
		['tomato-butter-beans', 'roasted-veg-farro', 'coconut-red-lentil-dal'].includes(item.id)
	);
	const result = buildShoppingList(targetRecipes, [
		pantry('cannellini bean', 1, 'can (15 oz)'),
		pantry('cherry tomato', 10, 'oz'),
		pantry('shallots', 1, 'item'),
		pantry('red onions', 1, 'item'),
		pantry('yellow onions', 1, 'items'),
		pantry('kale', 2, 'cups'),
		pantry('fresh cilantro', 2, 'tbsp'),
		pantry('ginger', 1, 'tbsp'),
		pantry('garlic', 2, 'heads')
	]);

	assert.equal(
		result.find((item) => normalizeName(item.name) === 'cannellini bean'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'cherry tomato'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'shallot'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'red onion'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'yellow onion'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'kale'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'cilantro'),
		undefined
	);
	assert.equal(
		result.find((item) => normalizeName(item.name) === 'ginger'),
		undefined
	);
	const garlic = result.find((item) => normalizeName(item.name) === 'garlic');
	assert.ok(garlic);
	assert.equal(garlic.quantity, 5);
	assert.equal(garlic.unit, 'clove');
});
