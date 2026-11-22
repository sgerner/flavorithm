import type { Ingredient, Meal, Recipe, ShoppingItem } from './types';

export type UnitSystem = 'metric' | 'customary' | 'count' | 'custom';
export type UnitInfo = { dimension: string; factor: number; display: string; system: UnitSystem };

const unitAliases: Record<string, UnitInfo> = {};
const canonicalUnits: UnitInfo[] = [];

function addUnits(
	dimension: string,
	system: UnitSystem,
	factor: number,
	display: string,
	aliases: string[]
) {
	const info: UnitInfo = { dimension, factor, display, system };
	canonicalUnits.push(info);
	for (const alias of aliases) unitAliases[alias] = info;
}

addUnits('mass', 'metric', 1, 'g', ['g', 'gram', 'grams']);
addUnits('mass', 'metric', 1000, 'kg', ['kg', 'kilogram', 'kilograms']);
addUnits('mass', 'metric', 0.001, 'mg', ['mg', 'milligram', 'milligrams']);
addUnits('mass', 'customary', 28.349523125, 'oz', ['oz', 'ounce', 'ounces']);
addUnits('mass', 'customary', 453.59237, 'lb', ['lb', 'lbs', 'pound', 'pounds']);
addUnits('volume', 'metric', 1, 'ml', [
	'ml',
	'milliliter',
	'milliliters',
	'millilitre',
	'millilitres'
]);
addUnits('volume', 'metric', 1000, 'l', ['l', 'liter', 'liters', 'litre', 'litres']);
addUnits('volume', 'customary', 4.928921594, 'tsp', ['tsp', 'teaspoon', 'teaspoons']);
addUnits('volume', 'customary', 14.78676478, 'tbsp', ['tbsp', 'tablespoon', 'tablespoons']);
addUnits('volume', 'customary', 236.5882365, 'cup', ['cup', 'cups']);
addUnits('volume', 'customary', 29.5735295625, 'fl oz', [
	'fl oz',
	'fl. oz',
	'fluid oz',
	'fluid ounce',
	'fluid ounces'
]);
addUnits('volume', 'customary', 473.176473, 'pt', ['pt', 'pint', 'pints']);
addUnits('volume', 'customary', 946.352946, 'qt', ['qt', 'quart', 'quarts']);
addUnits('volume', 'customary', 3785.411784, 'gal', ['gal', 'gallon', 'gallons']);
addUnits('count', 'count', 1, 'each', [
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
addUnits('count:clove', 'count', 1, 'clove', ['clove', 'cloves']);
addUnits('count:head', 'count', 1, 'head', [
	'head',
	'heads',
	'small head',
	'medium head',
	'large head'
]);
addUnits('count:slice', 'count', 1, 'slice', ['slice', 'slices']);
addUnits('count:can', 'count', 1, 'can', ['can', 'cans']);
addUnits('count:pinch', 'count', 1, 'pinch', ['pinch', 'pinches']);
addUnits('count:dash', 'count', 1, 'dash', ['dash', 'dashes']);

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
		unitAliases[cleaned] ?? {
			dimension: `unit:${cleaned}`,
			factor: 1,
			display: cleaned || 'each',
			system: 'custom'
		}
	);
}

const MIN_READABLE_SHOPPING_QUANTITY = 0.05;
const BASE_REMAINDER_EPSILON = 0.00001;

