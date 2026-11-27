import { hasZeroNutrition } from '#lib/recipe-collection.ts';
import { isValidServings } from '#lib/recipe-draft.ts';
import type { AppState, Meal, Recipe } from '#lib/types.ts';
import { resolveClosedDialog, type ResumeDialog } from '#lib/voice-capture.ts';

export type RecipeSubflowReset = {
	selectedId: null;
	selectedMealServings: undefined;
	editingRecipe: null;
	editingRecipeMode: 'edit';
	recipeToDeleteId: null;
	plannedRecipeId: null;
};

export type ModalDialogState<TMember = unknown> = {
	modal: string;
	selectedId: string | null;
	selectedMealServings?: number;
	plannedRecipeId: string | null;
	recipeToDeleteId: string | null;
	editingMealId: string;
	cookingMealId: string;
	memberToRemove: TMember | null;
	inviteCode: string;
	currentInviteId: string;
	resumeDialog: ResumeDialog;
	onboardingStatus?: 'completed' | 'skipped';
};

export type EscapeLayerState<
	TMember = unknown,
	TPantryDraft = unknown
> = ModalDialogState<TMember> & {
	editingRecipe: Recipe | null;
	editingRecipeMode?: 'create' | 'edit';
	butlerOpen?: boolean;
	mobileNav: boolean;
	pantryDraft?: TPantryDraft | null;
};

export function isRecipeDetailInert(modal: string, editingRecipe: Recipe | null): boolean {
	return Boolean(modal || editingRecipe);
}

export function resolveSelectedRecipe(recipes: Recipe[], selectedId: string | null): Recipe | null {
	if (!selectedId) return null;
	return recipes.find((item) => item.id === selectedId) ?? null;
}

export function clearRecipeSubflowState(): RecipeSubflowReset {
	return {
		selectedId: null,
		selectedMealServings: undefined,
		editingRecipe: null,
		editingRecipeMode: 'edit',
		recipeToDeleteId: null,
		plannedRecipeId: null
	};
}

export function cloneRecipeDraft(recipe: Recipe): Recipe {
	return {
		...recipe,
		tags: [...recipe.tags],
		ingredients: recipe.ingredients.map((item) => ({ ...item })),
		steps: [...recipe.steps],
		nutrition: { ...recipe.nutrition }
	};
}

export function beginEditSavedRecipe(
	recipes: Recipe[],
	selectedId: string | null,
	recipeId: string
): { selectedId: string | null; editingRecipe: Recipe; editingRecipeMode: 'edit' } | null {
	const saved = recipes.find((item) => item.id === recipeId && item.saved);
	if (!saved) return null;
	return {
		selectedId,
		editingRecipe: cloneRecipeDraft(saved),
		editingRecipeMode: 'edit'
	};
}

export function cancelEditSavedRecipe(selectedId: string | null): {
	selectedId: string | null;
	editingRecipe: null;
	editingRecipeMode: 'edit';
} {
	return {
		selectedId,
		editingRecipe: null,
		editingRecipeMode: 'edit'
	};
}

export function applyEditedRecipe(
	recipes: Recipe[],
	selectedId: string | null,
	updated: Recipe
): {
	recipes: Recipe[];
	selectedId: string | null;
	editingRecipe: null;
	editingRecipeMode: 'edit';
	saved: Recipe | null;
	nutritionNeedsRefresh: boolean;
} {
	const previous = recipes.find((item) => item.id === updated.id);
	if (!previous || !previous.saved) {
		return {
			recipes,
			selectedId,
			editingRecipe: null,
			editingRecipeMode: 'edit',
			saved: null,
			nutritionNeedsRefresh: false
		};
	}
	const nutritionNeedsRefresh =
		previous.servings !== updated.servings ||
		JSON.stringify(previous.ingredients) !== JSON.stringify(updated.ingredients);
	const nutritionChanged = JSON.stringify(previous.nutrition) !== JSON.stringify(updated.nutrition);
	const zeroNutrition = hasZeroNutrition(updated.nutrition);
	const { sampleSaved: _sampleSaved, ...cleanUpdated } = updated;
	const saved: Recipe = {
		...cleanUpdated,
		saved: true,
		nutritionStale: nutritionNeedsRefresh
			? true
			: updated.provenance === 'manual' && zeroNutrition
				? true
				: nutritionChanged && !zeroNutrition
					? false
					: previous.nutritionStale
	};
	return {
		recipes: recipes.map((item) => (item.id === saved.id ? saved : item)),
		selectedId: saved.id,
		editingRecipe: null,
		editingRecipeMode: 'edit',
		saved,
		nutritionNeedsRefresh
	};
}

