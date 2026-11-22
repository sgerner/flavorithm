import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SERVINGS } from '../src/lib/recipe-draft.ts';
import {
	applyEditedRecipe,
	beginDeleteSavedRecipe,
	beginEditSavedRecipe,
	beginPlanRecipe,
	cancelEditSavedRecipe,
	clearRecipeSubflowState,
	closeModalDialog,
	completePlanMeal,
	confirmDeleteSavedRecipe,
	dismissEscapeLayer,
	isRecipeDetailInert,
	pickRecipeForPlan,
	type EscapeLayerState
} from '../src/lib/recipe-subflows.ts';
import type { AppState, Recipe } from '../src/lib/types.ts';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'lemon-pasta',
		title: 'Lemon Herb Pasta',
		description: 'Bright weeknight pasta.',
		image: '',
		time: 25,
		servings: 4,
		difficulty: 'Easy',
		cuisine: 'Italian',
		tags: ['vegetarian', 'quick'],
		ingredients: [
			{ name: 'spaghetti', quantity: 400, unit: 'g' },
			{ name: 'lemon', quantity: 2, unit: 'whole' }
		],
		steps: ['Boil pasta.', 'Toss with lemon and herbs.'],
		nutrition: {
			calories: 480,
			fat: 12,
			saturatedFat: 2,
			sodium: 310,
			carbs: 76,
			fiber: 4,
			sugar: 3,
			protein: 14
		},
		saved: true,
		...overrides
	};
}

function makeKitchen(overrides: Partial<AppState> = {}): AppState {
	return {
		pantry: [],
		recipes: [],
		meals: [],
		shopping: [],
		preferences: {
			diet: 'none',
			allergies: '',
			maxTime: 45,
			complexity: 'Easy',
			cuisines: [],
			theme: 'nosh',
			dark: false,
			provider: 'openai',
			model: 'gpt-4.1-mini'
		},
		...overrides
	};
}

function makeEscapeState(overrides: Partial<EscapeLayerState> = {}): EscapeLayerState {
	return {
		modal: '',
		editingRecipe: null,
		selected: null,
		selectedMealServings: undefined,
		mobileNav: false,
		plannedRecipe: null,
		recipeToDelete: null,
		editingMealId: '',
		cookingMealId: '',
		memberToRemove: null,
		inviteCode: '',
		currentInviteId: '',
		resumeImport: false,
		onboardingStatus: 'completed',
		...overrides
	};
}

test('editing an open saved recipe preserves selected on cancel and updates selected + nutritionStale on save', () => {
	const original = makeRecipe();
	const other = makeRecipe({ id: 'chili', title: 'Smoky Chili' });
	const recipes = [original, other];

	// Open RecipeEditor from RecipeDetail: selected stays mounted and wrapper becomes inert.
	const started = beginEditSavedRecipe(recipes, original, original);
	assert.ok(started);
	assert.equal(started.selected, original);
	assert.notEqual(started.editingRecipe, original);
	assert.equal(isRecipeDetailInert('', started.editingRecipe), true);

	// Mutating draft does not mutate open selected recipe if user cancels.
	started.editingRecipe.title = 'Abandoned Title';
	started.editingRecipe.ingredients[0].quantity = 999;
	assert.equal(original.title, 'Lemon Herb Pasta');
	assert.equal(original.ingredients[0].quantity, 400);

	const canceled = cancelEditSavedRecipe(started.selected);
	assert.equal(canceled.selected, original);
	assert.equal(canceled.editingRecipe, null);
	assert.equal(isRecipeDetailInert('', canceled.editingRecipe), false);

	// Saving non-ingredient/non-serving changes updates selected without marking nutrition stale.
	const renamed = applyEditedRecipe(recipes, original, {
		...original,
		title: 'Weeknight Lemon Pasta'
	});
	assert.equal(renamed.editingRecipe, null);
	assert.equal(renamed.nutritionNeedsRefresh, false);
	assert.equal(renamed.selected?.title, 'Weeknight Lemon Pasta');
	assert.equal(renamed.selected?.nutritionStale, undefined);

	// Saving serving or ingredient changes assigns selected = saved and marks nutritionStale true.
	const rescaled = applyEditedRecipe(renamed.recipes, renamed.selected, {
		...renamed.saved!,
		servings: 6
	});
	assert.equal(rescaled.editingRecipe, null);
	assert.equal(rescaled.nutritionNeedsRefresh, true);
	assert.equal(rescaled.selected?.servings, 6);
	assert.equal(rescaled.selected?.nutritionStale, true);
	assert.equal(rescaled.recipes[0], rescaled.selected);
});

