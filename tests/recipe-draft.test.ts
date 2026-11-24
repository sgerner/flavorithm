import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import { buildShoppingList } from '#lib/domain.ts';
import { reconcileShoppingList } from '#lib/kitchen-workflows.ts';
import {
	createDraftBaseline,
	describeInvalidControl,
	hasIngredientsOrServingsChanged,
	hasNutritionChanged,
	hasRecipeEditorChanges,
	insertDraftItem,
	isDraftNutritionStale,
	isValidNutrition,
	isValidServings,
	MAX_DRAFT_INGREDIENTS,
	MAX_DRAFT_STEPS,
	MAX_SERVINGS,
	MAX_SHOPPING_QUANTITY,
	moveDraftItem,
	NUTRITION_FIELDS,
	openClosedImportNotes,
	validateRecipeDraft
} from '#lib/recipe-draft.ts';
import type { Recipe } from '#lib/types.ts';

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

function sampleDraft(overrides: Partial<Recipe> = {}): Recipe {
	const base = structuredClone(seedRecipes[0]);
	delete base.nutritionStale;
	return {
		...base,
		id: 'imported-draft',
		servings: 4,
		ingredients: [
			{ name: 'Chickpeas', quantity: 2, unit: 'cans' },
			{ name: 'Spinach', quantity: 150, unit: 'g' }
		],
		steps: ['Warm the chickpeas.', 'Fold in spinach and serve.'],
		nutrition: {
			calories: 320,
			fat: 8,
			saturatedFat: 1,
			sodium: 410,
			carbs: 42,
			fiber: 11,
			sugar: 5,
			protein: 18
		},
		...overrides
	};
}

test('unchanged drafts and non-ingredient edits keep nutritionStale false', () => {
	const draft = sampleDraft();
	const baseline = createDraftBaseline(draft);

	draft.title = '  Skillet Chickpeas & Greens  ';
	draft.steps.push('  Season with lemon juice.  ', '   ');
	draft.description = 'Quick pantry supper.';

	assert.equal(hasIngredientsOrServingsChanged(draft, baseline), false);
	assert.equal(hasNutritionChanged(draft.nutrition, baseline.nutrition), false);
	assert.equal(isDraftNutritionStale(draft, baseline), false);

	const result = validateRecipeDraft(draft, {
		baseline,
		assumptions: ['Assumed canned drained chickpeas.']
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.recipe.title, 'Skillet Chickpeas & Greens');
	assert.equal(result.recipe.steps.length, 3);
	assert.equal(result.recipe.nutritionStale, false);
	assert.deepEqual(result.recipe.importNotes, ['Assumed canned drained chickpeas.']);
	assert.ok(validateAppState({ ...createNewUserState(), recipes: [result.recipe] }));
});

test('editing quantities, ingredients, or servings without nutrition edits marks nutritionStale true', () => {
	const original = sampleDraft();
	const baseline = createDraftBaseline(original);

	const quantityEdited = structuredClone(original);
	quantityEdited.ingredients[0].quantity = 3;
	assert.equal(baseline.ingredients[0].quantity, 2);
	assert.equal(isDraftNutritionStale(quantityEdited, baseline), true);
	const savedQuantity = validateRecipeDraft(quantityEdited, { baseline });
	assert.equal(savedQuantity.ok, true);
	if (savedQuantity.ok) assert.equal(savedQuantity.recipe.nutritionStale, true);

	const servingsEdited = structuredClone(original);
	servingsEdited.servings = 6;
	assert.equal(baseline.servings, 4);
	const savedServings = validateRecipeDraft(servingsEdited, { baseline });
	assert.equal(savedServings.ok, true);
	if (savedServings.ok) assert.equal(savedServings.recipe.nutritionStale, true);

	const unitEdited = structuredClone(original);
	unitEdited.ingredients[1].unit = 'oz';
	assert.equal(isDraftNutritionStale(unitEdited, baseline), true);

	const addedIngredient = structuredClone(original);
	addedIngredient.ingredients.push({ name: 'Olive oil', quantity: 1, unit: 'tbsp' });
	assert.equal(isDraftNutritionStale(addedIngredient, baseline), true);
});

test('manual nutrition overrides keep nutritionStale false even when quantities or servings change', () => {
	const draft = sampleDraft();
	const baseline = createDraftBaseline(draft);

	draft.ingredients[0].quantity = 4;
	draft.servings = 6;
	draft.nutrition.calories = 380;
	draft.nutrition.protein = 22;

	assert.equal(hasIngredientsOrServingsChanged(draft, baseline), true);
	assert.equal(hasNutritionChanged(draft.nutrition, baseline.nutrition), true);
	assert.equal(isDraftNutritionStale(draft, baseline), false);

	const result = validateRecipeDraft(draft, { baseline });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.recipe.nutritionStale, false);
	assert.equal(result.recipe.nutrition.calories, 380);
	assert.equal(result.recipe.nutrition.protein, 22);
});

