import { unitInfo } from './domain.ts';
import type { Recipe, RecipeIngredient } from './types.ts';

export type ScrapedRecipeMetadata = {
	title: string;
	description: string;
	image: string;
	yield: string;
	time: number;
	cuisine?: string;
	tags?: string[];
	ingredients: string[];
	steps: string[];
	nutrition?: Partial<Recipe['nutrition']>;
};

export type ParsedIngredientLine = {
	ingredient: RecipeIngredient;
	inferredNote?: string;
};

const MAX_ASSUMPTIONS = 30;
const MAX_NOTE_LENGTH = 300;
const DEFAULT_TIME_MINUTES = 30;
const DEFAULT_SERVINGS = 4;

const VULGAR_FRACTIONS: Record<string, string> = {
	'½': '1/2',
	'⅓': '1/3',
	'⅔': '2/3',
	'¼': '1/4',
	'¾': '3/4',
	'⅕': '1/5',
	'⅖': '2/5',
	'⅗': '3/5',
	'⅘': '4/5',
	'⅙': '1/6',
	'⅚': '5/6',
	'⅛': '1/8',
	'⅜': '3/8',
	'⅝': '5/8',
	'⅞': '7/8'
};

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	deg: '°',
	frac12: '½',
	frac14: '¼',
	frac34: '¾',
	frac13: '⅓',
	frac23: '⅔',
	frac15: '⅕',
	frac25: '⅖',
	frac35: '⅗',
	frac45: '⅘',
	frac16: '⅙',
	frac56: '⅚',
	frac18: '⅛',
	frac38: '⅜',
	frac58: '⅝',
	frac78: '⅞'
};

/** Units mapped directly through domain.ts unitInfo plus normalized culinary containers. */
const KNOWN_UNIT_TOKENS: Record<string, string> = {
	// Mass (domain.ts)
	g: 'g',
	gr: 'g',
	gram: 'g',
	grams: 'g',
	kg: 'kg',
	kilo: 'kg',
	kilos: 'kg',
	kilogram: 'kg',
	kilograms: 'kg',
	mg: 'mg',
	milligram: 'mg',
	milligrams: 'mg',
	oz: 'oz',
	ounce: 'oz',
	ounces: 'oz',
	lb: 'lb',
	lbs: 'lb',
	pound: 'lb',
	pounds: 'lb',
	// Volume (domain.ts)
	ml: 'ml',
	milliliter: 'ml',
	milliliters: 'ml',
	millilitre: 'ml',
	millilitres: 'ml',
	l: 'l',
	liter: 'l',
	liters: 'l',
	litre: 'l',
	litres: 'l',
	tsp: 'tsp',
	tsps: 'tsp',
	teaspoon: 'tsp',
	teaspoons: 'tsp',
	tbsp: 'tbsp',
	tbs: 'tbsp',
	tbsps: 'tbsp',
	tablespoon: 'tbsp',
	tablespoons: 'tbsp',
	cup: 'cup',
	cups: 'cup',
	c: 'cup',
	'fl oz': 'fl oz',
	'fl. oz': 'fl oz',
	'fluid oz': 'fl oz',
	'fluid ounce': 'fl oz',
	'fluid ounces': 'fl oz',
	pt: 'pt',
	pint: 'pt',
	pints: 'pt',
	qt: 'qt',
	quart: 'qt',
	quarts: 'qt',
	gal: 'gal',
	gallon: 'gal',
	gallons: 'gal',
	// Count & count-scoped units (domain.ts)
	ea: 'each',
	each: 'each',
	piece: 'each',
	pieces: 'each',
	whole: 'each',
	small: 'each',
	medium: 'each',
	large: 'each',
	clove: 'clove',
	cloves: 'clove',
	head: 'head',
	heads: 'head',
	'small head': 'head',
	'medium head': 'head',
	'large head': 'head',
	slice: 'slice',
	slices: 'slice',
	can: 'can',
	cans: 'can',
	tin: 'can',
	tins: 'can',
	pinch: 'pinch',
	pinches: 'pinch',
	dash: 'dash',
	dashes: 'dash',
	// Common culinary package/bunch units
	bunch: 'bunch',
	bunches: 'bunch',
	sprig: 'sprig',
	sprigs: 'sprig',
	stalk: 'stalk',
	stalks: 'stalk',
	stick: 'stick',
	sticks: 'stick',
	pkg: 'package',
	pkgs: 'package',
	package: 'package',
	packages: 'package',
	packet: 'package',
	packets: 'package',
	jar: 'jar',
	jars: 'jar',
	bottle: 'bottle',
	bottles: 'bottle',
	bag: 'bag',
	bags: 'bag',
	box: 'box',
	boxes: 'box',
	handful: 'handful',
	handfuls: 'handful',
	leaf: 'leaf',
	leaves: 'leaf',
	fillet: 'fillet',
	fillets: 'fillet',
	sheet: 'sheet',
	sheets: 'sheet'
};