test('Basil edit subflow with selected === null keeps selected null on cancel and opens saved recipe on save', () => {
	const savedRecipe = makeRecipe();
	const unsavedRecipe = makeRecipe({ id: 'unsaved', saved: false });
	const recipes = [savedRecipe, unsavedRecipe];

	assert.equal(beginEditSavedRecipe(recipes, null, unsavedRecipe), null);

	const started = beginEditSavedRecipe(recipes, null, savedRecipe);
	assert.ok(started);
	assert.equal(started.selected, null);

	const canceled = cancelEditSavedRecipe(started.selected);
	assert.equal(canceled.selected, null);
	assert.equal(canceled.editingRecipe, null);

	const applied = applyEditedRecipe(recipes, started.selected, {
		...started.editingRecipe,
		ingredients: [
			...started.editingRecipe.ingredients,
			{ name: 'parmesan', quantity: 40, unit: 'g' }
		]
	});
	assert.equal(applied.editingRecipe, null);
	assert.equal(applied.nutritionNeedsRefresh, true);
	assert.equal(applied.selected?.id, savedRecipe.id);
	assert.equal(applied.selected?.nutritionStale, true);
});

test('delete subflow keeps selected on Keep recipe and clears selected + kitchen references on confirm', () => {
	const target = makeRecipe({ rating: 5 });
	const keptRecipe = makeRecipe({ id: 'soup', title: 'Tomato Soup' });
	const kitchen = makeKitchen({
		recipes: [target, keptRecipe],
		meals: [
			{ id: 'm1', date: '2026-11-18', slot: 'Dinner', recipeId: target.id, servings: 4 },
			{ id: 'm2', date: '2026-11-19', slot: 'Lunch', recipeId: keptRecipe.id, servings: 2 }
		],
		shopping: [
			{
				id: 's1',
				name: 'spaghetti',
				quantity: 400,
				unit: 'g',
				checked: false,
				sourceKey: `recipe:${target.id}`
			},
			{
				id: 's1-checked',
				name: 'lemon',
				quantity: 2,
				unit: 'whole',
				checked: true,
				sourceKey: `recipe:${target.id}`
			},
			{
				id: 's2',
				name: 'tomatoes',
				quantity: 4,
				unit: 'whole',
				checked: false,
				sourceKey: `recipe:${keptRecipe.id}`
			}
		],
		preferences: {
			...makeKitchen().preferences,
			ratings: { [target.id]: 5, [keptRecipe.id]: 4 }
		}
	});

	assert.equal(beginDeleteSavedRecipe(target, makeRecipe({ saved: false })), null);

	const asked = beginDeleteSavedRecipe(target, target);
	assert.ok(asked);
	assert.equal(asked.selected, target);
	assert.equal(asked.recipeToDelete, target);
	assert.equal(asked.modal, 'deleteRecipe');
	assert.equal(isRecipeDetailInert(asked.modal, null), true);

	// Clicking "Keep recipe" runs closeModalDialog: clears delete dialog and preserves selected.
	const kept = closeModalDialog(
		makeEscapeState({
			modal: asked.modal,
			selected: asked.selected,
			selectedMealServings: 6,
			recipeToDelete: asked.recipeToDelete
		})
	);
	assert.equal(kept.modal, '');
	assert.equal(kept.recipeToDelete, null);
	assert.equal(kept.selected, target);
	assert.equal(kept.selectedMealServings, 6);
	assert.equal(isRecipeDetailInert(kept.modal, null), false);

	// Confirming delete removes recipe, meals, shopping items, rating, and clears selected.
	const deleted = confirmDeleteSavedRecipe(kitchen, target, 6, target, () => '2026-11-16');
	assert.ok(deleted);
	assert.equal(deleted.selected, null);
	assert.equal(deleted.selectedMealServings, undefined);
	assert.equal(deleted.recipeToDelete, null);
	assert.equal(deleted.modal, '');
	assert.equal(deleted.impactedMealsCount, 1);
	assert.deepEqual(deleted.affectedWeeks, ['2026-11-16']);
	assert.deepEqual(
		deleted.recipes.map((r) => r.id),
		[keptRecipe.id]
	);
	assert.deepEqual(
		deleted.meals.map((m) => m.id),
		['m2']
	);
	assert.deepEqual(
		deleted.shopping.map((s) => s.id),
		['s1-checked', 's2']
	);
	assert.deepEqual(deleted.ratings, { [keptRecipe.id]: 4 });
});

