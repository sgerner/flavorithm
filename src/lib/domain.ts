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
addUnits('count:bunch', 'count', 1, 'bunch', ['bunch', 'bunches']);
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
	'divided',
	'finely',
	'roughly',
	'coarsely',
	'thinly',
	'thickly',
	'ripe',
	'organic'
]);

const modifierConjunctions = new Set(['and', 'or', '&']);

const trailingUsageClauses = [
	', to taste',
	' to taste',
	', for garnish',
	' for garnish',
	', for serving',
	' for serving',
	', optional'
];

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

function stripParentheticals(cleaned: string): string {
	if (!cleaned.includes('(') && !cleaned.includes(')')) return cleaned;
	const withoutParens = cleanText(cleaned.replace(/\([^)]*\)/g, ' '));
	if (withoutParens) return withoutParens;
	return cleanText(cleaned.replace(/[()]/g, ' '));
}

function stripTrailingClauses(cleaned: string): string {
	let current = cleaned;
	let changed = true;
	while (changed) {
		changed = false;
		for (const clause of trailingUsageClauses) {
			if (current.endsWith(clause)) {
				const candidate = cleanText(current.slice(0, -clause.length));
				if (candidate) {
					current = candidate;
					changed = true;
					break;
				}
			}
		}
	}
	return current;
}

function stripModifiers(cleaned: string): string {
	const clauses = cleaned.split(',');
	const allTokens: string[] = [];
	const keptTokens: string[] = [];
	for (const rawClause of clauses) {
		const clauseTokens = rawClause
			.trim()
			.split(' ')
			.map((token) => token.replace(/^,+|,+$/g, ''))
			.filter(Boolean);
		allTokens.push(...clauseTokens);
		const filtered = clauseTokens.filter((token) => !nonIdentityModifiers.has(token));
		while (filtered.length > 0 && modifierConjunctions.has(filtered[0])) {
			filtered.shift();
		}
		while (filtered.length > 0 && modifierConjunctions.has(filtered[filtered.length - 1])) {
			filtered.pop();
		}
		for (const token of filtered) {
			if (
				modifierConjunctions.has(token) &&
				keptTokens.length > 0 &&
				modifierConjunctions.has(keptTokens[keptTokens.length - 1])
			) {
				continue;
			}
			keptTokens.push(token);
		}
	}
	while (keptTokens.length > 0 && modifierConjunctions.has(keptTokens[0])) {
		keptTokens.shift();
	}
	while (keptTokens.length > 0 && modifierConjunctions.has(keptTokens[keptTokens.length - 1])) {
		keptTokens.pop();
	}
	return keptTokens.length > 0 ? keptTokens.join(' ') : allTokens.join(' ');
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
	const deannotated = stripTrailingClauses(stripParentheticals(cleaned));
	if (!deannotated) return '';
	if (ingredientAliases[deannotated]) return ingredientAliases[deannotated];
	const stripped = stripModifiers(deannotated);
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
				display: withoutParens,
				system: 'custom'
			}
		);
	}
	return {
		dimension: `unit:${cleaned}`,
		factor: 1,
		display: cleaned || 'each',
		system: 'custom'
	};
}

const MIN_READABLE_SHOPPING_QUANTITY = 0.05;
const BASE_REMAINDER_EPSILON = 0.00001;

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
		if (candidateName.startsWith('(')) {
			const closeIndex = candidateName.indexOf(')');
			if (closeIndex !== -1) {
				const afterParen = candidateName.slice(closeIndex + 1).trim();
				if (afterParen) candidateName = afterParen;
			}
		}
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

/** Return milliseconds until the next local calendar midnight (at least 250ms). */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const nextMidnight = new Date(
		safeNow.getFullYear(),
		safeNow.getMonth(),
		safeNow.getDate() + 1,
		0,
		0,
		0,
		50
	);
	return Math.max(250, nextMidnight.getTime() - safeNow.getTime());
}

export type ExpiryStatus = 'expired' | 'soon' | 'fresh' | 'unknown';

