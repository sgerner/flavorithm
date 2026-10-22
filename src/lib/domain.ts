import type { Ingredient, Meal, Recipe, ShoppingItem } from './types';

export type UnitInfo = { dimension: string; factor: number; display: string };

const unitAliases: Record<string, UnitInfo> = {};

function addUnits(dimension: string, factor: number, display: string, aliases: string[]) {
	for (const alias of aliases) unitAliases[alias] = { dimension, factor, display };
}

addUnits('mass', 1, 'g', ['g', 'gram', 'grams']);
addUnits('mass', 1000, 'kg', ['kg', 'kilogram', 'kilograms']);
addUnits('mass', 0.001, 'mg', ['mg', 'milligram', 'milligrams']);
addUnits('mass', 28.349523125, 'oz', ['oz', 'ounce', 'ounces']);
addUnits('mass', 453.59237, 'lb', ['lb', 'lbs', 'pound', 'pounds']);
addUnits('volume', 1, 'ml', ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres']);
addUnits('volume', 1000, 'l', ['l', 'liter', 'liters', 'litre', 'litres']);
addUnits('volume', 4.928921594, 'tsp', ['tsp', 'teaspoon', 'teaspoons']);
addUnits('volume', 14.78676478, 'tbsp', ['tbsp', 'tablespoon', 'tablespoons']);
addUnits('volume', 236.5882365, 'cup', ['cup', 'cups']);
addUnits('count', 1, 'each', [
	'ea',
	'each',
	'piece',
	'pieces',
	'whole',
	'egg',
	'eggs',
	'small',
	'medium',
	'large'
]);
addUnits('count:clove', 1, 'clove', ['clove', 'cloves']);
addUnits('count:head', 1, 'head', ['head', 'heads', 'small head', 'medium head', 'large head']);
addUnits('count:slice', 1, 'slice', ['slice', 'slices']);
addUnits('count:can', 1, 'can', ['can', 'cans']);
addUnits('count:pinch', 1, 'pinch', ['pinch', 'pinches']);
addUnits('count:dash', 1, 'dash', ['dash', 'dashes']);

const ingredientAliases: Record<string, string> = {
	avocadoes: 'avocado',
	'garbanzo bean': 'chickpea',
	'garbanzo beans': 'chickpea',
	chickpeas: 'chickpea',
	'green onions': 'scallion',
	'green onion': 'scallion',
	scallions: 'scallion',
	'baby potatoes': 'potato',
	potatoes: 'potato',
	'boneless chicken thighs': 'chicken thigh',
	'chicken thighs': 'chicken thigh',
	'fresh parsley': 'parsley',
	'fresh rosemary': 'rosemary',
	'fresh thyme': 'thyme',
	'fresh mint': 'mint',
	'fresh dill': 'dill',
	'extra virgin olive oil': 'olive oil',
	'extra-virgin olive oil': 'olive oil',
	'plain greek yogurt': 'greek yogurt',
	'plain greek yoghurt': 'greek yogurt',
	'roma tomatoes': 'tomato',
	tomatoes: 'tomato',
	'baby spinach': 'spinach',
	'boneless skinless chicken breast': 'chicken breast',
	'boneless chicken breast': 'chicken breast',
	'persian cucumber': 'cucumber',
	'persian cucumbers': 'cucumber'
};

const singulars: Record<string, string> = {
	apples: 'apple',
	avocados: 'avocado',
	beans: 'bean',
	'broccoli florets': 'broccoli floret',
	carrots: 'carrot',
	cucumbers: 'cucumber',
	eggs: 'egg',
	lemons: 'lemon',
	limes: 'lime',
	onions: 'onion',
	potatoes: 'potato',
	tomatoes: 'tomato'
};

function cleanText(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/[.,;:]$/, '');
}

export function normalizeName(name: string): string {
	const cleaned = cleanText(name);
	return ingredientAliases[cleaned] ?? singulars[cleaned] ?? cleaned;
}

export function unitInfo(unit: string): UnitInfo {
	const cleaned = cleanText(unit);
	return (
		unitAliases[cleaned] ?? { dimension: `unit:${cleaned}`, factor: 1, display: cleaned || 'each' }
	);
}

