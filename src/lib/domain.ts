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
	'item',
	'items',
	'piece',
	'pieces',
	'whole',
	'egg',
	'eggs',
	'small',
	'medium',
	'large'
]);
addUnits('count:bunch', 1, 'bunch', ['bunch', 'bunches']);
addUnits('count:clove', 1, 'clove', ['clove', 'cloves']);
addUnits('count:head', 1, 'head', ['head', 'heads', 'small head', 'medium head', 'large head']);
addUnits('count:slice', 1, 'slice', ['slice', 'slices']);
addUnits('count:can', 1, 'can', ['can', 'cans']);
addUnits('count:pinch', 1, 'pinch', ['pinch', 'pinches']);
addUnits('count:dash', 1, 'dash', ['dash', 'dashes']);

const sortedUnitAliases = Object.keys(unitAliases).sort((a, b) => b.length - a.length);

const unicodeFractions: Record<string, number> = {
	'¼': 1 / 4,
	'½': 1 / 2,
	'¾': 3 / 4,
	'⅐': 1 / 7,
	'⅑': 1 / 9,
	'⅒': 1 / 10,
	'⅓': 1 / 3,
	'⅔': 2 / 3,
	'⅕': 1 / 5,
	'⅖': 2 / 5,
	'⅗': 3 / 5,
	'⅘': 4 / 5,
	'⅙': 1 / 6,
	'⅚': 5 / 6,
	'⅛': 1 / 8,
	'⅜': 3 / 8,
	'⅝': 5 / 8,
	'⅞': 7 / 8
};

export type ParsedIngredient = {
	name: string;
	quantity: number;
	unit: string;
	category: string;
};

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

function roundParsedQuantity(value: number): number {
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function parseLeadingQuantity(text: string): { quantity: number; rest: string } | undefined {
	const mixedAscii = /^(\d+)(?:\s+|-)(\d+)\s*[\/⁄]\s*(\d+)(?=\s|[a-zA-Z]|$)(.*)$/.exec(text);
	if (mixedAscii) {
		const whole = Number(mixedAscii[1]);
		const num = Number(mixedAscii[2]);
		const den = Number(mixedAscii[3]);
		const rest = mixedAscii[4].trim();
		if (!rest) return undefined;
		if (den <= 0) return { quantity: 0, rest };
		return { quantity: roundParsedQuantity(whole + num / den), rest };
	}

	const mixedUnicode = /^(\d+)(?:\s+|-)?([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])(?=\s|[a-zA-Z]|$)(.*)$/.exec(text);
	if (mixedUnicode) {
		const whole = Number(mixedUnicode[1]);
		const frac = unicodeFractions[mixedUnicode[2]] ?? 0;
		const rest = mixedUnicode[3].trim();
		if (!rest) return undefined;
		return { quantity: roundParsedQuantity(whole + frac), rest };
	}

	const asciiFraction = /^(\d+)\s*[\/⁄]\s*(\d+)(?=\s|[a-zA-Z]|$)(.*)$/.exec(text);
	if (asciiFraction) {
		const num = Number(asciiFraction[1]);
		const den = Number(asciiFraction[2]);
		const rest = asciiFraction[3].trim();
		if (!rest) return undefined;
		if (den <= 0) return { quantity: 0, rest };
		return { quantity: roundParsedQuantity(num / den), rest };
	}

	const singleUnicode = /^([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])(?=\s|[a-zA-Z]|$)(.*)$/.exec(text);
	if (singleUnicode) {
		const frac = unicodeFractions[singleUnicode[1]] ?? 0;
		const rest = singleUnicode[2].trim();
		if (!rest) return undefined;
		return { quantity: roundParsedQuantity(frac), rest };
	}

	const decimal = /^(\d+(?:\.\d+)?|\.\d+)(?=\s|[a-zA-Z]|$)(.*)$/.exec(text);
	if (decimal) {
		const quantity = Number(decimal[1]);
		const rest = decimal[2].trim();
		if (!rest || !Number.isFinite(quantity)) return undefined;
		return { quantity: roundParsedQuantity(quantity), rest };
	}

	return undefined;
}

export function parseIngredientLine(raw: string): ParsedIngredient | undefined {
	let working = raw.trim().replace(/\s+/g, ' ');
	working = working.replace(/^[-*•]\s+/, '').trim();
	working = working.replace(/[.,;:]$/, '').trim();
	if (!working || /^\[[^\[\]]*\]$/.test(working)) return undefined;

	let category = 'Pantry';
	const categoryMatch = /^(.*?)\s*\[([^\[\]]*)\]\s*$/.exec(working);
	if (categoryMatch && categoryMatch[1].trim()) {
		working = categoryMatch[1]
			.trim()
			.replace(/[.,;:]$/, '')
			.trim();
		const parsedCategory = categoryMatch[2].trim().replace(/\s+/g, ' ').slice(0, 60);
		if (parsedCategory) category = parsedCategory;
	}
	if (!working || /^[\d\s\/⁄.\-¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]+$/.test(working)) return undefined;

	const leading = parseLeadingQuantity(working);
	if (!leading) {
		const name = working.slice(0, 100).trim();
		return name ? { name, quantity: 1, unit: 'each', category } : undefined;
	}
	if (!(leading.quantity > 0)) return undefined;

	const { quantity, rest } = leading;
	const lowerRest = rest.toLowerCase();
	for (const alias of sortedUnitAliases) {
		if (!lowerRest.startsWith(alias)) continue;
		const afterAlias = rest.slice(alias.length);
		if (!/^\.?\s+/.test(afterAlias)) continue;
		let candidateName = afterAlias.replace(/^\.?\s+/, '').trim();
		if (/^of$/i.test(candidateName)) candidateName = '';
		else candidateName = candidateName.replace(/^of\s+/i, '').trim();
		candidateName = candidateName
			.replace(/[.,;:]$/, '')
			.trim()
			.slice(0, 100)
			.trim();
		if (candidateName) {
			return {
				name: candidateName,
				quantity,
				unit: unitAliases[alias].display,
				category
			};
		}
	}

	const fallbackName = rest
		.replace(/^of\s+/i, '')
		.replace(/[.,;:]$/, '')
		.trim()
		.slice(0, 100)
		.trim();
	return fallbackName ? { name: fallbackName, quantity, unit: 'each', category } : undefined;
}

export function parseIngredientLines(input: string): ParsedIngredient[] {
	return input
		.split(/[,;\r\n]+(?![^\[\]]*\])/)
		.map((segment) => parseIngredientLine(segment))
		.filter((item): item is ParsedIngredient => item !== undefined);
}

function roundQuantity(value: number): number {
	const rounded = Math.round(value * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
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
			unit: UnitInfo;
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
				unit,
				quantityBase: 0,
				pantryBase: 0,
				requirements: []
			};
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
		if (!buckets.has(key)) continue;
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