const TWO_WORD_UNITS = [
	'fl. oz',
	'fl oz',
	'fluid oz',
	'fluid ounce',
	'fluid ounces',
	'small head',
	'medium head',
	'large head'
];

const SIZE_ADJECTIVE_UNITS = new Set(['small', 'medium', 'large']);

const TRAILING_PREP_PATTERN =
	/,\s*(?:(?:finely|roughly|coarsely|thinly|thickly|freshly|lightly|well)\s+)?(?:chopped|diced|minced|sliced|grated|shredded|crushed|peeled|seeded|cored|halved|quartered|cubed|julienned|torn|trimmed|rinsed|drained|drained and rinsed|rinsed and drained|melted|softened|beaten|whisked|sifted|toasted|roasted|warmed|cooled|chilled|thawed|divided|optional|to taste|as needed|for serving|for garnish|for drizzling|for dusting|for greasing|room temperature|at room temperature|plus more\b[^,]*).*$/i;

export function isStandaloneRecipeUrl(value: string): boolean {
	return /^https?:\/\/[^\s]+$/i.test(value.trim());
}

export function decodeRecipeText(value: string): string {
	const withoutTags = value
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi, ' ');
	return withoutTags.replace(/&(#x[\da-f]+|#\d+|[a-z0-9]+);/gi, (full, rawEntity: string) => {
		const entity = rawEntity.toLowerCase();
		if (Object.hasOwn(NAMED_HTML_ENTITIES, entity)) {
			return NAMED_HTML_ENTITIES[entity];
		}
		if (entity.startsWith('#x')) {
			const code = Number.parseInt(entity.slice(2), 16);
			return safeCodePoint(code) ?? full;
		}
		if (entity.startsWith('#')) {
			const code = Number.parseInt(entity.slice(1), 10);
			return safeCodePoint(code) ?? full;
		}
		return full;
	});
}

function safeCodePoint(code: number): string | undefined {
	try {
		return Number.isInteger(code) && code > 0 && code <= 0x10ffff
			? String.fromCodePoint(code)
			: undefined;
	} catch {
		return undefined;
	}
}

function canonicalUnit(token: string): string | undefined {
	const cleaned = token.toLowerCase().trim().replace(/\s+/g, ' ').replace(/\.$/, '');
	const mapped = KNOWN_UNIT_TOKENS[cleaned];
	if (!mapped) return undefined;
	return unitInfo(mapped).display;
}

function normalizeFractions(input: string): string {
	let result = input.replace(/\u2044/g, '/');
	for (const [glyph, ascii] of Object.entries(VULGAR_FRACTIONS)) {
		result = result
			.replace(new RegExp(`(\\d)\\s*${glyph}`, 'g'), `$1 ${ascii}`)
			.replace(new RegExp(glyph, 'g'), ascii);
	}
	return result;
}

