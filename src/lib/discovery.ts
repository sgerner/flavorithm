import type { AppState, Ingredient, Preferences, Recipe } from './types';
import { seedRecipes } from './data.ts';
import { normalizeName } from './domain.ts';
import {
	convertCompatibleQuantity,
	expiryStatus,
	normalizeIngredientName
} from './kitchen-workflows.ts';

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
	labelCheckItems: string[];
	unrecognizedAllergens: string[];
	matchingIngredientIndices: number[];
	ingredientReasons: Record<number, string[]>;
	badge: string;
	summary: string;
};

function foldAscii(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function normalized(value: string): string {
	return foldAscii(value);
}

const NONE_DIET_ALIASES = new Set([
	'',
	'none',
	'any',
	'flexible',
	'no preference',
	'no-preference',
	'no dietary restriction',
	'no dietary restrictions',
	'a bit of everything'
]);

const NONE_ALLERGY_ALIASES = new Set([
	...NONE_DIET_ALIASES,
	'no',
	'na',
	'n a',
	'n/a',
	'nil',
	'nothing',
	'no allergy',
	'no allergies',
	'no known allergy',
	'no known allergies',
	'no food allergy',
	'no food allergies',
	'no restriction',
	'no restrictions'
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
	cookies: 'cookie',
	brownies: 'brownie',
	blondies: 'blondie',
	pierogies: 'pierogi',
	tomatoes: 'tomato',
	potatoes: 'potato',
	avocadoes: 'avocado',
	mangoes: 'mango',
	halves: 'half',
	loaves: 'loaf',
	leaves: 'leaf',
	calves: 'calf',
	knives: 'knife'
};

const INVARIANT_S_WORDS = new Set([
	'couscous',
	'asparagus',
	'hummus',
	'houmous',
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
	return foldAscii(value)
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map(singularizeWord);
}

function phraseTokens(phrase: string): { raw: string[]; singular: string[] } {
	const raw = foldAscii(phrase)
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	return { raw, singular: raw.map(singularizeWord) };
}

function buildTokenVariants(rawText: string): { canonical: string; tokenSets: string[][] } {
	const raw = foldAscii(rawText);
	const canonical = foldAscii(normalizeName(rawText));
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

function tokensContainSequence(tokens: readonly string[], target: readonly string[]): boolean {
	if (!target.length || tokens.length < target.length) return false;
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
	return false;
}

function containsWholePhrase(tokenSets: readonly (readonly string[])[], phrase: string): boolean {
	const { raw, singular } = phraseTokens(phrase);
	if (!raw.length) return false;
	for (const tokens of tokenSets) {
		if (tokensContainSequence(tokens, raw) || tokensContainSequence(tokens, singular)) {
			return true;
		}
	}
	return false;
}

function matchesAnyPhrase(
	tokenSets: readonly (readonly string[])[],
	phrases: readonly string[]
): boolean {
	return phrases.some((phrase) => containsWholePhrase(tokenSets, phrase));
}

function stripSpanFromTokens(tokens: readonly string[], spans: readonly string[]): string[] {
	if (!tokens.length || !spans.length) return [...tokens];
	const parsedSpans = spans
		.map(phraseTokens)
		.filter((entry) => entry.raw.length > 0)
		.sort((a, b) => b.raw.length - a.raw.length);
	const out: string[] = [];
	let index = 0;
	while (index < tokens.length) {
		let skipLength = 0;
		for (const span of parsedSpans) {
			const len = span.raw.length;
			if (index + len > tokens.length) continue;
			let rawMatch = true;
			let singularMatch = true;
			for (let offset = 0; offset < len; offset++) {
				const tok = tokens[index + offset];
				if (tok !== span.raw[offset]) rawMatch = false;
				if (singularizeWord(tok) !== span.singular[offset]) singularMatch = false;
				if (!rawMatch && !singularMatch) break;
			}
			if (rawMatch || singularMatch) {
				skipLength = len;
				break;
			}
		}
		if (skipLength > 0) {
			index += skipLength;
		} else {
			out.push(tokens[index]);
			index += 1;
		}
	}
	return out;
}

function stripExemptSpans(
	tokenSets: readonly (readonly string[])[],
	spanExemptions: readonly string[]
): string[][] {
	return tokenSets.map((tokens) => stripSpanFromTokens(tokens, spanExemptions));
}

const FISH_TERMS = [
	'fish',
	'salmon',
	'tuna',
	'ahi',
	'albacore',
	'yellowfin',
	'bluefin',
	'cod',
	'scrod',
	'bacalao',
	'black cod',
	'sablefish',
	'halibut',
	'tilapia',
	'trout',
	'steelhead',
	'arctic char',
	'mackerel',
	'sardine',
	'pilchard',
	'anchovy',
	'snapper',
	'mahimahi',
	'mahi',
	'dorado',
	'haddock',
	'catfish',
	'swordfish',
	'sole',
	'flounder',
	'plaice',
	'turbot',
	'pollock',
	'walleye',
	'whiting',
	'hake',
	'herring',
	'kipper',
	'sprat',
	'whitebait',
	'grouper',
	'eel',
	'unagi',
	'anago',
	'bass',
	'sea bass',
	'branzino',
	'striped bass',
	'perch',
	'pike',
	'carp',
	'monkfish',
	'anglerfish',
	'barramundi',
	'hamachi',
	'yellowtail',
	'amberjack',
	'kampachi',
	'wahoo',
	'ono',
	'cobia',
	'pompano',
	'mullet',
	'bream',
	'dorade',
	'porgy',
	'skate',
	'sturgeon',
	'orange roughy',
	'toothfish',
	'smelt',
	'capelin',
	'milkfish',
	'fish sauce',
	'nam pla',
	'nuoc mam',
	'worcestershire',
	'dashi',
	'bonito',
	'katsuobushi',
	'roe',
	'caviar',
	'ikura',
	'tobiko',
	'masago',
	'taramasalata',
	'surimi',
	'imitation crab',
	'fish stock',
	'fish broth',
	'fumet'
] as const;

const SHELLFISH_TERMS = [
	'shellfish',
	'crustacean',
	'mollusc',
	'mollusk',
	'bivalve',
	'cephalopod',
	'shrimp',
	'prawn',
	'scampi',
	'langoustine',
	'crab',
	'lobster',
	'crayfish',
	'crawfish',
	'crawdad',
	'krill',
	'scallop',
	'clam',
	'quahog',
	'cockle',
	'geoduck',
	'mussel',
	'oyster',
	'abalone',
	'whelk',
	'conch',
	'periwinkle',
	'escargot',
	'snail',
	'squid',
	'calamari',
	'cuttlefish',
	'octopus',
	'tako',
	'uni',
	'oyster sauce',
	'shrimp paste',
	'belacan',
	'clam juice'
] as const;

type CategoryRule = {
	terms: readonly string[];
	labelExemptions: readonly string[];
	spanExemptions: readonly string[];
	tagTerms: readonly string[];
	tagExemptions: readonly string[];
};

const CATEGORY_RULES: Record<DietConflictCategory, CategoryRule> = {
	meat: {
		terms: [
			'meat',
			'beef',
			'steak',
			'brisket',
			'sirloin',
			'ribeye',
			'tenderloin',
			'filet mignon',
			'flank',
			'chuck',
			'short rib',
			'rib',
			'oxtail',
			'veal',
			'pork',
			'bacon',
			'pancetta',
			'prosciutto',
			'guanciale',
			'ham',
			'gammon',
			'sausage',
			'chorizo',
			'pepperoni',
			'salami',
			'soppressata',
			'mortadella',
			'bologna',
			'capicola',
			'coppa',
			'nduja',
			'speck',
			'pastrami',
			'corned beef',
			'roast beef',
			'lamb',
			'mutton',
			'goat',
			'cabrito',
			'venison',
			'deer',
			'elk',
			'bison',
			'buffalo meat',
			'boar',
			'rabbit',
			'hare',
			'kangaroo',
			'liver',
			'pate',
			'foie gras',
			'kidney',
			'tripe',
			'sweetbread',
			'offal',
			'giblet',
			'tongue',
			'bone marrow',
			'lard',
			'tallow',
			'suet',
			'dripping',
			'gelatin',
			'rennet',
			'isinglass',
			'aspic',
			'bone broth',
			'beef broth',
			'beef stock',
			'pork broth',
			'pork stock',
			'veal stock',
			'demi glace',
			'consomme',
			'meatball',
			'meatloaf',
			'bratwurst',
			'kielbasa',
			'andouille',
			'merguez',
			'lap cheong',
			'blood sausage',
			'black pudding',
			'haggis',
			'hot dog',
			'hotdog',
			'frankfurter',
			'wiener',
			'jerky',
			'biltong',
			'mince',
			'minced beef',
			'minced pork',
			'minced lamb',
			'carnitas',
			'barbacoa',
			'birria',
			'char siu',
			'spam',
			'pork rind',
			'chicharron',
			'crackling'
		],
		labelExemptions: ['vegan', 'plant based', 'meatless', 'meat free', 'beyond', 'impossible'],
		spanExemptions: [
			'goat cheese',
			'goat milk',
			'goat yogurt',
			'goat butter',
			'beefsteak tomato',
			'mushroom bacon',
			'coconut bacon',
			'tempeh bacon',
			'soy chorizo',
			'vegan mince',
			'plant mince',
			'soy mince',
			'quorn mince',
			'meatless mince',
			'mushroom jerky',
			'soy jerky',
			'jackfruit',
			'celery rib',
			'chard rib',
			'kale rib',
			'cabbage rib',
			'romaine heart',
			'artichoke heart',
			'heart of palm',
			'hearts of palm',
			'peach halve',
			'agar'
		],
		tagTerms: ['meat', 'beef', 'pork', 'lamb', 'bacon', 'steak', 'ribs'],
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
			'pheasant',
			'squab',
			'cornish hen',
			'hen',
			'gizzard',
			'chicken broth',
			'chicken stock',
			'turkey broth',
			'turkey stock',
			'duck fat',
			'schmaltz'
		],
		labelExemptions: ['vegan', 'plant based', 'meatless', 'chicken free'],
		spanExemptions: ['chicken of the woods', 'chickpea', 'gooseberry'],
		tagTerms: ['poultry', 'chicken', 'turkey', 'duck'],
		tagExemptions: ['chicken-free', 'vegan', 'vegetarian', 'plant-based']
	},
	seafood: {
		terms: ['seafood', ...FISH_TERMS, ...SHELLFISH_TERMS],
		labelExemptions: ['vegan', 'plant based', 'fish free', 'seafood free'],
		spanExemptions: [
			'vegan fish sauce',
			'vegan worcestershire',
			'vegan oyster sauce',
			'oyster mushroom',
			'king oyster',
			'lobster mushroom',
			'crabapple',
			'oyster plant',
			'solely'
		],
		tagTerms: ['seafood', 'fish', 'shellfish', 'salmon', 'shrimp'],
		tagExemptions: ['fish-free', 'shellfish-free', 'seafood-free', 'vegan', 'vegetarian']
	},
	dairy: {
		terms: [
			'dairy',
			'milk',
			'butter',
			'ghee',
			'cream',
			'creme fraiche',
			'fraiche',
			'sour cream',
			'heavy cream',
			'whipping cream',
			'whipped cream',
			'clotted cream',
			'double cream',
			'condensed milk',
			'evaporated milk',
			'buttermilk',
			'half and half',
			'yogurt',
			'yoghurt',
			'kefir',
			'skyr',
			'labneh',
			'lassi',
			'raita',
			'tzatziki',
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
			'emmental',
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
			'manchego',
			'asiago',
			'fontina',
			'havarti',
			'muenster',
			'colby',
			'gorgonzola',
			'roquefort',
			'stilton',
			'blue cheese',
			'cream cheese',
			'cottage cheese',
			'quark',
			'fromage',
			'whey',
			'casein',
			'lactose',
			'custard',
			'pastry cream',
			'creme patissiere',
			'creme anglaise',
			'dulce de leche',
			'ganache',
			'bechamel',
			'alfredo',
			'ice cream',
			'gelato',
			'brioche'
		],
		labelExemptions: ['dairy free', 'non dairy', 'nondairy', 'vegan', 'plant based'],
		spanExemptions: [
			'sunflower seed butter',
			'coconut milk',
			'coconut cream',
			'cream of coconut',
			'coconut yogurt',
			'coconut yoghurt',
			'almond milk',
			'almond cream',
			'almond yogurt',
			'oat milk',
			'oat cream',
			'oat yogurt',
			'soy milk',
			'soy cream',
			'soy yogurt',
			'cashew milk',
			'cashew cream',
			'cashew yogurt',
			'rice milk',
			'hemp milk',
			'pea milk',
			'macadamia milk',
			'hazelnut milk',
			'walnut milk',
			'pistachio milk',
			'flax milk',
			'sesame milk',
			'nut milk',
			'peanut butter',
			'almond butter',
			'cashew butter',
			'walnut butter',
			'pecan butter',
			'pistachio butter',
			'hazelnut butter',
			'macadamia butter',
			'sunflower butter',
			'seed butter',
			'nut butter',
			'cocoa butter',
			'cacao butter',
			'shea butter',
			'apple butter',
			'pumpkin butter',
			'maple butter',
			'cookie butter',
			'butter bean',
			'butter lettuce',
			'butterhead',
			'butternut',
			'cream of tartar',
			'cream soda',
			'creamed honey',
			'creamed corn',
			'swiss chard',
			'milkfish'
		],
		tagTerms: ['dairy', 'cheese', 'creamy-dairy'],
		tagExemptions: ['dairy-free', 'dairy free', 'non-dairy', 'vegan']
	},
	egg: {
		terms: [
			'egg',
			'egg white',
			'egg yolk',
			'egg wash',
			'egg noodle',
			'albumen',
			'albumin',
			'mayonnaise',
			'mayo',
			'aioli',
			'meringue',
			'hollandaise',
			'bearnaise',
			'remoulade',
			'tartar sauce',
			'custard',
			'lemon curd',
			'pastry cream',
			'creme patissiere',
			'creme anglaise',
			'creme brulee',
			'quiche',
			'frittata',
			'omelet',
			'omelette',
			'souffle',
			'zabaglione',
			'eggnog',
			'brioche',
			'challah'
		],
		labelExemptions: ['egg free', 'vegan', 'plant based'],
		spanExemptions: [
			'vegan mayo',
			'vegan mayonnaise',
			'vegan aioli',
			'vegan brioche',
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
		labelExemptions: ['vegan honey', 'honey free'],
		spanExemptions: ['honeydew', 'honeynut', 'honeycrisp', 'honeybush'],
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
			'khorasan',
			'einkorn',
			'emmer',
			'barley',
			'rye',
			'malt',
			'triticale',
			'bulgur',
			'freekeh',
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
			'ditalini',
			'farfalle',
			'fusilli',
			'rotini',
			'orecchiette',
			'cavatappi',
			'bucatini',
			'tagliatelle',
			'pappardelle',
			'ziti',
			'manicotti',
			'cannelloni',
			'udon',
			'ramen',
			'lo mein',
			'chow mein',
			'yakisoba',
			'somen',
			'noodle',
			'bread',
			'sourdough',
			'flatbread',
			'pita',
			'naan',
			'paratha',
			'roti',
			'chapati',
			'baguette',
			'ciabatta',
			'brioche',
			'challah',
			'focaccia',
			'bagel',
			'croissant',
			'pretzel',
			'bun',
			'dinner roll',
			'hoagie',
			'english muffin',
			'muffin',
			'scone',
			'biscuit',
			'dough',
			'pastry',
			'phyllo',
			'filo',
			'puff pastry',
			'shortcrust',
			'pie crust',
			'tart shell',
			'cake',
			'cupcake',
			'brownie',
			'blondie',
			'cookie',
			'biscotti',
			'shortbread',
			'wafer',
			'cracker',
			'graham cracker',
			'saltine',
			'matzo',
			'matzah',
			'dumpling',
			'gyoza',
			'potsticker',
			'wonton',
			'bao',
			'pierogi',
			'pelmeni',
			'empanada',
			'samosa',
			'spring roll',
			'egg roll',
			'pancake',
			'crepe',
			'waffle',
			'french toast',
			'cereal',
			'muesli',
			'bran',
			'tortilla',
			'wrap',
			'lavash',
			'breadcrumb',
			'panko',
			'crouton',
			'stuffing',
			'roux',
			'tempura',
			'seitan',
			'soy sauce',
			'shoyu',
			'teriyaki sauce',
			'hoisin sauce',
			'beer',
			'ale',
			'lager',
			'stout'
		],
		labelExemptions: ['gluten free', 'gf'],
		spanExemptions: [
			'tamari',
			'coconut amino',
			'liquid amino',
			'rice flour',
			'glutinous rice',
			'sweet rice flour',
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
			'tapioca flour',
			'arrowroot',
			'arrowroot flour',
			'chickpea flour',
			'besan',
			'gram flour',
			'sorghum flour',
			'cassava flour',
			'teff flour',
			'quinoa flour',
			'amaranth flour',
			'millet flour',
			'chestnut flour',
			'hazelnut flour',
			'buckwheat flour',
			'oat flour',
			'oat bran',
			'rice bran',
			'corn tortilla',
			'cassava tortilla',
			'almond flour tortilla',
			'rice noodle',
			'soba noodle',
			'rice paper',
			'rice wrapper',
			'spring roll rice paper',
			'glass noodle',
			'mung bean noodle',
			'cellophane noodle',
			'sweet potato noodle',
			'dangmyeon',
			'shirataki',
			'kelp noodle',
			'zucchini noodle',
			'cauliflower gnocchi',
			'rice cracker',
			'rice cake',
			'fish cake',
			'crab cake',
			'lettuce wrap',
			'ginger beer',
			'root beer'
		],
		tagTerms: ['gluten', 'wheat', 'pasta', 'bread', 'pastry'],
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
			'muesli',
			'cereal',
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
			'challah',
			'focaccia',
			'bagel',
			'croissant',
			'pretzel',
			'bun',
			'dough',
			'pastry',
			'pie crust',
			'cake',
			'cookie',
			'dumpling',
			'pancake',
			'waffle',
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
		labelExemptions: ['low carb', 'keto', 'sugar free'],
		spanExemptions: [
			'cauliflower rice',
			'riced cauliflower',
			'broccoli rice',
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

const GLUTEN_LABEL_CHECK_RULES: ReadonlyArray<{ label: string; terms: readonly string[] }> = [
	{
		label: 'oats',
		terms: [
			'oat',
			'oats',
			'oatmeal',
			'oat flour',
			'oat milk',
			'oat cream',
			'oat yogurt',
			'oat bran',
			'granola'
		]
	},
	{
		label: 'buckwheat',
		terms: ['buckwheat', 'buckwheat flour', 'kasha']
	},
	{
		label: 'soba',
		terms: ['soba', 'soba noodle']
	}
];

const DIET_EXCLUDED_CATEGORIES: Record<string, readonly DietConflictCategory[]> = {
	none: [],
	vegetarian: ['meat', 'poultry', 'seafood'],
	vegan: ['meat', 'poultry', 'seafood', 'dairy', 'egg', 'honey'],
	pescatarian: ['meat', 'poultry'],
	'gluten-free': ['gluten'],
	'dairy-free': ['dairy'],
	'low-carb': ['carb']
};

type AllergenExpansion = {
	terms: readonly string[];
	labelExemptions?: readonly string[];
	spanExemptions?: readonly string[];
	checkGlutenLabels?: boolean;
};

const TREE_NUT_TERMS = [
	'tree nut',
	'nut',
	'nut butter',
	'nut milk',
	'pesto',
	'almond',
	'walnut',
	'pecan',
	'cashew',
	'pistachio',
	'hazelnut',
	'filbert',
	'macadamia',
	'pine nut',
	'pinoli',
	'pignoli',
	'brazil nut',
	'chestnut',
	'praline',
	'marzipan',
	'gianduja',
	'nougat',
	'frangipane'
] as const;

const NUT_SPAN_EXEMPTIONS = [
	'water chestnut',
	'tiger nut',
	'tigernut',
	'butternut',
	'coconut',
	'nutmeg',
	'doughnut',
	'donut',
	'breadnut',
	'chufa'
] as const;

const PEANUT_TERMS = [
	'peanut',
	'groundnut',
	'arachis',
	'goober',
	'satay',
	'sate',
	'pad thai',
	'pad thai sauce',
	'kung pao',
	'kare kare'
] as const;

const ALLERGEN_EXPANSIONS: Record<string, AllergenExpansion> = {
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
			'natto',
			'teriyaki sauce',
			'hoisin sauce',
			'textured vegetable protein',
			'tvp'
		],
		labelExemptions: ['soy free']
	},
	sesame: {
		terms: [
			'sesame',
			'tahini',
			'tahina',
			'halva',
			'halvah',
			'gomashio',
			'gomasio',
			'hummus',
			'houmous',
			'baba ganoush',
			'baba ghanoush',
			'zaatar'
		],
		labelExemptions: ['sesame free']
	},
	peanut: {
		terms: PEANUT_TERMS,
		labelExemptions: ['peanut free', 'nut free']
	},
	nut: {
		terms: [...TREE_NUT_TERMS, ...PEANUT_TERMS],
		labelExemptions: ['nut free'],
		spanExemptions: NUT_SPAN_EXEMPTIONS
	},
	'tree nut': {
		terms: TREE_NUT_TERMS,
		labelExemptions: ['tree nut free', 'nut free'],
		spanExemptions: [...NUT_SPAN_EXEMPTIONS, 'peanut butter', 'peanut oil', 'peanut']
	},
	seafood: {
		terms: CATEGORY_RULES.seafood.terms,
		labelExemptions: CATEGORY_RULES.seafood.labelExemptions,
		spanExemptions: CATEGORY_RULES.seafood.spanExemptions
	},
	shellfish: {
		terms: SHELLFISH_TERMS,
		labelExemptions: ['shellfish free', 'seafood free'],
		spanExemptions: [
			'vegan oyster sauce',
			'oyster mushroom',
			'king oyster',
			'lobster mushroom',
			'crabapple',
			'oyster plant'
		]
	},
	fish: {
		terms: FISH_TERMS,
		labelExemptions: ['fish free', 'seafood free'],
		spanExemptions: ['vegan fish sauce', 'vegan worcestershire', 'solely']
	},
	dairy: {
		terms: CATEGORY_RULES.dairy.terms,
		labelExemptions: CATEGORY_RULES.dairy.labelExemptions,
		spanExemptions: CATEGORY_RULES.dairy.spanExemptions
	},
	egg: {
		terms: CATEGORY_RULES.egg.terms,
		labelExemptions: CATEGORY_RULES.egg.labelExemptions,
		spanExemptions: CATEGORY_RULES.egg.spanExemptions
	},
	wheat: {
		terms: CATEGORY_RULES.gluten.terms,
		labelExemptions: ['wheat free', 'gluten free', 'gf'],
		spanExemptions: CATEGORY_RULES.gluten.spanExemptions,
		checkGlutenLabels: true
	},
	gluten: {
		terms: CATEGORY_RULES.gluten.terms,
		labelExemptions: CATEGORY_RULES.gluten.labelExemptions,
		spanExemptions: CATEGORY_RULES.gluten.spanExemptions,
		checkGlutenLabels: true
	},
	corn: {
		terms: [
			'corn',
			'maize',
			'cornstarch',
			'cornmeal',
			'corn flour',
			'polenta',
			'grits',
			'hominy',
			'masa harina',
			'corn tortilla',
			'corn syrup',
			'popcorn'
		],
		labelExemptions: ['corn free'],
		spanExemptions: ['peppercorn', 'corned beef', 'cornish hen', 'acorn squash']
	},
	nightshade: {
		terms: [
			'tomato',
			'tomatillo',
			'potato',
			'eggplant',
			'aubergine',
			'bell pepper',
			'chili',
			'chile',
			'jalapeno',
			'habanero',
			'serrano',
			'cayenne',
			'paprika',
			'chipotle',
			'goji'
		],
		labelExemptions: ['nightshade free'],
		spanExemptions: ['sweet potato', 'black pepper', 'white pepper', 'sichuan pepper', 'peppercorn']
	},
	allium: {
		terms: ['onion', 'garlic', 'shallot', 'scallion', 'leek', 'chive', 'ramps'],
		labelExemptions: ['allium free', 'no onion no garlic']
	},
	sulfite: {
		terms: ['sulfite', 'sulphite', 'wine', 'vinegar', 'molasses'],
		labelExemptions: ['sulfite free', 'sulphite free', 'unsulfured', 'unsulphured']
	},
	mustard: {
		terms: ['mustard', 'dijon'],
		labelExemptions: ['mustard free']
	},
	lupin: {
		terms: ['lupin', 'lupine', 'lupini'],
		labelExemptions: ['lupin free']
	},
	meat: {
		terms: CATEGORY_RULES.meat.terms,
		labelExemptions: CATEGORY_RULES.meat.labelExemptions,
		spanExemptions: CATEGORY_RULES.meat.spanExemptions
	},
	poultry: {
		terms: CATEGORY_RULES.poultry.terms,
		labelExemptions: CATEGORY_RULES.poultry.labelExemptions,
		spanExemptions: CATEGORY_RULES.poultry.spanExemptions
	}
};

const ALLERGEN_SYNONYMS: Record<string, string> = {
	celiac: 'gluten',
	coeliac: 'gluten',
	lactose: 'dairy',
	milk: 'dairy',
	casein: 'dairy',
	whey: 'dairy',
	crustacean: 'shellfish',
	mollusc: 'shellfish',
	mollusk: 'shellfish',
	bivalve: 'shellfish',
	cephalopod: 'shellfish',
	soya: 'soy',
	soybean: 'soy',
	groundnut: 'peanut',
	arachis: 'peanut',
	goober: 'peanut',
	treenut: 'tree nut',
	albumen: 'egg',
	albumin: 'egg',
	sulphite: 'sulfite',
	aubergine: 'eggplant',
	courgette: 'zucchini',
	coriander: 'cilantro',
	garbanzo: 'chickpea',
	prawns: 'prawn'
};

const PHRASE_SYNONYMS: Record<string, string> = {
	'tree nut': 'tree nut',
	'alpha gal': 'meat',
	'celiac sprue': 'gluten',
	'wheat gluten': 'gluten',
	'cow milk': 'dairy',
	'cows milk': 'dairy'
};

const KNOWN_MULTIWORD_ALLERGENS = new Set([
	'tree nut',
	'pine nut',
	'brazil nut',
	'bell pepper',
	'black pepper',
	'white pepper',
	'chili pepper',
	'cayenne pepper',
	'hot pepper',
	'sweet potato',
	'green bean',
	'string bean',
	'fava bean',
	'kidney bean',
	'black bean',
	'pinto bean',
	'lima bean',
	'soy sauce',
	'fish sauce',
	'oyster sauce',
	'worcestershire sauce',
	'passion fruit',
	'dragon fruit',
	'star fruit',
	'star anise',
	'brussels sprout',
	'bok choy',
	'spring onion',
	'green onion',
	'sunflower seed',
	'pumpkin seed',
	'poppy seed',
	'mustard seed',
	'celery seed',
	'fennel seed',
	'chia seed',
	'flax seed',
	'hemp seed',
	'monosodium glutamate'
]);

const ALLERGY_STOPWORDS = new Set([
	'i',
	'im',
	'am',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'me',
	'my',
	'mine',
	'myself',
	'we',
	'us',
	'our',
	'have',
	'has',
	'had',
	'having',
	'do',
	'does',
	'did',
	'dont',
	'doesnt',
	'cant',
	'cannot',
	'can',
	'could',
	'will',
	'wont',
	'would',
	'must',
	'should',
	'not',
	'no',
	'never',
	'without',
	'avoid',
	'avoiding',
	'avoids',
	'exclude',
	'excluding',
	'excludes',
	'skip',
	'hold',
	'omit',
	'free',
	'of',
	'from',
	'to',
	'for',
	'with',
	'in',
	'on',
	'at',
	'by',
	'as',
	'the',
	'a',
	'an',
	'any',
	'all',
	'some',
	'eat',
	'eating',
	'consume',
	'consuming',
	'tolerate',
	'digest',
	'allergic',
	'allergy',
	'allergies',
	'intolerant',
	'intolerance',
	'intolerances',
	'sensitive',
	'sensitivity',
	'sensitivities',
	'severe',
	'severely',
	'mild',
	'mildly',
	'moderate',
	'moderately',
	'slight',
	'slightly',
	'acute',
	'chronic',
	'deadly',
	'fatal',
	'life',
	'threatening',
	'anaphylactic',
	'anaphylaxis',
	'reaction',
	'reactions',
	'disease',
	'syndrome',
	'disorder',
	'condition',
	'issue',
	'issues',
	'strict',
	'strictly',
	'very',
	'extremely',
	'highly',
	'really',
	'super',
	'only',
	'also',
	'especially',
	'including',
	'like',
	'such',
	'please',
	'thanks',
	'thank',
	'you',
	'trace',
	'traces',
	'cross',
	'contact',
	'contamination',
	'symptom',
	'symptoms'
]);

const SECONDARY_MODIFIER_WORDS = new Set([
	'fresh',
	'raw',
	'dried',
	'dry',
	'roasted',
	'toasted',
	'cooked',
	'fried',
	'baked',
	'steamed',
	'ground',
	'whole',
	'crushed',
	'chopped',
	'minced',
	'sliced',
	'diced',
	'grated',
	'shredded',
	'powder',
	'powdered',
	'extract',
	'product',
	'derived',
	'based',
	'react',
	'reacted',
	'badly',
	'bad',
	'sick',
	'ill',
	'make',
	'give',
	'gave',
	'hive',
	'rash'
]);

const TRAILING_FORM_WORDS = new Set(['seed', 'oil', 'paste', 'leaf', 'flake']);

const KNOWN_CULINARY_TERMS: Set<string> = (() => {
	const set = new Set<string>([
		...Object.keys(ALLERGEN_EXPANSIONS),
		...Object.keys(ALLERGEN_SYNONYMS),
		...Object.values(ALLERGEN_SYNONYMS),
		...Object.keys(PHRASE_SYNONYMS),
		...KNOWN_MULTIWORD_ALLERGENS,
		'pea',
		'carrot',
		'onion',
		'shallot',
		'scallion',
		'leek',
		'chive',
		'garlic',
		'ginger',
		'turmeric',
		'galangal',
		'celery',
		'celeriac',
		'fennel',
		'radish',
		'daikon',
		'turnip',
		'parsnip',
		'rutabaga',
		'beet',
		'beetroot',
		'asparagus',
		'artichoke',
		'okra',
		'broccoli',
		'cauliflower',
		'cabbage',
		'kale',
		'spinach',
		'chard',
		'arugula',
		'rocket',
		'lettuce',
		'romaine',
		'endive',
		'radicchio',
		'watercress',
		'cucumber',
		'zucchini',
		'squash',
		'pumpkin',
		'eggplant',
		'tomato',
		'tomatillo',
		'pepper',
		'capsicum',
		'jalapeno',
		'habanero',
		'serrano',
		'poblano',
		'chipotle',
		'cayenne',
		'paprika',
		'chili',
		'chile',
		'mushroom',
		'truffle',
		'avocado',
		'olive',
		'caper',
		'pickle',
		'apple',
		'pear',
		'quince',
		'peach',
		'nectarine',
		'plum',
		'apricot',
		'cherry',
		'berry',
		'strawberry',
		'blueberry',
		'raspberry',
		'blackberry',
		'cranberry',
		'gooseberry',
		'currant',
		'grape',
		'raisin',
		'fig',
		'date',
		'prune',
		'citrus',
		'lemon',
		'lime',
		'orange',
		'grapefruit',
		'tangerine',
		'mandarin',
		'clementine',
		'yuzu',
		'kumquat',
		'banana',
		'plantain',
		'mango',
		'pineapple',
		'papaya',
		'kiwi',
		'guava',
		'lychee',
		'passionfruit',
		'pomegranate',
		'persimmon',
		'melon',
		'watermelon',
		'cantaloupe',
		'honeydew',
		'rhubarb',
		'coconut',
		'jackfruit',
		'durian',
		'cilantro',
		'coriander',
		'parsley',
		'basil',
		'mint',
		'peppermint',
		'spearmint',
		'dill',
		'oregano',
		'thyme',
		'rosemary',
		'sage',
		'tarragon',
		'marjoram',
		'bay',
		'lemongrass',
		'lavender',
		'cinnamon',
		'nutmeg',
		'mace',
		'clove',
		'allspice',
		'cardamom',
		'cumin',
		'caraway',
		'anise',
		'fenugreek',
		'sumac',
		'saffron',
		'vanilla',
		'cocoa',
		'cacao',
		'chocolate',
		'coffee',
		'caffeine',
		'tea',
		'matcha',
		'alcohol',
		'wine',
		'beer',
		'vinegar',
		'yeast',
		'msg',
		'salt',
		'sugar',
		'stevia',
		'erythritol',
		'xylitol',
		'aspartame',
		'sucralose',
		'sunflower',
		'pepita',
		'poppy',
		'chia',
		'flax',
		'flaxseed',
		'linseed',
		'hemp',
		'buckwheat',
		'quinoa',
		'amaranth',
		'millet',
		'sorghum',
		'teff',
		'oat',
		'oats',
		'rice',
		'corn',
		'maize',
		'lentil',
		'chickpea',
		'bean',
		'soba',
		'seaweed',
		'nori',
		'kombu',
		'wakame'
	]);
	for (const rule of Object.values(CATEGORY_RULES)) {
		for (const term of rule.terms) {
			set.add(foldAscii(term));
			for (const word of wordTokens(term)) {
				if (word.length >= 3) set.add(word);
			}
		}
	}
	for (const expansion of Object.values(ALLERGEN_EXPANSIONS)) {
		for (const term of expansion.terms) {
			set.add(foldAscii(term));
			for (const word of wordTokens(term)) {
				if (word.length >= 3) set.add(word);
			}
		}
	}
	for (const seed of seedRecipes) {
		for (const item of seed.ingredients) {
			for (const word of wordTokens(item.name)) {
				if (word.length >= 3) set.add(word);
			}
		}
	}
	return set;
})();

const EXPLICIT_NONE_MARKERS = new Set(['no', 'none', 'nil', 'nothing', 'na', 'anything']);
const GENERIC_NONE_WORDS = new Set([
	...ALLERGY_STOPWORDS,
	'none',
	'nil',
	'nothing',
	'na',
	'known',
	'food',
	'dietary',
	'anything'
]);

function isExplicitNoneEntry(value: string): boolean {
	const cleaned = foldAscii(value).replace(/^[.!?()[\]"'•\-–—:\s]+|[.!?()[\]"'•\-–—:\s]+$/g, '');
	if (NONE_ALLERGY_ALIASES.has(cleaned)) return true;
	const words = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
	if (NONE_ALLERGY_ALIASES.has(words.join(' '))) return true;
	const singularWords = words.map(singularizeWord);
	if (
		singularWords.length > 0 &&
		singularWords.some((word) => EXPLICIT_NONE_MARKERS.has(word)) &&
		singularWords.every((word) => GENERIC_NONE_WORDS.has(word))
	) {
		return true;
	}
	return false;
}

function parseClauseTokens(clause: string): string[] {
	const rawWords = wordTokens(clause);
	if (!rawWords.length) return [];
	const contentWords = rawWords.filter((word) => !ALLERGY_STOPWORDS.has(word));
	if (!contentWords.length) return [];

	const rawJoined = contentWords.join(' ');
	if (NONE_ALLERGY_ALIASES.has(rawJoined)) return [];
	if (PHRASE_SYNONYMS[rawJoined]) return [PHRASE_SYNONYMS[rawJoined]];
	if (KNOWN_MULTIWORD_ALLERGENS.has(rawJoined)) return [rawJoined];

	let filtered = contentWords.filter((word) => !SECONDARY_MODIFIER_WORDS.has(word));
	if (!filtered.length) filtered = contentWords;

	const filteredJoined = filtered.join(' ');
	if (PHRASE_SYNONYMS[filteredJoined]) return [PHRASE_SYNONYMS[filteredJoined]];
	if (KNOWN_MULTIWORD_ALLERGENS.has(filteredJoined)) return [filteredJoined];

	if (
		filtered.length === 2 &&
		TRAILING_FORM_WORDS.has(filtered[1]) &&
		(ALLERGEN_SYNONYMS[filtered[0]] ||
			ALLERGEN_EXPANSIONS[filtered[0]] ||
			KNOWN_CULINARY_TERMS.has(filtered[0]))
	) {
		const head = ALLERGEN_SYNONYMS[filtered[0]] ?? filtered[0];
		return [head];
	}

	const mapped: string[] = [];
	let index = 0;
	while (index < filtered.length) {
		if (index + 1 < filtered.length) {
			const twoWord = `${filtered[index]} ${filtered[index + 1]}`;
			if (PHRASE_SYNONYMS[twoWord]) {
				mapped.push(PHRASE_SYNONYMS[twoWord]);
				index += 2;
				continue;
			}
			if (KNOWN_MULTIWORD_ALLERGENS.has(twoWord)) {
				mapped.push(twoWord);
				index += 2;
				continue;
			}
		}
		const word = filtered[index];
		const canonical = ALLERGEN_SYNONYMS[word] ?? word;
		if (!NONE_ALLERGY_ALIASES.has(canonical)) {
			mapped.push(canonical);
		}
		index += 1;
	}
	return mapped;
}

function parseAllergyInput(value: string | undefined | null): {
	allergens: string[];
	emptyStopwordSegments: string[];
} {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw || isExplicitNoneEntry(raw)) {
		return { allergens: [], emptyStopwordSegments: [] };
	}

	const primarySegments = raw.split(/[,;\r\n/|•&]+/);
	const segments: string[] = [];
	for (const piece of primarySegments) {
		for (const part of piece.split(/\s+\b(?:and|or|plus|nor)\b\s+/i)) {
			const trimmed = part.trim();
			if (trimmed) segments.push(trimmed);
		}
	}

	const seen = new Set<string>();
	const allergens: string[] = [];
	const emptyStopwordSegments: string[] = [];

	for (const segment of segments) {
		if (isExplicitNoneEntry(segment)) continue;
		const subClauses = segment
			.split(/[()[\]]+/)
			.map((sub) => sub.trim())
			.filter(Boolean);
		let segmentProducedToken = false;
		for (const clause of subClauses) {
			if (isExplicitNoneEntry(clause)) {
				segmentProducedToken = true;
				continue;
			}
			const tokens = parseClauseTokens(clause);
			if (tokens.length > 0) {
				segmentProducedToken = true;
				for (const token of tokens) {
					if (token && !seen.has(token)) {
						seen.add(token);
						allergens.push(token);
					}
				}
			}
		}
		if (!segmentProducedToken) {
			emptyStopwordSegments.push(segment);
		}
	}

	return { allergens, emptyStopwordSegments };
}

/** Parse full free-text allergies (never truncated) across delimiters, parentheticals, stopwords, and synonyms. */
export function parseAllergies(value: string | undefined | null): string[] {
	return parseAllergyInput(value).allergens;
}

function ingredientMatchesCategory(
	variants: ReturnType<typeof buildTokenVariants>,
	category: DietConflictCategory
): boolean {
	const rule = CATEGORY_RULES[category];
	if (matchesAnyPhrase(variants.tokenSets, rule.labelExemptions)) return false;
	const strippedSets = stripExemptSpans(variants.tokenSets, rule.spanExemptions);
	return matchesAnyPhrase(strippedSets, rule.terms);
}

function tagMatchesCategory(tag: string, category: DietConflictCategory): boolean {
	const cleaned = normalized(tag);
	const rule = CATEGORY_RULES[category];
	if (rule.tagExemptions.some((exempt) => cleaned.includes(exempt))) return false;
	const variants = buildTokenVariants(cleaned);
	if (matchesAnyPhrase(variants.tokenSets, rule.labelExemptions)) return false;
	const strippedSets = stripExemptSpans(variants.tokenSets, rule.spanExemptions);
	return rule.tagTerms.some((term) => cleaned === term || containsWholePhrase(strippedSets, term));
}

function ingredientMatchesAllergen(
	variants: ReturnType<typeof buildTokenVariants>,
	allergen: string
): boolean {
	const negated = `${allergen} free`;
	if (containsWholePhrase(variants.tokenSets, negated)) return false;
	const expansion = ALLERGEN_EXPANSIONS[allergen];
	if (expansion) {
		if (
			expansion.labelExemptions &&
			matchesAnyPhrase(variants.tokenSets, expansion.labelExemptions)
		) {
			return false;
		}
		const strippedSets = expansion.spanExemptions
			? stripExemptSpans(variants.tokenSets, expansion.spanExemptions)
			: variants.tokenSets;
		if (matchesAnyPhrase(strippedSets, expansion.terms)) return true;
		return containsWholePhrase(strippedSets, allergen);
	}
	return containsWholePhrase(variants.tokenSets, allergen);
}

function ingredientGlutenLabelCheck(
	variants: ReturnType<typeof buildTokenVariants>
): string | null {
	if (matchesAnyPhrase(variants.tokenSets, CATEGORY_RULES.gluten.labelExemptions)) {
		return null;
	}
	for (const rule of GLUTEN_LABEL_CHECK_RULES) {
		if (matchesAnyPhrase(variants.tokenSets, rule.terms)) {
			return rule.label;
		}
	}
	return null;
}

/** Evaluate recipe ingredients and tags deterministically against active diet and full allergy preferences. */
export function evaluateRecipeConflicts(
	recipe: Recipe,
	preferences: Pick<Preferences, 'diet' | 'allergies'>
): RecipeConflictReport {
	const diet = normalizeDiet(preferences.diet);
	const resolvedDietLabel = dietLabel(diet);
	const disallowedCategories = DIET_EXCLUDED_CATEGORIES[diet] ?? [];
	const { allergens: parsedAllergens, emptyStopwordSegments } = parseAllergyInput(
		preferences.allergies
	);

	const checkGlutenLabelCrossContact =
		disallowedCategories.includes('gluten') ||
		parsedAllergens.some((allergen) => Boolean(ALLERGEN_EXPANSIONS[allergen]?.checkGlutenLabels));

	const matchedCategories = new Set<DietConflictCategory>();
	const matchedAllergens = new Set<string>();
	const matchedLabelChecks = new Set<string>();
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
		let matchedHardGlutenOnRow = false;
		for (const category of disallowedCategories) {
			if (ingredientMatchesCategory(variants, category)) {
				matchedCategories.add(category);
				addIngredientReason(index, category);
				if (category === 'gluten') matchedHardGlutenOnRow = true;
			}
		}
		for (const allergen of parsedAllergens) {
			if (ingredientMatchesAllergen(variants, allergen)) {
				matchedAllergens.add(allergen);
				addIngredientReason(index, `avoided: ${allergen}`);
				if (ALLERGEN_EXPANSIONS[allergen]?.checkGlutenLabels) {
					matchedHardGlutenOnRow = true;
				}
			}
		}
		if (checkGlutenLabelCrossContact && !matchedHardGlutenOnRow) {
			const labelCheck = ingredientGlutenLabelCheck(variants);
			if (labelCheck) {
				matchedLabelChecks.add(labelCheck);
				addIngredientReason(index, `check label: ${labelCheck}`);
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

	const unrecognizedAllergens: string[] = [...emptyStopwordSegments];
	for (const allergen of parsedAllergens) {
		if (!matchedAllergens.has(allergen) && !KNOWN_CULINARY_TERMS.has(allergen)) {
			unrecognizedAllergens.push(allergen);
		}
	}

	const dietCategories = disallowedCategories.filter((category) => matchedCategories.has(category));
	const allergenMatches = parsedAllergens.filter((allergen) => matchedAllergens.has(allergen));
	const labelCheckItems = [...matchedLabelChecks];
	const matchingIngredientIndices = Object.keys(ingredientReasons)
		.map(Number)
		.sort((a, b) => a - b);
	const hasConflict =
		dietCategories.length > 0 ||
		allergenMatches.length > 0 ||
		labelCheckItems.length > 0 ||
		unrecognizedAllergens.length > 0;

	let badge = '';
	const summaryParts: string[] = [];
	const hasAllergenSignal =
		allergenMatches.length > 0 ||
		unrecognizedAllergens.length > 0 ||
		(labelCheckItems.length > 0 && !disallowedCategories.includes('gluten'));
	const hasDietSignal =
		dietCategories.length > 0 ||
		(labelCheckItems.length > 0 && disallowedCategories.includes('gluten'));

	if (hasDietSignal && hasAllergenSignal) {
		badge = 'Diet & allergen alert';
	} else if (allergenMatches.length > 0) {
		badge = 'Allergen alert';
	} else if (dietCategories.length > 0) {
		badge = `${resolvedDietLabel} conflict`;
	} else if (labelCheckItems.length > 0 || unrecognizedAllergens.length > 0) {
		badge = 'Check labels';
	}

	if (dietCategories.length > 0) {
		summaryParts.push(`Conflicts with ${resolvedDietLabel} (${dietCategories.join(', ')})`);
	}
	if (allergenMatches.length > 0) {
		summaryParts.push(`Contains avoided ${allergenMatches.join(', ')}`);
	}
	if (labelCheckItems.length > 0) {
		summaryParts.push(`Check label for gluten (${labelCheckItems.join(', ')})`);
	}
	if (unrecognizedAllergens.length > 0) {
		summaryParts.push('Allergy text not understood — check labels');
	}

	return {
		hasConflict,
		diet,
		dietLabel: resolvedDietLabel,
		dietCategories,
		allergenMatches,
		labelCheckItems,
		unrecognizedAllergens,
		matchingIngredientIndices,
		ingredientReasons,
		badge,
		summary: summaryParts.join(' · ')
	};
}

/** Sanitize preferences for `/api/ai` requests without truncating stored `allergies`. */
export function sanitizePreferencesForAI(preferences: Preferences): Preferences {
	return {
		diet: normalizeDiet(preferences.diet).slice(0, 200),
		allergies: preferences.allergies ?? '',
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
