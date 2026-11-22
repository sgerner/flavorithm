import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import {
	DEFAULT_RECIPE_FILTER,
	filterTabScrollTarget,
	filterTabsOverflow,
	hasActiveRecipeFilters,
	insertRecipes,
	MAX_RECIPES,
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