function parseLeadingNumber(text: string): { value: number; rest: string } | undefined {
	const trimmed = text.trim().replace(/^(?:about|approx\.?|approximately)\s+(?=\d|\.)/i, '');

	const mixed = /^(\d+)(?:\s+|-)(?:(\d+)\s*\/\s*(\d+))(?=\s|[-–—]|[a-zA-Z(]|$)/.exec(trimmed);
	if (mixed) {
		const whole = Number(mixed[1]);
		const num = Number(mixed[2]);
		const den = Number(mixed[3]);
		if (den > 0 && num < den) {
			return {
				value: whole + num / den,
				rest: stripRangeContinuation(trimmed.slice(mixed[0].length))
			};
		}
	}

	const fraction = /^(\d+)\s*\/\s*(\d+)(?=\s|[-–—]|[a-zA-Z(]|$)/.exec(trimmed);
	if (fraction) {
		const num = Number(fraction[1]);
		const den = Number(fraction[2]);
		if (den > 0) {
			return {
				value: num / den,
				rest: stripRangeContinuation(trimmed.slice(fraction[0].length))
			};
		}
	}

	const decimalOrThousands =
		/^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+,\d{1,2}(?!\d)|\d+(?:\.\d+)?|\.\d+)(?=\s|[-–—]|[a-zA-Z(]|$)/.exec(
			trimmed
		);
	if (decimalOrThousands) {
		const raw = decimalOrThousands[0];
		const isDecimalComma = /^\d+,\d{1,2}$/.test(raw);
		const normalized = isDecimalComma ? raw.replace(',', '.') : raw.replace(/,/g, '');
		const value = Number(normalized);
		if (Number.isFinite(value)) {
			return {
				value,
				rest: stripRangeContinuation(trimmed.slice(raw.length))
			};
		}
	}

	return undefined;
}

function stripRangeContinuation(rest: string): string {
	const rangeMatch =
		/^(?:\s*(?:[-–—]|to|or)\s*(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|\.\d+))(?=\s|[a-zA-Z(]|$)/i.exec(
			rest
		);
	return (rangeMatch ? rest.slice(rangeMatch[0].length) : rest).trim();
}

function matchLeadingUnit(
	text: string,
	allowAttachedUnit: boolean
): { unit: string; rest: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	for (const phrase of TWO_WORD_UNITS) {
		const escaped = phrase.replace(/\./g, '\\.?').replace(/\s+/g, '\\s+');
		const regex = new RegExp(`^(${escaped})\\.?\\s+(.+)$`, 'i');
		const match = regex.exec(trimmed);
		if (match) {
			const unit = canonicalUnit(match[1]);
			const afterOf = stripLeadingOf(match[2]);
			if (unit && afterOf) return { unit, rest: afterOf };
		}
	}

	const singleMatch = /^([a-zA-Z]+)\.?\s+(.+)$/.exec(trimmed);
	if (singleMatch) {
		const rawToken = singleMatch[1].trim();
		const rawRemainder = singleMatch[2].trim();
		if (!allowAttachedUnit && rawToken.length === 1 && !/^(?:g|l)$/i.test(rawToken)) {
			if (rawToken.toLowerCase() !== 'c' || !/^c\./i.test(trimmed)) return undefined;
		}
		if (rawToken.toLowerCase() === 'c' && !/^c\./i.test(trimmed)) return undefined;
		if (SIZE_ADJECTIVE_UNITS.has(rawToken.toLowerCase())) {
			const nestedUnit = matchLeadingUnit(rawRemainder, false);
			if (nestedUnit) return nestedUnit;
		}
		const unit = canonicalUnit(rawToken);
		const afterOf = stripLeadingOf(rawRemainder);
		if (unit && afterOf) return { unit, rest: afterOf };
	}

	return undefined;
}

function stripLeadingOf(value: string): string {
	return value
		.trim()
		.replace(/^of\s+/i, '')
		.trim();
}

function cleanIngredientName(raw: string, fallback: string): string {
	let cleaned = stripLeadingOf(raw).replace(/\s+/g, ' ').trim();

	// Remove parenthetical notes when doing so preserves a meaningful name.
	const withoutParens = cleaned
		.replace(/\([^()]*\)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (withoutParens) cleaned = withoutParens;

	const withoutPrep = cleaned.replace(TRAILING_PREP_PATTERN, '').trim();
	if (withoutPrep) cleaned = withoutPrep;

	const withoutTasteSuffix = cleaned
		.replace(/\s+(?:to taste|for garnish|for serving|as needed)$/i, '')
		.replace(/^[,\-–—:;.\s]+|[,\-–—:;.\s]+$/g, '')
		.trim();
	if (withoutTasteSuffix) cleaned = withoutTasteSuffix;

	const finalName = (cleaned || fallback.replace(/\s+/g, ' ').trim() || 'Ingredient')
		.slice(0, 100)
		.trim();
	return finalName || 'Ingredient';
}

function clampPositiveQuantity(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 1;
	const clamped = Math.min(1_000_000, value);
	const rounded = Math.round(clamped * 1000) / 1000;
	return rounded > 0 ? rounded : Number(clamped.toFixed(6)) || 0.01;
}

export function parseRecipeIngredientLine(rawLine: string): ParsedIngredientLine {
	const decoded = decodeRecipeText(rawLine)
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[•*▪◦\-–—]+\s*/, '')
		.trim();
	const normalized = normalizeFractions(decoded);
	const toTaste = /\bto taste\b/i.test(decoded);

	// Check "a pinch of salt" / "an ounce of ..."
	const articleMatch = /^(?:a|an)\s+(.+)$/i.exec(normalized);
	if (articleMatch) {
		const unitMatch = matchLeadingUnit(articleMatch[1], false);
		if (unitMatch) {
			const name = cleanIngredientName(unitMatch.rest, decoded);
			return {
				ingredient: {
					name,
					quantity: 1,
					unit: unitMatch.unit.slice(0, 40)
				}
			};
		}
	}

	const leadingNumber = parseLeadingNumber(normalized);
	if (leadingNumber) {
		const positiveValid = Number.isFinite(leadingNumber.value) && leadingNumber.value > 0;
		let quantity = clampPositiveQuantity(leadingNumber.value);
		let remainder = leadingNumber.rest;

		// Handle package-size parentheticals right after quantity: e.g. "1 (15-ounce) can chickpeas" or "1 (14 oz) firm tofu"
		const parenMatch = /^\(([^()]{1,40})\)\s*(.+)$/.exec(remainder);
		if (parenMatch) {
			const afterParen = parenMatch[2].trim();
			const afterParenUnit = matchLeadingUnit(afterParen, false);
			if (afterParenUnit) {
				const name = cleanIngredientName(afterParenUnit.rest, afterParen);
				return {
					ingredient: {
						name,
						quantity,
						unit: afterParenUnit.unit.slice(0, 40)
					},
					...(!positiveValid
						? {
								inferredNote: `Defaulted "${name}" quantity to ${quantity} ${afterParenUnit.unit}.`
							}
						: {})
				};
			}
			const parenSize = parseLeadingNumber(parenMatch[1]);
			if (parenSize && parenSize.value > 0 && parenSize.rest) {
				const parenUnit = canonicalUnit(parenSize.rest.replace(/^[-\s]+/, ''));
				if (parenUnit && parenUnit !== 'each') {
					const name = cleanIngredientName(afterParen, afterParen);
					quantity = clampPositiveQuantity(quantity * parenSize.value);
					return {
						ingredient: {
							name,
							quantity,
							unit: parenUnit.slice(0, 40)
						}
					};
				}
			}
			remainder = afterParen;
		}

		// Handle hyphenated package size before container unit: e.g. "1 15-oz can black beans"
		const hyphenSizeContainer =
			/^(?:\d+(?:\.\d+)?)\s*-?\s*(?:oz|ounce|ounces|g|gram|grams|ml)\.?\s+(.+)$/i.exec(remainder);
		if (hyphenSizeContainer) {
			const containerUnit = matchLeadingUnit(hyphenSizeContainer[1], false);
			if (containerUnit) {
				const name = cleanIngredientName(containerUnit.rest, hyphenSizeContainer[1]);
				return {
					ingredient: {
						name,
						quantity,
						unit: containerUnit.unit.slice(0, 40)
					}
				};
			}
		}

		const unitMatch = matchLeadingUnit(remainder, true);
		if (unitMatch) {
			const name = cleanIngredientName(unitMatch.rest, remainder || decoded);
			return {
				ingredient: {
					name,
					quantity,
					unit: unitMatch.unit.slice(0, 40)
				},
				...(!positiveValid
					? { inferredNote: `Defaulted "${name}" quantity to ${quantity} ${unitMatch.unit}.` }
					: {})
			};
		}

		const name = cleanIngredientName(remainder, decoded);
		const defaultUnit = toTaste ? 'pinch' : 'each';
		return {
			ingredient: {
				name,
				quantity,
				unit: defaultUnit
			},
			inferredNote: !positiveValid
				? `Defaulted "${name}" to ${quantity} ${defaultUnit}.`
				: `Defaulted "${name}" unit to "${defaultUnit}".`
		};
	}

	// Check leading unit word without number: e.g. "Pinch of nutmeg", "Juice of 1 lemon" -> only known units
	const unitOnlyMatch = matchLeadingUnit(normalized, false);
	if (
		unitOnlyMatch &&
		[
			'pinch',
			'dash',
			'handful',
			'bunch',
			'sprig',
			'can',
			'clove',
			'head',
			'slice',
			'package'
		].includes(unitOnlyMatch.unit)
	) {
		const name = cleanIngredientName(unitOnlyMatch.rest, decoded);
		return {
			ingredient: {
				name,
				quantity: 1,
				unit: unitOnlyMatch.unit.slice(0, 40)
			},
			inferredNote: `Defaulted "${name}" quantity to 1 ${unitOnlyMatch.unit}.`
		};
	}

	const name = cleanIngredientName(normalized, decoded);
	const defaultUnit = toTaste ? 'pinch' : 'each';
	return {
		ingredient: {
			name,
			quantity: 1,
			unit: defaultUnit
		},
		inferredNote: `Defaulted "${name}" to 1 ${defaultUnit} (no quantity or unit listed).`
	};
}

export function parseRecipeServings(rawYield: string): { servings: number; inferred: boolean } {
	const cleaned = decodeRecipeText(rawYield).trim();
	if (!cleaned) return { servings: DEFAULT_SERVINGS, inferred: true };

	const explicitMatch =
		/(\d+(?:\.\d+)?)\s*(?:[-–—to]+\s*\d+(?:\.\d+)?\s*)?(?:servings?|portions?|people|persons)\b/i.exec(
			cleaned
		) ?? /\bserves?\s+(\d+(?:\.\d+)?)/i.exec(cleaned);
	const fallbackMatch = /(\d+(?:\.\d+)?)/.exec(cleaned);
	const rawNumber = explicitMatch?.[1] ?? fallbackMatch?.[1];
	if (!rawNumber) return { servings: DEFAULT_SERVINGS, inferred: true };

	const parsed = Math.round(Number(rawNumber));
	if (!Number.isFinite(parsed) || parsed < 1) {
		return { servings: DEFAULT_SERVINGS, inferred: true };
	}
	return {
		servings: Math.min(10_000, parsed),
		inferred: false
	};
}

function isSectionHeaderLine(line: string): boolean {
	const trimmed = decodeRecipeText(line).trim();
	if (!trimmed) return true;
	if (/^[-–—*=_\s]+$/.test(trimmed)) return true;
	if (/^(?:for\s+the\s+|for\s+)[^:\d]{1,50}:$/i.test(trimmed)) return true;
	return false;
}

function normalizeSteps(rawSteps: string[]): string[] {
	const expanded =
		rawSteps.length === 1 && rawSteps[0].includes('\n') ? rawSteps[0].split(/\n+/) : rawSteps;
	const cleaned = expanded
		.map((step) =>
			decodeRecipeText(step)
				.replace(/\s+/g, ' ')
				.trim()
				.replace(/^(?:step\s*\d+\s*[:.)-]|\d+\s*[.)])\s+/i, '')
				.trim()
				.slice(0, 1_000)
		)
		.filter(Boolean)
		.slice(0, 40);
	return cleaned;
}

function inferDifficulty(timeMinutes: number, stepCount: number, ingredientCount: number): string {
	if (timeMinutes <= 30 && stepCount <= 6 && ingredientCount <= 10) return 'Easy';
	if (timeMinutes > 75 || stepCount > 12 || ingredientCount > 18) return 'Hard';
	return 'Medium';
}

function safeHttpsImage(value: string): string {
	if (!value || value.length > 2_000) return '';
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
	} catch {
		return '';
	}
}

