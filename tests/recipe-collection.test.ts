import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import { mergeKitchenStates } from '#lib/offline-sync.ts';
import {
	applyEditedRecipe,
	applyNutritionRefresh,
	cloneRecipe,
	DEFAULT_RECIPE_FILTER,
	filterTabScrollTarget,
	filterTabsOverflow,
	hasActiveRecipeFilters,
	insertRecipes,
	MAX_RECIPES,
	mergeEditedRecipe,
	rateRecipeById,
	resetRecipeFilterState,
	toggleSavedRecipe
} from '#lib/recipe-collection.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const { validateAppState } = await import('#lib/server/db.ts');
const recipe = (id: string) => ({ ...structuredClone(seedRecipes[0]), id });
const collection = (count: number) =>
	Array.from({ length: count }, (_, i) => recipe(`existing-${i}`));

test('recipe filter helpers detect active filters and reset to defaults', () => {
	const defaults = resetRecipeFilterState();
	assert.deepEqual(defaults, {
		filter: DEFAULT_RECIPE_FILTER,
		query: '',
		showHiddenRecipes: false
	});
	assert.equal(hasActiveRecipeFilters(defaults), false);
	assert.equal(hasActiveRecipeFilters({ ...defaults, filter: 'High protein' }), true);
	assert.equal(hasActiveRecipeFilters({ ...defaults, query: 'dal' }), true);
	assert.equal(hasActiveRecipeFilters({ ...defaults, showHiddenRecipes: true }), true);
});

test('filter tab scroll target centers off-screen pills and clamps to scroll bounds', () => {
	assert.equal(
		filterTabScrollTarget({
			clientWidth: 700,
			scrollWidth: 700,
			pillLeft: 436,
			pillWidth: 104
		}),
		0
	);
	assert.equal(
		filterTabScrollTarget({
			clientWidth: 358,
			scrollWidth: 701,
			pillLeft: 0,
			pillWidth: 86
		}),
		0
	);
	const highProteinTarget = filterTabScrollTarget({
		clientWidth: 358,
		scrollWidth: 701,
		pillLeft: 436.6,
		pillWidth: 104
	});
	assert.ok(highProteinTarget > 250 && highProteinTarget < 343);
	assert.equal(
		filterTabScrollTarget({
			clientWidth: 358,
			scrollWidth: 701,
			pillLeft: 550,
			pillWidth: 151
		}),
		343
	);
});

test('filter tab overflow flags reflect left and right scrollable horizontal edges', () => {
	assert.deepEqual(filterTabsOverflow({ scrollLeft: 0, clientWidth: 700, scrollWidth: 700 }), {
		left: false,
		right: false
	});
	assert.deepEqual(filterTabsOverflow({ scrollLeft: 0, clientWidth: 358, scrollWidth: 701 }), {
		left: false,
		right: true
	});
	assert.deepEqual(filterTabsOverflow({ scrollLeft: 310, clientWidth: 358, scrollWidth: 701 }), {
		left: true,
		right: true
	});
	assert.deepEqual(filterTabsOverflow({ scrollLeft: 343, clientWidth: 358, scrollWidth: 701 }), {
		left: true,
		right: false
	});
});

test('the last recipe slot is saveable under the actual household schema', () => {
	const existing = collection(MAX_RECIPES - 1);
	const recipes = insertRecipes(existing, [recipe('imported')]);
	assert.equal(recipes.length, MAX_RECIPES);
	assert.equal(recipes[0].id, 'imported');
	assert.ok(validateAppState({ ...createNewUserState(), recipes }));
	assert.equal(existing.length, MAX_RECIPES - 1);
});

test('a full collection rejects an import without changing the saved kitchen', () => {
	const existing = collection(MAX_RECIPES);
	const before = structuredClone(existing);
	assert.throws(() => insertRecipes(existing, [recipe('imported')]), /250 recipes/);
	assert.deepEqual(existing, before);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: existing }));
	assert.equal(
		validateAppState({ ...createNewUserState(), recipes: [recipe('imported'), ...existing] }),
		null
	);
});

test('generation batches are atomic and replacing an existing ID needs no extra slot', () => {
	const existing = collection(MAX_RECIPES - 2);
	assert.throws(
		() => insertRecipes(existing, [recipe('a'), recipe('b'), recipe('c')]),
		/250 recipes/
	);
	assert.equal(existing.length, MAX_RECIPES - 2);
	const full = insertRecipes(existing, [recipe('a'), recipe('b')]);
	const replacement = { ...recipe('a'), title: 'Updated recipe' };
	const updated = insertRecipes(full, [replacement]);
	assert.equal(updated.length, MAX_RECIPES);
	assert.equal(updated[0].title, 'Updated recipe');
	assert.equal(updated.filter((item) => item.id === 'a').length, 1);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: updated }));
});

