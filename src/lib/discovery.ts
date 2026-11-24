import type { AppState, Ingredient, Preferences, Recipe } from './types';
import { normalizeName } from './domain.ts';
import {
	convertCompatibleQuantity,
	expiryStatus,
	normalizeIngredientName
} from './kitchen-workflows.ts';

export const MAX_ALLERGIES_LENGTH = 500;

export const DIET_OPTIONS = [
	{ value: 'none', label: 'No dietary restriction' },
	{ value: 'vegetarian', label: 'Vegetarian' },
	{ value: 'vegan', label: 'Vegan' },
	{ value: 'pescatarian', label: 'Pescatarian' },
	{ value: 'gluten-free', label: 'Gluten-free' },
	{ value: 'dairy-free', label: 'Dairy-free' },
	{ value: 'low-carb', label: 'Low-carb' }
] as const;

export type DietValue = (typeof DIET_OPTIONS)[number]['value'];

export type DietConflictCategory =
	'meat' | 'poultry' | 'seafood' | 'dairy' | 'egg' | 'honey' | 'gluten' | 'carb';

export type RecipeConflictReport = {
	hasConflict: boolean;
	diet: string;
	dietLabel: string;
	dietCategories: DietConflictCategory[];
	allergenMatches: string[];
	matchingIngredientIndices: number[];
	ingredientReasons: Record<number, string[]>;
	badge: string;
	summary: string;
};

function normalized(value: string): string {
	return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

const NONE_DIET_ALIASES = new Set([
	'',
	'none',
	'any',
	'flexible',
	'no preference',
	'no-preference',
	'no dietary restriction',
	'a bit of everything'
]);

const CANONICAL_DIETS: Record<string, DietValue> = {
	vegetarian: 'vegetarian',
	vegan: 'vegan',
	pescatarian: 'pescatarian',
	pescetarian: 'pescatarian',
	'gluten-free': 'gluten-free',
	'dairy-free': 'dairy-free',
	'low-carb': 'low-carb'
};

/** Normalize diet strings case-insensitively across canonical diet options. */
export function normalizeDiet(value: string | undefined | null): string {
	const cleaned = normalized(value ?? '');
	if (NONE_DIET_ALIASES.has(cleaned)) return 'none';
	const hyphenated = cleaned.replace(/[\s_]+/g, '-');
	if (NONE_DIET_ALIASES.has(hyphenated)) return 'none';
	return CANONICAL_DIETS[hyphenated] ?? cleaned;
}

function sliceCodePoints(value: string, maxCodePoints: number): string {
	if (value.length <= maxCodePoints) return value;
	let count = 0;
	let end = 0;
	for (const char of value) {
		if (count >= maxCodePoints) break;
		end += char.length;
		count += 1;
	}
	return value.slice(0, end);
}

/** Clamp allergy free-text to 500 Unicode code points for matching and AI prompts without splitting surrogate pairs. */
export function clampAllergies(value: string | undefined | null): string {
	return typeof value === 'string' ? sliceCodePoints(value, MAX_ALLERGIES_LENGTH) : '';
}

/** Resolve a human-readable label for a saved or buffered diet value. */
export function dietLabel(value: string | undefined | null): string {
	const canonical = normalizeDiet(value);
	const found = DIET_OPTIONS.find((option) => option.value === canonical);
	if (found) return found.label;
	return canonical
		? canonical.charAt(0).toUpperCase() + canonical.slice(1)
		: 'No dietary restriction';
}

const IRREGULAR_SINGULARS: Record<string, string> = {
	anchovies: 'anchovy',
	berries: 'berry',
	cherries: 'cherry',
	cranberries: 'cranberry',
	strawberries: 'strawberry',
	blueberries: 'blueberry',
	raspberries: 'raspberry',
	blackberries: 'blackberry',
	pastries: 'pastry',
	tomatoes: 'tomato',
	potatoes: 'potato',
	avocadoes: 'avocado',
	mangoes: 'mango',
	halves: 'half',
	loaves: 'loaf',
	leaves: 'leaf'
};

const INVARIANT_S_WORDS = new Set([
	'couscous',
	'asparagus',
	'hummus',
	'molasses',
	'swiss',
	'bass',
	'citrus',
	'lemongrass',
	'watercress',
	'oats',
	'grits'
]);

function singularizeWord(word: string): string {
	if (IRREGULAR_SINGULARS[word]) return IRREGULAR_SINGULARS[word];
	if (INVARIANT_S_WORDS.has(word)) return word;
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
	if (
		word.length > 3 &&
		word.endsWith('s') &&
		!word.endsWith('ss') &&
		!word.endsWith('us') &&
		!word.endsWith('is')
	) {
		return word.slice(0, -1);
	}
	return word;
}

function wordTokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map(singularizeWord);
}

