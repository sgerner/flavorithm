import type { Recipe } from '#lib/types.ts';

export const MAX_RECIPES = 250;
export const DEFAULT_RECIPE_FILTER = 'For you';

export type RecipeFilterState = {
	filter: string;
	query: string;
	showHiddenRecipes: boolean;
};

export function hasActiveRecipeFilters(state: RecipeFilterState): boolean {
	return (
		state.filter !== DEFAULT_RECIPE_FILTER || state.query.length > 0 || state.showHiddenRecipes
	);
}

export function resetRecipeFilterState(): RecipeFilterState {
	return {
		filter: DEFAULT_RECIPE_FILTER,
		query: '',
		showHiddenRecipes: false
	};
}

export function filterTabScrollTarget(metrics: {
	clientWidth: number;
	scrollWidth: number;
	pillLeft: number;
	pillWidth: number;
}): number {
	const maxScroll = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
	if (maxScroll <= 0) return 0;
	const centered = metrics.pillLeft - (metrics.clientWidth - metrics.pillWidth) / 2;
	return Math.min(maxScroll, Math.max(0, centered));
}

export function filterTabsOverflow(metrics: {
	scrollLeft: number;
	clientWidth: number;
	scrollWidth: number;
}): { left: boolean; right: boolean } {
	const maxScroll = metrics.scrollWidth - metrics.clientWidth;
	if (maxScroll <= 1) return { left: false, right: false };
	return {
		left: metrics.scrollLeft > 1,
		right: metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - 1
	};
}

export function hasZeroNutrition(nutrition: Recipe['nutrition']): boolean {
	return (
		nutrition.calories === 0 &&
		nutrition.fat === 0 &&
		nutrition.saturatedFat === 0 &&
		nutrition.sodium === 0 &&
		nutrition.carbs === 0 &&
		nutrition.fiber === 0 &&
		nutrition.sugar === 0 &&
		nutrition.protein === 0
	);
}

export function createBlankRecipe(id: string = crypto.randomUUID()): Recipe {
	return {
		id,
		title: '',
		description: '',
		image: '',
		time: 30,
		servings: 2,
		difficulty: '',
		cuisine: '',
		tags: [],
		ingredients: [{ name: '', quantity: 1, unit: 'piece' }],
		steps: [''],
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
	};
}

export function finalizeManualRecipe(draft: Recipe): Recipe {
	return {
		...draft,
		saved: true,
		provenance: 'manual',
		nutritionStale: hasZeroNutrition(draft.nutrition)
	};
}

/** Apply a batch atomically, preserving existing recipes when it cannot fit. */
export function insertRecipes(existing: Recipe[], incoming: Recipe[]): Recipe[] {
	const additions = new Map(incoming.map((recipe) => [recipe.id, recipe]));
	const recipes = [
		...additions.values(),
		...existing.filter((recipe) => !additions.has(recipe.id))
	];
	if (recipes.length > MAX_RECIPES) {
		throw new Error(
			`Your kitchen can hold up to ${MAX_RECIPES} recipes. There isn’t enough room to save this.`
		);
	}
	return recipes;
}