test('meal scheduling separates plannedRecipe from selected across RecipeDetail and planner pickRecipe flows', () => {
	const openRecipe = makeRecipe();
	const pickedRecipe = makeRecipe({ id: 'curry', title: 'Chickpea Curry', servings: 3 });

	// 1. Plan from open RecipeDetail with custom servings, then cancel -> selected stays open.
	const fromDetail = beginPlanRecipe(openRecipe, openRecipe, 6, '2026-11-21');
	assert.equal(fromDetail.selected, openRecipe);
	assert.equal(fromDetail.plannedRecipe, openRecipe);
	assert.equal(fromDetail.plannedServings, 6);
	assert.equal(fromDetail.modal, 'plan');

	const canceledFromDetail = closeModalDialog(
		makeEscapeState({
			modal: fromDetail.modal,
			selected: fromDetail.selected,
			selectedMealServings: 5,
			plannedRecipe: fromDetail.plannedRecipe
		})
	);
	assert.equal(canceledFromDetail.modal, '');
	assert.equal(canceledFromDetail.plannedRecipe, null);
	assert.equal(canceledFromDetail.selected, openRecipe);
	assert.equal(canceledFromDetail.selectedMealServings, 5);

	// Confirming addMeal intentionally closes RecipeDetail and schedules plannedRecipe.
	assert.deepEqual(
		completePlanMeal(openRecipe, '2026-11-21', 'Snack', 4, () => 'meal-1'),
		{
			ok: false,
			reason: 'missing'
		}
	);
	for (const badServings of [0, 2.5, MAX_SERVINGS + 1]) {
		assert.deepEqual(
			completePlanMeal(openRecipe, '2026-11-21', 'Dinner', badServings, () => 'meal-1'),
			{
				ok: false,
				reason: 'invalidServings'
			}
		);
	}
	const highYield = completePlanMeal(
		openRecipe,
		'2026-11-21',
		'Dinner',
		MAX_SERVINGS,
		() => 'meal-max'
	);
	assert.equal(highYield.ok, true);
	if (highYield.ok) assert.equal(highYield.meal.servings, MAX_SERVINGS);
	const scheduledFromDetail = completePlanMeal(
		fromDetail.plannedRecipe,
		fromDetail.mealDate,
		'Dinner',
		fromDetail.plannedServings,
		() => 'meal-1'
	);
	assert.equal(scheduledFromDetail.ok, true);
	if (scheduledFromDetail.ok) {
		assert.deepEqual(scheduledFromDetail.meal, {
			id: 'meal-1',
			date: '2026-11-21',
			slot: 'Dinner',
			recipeId: openRecipe.id,
			servings: 6
		});
		assert.equal(scheduledFromDetail.plannedRecipe, null);
		assert.equal(scheduledFromDetail.selected, null);
		assert.equal(scheduledFromDetail.selectedMealServings, undefined);
		assert.equal(scheduledFromDetail.modal, '');
		assert.equal(scheduledFromDetail.page, 'planner');
	}

	// 2. Plan via planner pickRecipe: selected stays null so canceling returns to planner.
	const fromPicker = pickRecipeForPlan(null, pickedRecipe, '', '2026-11-22');
	assert.equal(fromPicker.selected, null);
	assert.equal(fromPicker.plannedRecipe, pickedRecipe);
	assert.equal(fromPicker.plannedServings, 3);
	assert.equal(fromPicker.mealDate, '2026-11-22');
	assert.equal(fromPicker.modal, 'plan');

	const canceledFromPicker = closeModalDialog(
		makeEscapeState({
			modal: fromPicker.modal,
			selected: fromPicker.selected,
			plannedRecipe: fromPicker.plannedRecipe
		})
	);
	assert.equal(canceledFromPicker.modal, '');
	assert.equal(canceledFromPicker.plannedRecipe, null);
	assert.equal(canceledFromPicker.selected, null);
});

