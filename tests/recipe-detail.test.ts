import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRecipes } from '../src/lib/discovery.ts';
import { mergeKitchenStates } from '../src/lib/offline-sync.ts';
import { MAX_SERVINGS } from '../src/lib/recipe-draft.ts';
import {
	MAX_RECIPE_SERVINGS,
	MIN_RECIPE_SERVINGS,
	applyRecipeRating,
	bookmarkLabel,
	clampServings,
	isValidServings,
	nextRatingStarForKey,
	nextRecipeTabForKey,
	nutritionAmountHeading,
	nutritionMultiplierFor,
	nutritionServingSizeLabel,
	ratingTabIndex,
	resolveActiveServings,
	resolveServingsFallback,
	scaleIngredientQuantity,
	scaleNutritionValue,
	starRatingLabel,
	stepServings,
	toggleRecipeRating
} from '../src/lib/recipe-detail.ts';
import type { AppState, Preferences, Recipe } from '../src/lib/types.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backendModulePath: string = '../src/lib/server/db.ts';
const backend = await import(backendModulePath);

function sampleRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'lemon-pasta',
		title: 'Lemon Herb Pasta',
		description: 'Bright weeknight pasta.',
		image: 'https://example.com/pasta.jpg',
		time: 20,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Italian',
		tags: ['pasta'],
		ingredients: [{ name: 'Pasta', quantity: 200, unit: 'g' }],
		steps: ['Boil pasta.', 'Toss with lemon and herbs.'],
		nutrition: {
			calories: 420,
			fat: 12,
			saturatedFat: 3,
			sodium: 380,
			carbs: 62,
			fiber: 4,
			sugar: 3,
			protein: 14
		},
		...overrides
	};
}

function samplePreferences(overrides: Partial<Preferences> = {}): Preferences {
	return {
		diet: '',
		allergies: '',
		maxTime: 0,
		complexity: '',
		cuisines: [],
		theme: 'nosh',
		dark: false,
		provider: '',
		model: '',
		...overrides
	};
}

test('serving steppers clamp between 1 and MAX_SERVINGS and fall back cleanly on blank or fractional input', () => {
	assert.equal(MAX_RECIPE_SERVINGS, MAX_SERVINGS);
	assert.equal(isValidServings(1), true);
	assert.equal(isValidServings(24), true);
	assert.equal(isValidServings(25), true);
	assert.equal(isValidServings(MAX_SERVINGS), true);
	assert.equal(isValidServings(0), false);
	assert.equal(isValidServings(MAX_SERVINGS + 1), false);
	assert.equal(isValidServings(2.5), false);
	assert.equal(isValidServings(null), false);
	assert.equal(isValidServings(undefined), false);
	assert.equal(isValidServings(Number.NaN), false);

	assert.equal(stepServings(MIN_RECIPE_SERVINGS, -1, 4), 1);
	assert.equal(stepServings(MAX_RECIPE_SERVINGS, 1, 4), MAX_SERVINGS);
	assert.equal(stepServings(4, 1, 4), 5);
	assert.equal(stepServings(4, -1, 4), 3);

	// Blank input falls back to lastValidServings
	assert.equal(stepServings(null, 1, 4), 5);
	assert.equal(stepServings(undefined, -1, 4), 3);
	assert.equal(stepServings(null, -1, 1), 1);
	assert.equal(stepServings(undefined, 1, MAX_SERVINGS), MAX_SERVINGS);

	// Out-of-range and fractional input clamp into 1..MAX_SERVINGS
	assert.equal(stepServings(0, 1, 2), 1);
	assert.equal(stepServings(MAX_SERVINGS + 50, -1, 2), MAX_SERVINGS);
	assert.equal(stepServings(2.4, 1, 2), 3);
	assert.equal(stepServings(2.4, -1, 2), 2);
	assert.equal(clampServings(Number.NaN), 1);
});

test('transient blank servings keep scaled ingredients and nutrition stable via lastValidServings', () => {
	assert.equal(resolveServingsFallback(undefined, 4), 4);
	assert.equal(resolveServingsFallback(6, 4), 6);
	assert.equal(resolveServingsFallback(50, 4), 50);
	assert.equal(resolveServingsFallback(MAX_SERVINGS + 50, 4), MAX_SERVINGS);

	// User scaled from 2 -> 5, then pressed Backspace (null/undefined)
	const activeDuringBlank = resolveActiveServings(null, 5);
	assert.equal(activeDuringBlank, 5);
	assert.equal(scaleIngredientQuantity(200, 2, activeDuringBlank), 500);
	assert.equal(scaleIngredientQuantity(0.75, 2, 3), 1.13);
});

