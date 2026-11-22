import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewUserState, seedRecipes } from '#lib/data.ts';
import { buildShoppingList } from '#lib/domain.ts';
import { reconcileShoppingList } from '#lib/kitchen-workflows.ts';
import {
	createDraftBaseline,
	hasIngredientsOrServingsChanged,
	hasNutritionChanged,
	isDraftNutritionStale,
	isValidNutrition,
	isValidServings,
	MAX_SERVINGS,
	MAX_SHOPPING_QUANTITY,
	NUTRITION_FIELDS,
	validateRecipeDraft
} from '#lib/recipe-draft.ts';
import type { Recipe } from '#lib/types.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const { validateAppState } = await import('#lib/server/db.ts');

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