test('mergeEditedRecipe keeps live household values on untouched fields so sync ignores stale draft values', () => {
	const base = cloneRecipe({
		...recipe('shared-pasta'),
		saved: true,
		description: '  Original description  ',
		servings: 2,
		image: `/api/recipe-covers/${'1'.repeat(64)}`,
		tags: ['quick', 'weeknight']
	});
	const draft = cloneRecipe({
		...base,
		title: base.title.trim(),
		description: 'Bright lemony weeknight pasta',
		tags: ['quick', 'weeknight']
	});
	const live = cloneRecipe({
		...base,
		servings: 6,
		image: `/api/recipe-covers/${'2'.repeat(64)}`,
		tags: ['family', 'comfort'],
		ingredients: [...base.ingredients, { name: 'parmesan', quantity: 50, unit: 'g' }],
		steps: [...base.steps, 'Finish with grated parmesan.'],
		rating: 5,
		nutritionStale: true
	});

	const result = mergeEditedRecipe(base, draft, live);
	assert.equal(result.status, 'merged');
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.recipe.description, 'Bright lemony weeknight pasta');
	assert.equal(result.recipe.servings, 6);
	assert.equal(result.recipe.image, `/api/recipe-covers/${'2'.repeat(64)}`);
	assert.deepEqual(result.recipe.tags, ['family', 'comfort']);
	assert.deepEqual(result.recipe.ingredients, live.ingredients);
	assert.deepEqual(result.recipe.steps, live.steps);
	assert.equal(result.recipe.rating, 5);
	assert.equal(result.recipe.nutritionStale, true);

	// Simulate client-sync having already advanced context.baseline to live before editor save:
	const advancedBaseline = { ...createNewUserState(), recipes: [live] };
	const localAfterEditorSave = { ...createNewUserState(), recipes: [result.recipe] };
	const mergedSync = mergeKitchenStates(advancedBaseline, localAfterEditorSave, advancedBaseline);
	assert.equal(mergedSync.conflicts.length, 0);
	assert.equal(mergedSync.state.recipes[0].description, 'Bright lemony weeknight pasta');
	assert.equal(mergedSync.state.recipes[0].servings, 6);
	assert.deepEqual(mergedSync.state.recipes[0].ingredients, live.ingredients);
	assert.deepEqual(mergedSync.state.recipes[0].steps, live.steps);
});

test('mergeEditedRecipe surfaces competing field edits and resolves with draft or household choice', () => {
	const base = cloneRecipe({
		...recipe('chili'),
		saved: true,
		title: 'Weeknight Chili',
		description: 'Original notes',
		time: 30
	});
	const draft = cloneRecipe({
		...base,
		title: 'Smoky Chipotle Chili',
		description: 'Added chipotle in adobo',
		nutrition: { ...base.nutrition, calories: 540 }
	});
	const live = cloneRecipe({
		...base,
		title: 'Family Three-Bean Chili',
		time: 45,
		nutrition: { ...base.nutrition, calories: 610 }
	});

	const conflictResult = mergeEditedRecipe(base, draft, live);
	assert.equal(conflictResult.status, 'conflict');
	assert.deepEqual(
		conflictResult.conflicts.map((item) => item.field),
		['title', 'nutrition.calories']
	);
	assert.equal(conflictResult.conflicts[0].draft, 'Smoky Chipotle Chili');
	assert.equal(conflictResult.conflicts[0].household, 'Family Three-Bean Chili');

	const keepDraft = mergeEditedRecipe(base, draft, live, { prefer: 'draft' });
	assert.equal(keepDraft.status, 'merged');
	assert.equal(keepDraft.recipe.title, 'Smoky Chipotle Chili');
	assert.equal(keepDraft.recipe.nutrition.calories, 540);
	assert.equal(keepDraft.recipe.description, 'Added chipotle in adobo');
	assert.equal(keepDraft.recipe.time, 45);

	const keepHousehold = mergeEditedRecipe(base, draft, live, { prefer: 'household' });
	assert.equal(keepHousehold.status, 'merged');
	assert.equal(keepHousehold.recipe.title, 'Family Three-Bean Chili');
	assert.equal(keepHousehold.recipe.nutrition.calories, 610);
	assert.equal(keepHousehold.recipe.description, 'Added chipotle in adobo');
	assert.equal(keepHousehold.recipe.time, 45);
});

