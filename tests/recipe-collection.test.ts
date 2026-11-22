import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import {
	createBlankRecipe,
	DEFAULT_RECIPE_FILTER,
	filterTabScrollTarget,
	filterTabsOverflow,
	finalizeManualRecipe,
	hasActiveRecipeFilters,
	hasZeroNutrition,
	insertRecipes,
	MAX_RECIPES,
	prepareImportedRecipe,
	resetRecipeFilterState
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

test('prepareImportedRecipe bounds assumptions, validates URLs and nutrition, and passes validateAppState', () => {
	const draft = {
		...recipe('imported-draft'),
		image: `/api/recipe-covers/${'c'.repeat(64)}`,
		source: 'https://example.com/imported-recipe'
	};
	const assumptions = [
		'   ',
		`  ${'a'.repeat(420)}  `,
		...Array.from({ length: 35 }, (_, index) => `Assumption ${index + 1}`)
	];
	const prepared = prepareImportedRecipe(draft, assumptions);
	assert.ok('recipe' in prepared);
	assert.equal(prepared.recipe.importNotes?.length, 30);
	assert.equal(prepared.recipe.importNotes?.[0]?.length, 300);
	const nextRecipes = insertRecipes(createNewUserState().recipes, [prepared.recipe]);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: nextRecipes }));

	assert.ok(
		'error' in prepareImportedRecipe({ ...draft, image: 'http://example.com/bad.jpg' }, [])
	);
	assert.ok(
		'error' in prepareImportedRecipe({ ...draft, image: `/recipe-covers/${'c'.repeat(64)}` }, [])
	);
	assert.ok(
		'error' in
			prepareImportedRecipe({ ...draft, source: 'https://user:pass@example.com/private' }, [])
	);
	assert.ok(
		'error' in
			prepareImportedRecipe(
				{
					...draft,
					nutrition: { ...draft.nutrition, calories: Number.NaN }
				},
				[]
			)
	);
	assert.ok(
		'error' in
			prepareImportedRecipe(
				{
					...draft,
					nutrition: { ...draft.nutrition, sodium: 1_000_001 }
				},
				[]
			)
	);
	assert.ok(
		'error' in
			prepareImportedRecipe(
				{
					...draft,
					ingredients: [{ name: 'Salt', quantity: 1, unit: 'u'.repeat(41) }]
				},
				[]
			)
	);
});

test('blank recipe starts with expected defaults and zeroed nutrition', () => {
	const blank = createBlankRecipe('manual-blank');
	assert.equal(blank.id, 'manual-blank');
	assert.equal(blank.title, '');
	assert.equal(blank.time, 30);
	assert.equal(blank.servings, 2);
	assert.deepEqual(blank.tags, []);
	assert.deepEqual(blank.ingredients, [{ name: '', quantity: 1, unit: 'piece' }]);
	assert.deepEqual(blank.steps, ['']);
	assert.equal(hasZeroNutrition(blank.nutrition), true);
});

test('finalizeManualRecipe sets manual provenance, saved flag, and stale nutrition only when zeroed', () => {
	const zeroDraft = {
		...createBlankRecipe('grandma-stew'),
		title: 'Grandma’s Beef Stew',
		cuisine: 'Homestyle',
		difficulty: 'Easy',
		tags: ['comfort', 'family'],
		ingredients: [{ name: 'beef chuck', quantity: 2, unit: 'lb' }],
		steps: ['Simmer gently until tender.']
	};
	const savedZero = finalizeManualRecipe(zeroDraft);
	assert.equal(savedZero.provenance, 'manual');
	assert.equal(savedZero.saved, true);
	assert.equal(savedZero.nutritionStale, true);

	const inserted = insertRecipes(collection(2), [savedZero]);
	assert.equal(inserted[0].id, 'grandma-stew');
	assert.ok(validateAppState({ ...createNewUserState(), recipes: inserted }));

	const withNutrition = finalizeManualRecipe({
		...zeroDraft,
		id: 'grandma-stew-nutrition',
		nutrition: { ...zeroDraft.nutrition, calories: 480, protein: 38 }
	});
	assert.equal(withNutrition.provenance, 'manual');
	assert.equal(withNutrition.saved, true);
	assert.equal(withNutrition.nutritionStale, false);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: [withNutrition] }));

	const full = collection(MAX_RECIPES);
	assert.throws(() => insertRecipes(full, [savedZero]), /250 recipes/);
});