/** Classify an expiry by local calendar day; date-only and ISO strings never shift by timezone. */
export function expiryStatus(expires?: string, now: Date = new Date()): ExpiryStatus {
	if (!expires?.trim() || !Number.isFinite(now.getTime())) return 'unknown';
	const expiry = parseCalendarDate(expires);
	if (!expiry) return 'unknown';
	const today = localCalendarDate(now);
	const daysUntilExpiry = dateOrdinal(expiry) - dateOrdinal(today);
	if (daysUntilExpiry < 0) return 'expired';
	if (daysUntilExpiry <= 3) return 'soon';
	return 'fresh';
}

export type IndexedPantryLot = {
	pantryIndex: number;
	unitFactor: number;
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

function roundLotQuantity(value: number): number {
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/** Index positive, non-expired pantry stock by normalized name and unit dimension. */
export function indexUsablePantry(pantry: Ingredient[], now: Date = new Date()): PantryLotIndex {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const index: PantryLotIndex = new Map();
	for (let pantryIndex = 0; pantryIndex < pantry.length; pantryIndex++) {
		const item = pantry[pantryIndex];
		if (!Number.isFinite(item.quantity) || !(item.quantity > 0) || !item.unit.trim()) continue;
		const expiry = expiryStatus(item.expires, safeNow);
		if (expiry === 'expired' || (Boolean(item.expires?.trim()) && expiry === 'unknown')) continue;
		const normalizedName = normalizeName(item.name);
		if (!normalizedName) continue;
		const unit = unitInfo(item.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const parsedExpiry = item.expires?.trim() ? parseCalendarDate(item.expires) : undefined;
		const priority = parsedExpiry ? dateOrdinal(parsedExpiry) : Number.MAX_SAFE_INTEGER;
		const lots = index.get(key) ?? [];
		lots.push({
			pantryIndex,
			unitFactor: unit.factor,
			quantityBase: item.quantity * unit.factor,
			expiry,
			priority,
			index: lots.length
		});
		index.set(key, lots);
	}
	for (const lots of index.values()) {
		lots.sort((a, b) => a.priority - b.priority || a.pantryIndex - b.pantryIndex);
	}
	return index;
}

type WorkingLot = {
	pantryIndex: number;
	unitFactor: number;
	initialBase: number;
	remainingBase: number;
	expiry: Exclude<ExpiryStatus, 'expired'>;
};

function allocateRecipePantry(
	recipe: Recipe,
	pantryOrIndex: Ingredient[] | PantryLotIndex,
	options: { servings?: number; now?: Date } = {}
): RecipePantryMatch & { consumedLots: WorkingLot[]; uncoveredByBucket: Map<string, number> } {
	const ingredients = recipe.ingredients.filter(
		(item) => Number.isFinite(item.quantity) && item.quantity > 0 && item.unit.trim()
	);
	if (!ingredients.length) {
		return {
			matchedCount: 0,
			available: 0,
			expiring: 0,
			consumedLots: [],
			uncoveredByBucket: new Map()
		};
	}

	const rawNow = options.now ?? new Date();
	const safeNow = Number.isFinite(rawNow.getTime()) ? rawNow : new Date();
	const index = Array.isArray(pantryOrIndex)
		? indexUsablePantry(pantryOrIndex, safeNow)
		: pantryOrIndex;
	const scale =
		options.servings !== undefined &&
		Number.isFinite(recipe.servings) &&
		recipe.servings > 0 &&
		Number.isFinite(options.servings) &&
		options.servings > 0
			? options.servings / recipe.servings
			: 1;
	const remainingByBucket = new Map<string, WorkingLot[]>();
	const buckets = new Map<
		string,
		{ requiredBase: number; allocatedBase: number; expiringBase: number }
	>();
	let matchedCount = 0;

	for (const ingredient of ingredients) {
		const normalizedName = normalizeName(ingredient.name);
		if (!normalizedName) continue;
		const unit = unitInfo(ingredient.unit);
		const key = `${normalizedName}\u0000${unit.dimension}`;
		const requiredBase = ingredient.quantity * scale * unit.factor;
		let lots = remainingByBucket.get(key);
		if (!lots) {
			lots = (index.get(key) ?? []).map((lot) => ({
				pantryIndex: lot.pantryIndex,
				unitFactor: lot.unitFactor,
				initialBase: lot.quantityBase,
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
			if (need >= lot.remainingBase) {
				const used = lot.remainingBase;
				lot.remainingBase = 0;
				need = Math.max(0, need - used);
				allocatedBase += used;
				if (lot.expiry === 'soon') expiringBase += used;
			} else {
				const used = need;
				lot.remainingBase -= used;
				need = 0;
				allocatedBase += used;
				if (lot.expiry === 'soon') expiringBase += used;
			}
		}
		if (allocatedBase > 0) matchedCount++;

		const bucket = buckets.get(key) ?? { requiredBase: 0, allocatedBase: 0, expiringBase: 0 };
		bucket.requiredBase += requiredBase;
		bucket.allocatedBase += allocatedBase;
		bucket.expiringBase += expiringBase;
		buckets.set(key, bucket);
	}

	const consumedLots: WorkingLot[] = [];
	for (const lots of remainingByBucket.values()) {
		for (const lot of lots) {
			if (lot.remainingBase < lot.initialBase) consumedLots.push(lot);
		}
	}

	const uncoveredByBucket = new Map<string, number>();
	for (const [key, bucket] of buckets) {
		const uncoveredBase = Math.max(0, bucket.requiredBase - bucket.allocatedBase);
		if (uncoveredBase > 0) uncoveredByBucket.set(key, uncoveredBase);
	}

	if (!buckets.size) {
		return { matchedCount, available: 0, expiring: 0, consumedLots, uncoveredByBucket };
	}
	let availabilitySum = 0;
	let expiringSum = 0;
	for (const bucket of buckets.values()) {
		availabilitySum += Math.min(1, bucket.allocatedBase / bucket.requiredBase);
		expiringSum += Math.min(1, bucket.expiringBase / bucket.requiredBase);
	}
	return {
		matchedCount,
		available: availabilitySum / buckets.size,
		expiring: expiringSum / buckets.size,
		consumedLots,
		uncoveredByBucket
	};
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
	const { matchedCount, available, expiring } = allocateRecipePantry(recipe, pantryOrIndex, {
		now
	});
	return { matchedCount, available, expiring };
}

/**
 * Deduct a recipe's scaled ingredient quantities from usable compatible pantry lots using the
 * shared lot allocator, returning updated pantry stock and any uncovered demand in base units.
 */
export function consumeRecipeFromPantry(
	pantry: Ingredient[],
	recipe: Recipe,
	servings: number,
	now: Date = new Date()
): { pantry: Ingredient[]; uncoveredByBucket: Map<string, number> } {
	const remaining = pantry.map((item) => ({ ...item }));
	if (!Number.isFinite(servings) || !(servings > 0)) {
		return { pantry: remaining, uncoveredByBucket: new Map() };
	}
	const { consumedLots, uncoveredByBucket } = allocateRecipePantry(recipe, pantry, {
		servings,
		now
	});
	for (const lot of consumedLots) {
		const item = remaining[lot.pantryIndex];
		if (!item || !(lot.unitFactor > 0)) continue;
		remaining[lot.pantryIndex] = {
			...item,
			quantity: roundLotQuantity(Math.max(0, lot.remainingBase / lot.unitFactor))
		};
	}
	return { pantry: remaining, uncoveredByBucket };
}

/**
 * Deduct a recipe's scaled ingredient quantities from usable compatible pantry lots using the
 * shared lot allocator, consuming soonest-expiring lots first and never going below zero.
 */
export function deductRecipeFromPantry(
	pantry: Ingredient[],
	recipe: Recipe,
	servings: number,
	now: Date = new Date()
): Ingredient[] {
	return consumeRecipeFromPantry(pantry, recipe, servings, now).pantry;
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
