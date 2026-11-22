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
addUnits('volume', 29.5735295625, 'fl oz', [
	'fl oz',
	'fl. oz',
	'fluid oz',
	'fluid ounce',
	'fluid ounces'
]);
addUnits('volume', 473.176473, 'pt', ['pt', 'pint', 'pints']);
addUnits('volume', 946.352946, 'qt', ['qt', 'quart', 'quarts']);
addUnits('volume', 3785.411784, 'gal', ['gal', 'gallon', 'gallons']);
addUnits('count', 1, 'each', [
	'ea',
	'each',
	'piece',
	'pieces',
	'whole',
	'egg',
	'eggs',
	'item',
	'items'
]);
addUnits('count:small', 1, 'small', ['small']);
addUnits('count:medium', 1, 'medium', ['medium']);
addUnits('count:large', 1, 'large', ['large']);
addUnits('count:clove', 1, 'clove', ['clove', 'cloves']);
addUnits('count:head', 1, 'head', ['head', 'heads', 'small head', 'medium head', 'large head']);
addUnits('count:slice', 1, 'slice', ['slice', 'slices']);
addUnits('count:can', 1, 'can', ['can', 'cans']);
addUnits('count:bunch', 1, 'bunch', ['bunch', 'bunches']);
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
	'greek yoghurt': 'greek yogurt',
	'roma tomato': 'tomato',
	'roma tomatoes': 'tomato',
	tomatoes: 'tomato',
	'baby spinach': 'spinach',
	'boneless skinless chicken breast': 'chicken breast',
	'boneless chicken breast': 'chicken breast',
	'persian cucumber': 'cucumber',
	'persian cucumbers': 'cucumber',
	'crushed garlic': 'garlic'
};

const nonIdentityModifiers = new Set([
	'fresh',
	'freshly',
	'baby',
	'minced',
	'boneless',
	'skinless',
	'chopped',
	'diced',
	'sliced',
	'grated',
	'shredded',
	'peeled',
	'trimmed',
	'halved',
	'quartered',
	'drained',
	'rinsed',
	'finely',
	'roughly',
	'coarsely',
	'thinly',
	'thickly',
	'ripe',
	'organic'
]);

const uncountableWords = new Set([
	'asparagus',
	'citrus',
	'couscous',
	'greens',
	'grits',
	'hummus',
	'lemongrass',
	'molasses',
	'oats',
	'swiss',
	'watercress'
]);

const irregularSingulars: Record<string, string> = {
	avocadoes: 'avocado',
	avocados: 'avocado',
	brioches: 'brioche',
	brownies: 'brownie',
	chilies: 'chili',
	chillies: 'chilli',
	cookies: 'cookie',
	halves: 'half',
	jalapenos: 'jalapeno',
	jalapeños: 'jalapeño',
	knives: 'knife',
	leaves: 'leaf',
	loaves: 'loaf',
	mangoes: 'mango',
	mangos: 'mango',
	pies: 'pie',
	potatoes: 'potato',
	quiches: 'quiche',
	smoothies: 'smoothie',
	tomatoes: 'tomato',
	veggies: 'veggie'
};

function cleanText(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/[.,;:]$/, '');
}

function stripModifiers(cleaned: string): string {
	const tokens = cleaned
		.split(' ')
		.map((token) => token.replace(/^,+|,+$/g, ''))
		.filter(Boolean);
	const remaining = tokens.filter((token) => !nonIdentityModifiers.has(token));
	return remaining.length > 0 ? remaining.join(' ') : tokens.join(' ');
}

function singularizeWord(word: string): string {
	if (word.length <= 2 || uncountableWords.has(word)) return word;
	const irregular = irregularSingulars[word];
	if (irregular) return irregular;
	if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
	if (word.length > 3 && word.endsWith('ies') && !/[aeiou]ies$/.test(word)) {
		return `${word.slice(0, -3)}y`;
	}
	if (/(?:sh|ch|x|ss|zz)es$/.test(word)) {
		return word.slice(0, -2);
	}
	if (word.endsWith('s')) {
		return word.slice(0, -1);
	}
	return word;
}