const NUTRITION_KEYS: Array<keyof Recipe['nutrition']> = [
	'calories',
	'fat',
	'saturatedFat',
	'sodium',
	'carbs',
	'fiber',
	'sugar',
	'protein'
];

export function buildStructuredRecipeDraft(
	source: ScrapedRecipeMetadata,
	sourceUrl: string
): { recipe: Recipe; assumptions: string[] } {
	const title = decodeRecipeText(source.title).replace(/\s+/g, ' ').trim().slice(0, 160);
	const description = decodeRecipeText(source.description)
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 600);
	const steps = normalizeSteps(source.steps);

	const nonHeaderLines = source.ingredients.filter((line) => !isSectionHeaderLine(line));
	const candidateLines = nonHeaderLines.length > 0 ? nonHeaderLines : source.ingredients;
	const parsedIngredients = candidateLines
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 60)
		.map((line) => parseRecipeIngredientLine(line));

	const ingredients = parsedIngredients.map((entry) => entry.ingredient);
	const ingredientNotes = parsedIngredients
		.map((entry) => entry.inferredNote)
		.filter((note): note is string => Boolean(note));

	const notes: string[] = [];

	const rawTime = Number.isFinite(source.time) ? Math.round(source.time) : 0;
	const time = rawTime > 0 ? Math.min(100_000, rawTime) : DEFAULT_TIME_MINUTES;
	if (rawTime <= 0) {
		notes.push(
			`Cooking time was not listed on the page; defaulted to ${DEFAULT_TIME_MINUTES} minutes.`
		);
	}

	const { servings, inferred: inferredServings } = parseRecipeServings(source.yield);
	if (inferredServings) {
		notes.push(`Servings were not listed on the page; defaulted to ${DEFAULT_SERVINGS} servings.`);
	}

	const nutrition: Recipe['nutrition'] = {
		calories: 0,
		fat: 0,
		saturatedFat: 0,
		sodium: 0,
		carbs: 0,
		fiber: 0,
		sugar: 0,
		protein: 0
	};
	let providedNutritionCount = 0;
	if (source.nutrition) {
		for (const key of NUTRITION_KEYS) {
			const val = source.nutrition[key];
			if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1_000_000) {
				nutrition[key] = val;
				providedNutritionCount += 1;
			}
		}
	}
	if (providedNutritionCount === 0) {
		notes.push(
			'Per-serving nutrition was not listed on the page; values defaulted to 0 for review.'
		);
	} else if (providedNutritionCount < NUTRITION_KEYS.length) {
		notes.push('Some nutrition fields were not listed on the page and defaulted to 0.');
	}

	const cuisine =
		decodeRecipeText(source.cuisine ?? '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 80) || 'International';
	const tags = [
		...new Set(
			(source.tags ?? [])
				.map((tag) => decodeRecipeText(tag).replace(/\s+/g, ' ').trim().slice(0, 40))
				.filter(Boolean)
		)
	].slice(0, 20);
	const difficulty = inferDifficulty(time, steps.length, ingredients.length);

	const uniqueIngredientNotes = [...new Set(ingredientNotes)];
	const availableIngredientSlots = Math.max(0, MAX_ASSUMPTIONS - notes.length);
	if (uniqueIngredientNotes.length <= availableIngredientSlots) {
		notes.push(...uniqueIngredientNotes);
	} else if (availableIngredientSlots > 0) {
		notes.push(...uniqueIngredientNotes.slice(0, availableIngredientSlots - 1));
		const remainingCount = uniqueIngredientNotes.length - (availableIngredientSlots - 1);
		notes.push(
			`Defaulted quantities or units for ${remainingCount} additional ingredient${remainingCount === 1 ? '' : 's'}.`
		);
	}

	const assumptions = notes
		.map((note) => note.trim().slice(0, MAX_NOTE_LENGTH))
		.filter(Boolean)
		.slice(0, MAX_ASSUMPTIONS);

	return {
		recipe: {
			id: crypto.randomUUID(),
			title,
			description,
			image: safeHttpsImage(source.image),
			time,
			servings,
			difficulty,
			cuisine,
			tags,
			ingredients,
			steps,
			nutrition,
			...(providedNutritionCount === 0 ? { nutritionStale: true } : {}),
			...(sourceUrl ? { source: sourceUrl } : {}),
			saved: false,
			provenance: 'web-import'
		},
		assumptions
	};
}