function buildTokenVariants(rawText: string): { canonical: string; tokenSets: string[][] } {
	const raw = normalized(rawText);
	const canonical = normalizeName(rawText);
	const rawWords = raw.split(/[^a-z0-9]+/).filter(Boolean);
	const canonicalWords = canonical.split(/[^a-z0-9]+/).filter(Boolean);
	return {
		canonical,
		tokenSets: [
			rawWords,
			rawWords.map(singularizeWord),
			canonicalWords,
			canonicalWords.map(singularizeWord)
		]
	};
}

function containsWholePhrase(tokenSets: string[][], phrase: string): boolean {
	const rawTarget = phrase
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (!rawTarget.length) return false;
	const singularTarget = rawTarget.map(singularizeWord);
	for (const tokens of tokenSets) {
		for (const target of [rawTarget, singularTarget]) {
			if (tokens.length < target.length) continue;
			for (let index = 0; index <= tokens.length - target.length; index++) {
				let matched = true;
				for (let offset = 0; offset < target.length; offset++) {
					if (tokens[index + offset] !== target[offset]) {
						matched = false;
						break;
					}
				}
				if (matched) return true;
			}
		}
	}
	return false;
}

function matchesAnyPhrase(tokenSets: string[][], phrases: readonly string[]): boolean {
	return phrases.some((phrase) => containsWholePhrase(tokenSets, phrase));
}

const CATEGORY_RULES: Record<
	DietConflictCategory,
	{
		terms: readonly string[];
		exemptions: readonly string[];
		tagTerms: readonly string[];
		tagExemptions: readonly string[];
	}
