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
	resolveSelectedRecipe,
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
		selectedId: null,
		selectedMealServings: undefined,
		mobileNav: false,
		plannedRecipeId: null,
		recipeToDeleteId: null,
		editingMealId: '',
		cookingMealId: '',
		memberToRemove: null,
		inviteCode: '',
		currentInviteId: '',
		resumeDialog: '',
		onboardingStatus: 'completed',
		...overrides
	};
}

test('resolveSelectedRecipe reflects live kitchen recipes across replacements and deletions', () => {
	const initial = makeRecipe({ title: 'Initial Title', servings: 4 });
	const other = makeRecipe({ id: 'chili', title: 'Smoky Chili' });

	assert.equal(resolveSelectedRecipe([initial, other], null), null);
	assert.equal(resolveSelectedRecipe([initial, other], initial.id), initial);

	// Replacing kitchen.recipes with synced/undo state returns the updated Recipe object.
	const synced = makeRecipe({ title: 'Synced Title', servings: 6, rating: 5 });
	assert.equal(resolveSelectedRecipe([synced, other], initial.id), synced);

	// Replacing kitchen.recipes without the recipe resolves to null instead of keeping a stale object.
	assert.equal(resolveSelectedRecipe([other], initial.id), null);
});

test('editing an open saved recipe preserves selectedId on cancel and updates saved recipe + nutritionStale on save', () => {
	const original = makeRecipe();
	const other = makeRecipe({ id: 'chili', title: 'Smoky Chili' });
	const recipes = [original, other];

	// Open RecipeEditor from RecipeDetail: selectedId stays set and wrapper becomes inert.
	const started = beginEditSavedRecipe(recipes, original.id, original.id);
	assert.ok(started);
	assert.equal(started.selectedId, original.id);
	assert.equal(started.editingRecipeMode, 'edit');
	assert.notEqual(started.editingRecipe, original);
	assert.equal(isRecipeDetailInert('', started.editingRecipe), true);

	// Mutating draft does not mutate open selected recipe if user cancels.
	started.editingRecipe.title = 'Abandoned Title';
	started.editingRecipe.ingredients[0].quantity = 999;
	assert.equal(original.title, 'Lemon Herb Pasta');
	assert.equal(original.ingredients[0].quantity, 400);

	const canceled = cancelEditSavedRecipe(started.selectedId);
	assert.equal(canceled.selectedId, original.id);
	assert.equal(canceled.editingRecipe, null);
	assert.equal(canceled.editingRecipeMode, 'edit');
	assert.equal(isRecipeDetailInert('', canceled.editingRecipe), false);

	// Saving non-ingredient/non-serving changes updates recipe without marking nutrition stale.
	const renamed = applyEditedRecipe(recipes, original.id, {
		...original,
		title: 'Weeknight Lemon Pasta'
	});
	assert.equal(renamed.editingRecipe, null);
	assert.equal(renamed.nutritionNeedsRefresh, false);
	assert.equal(renamed.selectedId, original.id);
	const renamedSelected = resolveSelectedRecipe(renamed.recipes, renamed.selectedId);
	assert.equal(renamedSelected?.title, 'Weeknight Lemon Pasta');
	assert.equal(renamedSelected?.nutritionStale, undefined);

	// Saving serving or ingredient changes updates recipes[0] and marks nutritionStale true.
	const rescaled = applyEditedRecipe(renamed.recipes, renamed.selectedId, {
		...renamed.saved!,
		servings: 6
	});
	assert.equal(rescaled.editingRecipe, null);
	assert.equal(rescaled.editingRecipeMode, 'edit');
	assert.equal(rescaled.nutritionNeedsRefresh, true);
	const rescaledSelected = resolveSelectedRecipe(rescaled.recipes, rescaled.selectedId);
	assert.equal(rescaledSelected?.servings, 6);
	assert.equal(rescaledSelected?.nutritionStale, true);
	assert.equal(rescaled.recipes[0], rescaledSelected);

	// Manual recipes with zero nutrition keep nutritionStale true until non-zero nutrition is entered.
	const manualZero = makeRecipe({
		id: 'manual-stew',
		provenance: 'manual',
		nutritionStale: true,
		nutrition: {
			calories: 0,
			fat: 0,
			saturatedFat: 0,
			sodium: 0,
			carbs: 0,
			fiber: 0,
			sugar: 0,
			protein: 0
		}
	});
	const manualRenamed = applyEditedRecipe([manualZero], manualZero.id, {
		...manualZero,
		title: 'Hearty Manual Stew'
	});
	assert.equal(manualRenamed.nutritionNeedsRefresh, false);
	assert.equal(
		resolveSelectedRecipe(manualRenamed.recipes, manualRenamed.selectedId)?.nutritionStale,
		true
	);

	const manualWithNutrition = applyEditedRecipe(manualRenamed.recipes, manualRenamed.selectedId, {
		...manualRenamed.saved!,
		nutrition: { ...manualRenamed.saved!.nutrition, calories: 420, protein: 28 }
	});
	assert.equal(manualWithNutrition.nutritionNeedsRefresh, false);
	assert.equal(
		resolveSelectedRecipe(manualWithNutrition.recipes, manualWithNutrition.selectedId)
			?.nutritionStale,
		false
	);
});