test('invalid nutrition values fail validation and flag nutritionInvalid to open details', () => {
	for (const [key] of NUTRITION_FIELDS) {
		for (const badValue of [
			Number.NaN,
			-1,
			1_000_001,
			Number.POSITIVE_INFINITY,
			null as unknown as number
		]) {
			const draft = sampleDraft();
			draft.nutrition[key] = badValue;
			assert.equal(isValidNutrition(draft.nutrition), false);
			const result = validateRecipeDraft(draft, { baseline: createDraftBaseline(sampleDraft()) });
			assert.equal(result.ok, false);
			if (result.ok) continue;
			assert.equal(result.nutritionInvalid, true);
			assert.match(result.error, /nutrition/i);
		}
	}
});

test('rejects fractional or out-of-range servings and supports whole yields up to 10,000', () => {
	for (const invalid of [0, -2, 1.5, 2.25, 10_001, Number.NaN, null as unknown as number]) {
		assert.equal(isValidServings(invalid), false);
		const draft = sampleDraft({ servings: invalid });
		const result = validateRecipeDraft(draft, { baseline: createDraftBaseline(sampleDraft()) });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.nutritionInvalid, false);
	}

	for (const valid of [1, 24, 25, 100, MAX_SERVINGS]) {
		assert.equal(isValidServings(valid), true);
		const draft = sampleDraft({ servings: valid });
		const baseline = createDraftBaseline(draft);
		const result = validateRecipeDraft(draft, { baseline });
		assert.equal(result.ok, true);
		if (!result.ok) continue;
		assert.equal(result.recipe.servings, valid);
		assert.equal(result.recipe.nutritionStale, false);
		assert.ok(
			validateAppState({
				...createNewUserState(),
				recipes: [result.recipe],
				meals: [
					{
						id: `meal-${valid}`,
						date: '2026-11-21',
						slot: 'Dinner',
						recipeId: result.recipe.id,
						servings: valid
					}
				]
			})
		);
	}
});

test('shopping reconciliation clamps scaled high-yield totals to 1,000,000 for state schema parity', () => {
	const highScaleRecipe = sampleDraft({
		id: 'bakery-batch',
		servings: 1,
		ingredients: [{ name: 'Bread flour', quantity: 500, unit: 'g' }]
	});
	const meals = [
		{
			id: 'catering-dinner',
			date: '2026-11-21',
			slot: 'Dinner',
			recipeId: highScaleRecipe.id,
			servings: MAX_SERVINGS
		}
	];
	const additions = buildShoppingList([highScaleRecipe], [], meals);
	assert.equal(additions[0]?.quantity, 5_000_000);

	const shopping = reconcileShoppingList([], additions, 'week:2026-11-16');
	assert.equal(shopping.length, 1);
	assert.equal(shopping[0].quantity, MAX_SHOPPING_QUANTITY);
	assert.ok(
		validateAppState({
			...createNewUserState(),
			recipes: [highScaleRecipe],
			meals,
			shopping
		})
	);
});

test('validateRecipeDraft bounds assumptions and enforces public HTTPS or recipe cover URLs', () => {
	const draft = sampleDraft({
		image: `/api/recipe-covers/${'a'.repeat(64)}`,
		source: 'https://example.com/recipes/chickpeas'
	});
	const baseline = createDraftBaseline(draft);
	const assumptions = [
		'   ',
		`  ${'n'.repeat(380)}  `,
		...Array.from({ length: 35 }, (_, index) => `Note ${index + 1}`)
	];
	const valid = validateRecipeDraft(draft, { baseline, assumptions });
	assert.equal(valid.ok, true);
	if (valid.ok) {
		assert.equal(valid.recipe.importNotes?.length, 30);
		assert.equal(valid.recipe.importNotes?.[0]?.length, 300);
		assert.ok(validateAppState({ ...createNewUserState(), recipes: [valid.recipe] }));
	}

	const badImage = validateRecipeDraft(
		{ ...draft, image: 'http://example.com/photo.jpg' },
		{ baseline }
	);
	assert.equal(badImage.ok, false);
	if (!badImage.ok) assert.equal(badImage.nutritionInvalid, false);

	const badCover = validateRecipeDraft(
		{ ...draft, image: `/recipe-covers/${'a'.repeat(64)}` },
		{ baseline }
	);
	assert.equal(badCover.ok, false);

	const badSource = validateRecipeDraft(
		{ ...draft, source: 'https://user:pass@example.com/private' },
		{ baseline }
	);
	assert.equal(badSource.ok, false);
});