> = {
	meat: {
		terms: [
			'meat',
			'beef',
			'steak',
			'brisket',
			'sirloin',
			'ribeye',
			'chuck',
			'veal',
			'pork',
			'bacon',
			'pancetta',
			'prosciutto',
			'guanciale',
			'ham',
			'sausage',
			'chorizo',
			'pepperoni',
			'salami',
			'lamb',
			'mutton',
			'venison',
			'bison',
			'boar',
			'lard',
			'tallow',
			'suet',
			'gelatin',
			'bone broth',
			'beef broth',
			'beef stock',
			'pork broth',
			'meatball',
			'bratwurst',
			'hot dog',
			'short rib'
		],
		exemptions: [
			'vegan',
			'plant based',
			'meatless',
			'meat free',
			'beyond',
			'impossible',
			'beefsteak tomato',
			'mushroom bacon',
			'coconut bacon',
			'tempeh bacon',
			'soy chorizo',
			'jackfruit'
		],
		tagTerms: ['meat', 'beef', 'pork', 'lamb', 'bacon', 'steak'],
		tagExemptions: ['meat-free', 'meat free', 'meatless', 'vegan', 'vegetarian', 'plant-based']
	},
	poultry: {
		terms: [
			'poultry',
			'chicken',
			'turkey',
			'duck',
			'goose',
			'quail',
			'hen',
			'chicken broth',
			'chicken stock',
			'turkey broth',
			'duck fat',
			'schmaltz'
		],
		exemptions: ['vegan', 'plant based', 'meatless', 'chicken free', 'chicken of the woods'],
		tagTerms: ['poultry', 'chicken', 'turkey', 'duck'],
		tagExemptions: ['chicken-free', 'vegan', 'vegetarian', 'plant-based']
	},
	seafood: {
		terms: [
			'seafood',
			'fish',
			'salmon',
			'tuna',
			'cod',
			'halibut',
			'tilapia',
			'trout',
			'mackerel',
			'sardine',
			'anchovy',
			'snapper',
			'mahimahi',
			'mahi',
			'haddock',
			'catfish',
			'swordfish',
			'sole',
			'flounder',
			'pollock',
			'herring',
			'sea bass',
			'fish sauce',
			'worcestershire',
			'dashi',
			'bonito',
			'katsuobushi',
			'shellfish',
			'shrimp',
			'prawn',
			'crab',
			'lobster',
			'scallop',
			'clam',
			'mussel',
			'oyster',
			'squid',
			'calamari',
			'octopus',
			'crayfish',
			'crawfish',
			'roe',
			'caviar',
			'surimi'
		],
		exemptions: [
			'vegan',
			'plant based',
			'fish free',
			'oyster mushroom',
			'king oyster',
			'lobster mushroom',
			'crabapple',
			'oyster plant'
		],
		tagTerms: ['seafood', 'fish', 'shellfish', 'salmon', 'shrimp'],
		tagExemptions: ['fish-free', 'shellfish-free', 'vegan', 'vegetarian']
	},
	dairy: {
		terms: [
			'dairy',
			'milk',
			'butter',
			'ghee',
			'cream',
			'buttermilk',
			'half and half',
			'yogurt',
			'yoghurt',
			'kefir',
			'cheese',
			'feta',
			'parmesan',
			'parmigiano',
			'pecorino',
			'mozzarella',
			'cheddar',
			'ricotta',
			'gouda',
			'brie',
			'camembert',
			'gruyere',
			'swiss',
			'provolone',
			'monterey jack',
			'pepper jack',
			'mascarpone',
			'paneer',
			'halloumi',
			'burrata',
			'cotija',
			'queso',
			'whey',
			'casein',
			'lactose',
			'custard'
		],
		exemptions: [
			'dairy free',
			'non dairy',
			'nondairy',
			'vegan',
			'plant based',
			'coconut milk',
			'coconut cream',
			'coconut yogurt',
			'coconut yoghurt',
			'almond milk',
			'almond yogurt',
			'oat milk',
			'oat cream',
			'oat yogurt',
			'soy milk',
			'soy cream',
			'soy yogurt',
			'cashew milk',
			'cashew cream',
			'rice milk',
			'hemp milk',
			'pea milk',
			'macadamia milk',
			'hazelnut milk',
			'flax milk',
			'peanut butter',
			'almond butter',
			'cashew butter',
			'sunflower butter',
			'sunflower seed butter',
			'seed butter',
			'nut butter',
			'cocoa butter',
			'shea butter',
			'apple butter',
			'pumpkin butter',
			'maple butter',
			'cookie butter',
			'butter bean',
			'butter lettuce',
			'butternut',
			'cream of tartar',
			'cream soda'
		],
		tagTerms: ['dairy', 'cheese', 'creamy-dairy'],
		tagExemptions: ['dairy-free', 'dairy free', 'non-dairy', 'vegan']
	},
	egg: {
		terms: ['egg', 'mayonnaise', 'mayo', 'aioli', 'meringue', 'hollandaise'],
		exemptions: [
			'egg free',
			'vegan',
			'plant based',
			'eggplant',
			'flax egg',
			'chia egg',
			'just egg'
		],
		tagTerms: ['egg', 'eggs'],
		tagExemptions: ['egg-free', 'egg free', 'vegan']
	},
	honey: {
		terms: ['honey', 'honeycomb', 'bee pollen', 'royal jelly'],
		exemptions: ['vegan honey', 'honeydew', 'honeynut', 'honeycrisp'],
		tagTerms: ['honey'],
		tagExemptions: ['honey-free', 'vegan']
	},
	gluten: {
		terms: [
			'gluten',
			'wheat',
			'flour',
			'semolina',
			'durum',
			'spelt',
			'farro',
			'kamut',
			'einkorn',
			'barley',
			'rye',
			'malt',
			'triticale',
			'bulgur',
			'couscous',
			'orzo',
			'pasta',
			'spaghetti',
			'penne',
			'rigatoni',
			'fettuccine',
			'linguine',
			'macaroni',
			'lasagna',
			'ravioli',
			'tortellini',
			'gnocchi',
			'udon',
			'ramen',
			'noodle',
			'bread',
			'sourdough',
			'flatbread',
			'pita',
			'naan',
			'baguette',
			'ciabatta',
			'brioche',
			'focaccia',
			'bagel',
			'croissant',
			'tortilla',
			'wrap',
			'lavash',
			'breadcrumb',
			'panko',
			'crouton',
			'seitan',
			'soy sauce',
			'teriyaki sauce',
			'hoisin sauce',
			'beer'
		],
		exemptions: [
			'gluten free',
			'gf',
			'tamari',
			'coconut amino',
			'liquid amino',
			'rice flour',
			'glutinous rice',
			'almond flour',
			'almond meal',
			'coconut flour',
			'corn flour',
			'masa harina',
			'cornmeal',
			'cornstarch',
			'potato starch',
			'potato flour',
			'tapioca',
			'arrowroot',
			'chickpea flour',
			'besan',
			'gram flour',
			'sorghum flour',
			'buckwheat',
			'cassava flour',
			'teff flour',
			'quinoa flour',
			'oat flour',
			'corn tortilla',
			'rice noodle',
			'rice paper',
			'glass noodle',
			'mung bean noodle',
			'cellophane noodle',
			'shirataki',
			'kelp noodle',
			'zucchini noodle',
			'lettuce wrap'
		],
		tagTerms: ['gluten', 'wheat', 'pasta', 'bread'],
		tagExemptions: ['gluten-free', 'gluten free', 'grain-free']
	},
	carb: {
		terms: [
			'rice',
			'quinoa',
			'farro',
			'barley',
			'bulgur',
			'couscous',
			'oats',
			'oat',
			'oatmeal',
			'granola',
			'polenta',
			'grits',
			'cornmeal',
			'cornstarch',
			'potato',
			'yam',
			'taro',
			'cassava',
			'plantain',
			'corn',
			'hominy',
			'pasta',
			'orzo',
			'spaghetti',
			'penne',
			'rigatoni',
			'fettuccine',
			'linguine',
			'macaroni',
			'lasagna',
			'ravioli',
			'tortellini',
			'gnocchi',
			'noodle',
			'udon',
			'ramen',
			'soba',
			'vermicelli',
			'bread',
			'sourdough',
			'flatbread',
			'pita',
			'naan',
			'baguette',
			'ciabatta',
			'brioche',
			'focaccia',
			'bagel',
			'croissant',
			'tortilla',
			'wrap',
			'breadcrumb',
			'panko',
			'crouton',
			'cracker',
			'flour',
			'bean',
			'cannellini',
			'chickpea',
			'garbanzo',
			'lentil',
			'split pea',
			'sugar',
			'maple syrup',
			'honey',
			'agave',
			'molasses',
			'corn syrup',
			'date',
			'raisin'
		],
		exemptions: [
			'low carb',
			'keto',
			'sugar free',
			'cauliflower rice',
			'riced cauliflower',
			'zucchini noodle',
			'shirataki',
			'konjac',
			'miracle noodle',
			'kelp noodle',
			'palmini',
			'almond flour',
			'almond meal',
			'coconut flour',
			'flaxseed meal',
			'rice vinegar',
			'rice wine vinegar',
			'green bean',
			'string bean',
			'wax bean',
			'vanilla bean',
			'coffee bean',
			'cocoa bean',
			'lettuce wrap',
			'baby corn'
		],
		tagTerms: ['high-carb', 'high carb', 'pasta', 'bread', 'whole-grain', 'grain'],
		tagExemptions: ['low-carb', 'low carb', 'keto', 'grain-free']
	}
};

