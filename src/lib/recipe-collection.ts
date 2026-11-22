import type { Recipe } from '#lib/types.ts';

export const MAX_RECIPES = 250;

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