test('settings, onboarding, resumeImport, and identity reset helpers preserve or clear recipe state appropriately', () => {
	const activeRecipe = makeRecipe({ nutritionStale: true });

	// Settings opened from RecipeDetail (e.g. Refresh nutrition -> needAI) keeps RecipeDetail inert, then restores on Done.
	assert.equal(isRecipeDetailInert('settings', null), true);
	const closedSettings = closeModalDialog(
		makeEscapeState({
			modal: 'settings',
			selected: activeRecipe,
			selectedMealServings: 4
		})
	);
	assert.equal(closedSettings.modal, '');
	assert.equal(closedSettings.selected, activeRecipe);
	assert.equal(isRecipeDetailInert(closedSettings.modal, null), false);

	// Settings -> Onboarding dismissed via closeModalDialog records skipped onboarding without dropping selected.
	const closedOnboarding = closeModalDialog(
		makeEscapeState({
			modal: 'onboarding',
			selected: activeRecipe,
			onboardingStatus: undefined
		})
	);
	assert.equal(closedOnboarding.modal, '');
	assert.equal(closedOnboarding.onboardingStatus, 'skipped');
	assert.equal(closedOnboarding.selected, activeRecipe);

	// Settings opened during recipe import resumes import modal when closed.
	const resumedImport = closeModalDialog(
		makeEscapeState({
			modal: 'settings',
			resumeImport: true,
			selected: null
		})
	);
	assert.equal(resumedImport.modal, 'import');
	assert.equal(resumedImport.resumeImport, false);

	// Account, household, and freshKitchen reset helper clears all transient recipe state.
	assert.deepEqual(clearRecipeSubflowState(), {
		selected: null,
		selectedMealServings: undefined,
		editingRecipe: null,
		recipeToDelete: null,
		plannedRecipe: null
	});
});

test('layered Escape ignores defaultPrevented and dismisses modal, editingRecipe, selected, then mobileNav', () => {
	const activeRecipe = makeRecipe();
	const draft = makeRecipe({ title: 'Draft Edit' });

	let state = makeEscapeState({
		modal: 'deleteRecipe',
		recipeToDelete: activeRecipe,
		editingRecipe: draft,
		selected: activeRecipe,
		selectedMealServings: 6,
		mobileNav: true
	});

	// Non-Escape keys and defaultPrevented Escape (e.g. ButlerChat) are ignored.
	assert.equal(dismissEscapeLayer({ key: 'Enter' }, state).dismissed, 'none');
	assert.equal(
		dismissEscapeLayer({ key: 'Escape', defaultPrevented: true }, state).dismissed,
		'none'
	);

	// 1st Escape dismisses modal only.
	let step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'modal');
	state = step.state;
	assert.equal(state.modal, '');
	assert.equal(state.recipeToDelete, null);
	assert.equal(state.editingRecipe, draft);
	assert.equal(state.selected, activeRecipe);
	assert.equal(state.selectedMealServings, 6);
	assert.equal(state.mobileNav, true);

	// 2nd Escape dismisses editingRecipe only.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'editingRecipe');
	state = step.state;
	assert.equal(state.editingRecipe, null);
	assert.equal(state.selected, activeRecipe);
	assert.equal(state.selectedMealServings, 6);
	assert.equal(state.mobileNav, true);

	// 3rd Escape dismisses selected and clears selectedMealServings, keeping mobileNav.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'selected');
	state = step.state;
	assert.equal(state.selected, null);
	assert.equal(state.selectedMealServings, undefined);
	assert.equal(state.mobileNav, true);

	// 4th Escape dismisses mobileNav.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'mobileNav');
	state = step.state;
	assert.equal(state.mobileNav, false);

	// 5th Escape with nothing open is a no-op.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'none');
});