const DIET_EXCLUDED_CATEGORIES: Record<string, readonly DietConflictCategory[]> = {
	none: [],
	vegetarian: ['meat', 'poultry', 'seafood'],
	vegan: ['meat', 'poultry', 'seafood', 'dairy', 'egg', 'honey'],
	pescatarian: ['meat', 'poultry'],
	'gluten-free': ['gluten'],
	'dairy-free': ['dairy'],
	'low-carb': ['carb']
};

const ALLERGEN_EXPANSIONS: Record<
	string,
	{ terms: readonly string[]; exemptions?: readonly string[] }
> = {
	soy: {
		terms: [
			'soy',
			'soya',
			'soybean',
			'tofu',
			'edamame',
			'tempeh',
			'miso',
			'tamari',
			'shoyu',
			'natto'
		],
		exemptions: ['soy free']
	},
	soya: {
		terms: [
			'soy',
			'soya',
			'soybean',
			'tofu',
			'edamame',
			'tempeh',
			'miso',
			'tamari',
			'shoyu',
			'natto'
		],
		exemptions: ['soy free']
	},
	sesame: {
		terms: ['sesame', 'tahini', 'halva', 'gomashio'],
		exemptions: ['sesame free']
	},
	peanut: {
		terms: ['peanut', 'groundnut'],
		exemptions: ['peanut free']
	},
	nut: {
		terms: [
			'nut',
			'almond',
			'walnut',
			'pecan',
			'cashew',
			'pistachio',
			'hazelnut',
			'macadamia',
			'pine nut',
			'brazil nut',
			'chestnut',
			'praline',
			'marzipan'
		],
		exemptions: [
			'nut free',
			'butternut',
			'coconut',
			'nutmeg',
			'water chestnut',
			'doughnut',
			'donut'
		]
	},
	'tree nut': {
		terms: [
			'almond',
			'walnut',
			'pecan',
			'cashew',
			'pistachio',
			'hazelnut',
			'macadamia',
			'pine nut',
			'brazil nut',
			'chestnut',
			'praline',
			'marzipan'
		],
		exemptions: ['nut free', 'tree nut free', 'butternut', 'coconut', 'nutmeg', 'water chestnut']
	},
	shellfish: {
		terms: [
			'shellfish',
			'shrimp',
			'prawn',
			'crab',
			'lobster',
			'scallop',
			'clam',
			'mussel',
			'oyster',
			'squid',
			'calamari',
			'octopus',
			'crayfish',
			'crawfish'
		],
		exemptions: [
			'shellfish free',
			'oyster mushroom',
			'king oyster',
			'lobster mushroom',
			'crabapple'
		]
	},
	fish: {
		terms: [
			'fish',
			'salmon',
			'tuna',
			'cod',
			'halibut',
			'tilapia',
			'trout',
			'mackerel',
			'sardine',
			'anchovy',
			'snapper',
			'mahimahi',
			'haddock',
			'catfish',
			'swordfish',
			'sole',
			'flounder',
			'pollock',
			'herring',
			'bonito',
			'dashi'
		],
		exemptions: ['fish free', 'vegan fish sauce']
	},
	dairy: {
		terms: CATEGORY_RULES.dairy.terms,
		exemptions: CATEGORY_RULES.dairy.exemptions
	},
	milk: {
		terms: CATEGORY_RULES.dairy.terms,
		exemptions: CATEGORY_RULES.dairy.exemptions
	},
	lactose: {
		terms: CATEGORY_RULES.dairy.terms,
		exemptions: [...CATEGORY_RULES.dairy.exemptions, 'lactose free']
	},
	egg: {
		terms: CATEGORY_RULES.egg.terms,
		exemptions: CATEGORY_RULES.egg.exemptions
	},
	wheat: {
		terms: [
			'wheat',
			'flour',
			'semolina',
			'durum',
			'spelt',
			'farro',
			'kamut',
			'einkorn',
			'bulgur',
			'couscous',
			'orzo',
			'pasta',
			'spaghetti',
			'penne',
			'fettuccine',
			'macaroni',
			'lasagna',
			'udon',
			'ramen',
			'bread',
			'sourdough',
			'flatbread',
			'pita',
			'naan',
			'baguette',
			'brioche',
			'ciabatta',
			'tortilla',
			'breadcrumb',
			'panko',
			'crouton',
			'seitan',
			'soy sauce'
		],
		exemptions: CATEGORY_RULES.gluten.exemptions
	},
	gluten: {
		terms: CATEGORY_RULES.gluten.terms,
		exemptions: CATEGORY_RULES.gluten.exemptions
	},
	corn: {
		terms: [
			'corn',
			'cornstarch',
			'cornmeal',
			'polenta',
			'grits',
			'hominy',
			'masa harina',
			'corn syrup'
		],
		exemptions: ['corn free', 'peppercorn']
	}
};