test('applyEditedRecipe protects drafts when unsaved or deleted remotely and enforces MAX_RECIPES on re-save', () => {
	const initialCover = `/api/recipe-covers/${'a'.repeat(64)}`;
	const uploadedCover = `/api/recipe-covers/${'f'.repeat(64)}`;
	const base = cloneRecipe({
		...recipe('focaccia'),
		saved: true,
		image: initialCover
	});
	const draft = cloneRecipe({
		...base,
		description: 'Crisp olive oil crust',
		image: uploadedCover
	});

	const unsavedLive = [{ ...cloneRecipe(base), saved: false, time: 55 }];
	const unsavedAttempt = applyEditedRecipe(unsavedLive, base, draft);
	assert.equal(unsavedAttempt.status, 'unsaved');
	assert.equal(unsavedAttempt.recipes, unsavedLive);

	const resavedFromUnsaved = applyEditedRecipe(unsavedLive, base, draft, { resave: true });
	assert.equal(resavedFromUnsaved.status, 'merged');
	assert.equal(resavedFromUnsaved.recipes[0].saved, true);
	assert.equal(resavedFromUnsaved.recipes[0].description, 'Crisp olive oil crust');
	assert.equal(resavedFromUnsaved.recipes[0].time, 55);
	assert.equal(resavedFromUnsaved.recipes[0].image, uploadedCover);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: resavedFromUnsaved.recipes }));

	const deletedAttempt = applyEditedRecipe([], base, draft);
	assert.equal(deletedAttempt.status, 'deleted');
	assert.equal(deletedAttempt.recipes.length, 0);

	const resavedFromDeleted = applyEditedRecipe([], base, draft, { resave: true });
	assert.equal(resavedFromDeleted.status, 'merged');
	assert.equal(resavedFromDeleted.recipes.length, 1);
	assert.equal(resavedFromDeleted.recipes[0].saved, true);
	assert.equal(resavedFromDeleted.recipes[0].image, uploadedCover);

	const fullKitchen = collection(MAX_RECIPES);
	assert.throws(() => applyEditedRecipe(fullKitchen, base, draft, { resave: true }), /250 recipes/);
});

test('ID-keyed recipe helpers update cloned arrays, skip missing recipes, and detect mid-flight nutrition staleness', () => {
	const state = createNewUserState();
	const initial = [{ ...recipe('soup'), saved: true }];
	const clonedAfterSync = structuredClone(initial);

	const toggled = toggleSavedRecipe(clonedAfterSync, 'soup');
	assert.ok(toggled);
	assert.equal(toggled.saved, false);
	assert.equal(toggled.recipes[0].saved, false);
	assert.equal(toggleSavedRecipe(clonedAfterSync, 'missing'), null);

	const rated = rateRecipeById(clonedAfterSync, state.preferences, 'soup', 4);
	assert.ok(rated);
	assert.equal(rated.recipes[0].rating, 4);
	assert.equal(rated.preferences.ratings?.soup, 4);
	assert.equal(rateRecipeById(clonedAfterSync, state.preferences, 'missing', 4), null);

	const freshNutrition = {
		calories: 320,
		fat: 12,
		saturatedFat: 3,
		sodium: 480,
		carbs: 38,
		fiber: 6,
		sugar: 5,
		protein: 14
	};
	const refreshedClean = applyNutritionRefresh(
		clonedAfterSync,
		'soup',
		{ servings: clonedAfterSync[0].servings, ingredients: clonedAfterSync[0].ingredients },
		freshNutrition
	);
	assert.ok(refreshedClean);
	assert.equal(refreshedClean.nutritionStale, false);
	assert.deepEqual(refreshedClean.recipes[0].nutrition, freshNutrition);
	assert.equal(refreshedClean.recipes[0].nutritionStale, false);

	const editedInFlight = [
		{
			...clonedAfterSync[0],
			servings: clonedAfterSync[0].servings + 2,
			nutritionStale: true
		}
	];
	const refreshedStale = applyNutritionRefresh(
		editedInFlight,
		'soup',
		{ servings: clonedAfterSync[0].servings, ingredients: clonedAfterSync[0].ingredients },
		freshNutrition
	);
	assert.ok(refreshedStale);
	assert.equal(refreshedStale.nutritionStale, true);
	assert.equal(refreshedStale.recipes[0].nutritionStale, true);
	assert.deepEqual(refreshedStale.recipes[0].nutrition, clonedAfterSync[0].nutrition);
	assert.equal(
		applyNutritionRefresh(
			clonedAfterSync,
			'missing',
			{ servings: clonedAfterSync[0].servings, ingredients: clonedAfterSync[0].ingredients },
			freshNutrition
		),
		null
	);
});
