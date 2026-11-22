import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import {
	describeInvalidControl,
	hasRecipeEditorChanges,
	insertDraftItem,
	MAX_DRAFT_INGREDIENTS,
	MAX_DRAFT_STEPS,
	moveDraftItem,
	openClosedImportNotes
} from '#lib/recipe-draft.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const { validateAppState } = await import('#lib/server/db.ts');

test('insertDraftItem appends, inserts below a row, handles empty lists, and enforces limits', () => {
	const emptyInsert = insertDraftItem<string>([], -1, 'first', MAX_DRAFT_STEPS);
	assert.deepEqual(emptyInsert, { items: ['first'], index: 0 });

	const appended = insertDraftItem(['a', 'b', 'c'], 2, 'd', MAX_DRAFT_STEPS);
	assert.deepEqual(appended, { items: ['a', 'b', 'c', 'd'], index: 3 });

	const insertedBelowFirst = insertDraftItem(['a', 'b', 'c'], 0, 'a2', MAX_DRAFT_STEPS);
	assert.deepEqual(insertedBelowFirst, { items: ['a', 'a2', 'b', 'c'], index: 1 });

	const fullIngredients = Array.from({ length: MAX_DRAFT_INGREDIENTS }, (_, i) => `item-${i}`);
	assert.equal(
		insertDraftItem(fullIngredients, fullIngredients.length - 1, 'extra', MAX_DRAFT_INGREDIENTS),
		null
	);

	const fullSteps = Array.from({ length: MAX_DRAFT_STEPS }, (_, i) => `step-${i}`);
	assert.equal(insertDraftItem(fullSteps, 0, 'extra', MAX_DRAFT_STEPS), null);
});

test('moveDraftItem reorders adjacent rows and rejects boundary moves without mutating source', () => {
	const original = ['step 1', 'step 2', 'step 3', 'step 4'];
	assert.equal(moveDraftItem(original, 0, -1), null);
	assert.equal(moveDraftItem(original, 3, 1), null);

	const movedUp = moveDraftItem(original, 3, -1);
	assert.deepEqual(movedUp, {
		items: ['step 1', 'step 2', 'step 4', 'step 3'],
		index: 2
	});
	assert.deepEqual(original, ['step 1', 'step 2', 'step 3', 'step 4']);

	const movedDown = moveDraftItem(original, 1, 1);
	assert.deepEqual(movedDown, {
		items: ['step 1', 'step 3', 'step 2', 'step 4'],
		index: 2
	});
});

test('hasRecipeEditorChanges detects scalar, tag, list, and nutrition edits and ignores reverted edits', () => {
	const baseDraft = structuredClone(seedRecipes[0]);
	const initial = {
		draft: structuredClone(baseDraft),
		tagsText: baseDraft.tags.join(', ')
	};

	assert.equal(
		hasRecipeEditorChanges(initial, {
			draft: structuredClone(baseDraft),
			tagsText: baseDraft.tags.join(', ')
		}),
		false
	);

	assert.equal(
		hasRecipeEditorChanges(initial, {
			draft: structuredClone(baseDraft),
			tagsText: `${baseDraft.tags.join(', ')}, quick`
		}),
		true
	);

	const reorderedSteps = structuredClone(baseDraft);
	[reorderedSteps.steps[0], reorderedSteps.steps[1]] = [
		reorderedSteps.steps[1],
		reorderedSteps.steps[0]
	];
	assert.equal(
		hasRecipeEditorChanges(initial, {
			draft: reorderedSteps,
			tagsText: initial.tagsText
		}),
		true
	);

	const clearedNutrition = structuredClone(baseDraft);
	(clearedNutrition.nutrition as Record<string, unknown>).calories = null;
	assert.equal(
		hasRecipeEditorChanges(initial, {
			draft: clearedNutrition,
			tagsText: initial.tagsText
		}),
		true
	);

	const appendedIngredient = structuredClone(baseDraft);
	appendedIngredient.ingredients.push({ name: '', quantity: 1, unit: 'piece' });
	assert.equal(
		hasRecipeEditorChanges(initial, {
			draft: appendedIngredient,
			tagsText: initial.tagsText
		}),
		true
	);
});

test('openClosedImportNotes opens closed ancestor disclosures and describeInvalidControl formats readable alerts', () => {
	const outer = {
		open: false,
		parentElement: null as { closest(selector: string): unknown } | null
	};
	const inner = {
		open: false,
		parentElement: {
			closest: (selector: string) => (selector === 'details.import-notes' ? outer : null)
		}
	};
	const nutritionInput = {
		type: 'number',
		min: '0',
		max: '1000000',
		validity: { rangeUnderflow: true },
		getAttribute: () => null,
		closest: (selector: string) => {
			if (selector === 'details.import-notes') return inner;
			if (selector === 'label') return { textContent: 'Calories (kcal)' };
			return null;
		}
	};

	assert.equal(openClosedImportNotes(nutritionInput), true);
	assert.equal(inner.open, true);
	assert.equal(outer.open, true);
	assert.equal(openClosedImportNotes(nutritionInput), false);
	assert.equal(
		describeInvalidControl(nutritionInput),
		'Enter a number from 0 to 1,000,000 for Calories (kcal).'
	);

	const ingredientInput = {
		type: 'text',
		validity: { valueMissing: true },
		getAttribute: (name: string) => (name === 'aria-label' ? 'Ingredient 3' : null),
		closest: () => null
	};
	assert.equal(describeInvalidControl(ingredientInput), 'Enter a value for Ingredient 3.');
});

test('all 8 nutrition fields enforce 0..1000000 bounds matching server persistence', () => {
	const keys = [
		'calories',
		'fat',
		'saturatedFat',
		'sodium',
		'carbs',
		'fiber',
		'sugar',
		'protein'
	] as const;
	for (const key of keys) {
		const validZero = structuredClone(seedRecipes[0]);
		validZero.nutrition[key] = 0;
		assert.ok(validateAppState({ ...createNewUserState(), recipes: [validZero] }));

		const validMax = structuredClone(seedRecipes[0]);
		validMax.nutrition[key] = 1_000_000;
		assert.ok(validateAppState({ ...createNewUserState(), recipes: [validMax] }));

		const negative = structuredClone(seedRecipes[0]);
		negative.nutrition[key] = -1;
		assert.equal(validateAppState({ ...createNewUserState(), recipes: [negative] }), null);

		const overMax = structuredClone(seedRecipes[0]);
		overMax.nutrition[key] = 1_000_001;
		assert.equal(validateAppState({ ...createNewUserState(), recipes: [overMax] }), null);
	}
});