export function beginDeleteSavedRecipe(
	recipes: Recipe[],
	selectedId: string | null,
	recipeId: string
): {
	selectedId: string | null;
	recipeToDeleteId: string;
	modal: 'deleteRecipe';
} | null {
	const saved = recipes.find((item) => item.id === recipeId && item.saved);
	if (!saved) return null;
	return {
		selectedId,
		recipeToDeleteId: saved.id,
		modal: 'deleteRecipe'
	};
}

export function confirmDeleteSavedRecipe(
	kitchen: AppState,
	selectedId: string | null,
	selectedMealServings: number | undefined,
	recipeToDeleteId: string | null,
	weekStartForDate: (date: string) => string
): {
	recipes: Recipe[];
	meals: Meal[];
	shopping: AppState['shopping'];
	ratings: Record<string, number> | undefined;
	affectedWeeks: string[];
	impactedMealsCount: number;
	deletedRecipe: Recipe;
	selectedId: string | null;
	selectedMealServings: number | undefined;
	recipeToDeleteId: null;
	modal: '';
} | null {
	const recipe = recipeToDeleteId
		? kitchen.recipes.find((item) => item.id === recipeToDeleteId)
		: undefined;
	if (!recipe) return null;
	const impactedMeals = kitchen.meals.filter((meal) => meal.recipeId === recipe.id);
	const affectedWeeks = [...new Set(impactedMeals.map((meal) => weekStartForDate(meal.date)))];
	const meals = kitchen.meals.filter((meal) => meal.recipeId !== recipe.id);
	const recipes = kitchen.recipes.filter((item) => item.id !== recipe.id);
	const shopping = kitchen.shopping.filter(
		(item) => item.sourceKey !== `recipe:${recipe.id}` || item.checked
	);
	let ratings = kitchen.preferences.ratings;
	if (ratings) {
		ratings = { ...ratings };
		delete ratings[recipe.id];
	}
	const closingSelected = selectedId === recipe.id;
	return {
		recipes,
		meals,
		shopping,
		ratings,
		affectedWeeks,
		impactedMealsCount: impactedMeals.length,
		deletedRecipe: recipe,
		selectedId: closingSelected ? null : selectedId,
		selectedMealServings: closingSelected ? undefined : selectedMealServings,
		recipeToDeleteId: null,
		modal: ''
	};
}

export function beginPlanRecipe(
	selectedId: string | null,
	recipe: Recipe,
	servings: number | undefined,
	todayDate: string
): {
	selectedId: string | null;
	plannedRecipeId: string;
	plannedServings: number;
	mealDate: string;
	modal: 'plan';
} {
	return {
		selectedId,
		plannedRecipeId: recipe.id,
		plannedServings: servings ?? recipe.servings,
		mealDate: todayDate,
		modal: 'plan'
	};
}

export function pickRecipeForPlan(
	selectedId: string | null,
	recipe: Recipe,
	mealDate: string,
	todayDate: string
): {
	selectedId: string | null;
	plannedRecipeId: string;
	plannedServings: number;
	mealDate: string;
	modal: 'plan';
} {
	return {
		selectedId,
		plannedRecipeId: recipe.id,
		plannedServings: recipe.servings,
		mealDate: mealDate || todayDate,
		modal: 'plan'
	};
}