function singularizePhrase(phrase: string): string {
	const words = phrase.split(' ').filter(Boolean);
	if (words.length === 0) return phrase;
	words[words.length - 1] = singularizeWord(words[words.length - 1]);
	return words.join(' ');
}

export function normalizeName(name: string): string {
	const cleaned = cleanText(name);
	if (!cleaned) return '';
	if (ingredientAliases[cleaned]) return ingredientAliases[cleaned];
	const stripped = stripModifiers(cleaned);
	if (ingredientAliases[stripped]) return ingredientAliases[stripped];
	const singular = singularizePhrase(stripped);
	return ingredientAliases[singular] ?? singular;
}

export function unitInfo(unit: string): UnitInfo {
	const cleaned = cleanText(unit);
	if (unitAliases[cleaned]) return unitAliases[cleaned];
	const withoutParens = cleanText(cleaned.replace(/\s*\([^)]*\)/g, ' '));
	if (withoutParens && /^[a-z][a-z.\s-]*$/.test(withoutParens)) {
		return (
			unitAliases[withoutParens] ?? {
				dimension: `unit:${withoutParens}`,
				factor: 1,
				display: withoutParens
			}
		);
	}
	return { dimension: `unit:${cleaned}`, factor: 1, display: cleaned || 'each' };
}

function roundQuantity(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function calendarDate(value: string): { year: number; month: number; day: number } | undefined {
	const cleaned = value.trim();
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
	if (dateOnly) {
		const year = Number(dateOnly[1]);
		const month = Number(dateOnly[2]) - 1;
		const day = Number(dateOnly[3]);
		const parsed = new Date(0);
		parsed.setFullYear(year, month, day);
		parsed.setHours(0, 0, 0, 0);
		if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day)
			return undefined;
		return { year, month, day };
	}
	const parsed = new Date(cleaned);
	if (!Number.isFinite(parsed.getTime())) return undefined;
	return { year: parsed.getFullYear(), month: parsed.getMonth(), day: parsed.getDate() };
}

function dateOrdinal(date: { year: number; month: number; day: number }): number {
	const utcDate = new Date(0);
	utcDate.setUTCFullYear(date.year, date.month, date.day);
	utcDate.setUTCHours(0, 0, 0, 0);
	return Math.floor(utcDate.getTime() / 86_400_000);
}