function cleanAllergyToken(segment: string): string {
	let cleaned = segment
		.toLowerCase()
		.trim()
		.replace(/^[.!?()[\]"'•\-–—:\s]+|[.!?()[\]"'•\-–—:\s]+$/g, '')
		.replace(/\s+/g, ' ');
	let changed = true;
	while (changed && cleaned) {
		changed = false;
		const next = cleaned
			.replace(/^(?:and|or|plus)\b\s*/i, '')
			.replace(
				/^(?:no|avoid|avoiding|avoids|without|allergic to|allergy to|intolerant to|sensitive to|free of|free from)\b\s*/i,
				''
			)
			.replace(
				/\s+\b(?:allergy|allergies|intolerance|intolerances|sensitivity|sensitivities)$/i,
				''
			)
			.trim();
		if (next !== cleaned) {
			cleaned = next;
			changed = true;
		}
	}
	if (!cleaned) return '';
	const canonical = normalizeName(cleaned);
	const words = wordTokens(canonical);
	if (!words.length) return '';
	const joined = words.join(' ');
	if (
		NONE_DIET_ALIASES.has(joined) ||
		joined === 'nothing' ||
		joined === 'na' ||
		joined === 'n a'
	) {
		return '';
	}
	return joined;
}

/** Parse free-text allergies on commas, newlines, semicolons, slashes, and conjunctions into normalized tokens. */
export function parseAllergies(value: string | undefined | null): string[] {
	const bounded = clampAllergies(value);
	if (!bounded) return [];
	const segments = bounded.split(/(?:[,;\r\n/|•&]+|\s+\b(?:and|or|plus)\b\s+)/i);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const segment of segments) {
		const token = cleanAllergyToken(segment);
		if (token && !seen.has(token)) {
			seen.add(token);
			result.push(token);
		}
	}
	return result;
}

function ingredientMatchesCategory(
	variants: ReturnType<typeof buildTokenVariants>,
	category: DietConflictCategory
): boolean {
	if (category === 'meat' && matchesAnyPhrase(variants.tokenSets, ['goat cheese', 'goat milk'])) {
		return false;
	}
	const rule = CATEGORY_RULES[category];
	if (matchesAnyPhrase(variants.tokenSets, rule.exemptions)) return false;
	return matchesAnyPhrase(variants.tokenSets, rule.terms);
}

function tagMatchesCategory(tag: string, category: DietConflictCategory): boolean {
	const cleaned = normalized(tag);
	const rule = CATEGORY_RULES[category];
	if (rule.tagExemptions.some((exempt) => cleaned.includes(exempt))) return false;
	const variants = buildTokenVariants(cleaned);
	if (matchesAnyPhrase(variants.tokenSets, rule.exemptions)) return false;
	return rule.tagTerms.some(
		(term) => cleaned === term || containsWholePhrase(variants.tokenSets, term)
	);
}

function ingredientMatchesAllergen(
	variants: ReturnType<typeof buildTokenVariants>,
	allergen: string
): boolean {
	const negated = `${allergen} free`;
	if (containsWholePhrase(variants.tokenSets, negated)) return false;
	const expansion = ALLERGEN_EXPANSIONS[allergen];
	if (expansion) {
		if (expansion.exemptions && matchesAnyPhrase(variants.tokenSets, expansion.exemptions)) {
			return false;
		}
		if (matchesAnyPhrase(variants.tokenSets, expansion.terms)) return true;
	}
	return containsWholePhrase(variants.tokenSets, allergen);
}

/** Evaluate recipe ingredients and tags deterministically against active diet and allergy preferences. */
export function evaluateRecipeConflicts(
	recipe: Recipe,
	preferences: Pick<Preferences, 'diet' | 'allergies'>
): RecipeConflictReport {
	const diet = normalizeDiet(preferences.diet);
	const resolvedDietLabel = dietLabel(diet);
	const disallowedCategories = DIET_EXCLUDED_CATEGORIES[diet] ?? [];
	const parsedAllergens = parseAllergies(clampAllergies(preferences.allergies));

	const matchedCategories = new Set<DietConflictCategory>();
	const matchedAllergens = new Set<string>();
	const ingredientReasons: Record<number, string[]> = {};

	const addIngredientReason = (index: number, reason: string) => {
		const list = ingredientReasons[index] ?? [];
		if (!list.includes(reason)) list.push(reason);
		ingredientReasons[index] = list;
	};

	const recipeHasGlutenFreeTag = recipe.tags.some((tag) => /gluten[\s-]free/i.test(tag));
	const recipeHasDairyFreeTag = recipe.tags.some((tag) => /(?:dairy[\s-]free|vegan)/i.test(tag));
	const recipeHasLowCarbTag = recipe.tags.some((tag) => /(?:low[\s-]carb|keto)/i.test(tag));

	recipe.ingredients.forEach((ingredient, index) => {
		const variants = buildTokenVariants(ingredient.name);
		for (const category of disallowedCategories) {
			if (ingredientMatchesCategory(variants, category)) {
				matchedCategories.add(category);
				addIngredientReason(index, category);
			}
		}
		for (const allergen of parsedAllergens) {
			if (ingredientMatchesAllergen(variants, allergen)) {
				matchedAllergens.add(allergen);
				addIngredientReason(index, `avoided: ${allergen}`);
			}
		}
	});

	for (const category of disallowedCategories) {
		if (category === 'gluten' && recipeHasGlutenFreeTag) continue;
		if (category === 'dairy' && recipeHasDairyFreeTag) continue;
		if (category === 'carb' && recipeHasLowCarbTag) continue;
		if (recipe.tags.some((tag) => tagMatchesCategory(tag, category))) {
			matchedCategories.add(category);
		}
	}

	if (
		disallowedCategories.includes('carb') &&
		!recipeHasLowCarbTag &&
		Number.isFinite(recipe.nutrition?.carbs)
	) {
		const netCarbs = Math.max(0, recipe.nutrition.carbs - (recipe.nutrition.fiber || 0));
		if (netCarbs > 30) matchedCategories.add('carb');
	}

	const dietCategories = disallowedCategories.filter((category) => matchedCategories.has(category));
	const allergenMatches = parsedAllergens.filter((allergen) => matchedAllergens.has(allergen));
	const matchingIngredientIndices = Object.keys(ingredientReasons)
		.map(Number)
		.sort((a, b) => a - b);
	const hasConflict = dietCategories.length > 0 || allergenMatches.length > 0;

	let badge = '';
	const summaryParts: string[] = [];
	if (dietCategories.length > 0 && allergenMatches.length > 0) {
		badge = 'Diet & allergen alert';
	} else if (allergenMatches.length > 0) {
		badge = 'Allergen alert';
	} else if (dietCategories.length > 0) {
		badge = `${resolvedDietLabel} conflict`;
	}

	if (dietCategories.length > 0) {
		summaryParts.push(`Conflicts with ${resolvedDietLabel} (${dietCategories.join(', ')})`);
	}
	if (allergenMatches.length > 0) {
		summaryParts.push(`Contains avoided ${allergenMatches.join(', ')}`);
	}

	return {
		hasConflict,
		diet,
		dietLabel: resolvedDietLabel,
		dietCategories,
		allergenMatches,
		matchingIngredientIndices,
		ingredientReasons,
		badge,
		summary: summaryParts.join(' · ')
	};
}

/** Sanitize preferences for `/api/ai` requests so legacy or buffered values always pass schema bounds. */
export function sanitizePreferencesForAI(preferences: Preferences): Preferences {
	return {
		diet: normalizeDiet(preferences.diet).slice(0, 200),
		allergies: clampAllergies(preferences.allergies).trim(),
		maxTime:
			Number.isFinite(preferences.maxTime) && preferences.maxTime >= 0
				? Math.min(100_000, preferences.maxTime)
				: 45,
		complexity: (preferences.complexity ?? '').slice(0, 100),
		...(preferences.cuisines?.length
			? {
					cuisines: preferences.cuisines
						.map((cuisine) => cuisine.trim().slice(0, 80))
						.filter(Boolean)
						.slice(0, 8)
				}
			: {}),
		theme: (preferences.theme ?? 'nosh').slice(0, 100),
		dark: Boolean(preferences.dark),
		provider: (preferences.provider || '').slice(0, 100),
		model: (preferences.model || '').slice(0, 200)
	};
}

/** Build a validated client `/api/ai` payload matching the server boundary contract. */
export function buildAIRequestPayload(
	kitchen: AppState,
	action: string,
	options: {
		apiKey?: string;
		prompt?: string;
		extra?: Record<string, unknown>;
		now?: Date;
	} = {}
): Record<string, unknown> {
	const { apiKey = '', prompt = '', extra = {}, now = new Date() } = options;
	const provider = kitchen.preferences.provider?.trim();
	const sanitizedExtra = { ...extra };
	if ('preferences' in sanitizedExtra && sanitizedExtra.preferences) {
		sanitizedExtra.preferences = sanitizePreferencesForAI(
			sanitizedExtra.preferences as Preferences
		);
	}
	return {
		action,
		...(provider === 'chatgpt'
			? kitchen.preferences.chatgptAccountId
				? { connectionId: kitchen.preferences.chatgptAccountId }
				: {}
			: { apiKey }),
		...(provider && /^[a-z0-9-]{1,100}$/.test(provider) ? { provider } : {}),
		model: kitchen.preferences.model ?? '',
		...(kitchen.preferences.reasoning ? { reasoning: kitchen.preferences.reasoning } : {}),
		...(action === 'capture' || action === 'chat'
			? {}
			: {
					pantry: kitchen.pantry
						.filter((item) => item.quantity > 0 && expiryStatus(item.expires, now) !== 'expired')
						.slice(0, 300),
					preferences: sanitizePreferencesForAI(kitchen.preferences),
					recipes: kitchen.recipes.filter((r) => r.rating).slice(0, 30),
					prompt: prompt.slice(0, 2_000)
				}),
		...sanitizedExtra
	};
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
	pantry: Map<string, { item: Ingredient; expiry: ReturnType<typeof expiryStatus> }[]>
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
		for (const { item, expiry } of pantry.get(normalizeIngredientName(ingredient.name)) ?? []) {
			const compatibleQuantity = convertCompatibleQuantity(
				item.quantity,
				item.unit,
				ingredient.unit
			);
			if (compatibleQuantity === undefined || compatibleQuantity <= 0) continue;
			quantityAvailable += compatibleQuantity;
			if (expiry === 'soon') quantityExpiring += compatibleQuantity;
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
	for (const entry of rated) {
		const distance = Math.abs(recipe.time - entry.recipe.time);
		const weight = 1 / (1 + distance / 20);
		weighted += entry.signal * weight;
	}
	return rated.length ? weighted / rated.length : 0;
}

function scoreRecipe(
	recipe: Recipe,
	pantryItems: Map<string, { item: Ingredient; expiry: ReturnType<typeof expiryStatus> }[]>,
	preferences: Preferences,
	rated: RatedRecipe[]
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

	const diet = normalizeDiet(preferences.diet);
	if (diet !== 'none') {
		if (recipe.tags.some((tag) => normalized(tag).includes(diet))) score += 2;
	}

	const pantryMatch = pantryScores(recipe, pantryItems);
	score += pantryMatch.available * 9;
	score += pantryMatch.expiring * 4;
	return score;
}

type PantryIndex = Map<string, { item: Ingredient; expiry: ReturnType<typeof expiryStatus> }[]>;

function buildPantryIndex(pantry: Ingredient[], now: Date): PantryIndex {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const pantryIndex: PantryIndex = new Map();
	for (const item of pantry) {
		if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
		const expiry = expiryStatus(item.expires, safeNow);
		if (expiry === 'expired' || (Boolean(item.expires?.trim()) && expiry === 'unknown')) continue;
		const key = normalizeIngredientName(item.name);
		const entries = pantryIndex.get(key) ?? [];
		entries.push({ item, expiry });
		pantryIndex.set(key, entries);
	}
	return pantryIndex;
}

function ratedSignals(recipes: Recipe[], preferences: Preferences): RatedRecipe[] {
	return recipes.flatMap((recipe) => {
		const rating = recipeRating(recipe, preferences);
		return rating === undefined ? [] : [{ recipe, signal: (rating - 3) / 2 }];
	});
}

/** Filter and rank local recipes with positive pantryScores against stocked or targeted expiring ingredients. */
export function rankPantryRecipes(
	recipes: Recipe[],
	pantry: Ingredient[],
	preferences: Preferences,
	targetIngredients?: Ingredient[],
	now: Date = new Date()
): Recipe[] {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const pantryIndex = buildPantryIndex(pantry, safeNow);
	const matchIndex =
		targetIngredients !== undefined ? buildPantryIndex(targetIngredients, safeNow) : pantryIndex;
	if (!matchIndex.size) return [];
	const rated = ratedSignals(recipes, preferences);

	return recipes
		.flatMap((recipe, index) => {
			const targetMatch = pantryScores(recipe, matchIndex);
			if (targetMatch.available <= 0) return [];
			const score =
				targetMatch.available * 18 +
				targetMatch.expiring * 8 +
				scoreRecipe(recipe, pantryIndex, preferences, rated);
			return [{ recipe, index, score }];
		})
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ recipe }) => recipe);
}

/** Rank suggestions from explicit preferences, past ratings, and usable pantry ingredients. */
export function rankRecipes(
	recipes: Recipe[],
	pantry: Ingredient[],
	preferences: Preferences,
	now: Date = new Date(),
	options?: { includeConflicts?: boolean }
): Recipe[] {
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	const eligible = options?.includeConflicts
		? recipes
		: recipes.filter((recipe) => !evaluateRecipeConflicts(recipe, preferences).hasConflict);
	const rated = ratedSignals(recipes, preferences);
	const pantryIndex = buildPantryIndex(pantry, safeNow);
	return eligible
		.map((recipe, index) => ({
			recipe,
			index,
			score: scoreRecipe(recipe, pantryIndex, preferences, rated)
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ recipe }) => recipe);
}
