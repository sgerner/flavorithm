import type { Ingredient, Preferences, Recipe } from './types';
import {
	convertCompatibleQuantity,
	expiryStatus,
	normalizeIngredientName
} from './kitchen-workflows.ts';

function normalized(value: string): string {
	return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function difficultyKey(value: string): string {
	const cleaned = normalized(value);
	if (/easy|simple|beginner|low/.test(cleaned)) return 'easy';
	if (/medium|moderate|intermediate/.test(cleaned)) return 'medium';
	if (/hard|challenging|advanced|high/.test(cleaned)) return 'hard';
	return cleaned;
}

function recipeRating(recipe: Recipe, preferences: Preferences): number | undefined {
	const value = preferences.ratings?.[recipe.id] ?? recipe.rating;
	return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5
		? value
		: undefined;
}

type RatedRecipe = { recipe: Recipe; signal: number };

function averageSignal(entries: RatedRecipe[], matches: (recipe: Recipe) => boolean): number {
	const relevant = entries.filter(({ recipe }) => matches(recipe));
	if (!relevant.length) return 0;
	return relevant.reduce((sum, entry) => sum + entry.signal, 0) / relevant.length;
}

function pantryScores(
	recipe: Recipe,
	pantry: Ingredient[],
	now: Date
): { available: number; expiring: number } {
	const ingredients = recipe.ingredients.filter(
		(item) => Number.isFinite(item.quantity) && item.quantity > 0 && item.unit.trim()
	);
	if (!ingredients.length) return { available: 0, expiring: 0 };

	let availability = 0;
	let expiringAvailability = 0;
	for (const ingredient of ingredients) {
		let quantityAvailable = 0;
		let quantityExpiring = 0;
		for (const item of pantry) {
			if (normalizeIngredientName(item.name) !== normalizeIngredientName(ingredient.name)) continue;
			if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
			if (expiryStatus(item.expires, now) === 'expired') continue;
			const compatibleQuantity = convertCompatibleQuantity(
				item.quantity,
				item.unit,
				ingredient.unit
			);
			if (compatibleQuantity === undefined || compatibleQuantity <= 0) continue;
			quantityAvailable += compatibleQuantity;
			if (expiryStatus(item.expires, now) === 'soon') quantityExpiring += compatibleQuantity;
		}
		availability += Math.min(1, quantityAvailable / ingredient.quantity);
		expiringAvailability += Math.min(1, quantityExpiring / ingredient.quantity);
	}

	return {
		available: availability / ingredients.length,
		expiring: expiringAvailability / ingredients.length
	};
}

function learnedTimeSignal(recipe: Recipe, rated: RatedRecipe[]): number {
	let weighted = 0;
	let weights = 0;
	for (const entry of rated) {
		const distance = Math.abs(recipe.time - entry.recipe.time);
		const weight = 1 / (1 + distance / 20);
		weighted += entry.signal * weight;
		weights += weight;
	}
	return weights ? weighted / weights : 0;
}

function scoreRecipe(
	recipe: Recipe,
	pantryItems: Ingredient[],
	preferences: Preferences,
	rated: RatedRecipe[],
	now: Date
): number {
	let score = 0;
	const rating = recipeRating(recipe, preferences);
	if (rating !== undefined) score += (rating - 3) * 5;

	score +=
		averageSignal(rated, (other) => normalized(other.cuisine) === normalized(recipe.cuisine)) * 4.5;
	const candidateTags = new Set(recipe.tags.map(normalized));
	score +=
		averageSignal(rated, (other) => other.tags.some((tag) => candidateTags.has(normalized(tag)))) *
		3;
	score +=
		averageSignal(
			rated,
			(other) => difficultyKey(other.difficulty) === difficultyKey(recipe.difficulty)
		) * 2;
	score += learnedTimeSignal(recipe, rated) * 2.5;

	const preferredCuisines = preferences.cuisines ?? [];
	if (preferredCuisines.some((cuisine) => normalized(cuisine) === normalized(recipe.cuisine)))
		score += 5;

	if (Number.isFinite(preferences.maxTime) && preferences.maxTime > 0) {
		if (recipe.time <= preferences.maxTime) score += 2;
		else
			score -= Math.min(
				6,
				((recipe.time - preferences.maxTime) / Math.max(15, preferences.maxTime)) * 6
			);
	}

	const preferredDifficulty = difficultyKey(preferences.complexity);
	if (preferredDifficulty && !['any', 'flexible', 'no preference'].includes(preferredDifficulty)) {
		if (preferredDifficulty === difficultyKey(recipe.difficulty)) score += 2.5;
	}

	// Diet labels only add a preference signal when they appear in the recipe tags.
	// Allergy data is intentionally not treated as a safety determination here.
	const diet = normalized(preferences.diet);
	if (diet && !['any', 'flexible', 'no preference', 'none'].includes(diet)) {
		if (recipe.tags.some((tag) => normalized(tag).includes(diet))) score += 2;
	}

	const pantryMatch = pantryScores(recipe, pantryItems, now);
	score += pantryMatch.available * 9;
	score += pantryMatch.expiring * 4;
	return score;
}

/** Rank suggestions from explicit preferences, past ratings, and usable pantry ingredients. */
export function rankRecipes(
	recipes: Recipe[],
	pantry: Ingredient[],
	preferences: Preferences,
	now: Date = new Date()
): Recipe[] {
	const rated: RatedRecipe[] = recipes.flatMap((recipe) => {
		const rating = recipeRating(recipe, preferences);
		return rating === undefined ? [] : [{ recipe, signal: (rating - 3) / 2 }];
	});

	return recipes
		.map((recipe, index) => ({
			recipe,
			index,
			score: scoreRecipe(recipe, pantry, preferences, rated, now)
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ recipe }) => recipe);
}