function localDateKey(value: Date): string | undefined {
	if (!Number.isFinite(value.getTime())) return undefined;
	return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function expiredBefore(expires: string | undefined, date: string | undefined): boolean {
	if (!expires?.trim() || !date?.trim()) return false;
	const expiryDate = calendarDate(expires);
	const scheduledDate = calendarDate(date);
	return Boolean(
		expiryDate && scheduledDate && dateOrdinal(expiryDate) < dateOrdinal(scheduledDate)
	);
}

export type ExpiryStatus = 'expired' | 'soon' | 'fresh' | 'unknown';

/** Classify an expiry by local calendar day; date-only strings are never parsed as UTC. */
export function expiryStatus(expires?: string, now: Date = new Date()): ExpiryStatus {
	if (!expires?.trim() || !Number.isFinite(now.getTime())) return 'unknown';
	const expiry = calendarDate(expires);
	if (!expiry) return 'unknown';
	const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
	const daysUntilExpiry = dateOrdinal(expiry) - dateOrdinal(today);
	if (daysUntilExpiry < 0) return 'expired';
	if (daysUntilExpiry <= 3) return 'soon';
	return 'fresh';
}

export type IndexedPantryLot = {
	quantityBase: number;
	expiry: Exclude<ExpiryStatus, 'expired'>;
	priority: number;
	index: number;
};

export type PantryLotIndex = Map<string, IndexedPantryLot[]>;

export type RecipePantryMatch = {
	matchedCount: number;
	available: number;
	expiring: number;
};

/** Index positive, non-expired pantry stock by normalized name and unit dimension. */
export function indexUsablePantry(pantry: Ingredient[], now: Date = new Date()): PantryLotIndex {
	const index: PantryLotIndex = new Map();
	for (const item of pantry) {
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		const expiry = expiryStatus(item.expires, now);
		if (expiry === 'expired') continue;
		const normalizedName = normalizeName(item.name);
		if (!normalizedName) continue;
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const parsedExpiry = item.expires?.trim() ? calendarDate(item.expires) : undefined;
		const priority = parsedExpiry ? dateOrdinal(parsedExpiry) : Number.MAX_SAFE_INTEGER;
		const lots = index.get(key) ?? [];
		lots.push({
			quantityBase: item.quantity * unit.factor,
			expiry,
			priority,
			index: lots.length
		});
		index.set(key, lots);
	}
	for (const lots of index.values()) {
		lots.sort((a, b) => a.priority - b.priority || a.index - b.index);
	}
	return index;
}

/**
 * Allocate usable compatible pantry stock across a recipe's ingredients, deducting consumed
 * lot balances so split ingredient lines never count shared stock twice.
 */
export function matchRecipePantry(
	recipe: Recipe,
	pantryOrIndex: Ingredient[] | PantryLotIndex,
	now: Date = new Date()
): RecipePantryMatch {
	const ingredients = recipe.ingredients.filter(
		(item) => Number.isFinite(item.quantity) && item.quantity > 0 && item.unit.trim()
	);
	if (!ingredients.length) return { matchedCount: 0, available: 0, expiring: 0 };

	const index = Array.isArray(pantryOrIndex)
		? indexUsablePantry(pantryOrIndex, now)
		: pantryOrIndex;
	const remainingByBucket = new Map<
		string,
		Array<{ remainingBase: number; expiry: Exclude<ExpiryStatus, 'expired'> }>
	>();
	const buckets = new Map<
		string,
		{ requiredBase: number; allocatedBase: number; expiringBase: number }
	>();
	let matchedCount = 0;

	for (const ingredient of ingredients) {
		const normalizedName = normalizeName(ingredient.name);
		const unit = unitInfo(ingredient.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const requiredBase = ingredient.quantity * unit.factor;
		let lots = remainingByBucket.get(key);
		if (!lots) {
			lots = (index.get(key) ?? []).map((lot) => ({
				remainingBase: lot.quantityBase,
				expiry: lot.expiry
			}));
			remainingByBucket.set(key, lots);
		}

		let need = requiredBase;
		let allocatedBase = 0;
		let expiringBase = 0;
		for (const lot of lots) {
			if (need <= 0) break;
			if (!(lot.remainingBase > 0)) continue;
			const used = Math.min(need, lot.remainingBase);
			lot.remainingBase -= used;
			need -= used;
			allocatedBase += used;
			if (lot.expiry === 'soon') expiringBase += used;
		}
		if (allocatedBase > 0) matchedCount++;

		const bucket = buckets.get(key) ?? { requiredBase: 0, allocatedBase: 0, expiringBase: 0 };
		bucket.requiredBase += requiredBase;
		bucket.allocatedBase += allocatedBase;
		bucket.expiringBase += expiringBase;
		buckets.set(key, bucket);
	}

	if (!buckets.size) return { matchedCount, available: 0, expiring: 0 };
	let availabilitySum = 0;
	let expiringSum = 0;
	for (const bucket of buckets.values()) {
		availabilitySum += Math.min(1, bucket.allocatedBase / bucket.requiredBase);
		expiringSum += Math.min(1, bucket.expiringBase / bucket.requiredBase);
	}
	return {
		matchedCount,
		available: availabilitySum / buckets.size,
		expiring: expiringSum / buckets.size
	};
}

type ShoppingRequirement = {
	quantityBase: number;
	mealDate?: string;
	canUsePantry: boolean;
};

/**
 * Build a consolidated shopping list. With no meal plan, each recipe is included
 * at its listed serving count. Passing a meal array (including an empty array)
 * uses only the planned meals and scales each recipe to its requested servings.
 */
export function buildShoppingList(
	recipes: Recipe[],
	pantry: Ingredient[],
	meals?: Meal[],
	now: Date = new Date()
): ShoppingItem[] {
	const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
	const requested: Array<{ recipe: Recipe; servings: number; mealDate?: string }> =
		meals === undefined
			? recipes.map((recipe) => ({
					recipe,
					servings: recipe.servings,
					mealDate: localDateKey(now)
				}))
			: meals.flatMap((meal) => {
					const recipe = recipesById.get(meal.recipeId);
					return recipe && Number.isFinite(meal.servings) && meal.servings > 0
						? [
								{
									recipe,
									servings: meal.servings,
									mealDate: meal.date.trim() ? meal.date : localDateKey(now)
								}
							]
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
			requirements: ShoppingRequirement[];
		}
	>();

	for (const { recipe, servings, mealDate } of requested) {
		const hasServingBaseline = Number.isFinite(recipe.servings) && recipe.servings > 0;
		const scale = hasServingBaseline ? servings / recipe.servings : 1;
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
				pantryBase: 0,
				requirements: []
			};
			const quantityBase = ingredient.quantity * scale * unit.factor;
			bucket.quantityBase += quantityBase;
			bucket.requirements.push({
				quantityBase,
				mealDate,
				// Without a recipe serving baseline, pantry stock cannot prove this request is covered.
				canUsePantry: hasServingBaseline && Boolean(mealDate && calendarDate(mealDate))
			});
			buckets.set(key, bucket);
		}
	}

	const pantryByBucket = new Map<
		string,
		Array<{ quantityBase: number; expires?: string; index: number }>
	>();
	for (const item of pantry) {
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		const normalizedName = normalizeName(item.name);
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		if (!buckets.has(key)) continue;
		const lots = pantryByBucket.get(key) ?? [];
		lots.push({
			quantityBase: item.quantity * unit.factor,
			expires: item.expires,
			index: lots.length
		});
		pantryByBucket.set(key, lots);
	}

	for (const [key, bucket] of buckets) {
		const lots = (pantryByBucket.get(key) ?? []).sort((a, b) => {
			const expiryA = a.expires ? calendarDate(a.expires) : undefined;
			const expiryB = b.expires ? calendarDate(b.expires) : undefined;
			const priorityA = expiryA ? dateOrdinal(expiryA) : Number.MAX_SAFE_INTEGER;
			const priorityB = expiryB ? dateOrdinal(expiryB) : Number.MAX_SAFE_INTEGER;
			return priorityA - priorityB || a.index - b.index;
		});
		const requirements = [...bucket.requirements].sort((a, b) => {
			const dateA = a.mealDate ? calendarDate(a.mealDate) : undefined;
			const dateB = b.mealDate ? calendarDate(b.mealDate) : undefined;
			const orderA = dateA ? dateOrdinal(dateA) : Number.MAX_SAFE_INTEGER;
			const orderB = dateB ? dateOrdinal(dateB) : Number.MAX_SAFE_INTEGER;
			return orderA - orderB;
		});
		for (const requirement of requirements) {
			if (!requirement.canUsePantry) continue;
			let need = requirement.quantityBase;
			for (const lot of lots) {
				if (need <= 0) break;
				if (!(lot.quantityBase > 0) || expiredBefore(lot.expires, requirement.mealDate)) continue;
				const used = Math.min(need, lot.quantityBase);
				lot.quantityBase -= used;
				need -= used;
				bucket.pantryBase += used;
			}
		}
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
