import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import {
	createBlankRecipe,
	finalizeManualRecipe,
	hasZeroNutrition,
	insertRecipes,
	MAX_RECIPES
} from '#lib/recipe-collection.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const { validateAppState } = await import('#lib/server/db.ts');
const recipe = (id: string) => ({ ...structuredClone(seedRecipes[0]), id });
const collection = (count: number) =>
	Array.from({ length: count }, (_, i) => recipe(`existing-${i}`));

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