function roundQuantity(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Build a consolidated shopping list. With no meal plan, each recipe is included
 * at its listed serving count. Passing a meal array (including an empty array)
 * uses only the planned meals and scales each recipe to its requested servings.
 */
export function buildShoppingList(
	recipes: Recipe[],
	pantry: Ingredient[],
	meals?: Meal[]
): ShoppingItem[] {
	const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
	const requested: Array<{ recipe: Recipe; servings: number }> =
		meals === undefined
			? recipes.map((recipe) => ({ recipe, servings: recipe.servings }))
			: meals.flatMap((meal) => {
					const recipe = recipesById.get(meal.recipeId);
					return recipe && Number.isFinite(meal.servings) && meal.servings > 0
						? [{ recipe, servings: meal.servings }]
						: [];
				});

	const buckets = new Map<
		string,
		{
			name: string;
			normalizedName: string;
			dimension: string;
			unit: UnitInfo;
			quantityBase: number;
			pantryBase: number;
		}
	>();

	for (const { recipe, servings } of requested) {
		const scale = recipe.servings > 0 ? servings / recipe.servings : 1;
		for (const ingredient of recipe.ingredients) {
			if (
				!Number.isFinite(ingredient.quantity) ||
				!(ingredient.quantity > 0) ||
				!ingredient.unit.trim()
			)
				continue;
			const normalizedName = normalizeName(ingredient.name);
			const unit = unitInfo(ingredient.unit);
			const key = `${normalizedName}\u0000${unit.dimension}`;
			const bucket = buckets.get(key) ?? {
				name: ingredient.name.trim(),
				normalizedName,
				dimension: unit.dimension,
				unit,
				quantityBase: 0,
				pantryBase: 0
			};
			bucket.quantityBase += ingredient.quantity * scale * unit.factor;
			buckets.set(key, bucket);
		}
	}

	for (const item of pantry) {
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		const normalizedName = normalizeName(item.name);
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key);
		if (bucket) bucket.pantryBase += item.quantity * unit.factor;
	}

	return [...buckets.values()]
		.map((bucket) => {
			const remainingBase = Math.max(0, bucket.quantityBase - bucket.pantryBase);
			return {
				id: `shopping-${bucket.normalizedName.replace(/[^a-z0-9]+/g, '-')}-${bucket.unit.display.replace(/[^a-z0-9]+/g, '-')}`,
				name: bucket.name,
				quantity: roundQuantity(remainingBase / bucket.unit.factor),
				unit: bucket.unit.display,
				checked: false
			};
		})
		.filter((item) => item.quantity > 0)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turn saved recipe ratings into a compact preference note for future suggestions. */
export function preferenceSummary(recipes: Recipe[]): string {
	const rated = recipes.filter(
		(recipe) => typeof recipe.rating === 'number' && recipe.rating > 0 && recipe.rating <= 5
	);
	if (rated.length === 0)
		return 'No recipe ratings yet. Ask for a few suggestions and learn from the next ratings.';

	const favorites = rated.filter((recipe) => (recipe.rating ?? 0) >= 4);
	const misses = rated.filter((recipe) => (recipe.rating ?? 0) <= 2);
	const label = (items: Recipe[]) =>
		items
			.slice(0, 3)
			.map((recipe) => recipe.title)
			.join(', ');
	const favoriteCuisines = [
		...new Set(favorites.map((recipe) => recipe.cuisine).filter(Boolean))
	].slice(0, 3);
	const favoriteTags = [...new Set(favorites.flatMap((recipe) => recipe.tags))].slice(0, 4);
	const parts = [`Ratings from ${rated.length} recipe${rated.length === 1 ? '' : 's'} so far.`];
	if (favorites.length) {
		parts.push(
			`Well-liked${label(favorites) ? `: ${label(favorites)}` : ''}${favoriteCuisines.length ? `; cuisines: ${favoriteCuisines.join(', ')}` : ''}${favoriteTags.length ? `; themes: ${favoriteTags.join(', ')}` : ''}.`
		);
	}
	if (misses.length) parts.push(`Lower-rated: ${label(misses)}.`);
	if (!favorites.length && !misses.length)
		parts.push('Ratings are mostly mixed; keep suggestions varied and continue learning.');
	return parts.join(' ');
}