export function completePlanMeal(
	recipes: Recipe[],
	plannedRecipeId: string | null,
	mealDate: string,
	mealSlot: string,
	plannedServings: number,
	createId: () => string = () => crypto.randomUUID()
):
	| { ok: false; reason: 'missing' | 'invalidServings' }
	| {
			ok: true;
			meal: Meal;
			plannedRecipeId: null;
			selectedId: null;
			selectedMealServings: undefined;
			modal: '';
			page: 'planner';
	  } {
	const plannedRecipe = plannedRecipeId
		? recipes.find((item) => item.id === plannedRecipeId)
		: undefined;
	if (!plannedRecipe || !mealDate || !['Breakfast', 'Lunch', 'Dinner'].includes(mealSlot)) {
		return { ok: false, reason: 'missing' };
	}
	if (!isValidServings(plannedServings)) {
		return { ok: false, reason: 'invalidServings' };
	}
	return {
		ok: true,
		meal: {
			id: createId(),
			date: mealDate,
			slot: mealSlot,
			recipeId: plannedRecipe.id,
			servings: plannedServings
		},
		plannedRecipeId: null,
		selectedId: null,
		selectedMealServings: undefined,
		modal: '',
		page: 'planner'
	};
}

export function closeModalDialog<TMember = unknown>(
	state: ModalDialogState<TMember>
): ModalDialogState<TMember> {
	const next: ModalDialogState<TMember> = { ...state };
	if (state.modal === 'plan') next.plannedRecipeId = null;
	if (state.modal === 'editMeal') next.editingMealId = '';
	if (state.modal === 'cookMeal') next.cookingMealId = '';
	if (state.modal === 'deleteRecipe') next.recipeToDeleteId = null;
	if (state.modal === 'removeMember') next.memberToRemove = null;
	if (state.modal === 'household') {
		next.inviteCode = '';
		next.currentInviteId = '';
	}
	if (state.modal === 'onboarding') {
		if (!next.onboardingStatus) next.onboardingStatus = 'skipped';
		next.modal = '';
	} else {
		const resolved = resolveClosedDialog(state.modal, state.resumeDialog);
		next.resumeDialog = resolved.resumeDialog;
		next.modal = resolved.modal;
	}
	return next;
}

export function dismissEscapeLayer<TMember = unknown, TPantryDraft = unknown>(
	event: { key: string; defaultPrevented?: boolean },
	state: EscapeLayerState<TMember, TPantryDraft>
): {
	dismissed:
		'none' | 'modal' | 'editingRecipe' | 'selected' | 'butler' | 'mobileNav' | 'pantryDraft';
	state: EscapeLayerState<TMember, TPantryDraft>;
} {
	if (event.key !== 'Escape' || event.defaultPrevented) {
		return { dismissed: 'none', state };
	}
	if (state.modal) {
		return {
			dismissed: 'modal',
			state: {
				...state,
				...closeModalDialog(state)
			}
		};
	}
	if (state.editingRecipe) {
		return {
			dismissed: 'editingRecipe',
			state: {
				...state,
				editingRecipe: null,
				editingRecipeMode: 'edit'
			}
		};
	}
	if (state.selectedId) {
		return {
			dismissed: 'selected',
			state: {
				...state,
				selectedId: null,
				selectedMealServings: undefined
			}
		};
	}
	if (state.butlerOpen) {
		return {
			dismissed: 'butler',
			state: {
				...state,
				butlerOpen: false
			}
		};
	}
	if (state.mobileNav) {
		return {
			dismissed: 'mobileNav',
			state: {
				...state,
				mobileNav: false
			}
		};
	}
	if (state.pantryDraft) {
		return {
			dismissed: 'pantryDraft',
			state: {
				...state,
				pantryDraft: null
			}
		};
	}
	return { dismissed: 'none', state };
}