test('nutrition multiplier and labels scale for serving, scaled, and whole-recipe modes', () => {
	const recipe = sampleRecipe({ servings: 2 });
	const scaledServings = 5;

	assert.equal(nutritionMultiplierFor('serving', recipe.servings, scaledServings), 1);
	assert.equal(nutritionMultiplierFor('scaled', recipe.servings, scaledServings), 5);
	assert.equal(nutritionMultiplierFor('recipe', recipe.servings, scaledServings), 2);

	assert.equal(
		scaleNutritionValue(
			recipe.nutrition.calories,
			nutritionMultiplierFor('scaled', recipe.servings, scaledServings)
		),
		2100
	);
	assert.equal(
		scaleNutritionValue(
			recipe.nutrition.protein,
			nutritionMultiplierFor('scaled', recipe.servings, scaledServings)
		),
		70
	);

	assert.equal(nutritionServingSizeLabel('serving', 5), '1 serving');
	assert.equal(nutritionServingSizeLabel('scaled', 1), '1 serving');
	assert.equal(nutritionServingSizeLabel('scaled', 5), '5 servings');
	assert.equal(nutritionServingSizeLabel('recipe', 5), 'Whole recipe');

	assert.equal(nutritionAmountHeading('serving', 5), 'Amount per serving');
	assert.equal(nutritionAmountHeading('scaled', 1), 'Amount per 1 serving');
	assert.equal(nutritionAmountHeading('scaled', 5), 'Amount per 5 servings');
	assert.equal(nutritionAmountHeading('recipe', 5), 'Amount per recipe');
});

test('tab, bookmark, and rating radiogroup helpers support ARIA labels and keyboard navigation', () => {
	assert.equal(nextRecipeTabForKey('recipe', 'ArrowRight'), 'nutrition');
	assert.equal(nextRecipeTabForKey('nutrition', 'ArrowRight'), 'recipe');
	assert.equal(nextRecipeTabForKey('recipe', 'ArrowLeft'), 'nutrition');
	assert.equal(nextRecipeTabForKey('nutrition', 'ArrowLeft'), 'recipe');
	assert.equal(nextRecipeTabForKey('nutrition', 'Home'), 'recipe');
	assert.equal(nextRecipeTabForKey('recipe', 'End'), 'nutrition');
	assert.equal(nextRecipeTabForKey('recipe', 'Enter'), undefined);

	assert.equal(bookmarkLabel(false), 'Save recipe');
	assert.equal(bookmarkLabel(undefined), 'Save recipe');
	assert.equal(bookmarkLabel(true), 'Unsave recipe');

	assert.equal(starRatingLabel(1), 'Rate 1 star');
	assert.equal(starRatingLabel(2), 'Rate 2 stars');
	assert.equal(starRatingLabel(5), 'Rate 5 stars');
	assert.deepEqual(
		[undefined, 0, 3, 7].map((rating) =>
			[1, 2, 3, 4, 5].filter((star) => ratingTabIndex(rating, star) === 0)
		),
		[[1], [1], [3], [1]]
	);

	assert.equal(nextRatingStarForKey(1, 'ArrowRight'), 2);
	assert.equal(nextRatingStarForKey(5, 'ArrowRight'), 1);
	assert.equal(nextRatingStarForKey(1, 'ArrowLeft'), 5);
	assert.equal(nextRatingStarForKey(3, 'ArrowUp'), 2);
	assert.equal(nextRatingStarForKey(3, 'ArrowDown'), 4);
	assert.equal(nextRatingStarForKey(4, 'Home'), 1);
	assert.equal(nextRatingStarForKey(2, 'End'), 5);
	assert.equal(nextRatingStarForKey(2, 'Tab'), undefined);

	assert.equal(toggleRecipeRating(undefined, 4), 4);
	assert.equal(toggleRecipeRating(3, 4), 4);
	assert.equal(toggleRecipeRating(4, 4), undefined);
});

