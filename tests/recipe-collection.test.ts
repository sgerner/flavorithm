import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import { insertRecipes, MAX_RECIPES } from '#lib/recipe-collection.ts';

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
