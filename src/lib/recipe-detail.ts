import { isValidServings, MAX_SERVINGS } from './recipe-draft.ts';
import type { Recipe } from './types.ts';

export { isValidServings };

export const MIN_RECIPE_SERVINGS = 1;
export const MAX_RECIPE_SERVINGS = MAX_SERVINGS;

export const RECIPE_TABS = ['recipe', 'nutrition'] as const;
export type RecipeTab = (typeof RECIPE_TABS)[number];

export type NutritionMode = 'serving' | 'scaled' | 'recipe';

export const RATING_STARS = [1, 2, 3, 4, 5] as const;

export function clampServings(value: number): number {
	if (!Number.isFinite(value)) return MIN_RECIPE_SERVINGS;
	return Math.min(MAX_RECIPE_SERVINGS, Math.max(MIN_RECIPE_SERVINGS, Math.round(value)));
}

export function resolveServingsFallback(
	candidate: number | null | undefined,
	recipeServings: number
): number {
	if (isValidServings(candidate)) return candidate;
	if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
		return clampServings(candidate);
	}
	if (Number.isFinite(recipeServings) && recipeServings > 0) {
		return clampServings(recipeServings);
	}
	return MIN_RECIPE_SERVINGS;
}

export function resolveActiveServings(
	servingCount: number | null | undefined,
	lastValidServings: number
): number {
	return isValidServings(servingCount) ? servingCount : clampServings(lastValidServings);
}

export function stepServings(
	current: number | null | undefined,
	delta: -1 | 1,
	lastValidServings: number
): number {
	if (isValidServings(current)) {
		return clampServings(current + delta);
	}
	if (typeof current === 'number' && Number.isFinite(current)) {
		if (!Number.isInteger(current)) {
			const base = delta > 0 ? Math.floor(current) : Math.ceil(current);
			return clampServings(base + delta);
		}
		return clampServings(current + delta);
	}
	return clampServings(lastValidServings + delta);
}

export function scaleIngredientQuantity(
	quantity: number,
	recipeServings: number,
	targetServings: number
): number {
	const baseline = Number.isFinite(recipeServings) && recipeServings > 0 ? recipeServings : 1;
	return +((quantity * targetServings) / baseline).toFixed(2);
}

export function nutritionMultiplierFor(
	mode: NutritionMode,
	recipeServings: number,
	scaledServings: number
): number {
	if (mode === 'recipe') return recipeServings;
	if (mode === 'scaled') return scaledServings;
	return 1;
}

export function nutritionServingSizeLabel(mode: NutritionMode, scaledServings: number): string {
	if (mode === 'recipe') return 'Whole recipe';
	if (mode === 'scaled') {
		return `${scaledServings} ${scaledServings === 1 ? 'serving' : 'servings'}`;
	}
	return '1 serving';
}

export function nutritionAmountHeading(mode: NutritionMode, scaledServings: number): string {
	if (mode === 'recipe') return 'Amount per recipe';
	if (mode === 'scaled') {
		return `Amount per ${scaledServings} ${scaledServings === 1 ? 'serving' : 'servings'}`;
	}
	return 'Amount per serving';
}

export function scaleNutritionValue(perServingValue: number, multiplier: number): number {
	return Math.round(perServingValue * multiplier);
}

export function nextRecipeTabForKey(current: RecipeTab, key: string): RecipeTab | undefined {
	const index = RECIPE_TABS.indexOf(current);
	const safeIndex = index >= 0 ? index : 0;
	if (key === 'ArrowRight') return RECIPE_TABS[(safeIndex + 1) % RECIPE_TABS.length];
	if (key === 'ArrowLeft') {
		return RECIPE_TABS[(safeIndex - 1 + RECIPE_TABS.length) % RECIPE_TABS.length];
	}
	if (key === 'Home') return RECIPE_TABS[0];
	if (key === 'End') return RECIPE_TABS[RECIPE_TABS.length - 1];
	return undefined;
}

export function bookmarkLabel(saved: boolean | undefined): string {
	return saved ? 'Unsave recipe' : 'Save recipe';
}

export function starRatingLabel(stars: number): string {
	return stars === 1 ? 'Rate 1 star' : `Rate ${stars} stars`;
}

export function ratingTabIndex(currentRating: number | undefined, star: number): 0 | -1 {
	const selected = RATING_STARS.find((value) => value === currentRating) ?? RATING_STARS[0];
	return star === selected ? 0 : -1;
}

export function toggleRecipeRating(
	currentRating: number | undefined,
	selectedStar: number
): number | undefined {
	return currentRating === selectedStar ? undefined : selectedStar;
}

export function nextRatingStarForKey(focusedStar: number, key: string): number | undefined {
	const index = RATING_STARS.indexOf(focusedStar as (typeof RATING_STARS)[number]);
	const safeIndex = index >= 0 ? index : 0;
	if (key === 'ArrowRight' || key === 'ArrowDown') {
		return RATING_STARS[(safeIndex + 1) % RATING_STARS.length];
	}
	if (key === 'ArrowLeft' || key === 'ArrowUp') {
		return RATING_STARS[(safeIndex - 1 + RATING_STARS.length) % RATING_STARS.length];
	}
	if (key === 'Home') return RATING_STARS[0];
	if (key === 'End') return RATING_STARS[RATING_STARS.length - 1];
	return undefined;
}

export function applyRecipeRating(
	recipe: Pick<Recipe, 'id' | 'rating'>,
	ratings: Record<string, number> | undefined,
	nextRating: number | undefined
): Record<string, number> | undefined {
	if (nextRating === undefined) {
		delete recipe.rating;
		if (!ratings) return undefined;
		const updated = { ...ratings };
		delete updated[recipe.id];
		return updated;
	}
	recipe.rating = nextRating;
	return { ...(ratings ?? {}), [recipe.id]: nextRating };
}
