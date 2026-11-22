import { isValidServings } from '#lib/recipe-draft.ts';
import type { AppState, Meal, Recipe } from '#lib/types.ts';

export type RecipeSubflowReset = {
	selected: null;
	selectedMealServings: undefined;
	editingRecipe: null;
	recipeToDelete: null;
	plannedRecipe: null;
};

export type ModalDialogState<TMember = unknown> = {
	modal: string;
	selected: Recipe | null;
	selectedMealServings?: number;
	plannedRecipe: Recipe | null;
	recipeToDelete: Recipe | null;
	editingMealId: string;
	cookingMealId: string;
	memberToRemove: TMember | null;
	inviteCode: string;
	currentInviteId: string;
	resumeImport: boolean;
	onboardingStatus?: 'completed' | 'skipped';
};

export type EscapeLayerState<TMember = unknown> = ModalDialogState<TMember> & {
	editingRecipe: Recipe | null;
	mobileNav: boolean;
};

export function isRecipeDetailInert(modal: string, editingRecipe: Recipe | null): boolean {
	return Boolean(modal || editingRecipe);
}

export function clearRecipeSubflowState(): RecipeSubflowReset {
	return {
		selected: null,
		selectedMealServings: undefined,
		editingRecipe: null,
		recipeToDelete: null,
		plannedRecipe: null
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
	selected: Recipe | null,
	recipe: Recipe
): { selected: Recipe | null; editingRecipe: Recipe } | null {
	const saved = recipes.find((item) => item.id === recipe.id && item.saved);
	if (!saved) return null;
	return {
		selected,
		editingRecipe: cloneRecipeDraft(saved)
	};
}

export function cancelEditSavedRecipe(selected: Recipe | null): {
	selected: Recipe | null;
	editingRecipe: null;
} {
	return {
		selected,
		editingRecipe: null
	};
}

export function applyEditedRecipe(
	recipes: Recipe[],
	selected: Recipe | null,
	updated: Recipe
): {
	recipes: Recipe[];
	selected: Recipe | null;
	editingRecipe: null;
	saved: Recipe | null;
	nutritionNeedsRefresh: boolean;
} {
	const previous = recipes.find((item) => item.id === updated.id);
	if (!previous || !previous.saved) {
		return {
			recipes,
			selected,
			editingRecipe: null,
			saved: null,
			nutritionNeedsRefresh: false
		};
	}
	const nutritionNeedsRefresh =
		previous.servings !== updated.servings ||
		JSON.stringify(previous.ingredients) !== JSON.stringify(updated.ingredients);
	const saved: Recipe = {
		...updated,
		saved: true,
		nutritionStale: nutritionNeedsRefresh ? true : previous.nutritionStale
	};
	return {
		recipes: recipes.map((item) => (item.id === saved.id ? saved : item)),
		selected: saved,
		editingRecipe: null,
		saved,
		nutritionNeedsRefresh
	};
}

export function beginDeleteSavedRecipe(
	selected: Recipe | null,
	recipe: Recipe
): {
	selected: Recipe | null;
	recipeToDelete: Recipe;
	modal: 'deleteRecipe';
} | null {
	if (!recipe.saved) return null;
	return {
		selected,
		recipeToDelete: recipe,
		modal: 'deleteRecipe'
	};
}

export function confirmDeleteSavedRecipe(
	kitchen: AppState,
	selected: Recipe | null,
	selectedMealServings: number | undefined,
	recipeToDelete: Recipe | null,
	weekStartForDate: (date: string) => string
): {
	recipes: Recipe[];
	meals: Meal[];
	shopping: AppState['shopping'];
	ratings: Record<string, number> | undefined;
	affectedWeeks: string[];
	impactedMealsCount: number;
	deletedRecipe: Recipe;
	selected: Recipe | null;
	selectedMealServings: number | undefined;
	recipeToDelete: null;
	modal: '';
} | null {
	const recipe = recipeToDelete;
	if (!recipe) return null;
	const impactedMeals = kitchen.meals.filter((meal) => meal.recipeId === recipe.id);
	const affectedWeeks = [...new Set(impactedMeals.map((meal) => weekStartForDate(meal.date)))];
	const meals = kitchen.meals.filter((meal) => meal.recipeId !== recipe.id);
	const recipes = kitchen.recipes.filter((item) => item.id !== recipe.id);
	const shopping = kitchen.shopping.filter((item) => item.sourceKey !== `recipe:${recipe.id}`);
	let ratings = kitchen.preferences.ratings;
	if (ratings) {
		ratings = { ...ratings };
		delete ratings[recipe.id];
	}
	const closingSelected = selected?.id === recipe.id;
	return {
		recipes,
		meals,
		shopping,
		ratings,
		affectedWeeks,
		impactedMealsCount: impactedMeals.length,
		deletedRecipe: recipe,
		selected: closingSelected ? null : selected,
		selectedMealServings: closingSelected ? undefined : selectedMealServings,
		recipeToDelete: null,
		modal: ''
	};
}

export function beginPlanRecipe(
	selected: Recipe | null,
	recipe: Recipe,
	servings: number | undefined,
	todayDate: string
): {
	selected: Recipe | null;
	plannedRecipe: Recipe;
	plannedServings: number;
	mealDate: string;
	modal: 'plan';
} {
	return {
		selected,
		plannedRecipe: recipe,
		plannedServings: servings ?? recipe.servings,
		mealDate: todayDate,
		modal: 'plan'
	};
}

export function pickRecipeForPlan(
	selected: Recipe | null,
	recipe: Recipe,
	mealDate: string,
	todayDate: string
): {
	selected: Recipe | null;
	plannedRecipe: Recipe;
	plannedServings: number;
	mealDate: string;
	modal: 'plan';
} {
	return {
		selected,
		plannedRecipe: recipe,
		plannedServings: recipe.servings,
		mealDate: mealDate || todayDate,
		modal: 'plan'
	};
}

export function completePlanMeal(
	plannedRecipe: Recipe | null,
	mealDate: string,
	mealSlot: string,
	plannedServings: number,
	createId: () => string = () => crypto.randomUUID()
):
	| { ok: false; reason: 'missing' | 'invalidServings' }
	| {
			ok: true;
			meal: Meal;
			plannedRecipe: null;
			selected: null;
			selectedMealServings: undefined;
			modal: '';
			page: 'planner';
	  } {
	if (!plannedRecipe || !mealDate) {
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
		plannedRecipe: null,
		selected: null,
		selectedMealServings: undefined,
		modal: '',
		page: 'planner'
	};
}

export function closeModalDialog<TMember = unknown>(
	state: ModalDialogState<TMember>
): ModalDialogState<TMember> {
	const next: ModalDialogState<TMember> = { ...state };
	if (state.modal === 'plan') next.plannedRecipe = null;
	if (state.modal === 'editMeal') next.editingMealId = '';
	if (state.modal === 'cookMeal') next.cookingMealId = '';
	if (state.modal === 'deleteRecipe') next.recipeToDelete = null;
	if (state.modal === 'removeMember') next.memberToRemove = null;
	if (state.modal === 'household') {
		next.inviteCode = '';
		next.currentInviteId = '';
	}
	if (state.modal === 'onboarding') {
		if (!next.onboardingStatus) next.onboardingStatus = 'skipped';
		next.modal = '';
	} else if (state.resumeImport && (state.modal === 'settings' || state.modal === 'auth')) {
		next.resumeImport = false;
		next.modal = 'import';
	} else {
		next.modal = '';
	}
	return next;
}

export function dismissEscapeLayer<TMember = unknown>(
	event: { key: string; defaultPrevented?: boolean },
	state: EscapeLayerState<TMember>
): {
	dismissed: 'none' | 'modal' | 'editingRecipe' | 'selected' | 'mobileNav';
	state: EscapeLayerState<TMember>;
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
				editingRecipe: null
			}
		};
	}
	if (state.selected) {
		return {
			dismissed: 'selected',
			state: {
				...state,
				selected: null,
				selectedMealServings: undefined
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
	return { dismissed: 'none', state };
}