export function roundShoppingQuantity(value: number): number {
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function selectShoppingUnit(
	remainingBase: number,
	seenUnits: Iterable<UnitInfo>
): UnitInfo | undefined {
	const seenByDisplay = new Map<string, UnitInfo>();
	for (const unit of seenUnits) seenByDisplay.set(unit.display, unit);
	const sortedSeen = [...seenByDisplay.values()].sort((a, b) => b.factor - a.factor);
	if (sortedSeen.length === 0) return undefined;

	const readableSeen = sortedSeen.find(
		(unit) => roundShoppingQuantity(remainingBase / unit.factor) >= MIN_READABLE_SHOPPING_QUANTITY
	);
	if (readableSeen) return readableSeen;

	const anchor = sortedSeen[sortedSeen.length - 1];
	const smallerUnits = canonicalUnits
		.filter(
			(unit) =>
				unit.dimension === anchor.dimension &&
				unit.system === anchor.system &&
				unit.factor < anchor.factor
		)
		.sort((a, b) => b.factor - a.factor);
	return (
		smallerUnits.find(
			(unit) => roundShoppingQuantity(remainingBase / unit.factor) >= MIN_READABLE_SHOPPING_QUANTITY
		) ??
		smallerUnits[smallerUnits.length - 1] ??
		anchor
	);
}

/**
 * Clamp negligible base remainders up to 0.00001 to zero, pick a readable unit
 * from the seen units or downscale within its unit system, and round to 0.000001.
 */
export function resolveShoppingQuantity(
	rawRemainingBase: number,
	seenUnits: Iterable<UnitInfo>
): { quantity: number; unit: UnitInfo } | undefined {
	if (!Number.isFinite(rawRemainingBase) || rawRemainingBase <= BASE_REMAINDER_EPSILON)
		return undefined;
	const unit = selectShoppingUnit(rawRemainingBase, seenUnits);
	if (!unit) return undefined;
	const quantity = roundShoppingQuantity(rawRemainingBase / unit.factor);
	if (quantity <= 0) return undefined;
	return { quantity, unit };
}

/**
 * Format scaled recipe ingredient quantities: at most two decimal places from 0.1 upward,
 * and two significant digits in plain decimal form for positive values below 0.1.
 */
export function formatRecipeQuantity(value: number): string {
	if (!Number.isFinite(value)) return '—';
	if (value <= 0) return '0';
	if (value >= 0.1) return String(Number(value.toFixed(2)));
	const precise = value.toPrecision(2);
	const exponential = /^(\d)(?:\.(\d+))?e-(\d+)$/i.exec(precise);
	if (exponential) {
		const digits = `${exponential[1]}${exponential[2] ?? ''}`.replace(/0+$/, '');
		return `0.${'0'.repeat(Number(exponential[3]) - 1)}${digits}`;
	}
	return String(Number(precise));
}

export type CalendarDate = { year: number; month: number; day: number };

const ISO_CALENDAR_DATE_RE =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i;

export function parseCalendarDate(value: string): CalendarDate | undefined {
	const match = ISO_CALENDAR_DATE_RE.exec(value.trim());
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	const parsed = new Date(0);
	parsed.setUTCFullYear(year, month, day);
	parsed.setUTCHours(0, 0, 0, 0);
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month ||
		parsed.getUTCDate() !== day
	)
		return undefined;
	return { year, month, day };
}

export function dateOrdinal(date: CalendarDate): number {
	const utcDate = new Date(0);
	utcDate.setUTCFullYear(date.year, date.month, date.day);
	utcDate.setUTCHours(0, 0, 0, 0);
	return Math.floor(utcDate.getTime() / 86_400_000);
}

function localCalendarDate(value: Date): CalendarDate {
	return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
}