test('Basil edit subflow with selectedId === null keeps selectedId null on cancel and opens saved recipe on save', () => {
	const savedRecipe = makeRecipe();
	const unsavedRecipe = makeRecipe({ id: 'unsaved', saved: false });
	const recipes = [savedRecipe, unsavedRecipe];

	assert.equal(beginEditSavedRecipe(recipes, null, unsavedRecipe.id), null);

	const started = beginEditSavedRecipe(recipes, null, savedRecipe.id);
	assert.ok(started);
	assert.equal(started.selectedId, null);

	const canceled = cancelEditSavedRecipe(started.selectedId);
	assert.equal(canceled.selectedId, null);
	assert.equal(canceled.editingRecipe, null);

	const applied = applyEditedRecipe(recipes, started.selectedId, {
		...started.editingRecipe,
		ingredients: [
			...started.editingRecipe.ingredients,
			{ name: 'parmesan', quantity: 40, unit: 'g' }
		]
	});
	assert.equal(applied.editingRecipe, null);
	assert.equal(applied.nutritionNeedsRefresh, true);
	assert.equal(applied.selectedId, savedRecipe.id);
	assert.equal(resolveSelectedRecipe(applied.recipes, applied.selectedId)?.nutritionStale, true);
});

test('delete subflow keeps selectedId on Keep recipe and clears selectedId + kitchen references on confirm', () => {
	const target = makeRecipe({ rating: 5 });
	const keptRecipe = makeRecipe({ id: 'soup', title: 'Tomato Soup' });
	const unsaved = makeRecipe({ id: 'draft', saved: false });
	const kitchen = makeKitchen({
		recipes: [target, keptRecipe, unsaved],
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

	assert.equal(beginDeleteSavedRecipe(kitchen.recipes, target.id, unsaved.id), null);

	const asked = beginDeleteSavedRecipe(kitchen.recipes, target.id, target.id);
	assert.ok(asked);
	assert.equal(asked.selectedId, target.id);
	assert.equal(asked.recipeToDeleteId, target.id);
	assert.equal(asked.modal, 'deleteRecipe');
	assert.equal(isRecipeDetailInert(asked.modal, null), true);

	// Clicking "Keep recipe" runs closeModalDialog: clears delete dialog and preserves selectedId.
	const kept = closeModalDialog(
		makeEscapeState({
			modal: asked.modal,
			selectedId: asked.selectedId,
			selectedMealServings: 6,
			recipeToDeleteId: asked.recipeToDeleteId
		})
	);
	assert.equal(kept.modal, '');
	assert.equal(kept.recipeToDeleteId, null);
	assert.equal(kept.selectedId, target.id);
	assert.equal(kept.selectedMealServings, 6);
	assert.equal(isRecipeDetailInert(kept.modal, null), false);

	// Confirming delete removes recipe, meals, shopping items, rating, and clears selectedId.
	const deleted = confirmDeleteSavedRecipe(kitchen, target.id, 6, target.id, () => '2026-11-16');
	assert.ok(deleted);
	assert.equal(deleted.selectedId, null);
	assert.equal(deleted.selectedMealServings, undefined);
	assert.equal(deleted.recipeToDeleteId, null);
	assert.equal(deleted.modal, '');
	assert.equal(deleted.impactedMealsCount, 1);
	assert.deepEqual(deleted.affectedWeeks, ['2026-11-16']);
	assert.deepEqual(
		deleted.recipes.map((r) => r.id),
		[keptRecipe.id, unsaved.id]
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

test('meal scheduling separates plannedRecipeId from selectedId across RecipeDetail and planner pickRecipe flows', () => {
	const openRecipe = makeRecipe();
	const pickedRecipe = makeRecipe({ id: 'curry', title: 'Chickpea Curry', servings: 3 });
	const recipes = [openRecipe, pickedRecipe];

	// 1. Plan from open RecipeDetail with custom servings, then cancel -> selectedId stays open.
	const fromDetail = beginPlanRecipe(openRecipe.id, openRecipe, 6, '2026-11-21');
	assert.equal(fromDetail.selectedId, openRecipe.id);
	assert.equal(fromDetail.plannedRecipeId, openRecipe.id);
	assert.equal(fromDetail.plannedServings, 6);
	assert.equal(fromDetail.modal, 'plan');

	const canceledFromDetail = closeModalDialog(
		makeEscapeState({
			modal: fromDetail.modal,
			selectedId: fromDetail.selectedId,
			selectedMealServings: 5,
			plannedRecipeId: fromDetail.plannedRecipeId
		})
	);
	assert.equal(canceledFromDetail.modal, '');
	assert.equal(canceledFromDetail.plannedRecipeId, null);
	assert.equal(canceledFromDetail.selectedId, openRecipe.id);
	assert.equal(canceledFromDetail.selectedMealServings, 5);

	// Confirming addMeal intentionally closes RecipeDetail and schedules plannedRecipeId.
	assert.deepEqual(
		completePlanMeal(recipes, openRecipe.id, '2026-11-21', 'Snack', 4, () => 'meal-1'),
		{
			ok: false,
			reason: 'missing'
		}
	);
	for (const badServings of [0, 2.5, MAX_SERVINGS + 1]) {
		assert.deepEqual(
			completePlanMeal(recipes, openRecipe.id, '2026-11-21', 'Dinner', badServings, () => 'meal-1'),
			{
				ok: false,
				reason: 'invalidServings'
			}
		);
	}
	const highYield = completePlanMeal(
		recipes,
		openRecipe.id,
		'2026-11-21',
		'Dinner',
		MAX_SERVINGS,
		() => 'meal-max'
	);
	assert.equal(highYield.ok, true);
	if (highYield.ok) assert.equal(highYield.meal.servings, MAX_SERVINGS);
	const scheduledFromDetail = completePlanMeal(
		recipes,
		fromDetail.plannedRecipeId,
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
		assert.equal(scheduledFromDetail.plannedRecipeId, null);
		assert.equal(scheduledFromDetail.selectedId, null);
		assert.equal(scheduledFromDetail.selectedMealServings, undefined);
		assert.equal(scheduledFromDetail.modal, '');
		assert.equal(scheduledFromDetail.page, 'planner');
	}

	// 2. Plan via planner pickRecipe: selectedId stays null so canceling returns to planner.
	const fromPicker = pickRecipeForPlan(null, pickedRecipe, '', '2026-11-22');
	assert.equal(fromPicker.selectedId, null);
	assert.equal(fromPicker.plannedRecipeId, pickedRecipe.id);
	assert.equal(fromPicker.plannedServings, 3);
	assert.equal(fromPicker.mealDate, '2026-11-22');
	assert.equal(fromPicker.modal, 'plan');

	const canceledFromPicker = closeModalDialog(
		makeEscapeState({
			modal: fromPicker.modal,
			selectedId: fromPicker.selectedId,
			plannedRecipeId: fromPicker.plannedRecipeId
		})
	);
	assert.equal(canceledFromPicker.modal, '');
	assert.equal(canceledFromPicker.plannedRecipeId, null);
	assert.equal(canceledFromPicker.selectedId, null);
});

test('settings, onboarding, resumeDialog, and identity reset helpers preserve or clear recipe state appropriately', () => {
	const activeRecipe = makeRecipe({ nutritionStale: true });

	// Settings opened from RecipeDetail (e.g. Refresh nutrition -> needAI) keeps RecipeDetail inert, then restores on Done.
	assert.equal(isRecipeDetailInert('settings', null), true);
	const closedSettings = closeModalDialog(
		makeEscapeState({
			modal: 'settings',
			selectedId: activeRecipe.id,
			selectedMealServings: 4
		})
	);
	assert.equal(closedSettings.modal, '');
	assert.equal(closedSettings.selectedId, activeRecipe.id);
	assert.equal(isRecipeDetailInert(closedSettings.modal, null), false);

	// Settings -> Onboarding dismissed via closeModalDialog records skipped onboarding without dropping selectedId.
	const closedOnboarding = closeModalDialog(
		makeEscapeState({
			modal: 'onboarding',
			selectedId: activeRecipe.id,
			onboardingStatus: undefined
		})
	);
	assert.equal(closedOnboarding.modal, '');
	assert.equal(closedOnboarding.onboardingStatus, 'skipped');
	assert.equal(closedOnboarding.selectedId, activeRecipe.id);

	// Settings or auth opened during recipe import or pantry dictation resumes target dialog when closed.
	const resumedImport = closeModalDialog(
		makeEscapeState({
			modal: 'settings',
			resumeDialog: 'import',
			selectedId: null
		})
	);
	assert.equal(resumedImport.modal, 'import');
	assert.equal(resumedImport.resumeDialog, '');

	const resumedPantry = closeModalDialog(
		makeEscapeState({
			modal: 'auth',
			resumeDialog: 'pantry',
			selectedId: activeRecipe.id
		})
	);
	assert.equal(resumedPantry.modal, 'pantry');
	assert.equal(resumedPantry.resumeDialog, '');
	assert.equal(resumedPantry.selectedId, activeRecipe.id);

	const closedPantry = closeModalDialog(
		makeEscapeState({
			modal: 'pantry',
			resumeDialog: 'pantry',
			selectedId: activeRecipe.id
		})
	);
	assert.equal(closedPantry.modal, '');
	assert.equal(closedPantry.resumeDialog, '');
	assert.equal(closedPantry.selectedId, activeRecipe.id);

	// Account, household, and freshKitchen reset helper clears all transient recipe state.
	assert.deepEqual(clearRecipeSubflowState(), {
		selectedId: null,
		selectedMealServings: undefined,
		editingRecipe: null,
		editingRecipeMode: 'edit',
		recipeToDeleteId: null,
		plannedRecipeId: null
	});
});

test('layered Escape ignores defaultPrevented and dismisses modal, editingRecipe, selectedId, mobileNav, then pantryDraft', () => {
	const activeRecipe = makeRecipe();
	const draft = makeRecipe({ title: 'Draft Edit' });
	const pantryEdit = { id: 'p1', quantity: 2, unit: 'g', category: 'Pantry', expires: '' };

	let state = makeEscapeState({
		modal: 'deleteRecipe',
		recipeToDeleteId: activeRecipe.id,
		editingRecipe: draft,
		editingRecipeMode: 'create',
		selectedId: activeRecipe.id,
		selectedMealServings: 6,
		mobileNav: true,
		pantryDraft: pantryEdit
	});

	// Non-Escape keys and defaultPrevented Escape (e.g. ButlerChat or pantry input) are ignored.
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
	assert.equal(state.recipeToDeleteId, null);
	assert.equal(state.editingRecipe, draft);
	assert.equal(state.selectedId, activeRecipe.id);
	assert.equal(state.selectedMealServings, 6);
	assert.equal(state.mobileNav, true);
	assert.equal(state.pantryDraft, pantryEdit);

	// 2nd Escape dismisses editingRecipe only and resets editingRecipeMode.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'editingRecipe');
	state = step.state;
	assert.equal(state.editingRecipe, null);
	assert.equal(state.editingRecipeMode, 'edit');
	assert.equal(state.selectedId, activeRecipe.id);
	assert.equal(state.selectedMealServings, 6);
	assert.equal(state.mobileNav, true);
	assert.equal(state.pantryDraft, pantryEdit);

	// 3rd Escape dismisses selectedId and clears selectedMealServings, keeping mobileNav and pantryDraft.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'selected');
	state = step.state;
	assert.equal(state.selectedId, null);
	assert.equal(state.selectedMealServings, undefined);
	assert.equal(state.mobileNav, true);
	assert.equal(state.pantryDraft, pantryEdit);

	// 4th Escape dismisses mobileNav, keeping pantryDraft.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'mobileNav');
	state = step.state;
	assert.equal(state.mobileNav, false);
	assert.equal(state.pantryDraft, pantryEdit);

	// 5th Escape dismisses pantryDraft.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'pantryDraft');
	state = step.state;
	assert.equal(state.pantryDraft, null);

	// 6th Escape with nothing open is a no-op.
	step = dismissEscapeLayer({ key: 'Escape' }, state);
	assert.equal(step.dismissed, 'none');
});