test('clearing a rating deletes keys across recipe, preferences, discovery, offline sync, and db saveState', async () => {
	const pasta = sampleRecipe({ id: 'pasta', cuisine: 'Italian' });
	const tacos = sampleRecipe({ id: 'tacos', title: 'Fish Tacos', cuisine: 'Mexican' });

	let ratings = applyRecipeRating(pasta, undefined, 5);
	ratings = applyRecipeRating(tacos, ratings, 4);
	assert.equal(pasta.rating, 5);
	assert.deepEqual(ratings, { pasta: 5, tacos: 4 });

	const baseState: AppState = {
		pantry: [],
		recipes: [{ ...pasta }, { ...tacos }],
		meals: [],
		shopping: [],
		preferences: samplePreferences({ ratings: { ...ratings } })
	};

	// Clear pasta rating while keeping tacos rating
	ratings = applyRecipeRating(pasta, ratings, undefined);
	assert.equal('rating' in pasta, false);
	assert.equal(pasta.rating, undefined);
	assert.deepEqual(ratings, { tacos: 4 });
	assert.equal('pasta' in (ratings ?? {}), false);

	// Discovery ranking treats cleared recipe as unrated rather than 0-star or stale 5-star
	const italian2 = sampleRecipe({ id: 'italian-2', cuisine: 'Italian' });
	const mex2 = sampleRecipe({ id: 'mex-2', cuisine: 'Mexican' });
	const ranked = rankRecipes([italian2, mex2, pasta, tacos], [], samplePreferences({ ratings }));
	assert.equal(ranked[0]?.cuisine, 'Mexican');

	// Offline three-way merge propagates rating deletion cleanly without conflict
	const localState: AppState = {
		...baseState,
		recipes: [pasta, { ...tacos }],
		preferences: samplePreferences({ ratings })
	};
	const remoteState: AppState = {
		...baseState,
		pantry: [{ id: 'lime', name: 'Lime', quantity: 2, unit: 'each', category: 'Produce' }]
	};
	const merged = mergeKitchenStates(baseState, localState, remoteState);
	assert.equal(merged.conflicts.length, 0);
	assert.equal(merged.state.recipes.find((r) => r.id === 'pasta')?.rating, undefined);
	assert.equal('pasta' in (merged.state.preferences.ratings ?? {}), false);
	assert.equal(merged.state.preferences.ratings?.tacos, 4);

	// SQLite persistence in db.ts saveState + getState deletes cleared rating and preserves other ratings
	const account = await backend.registerUser(
		'chef-rating-test',
		'chef-rating@example.com',
		'correct horse battery'
	);
	const initial = backend.getState(account.user)!;
	const target = structuredClone(initial.recipes[0]!);
	const secondary = structuredClone(initial.recipes[1]!);

	let persistedRatings = applyRecipeRating(target, initial.preferences.ratings, 5);
	persistedRatings = applyRecipeRating(secondary, persistedRatings, 3);
	backend.saveState(
		account.user,
		{
			...initial,
			recipes: [target, secondary, ...initial.recipes.slice(2)],
			preferences: { ...initial.preferences, ratings: persistedRatings }
		},
		{ ifMatch: backend.getStateEtag(account.user), ifNoneMatch: null }
	);

	const afterRate = backend.getState(account.user)!;
	assert.equal(afterRate.recipes[0]?.rating, 5);
	assert.equal(afterRate.preferences.ratings?.[target.id], 5);
	assert.equal(afterRate.recipes[1]?.rating, 3);

	const clearedTarget = structuredClone(afterRate.recipes[0]!);
	const clearedRatings = applyRecipeRating(clearedTarget, afterRate.preferences.ratings, undefined);
	backend.saveState(
		account.user,
		{
			...afterRate,
			recipes: [clearedTarget, ...afterRate.recipes.slice(1)],
			preferences: { ...afterRate.preferences, ratings: clearedRatings }
		},
		{ ifMatch: backend.getStateEtag(account.user), ifNoneMatch: null }
	);

	const afterClear = backend.getState(account.user)!;
	assert.equal(afterClear.recipes[0]?.rating, undefined);
	assert.equal('rating' in afterClear.recipes[0]!, false);
	assert.equal(target.id in (afterClear.preferences.ratings ?? {}), false);
	assert.equal(afterClear.recipes[1]?.rating, 3);
	assert.equal(afterClear.preferences.ratings?.[secondary.id], 3);
});