type ShoppingRequirement = {
	quantityBase: number;
	mealOrdinal?: number;
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
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const todayOrdinal = dateOrdinal(localCalendarDate(safeNow));
	const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
	const requested: Array<{ recipe: Recipe; servings: number; mealOrdinal?: number }> =
		meals === undefined
			? recipes.map((recipe) => ({
					recipe,
					servings: recipe.servings,
					mealOrdinal: todayOrdinal
				}))
			: meals.flatMap((meal) => {
					const recipe = recipesById.get(meal.recipeId);
					if (!recipe || !Number.isFinite(meal.servings) || !(meal.servings > 0)) return [];
					const trimmedDate = meal.date.trim();
					const parsedMealDate = trimmedDate ? parseCalendarDate(trimmedDate) : undefined;
					return [
						{
							recipe,
							servings: meal.servings,
							mealOrdinal: trimmedDate
								? parsedMealDate
									? Math.max(todayOrdinal, dateOrdinal(parsedMealDate))
									: undefined
								: todayOrdinal
						}
					];
				});

	const buckets = new Map<
		string,
		{
			name: string;
			normalizedName: string;
			dimension: string;
			units: UnitInfo[];
			quantityBase: number;
			pantryBase: number;
			requirements: ShoppingRequirement[];
		}
	>();

	for (const { recipe, servings, mealOrdinal } of requested) {
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
				units: [],
				quantityBase: 0,
				pantryBase: 0,
				requirements: []
			};
			bucket.units.push(unit);
			const quantityBase = ingredient.quantity * scale * unit.factor;
			bucket.quantityBase += quantityBase;
			bucket.requirements.push({
				quantityBase,
				mealOrdinal,
				// Without a recipe serving baseline, pantry stock cannot prove this request is covered.
				canUsePantry: hasServingBaseline && mealOrdinal !== undefined
			});
			buckets.set(key, bucket);
		}
	}

	const pantryByBucket = new Map<
		string,
		Array<{ quantityBase: number; expiryOrdinal?: number; index: number }>
	>();
	for (const item of pantry) {
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		const rawExpires = item.expires?.trim();
		let expiryOrdinal: number | undefined;
		if (rawExpires) {
			const parsedExpiry = parseCalendarDate(rawExpires);
			if (!parsedExpiry) continue;
			expiryOrdinal = dateOrdinal(parsedExpiry);
		}
		const normalizedName = normalizeName(item.name);
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const bucket = buckets.get(key);
		if (!bucket) continue;
		bucket.units.push(unit);
		const lots = pantryByBucket.get(key) ?? [];
		lots.push({
			quantityBase: item.quantity * unit.factor,
			expiryOrdinal,
			index: lots.length
		});
		pantryByBucket.set(key, lots);
	}

	for (const [key, bucket] of buckets) {
		const lots = (pantryByBucket.get(key) ?? []).sort((a, b) => {
			const priorityA = a.expiryOrdinal ?? Number.MAX_SAFE_INTEGER;
			const priorityB = b.expiryOrdinal ?? Number.MAX_SAFE_INTEGER;
			return priorityA - priorityB || a.index - b.index;
		});
		const requirements = [...bucket.requirements].sort((a, b) => {
			const orderA = a.mealOrdinal ?? Number.MAX_SAFE_INTEGER;
			const orderB = b.mealOrdinal ?? Number.MAX_SAFE_INTEGER;
			return orderA - orderB;
		});
		for (const requirement of requirements) {
			if (!requirement.canUsePantry || requirement.mealOrdinal === undefined) continue;
			let need = requirement.quantityBase;
			for (const lot of lots) {
				if (need <= 0) break;
				if (
					!(lot.quantityBase > 0) ||
					(lot.expiryOrdinal !== undefined && lot.expiryOrdinal < requirement.mealOrdinal)
				)
					continue;
				const used = Math.min(need, lot.quantityBase);
				lot.quantityBase -= used;
				need -= used;
				bucket.pantryBase += used;
			}
		}
	}

	return [...buckets.values()]
		.flatMap((bucket) => {
			const resolved = resolveShoppingQuantity(
				bucket.quantityBase - bucket.pantryBase,
				bucket.units
			);
			if (!resolved) return [];
			return [
				{
					id: `shopping-${bucket.normalizedName.replace(/[^a-z0-9]+/g, '-')}-${resolved.unit.display.replace(/[^a-z0-9]+/g, '-')}`,
					name: bucket.name,
					quantity: resolved.quantity,
					unit: resolved.unit.display,
					checked: false
				}
			];
		})
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
