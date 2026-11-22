import { COVER_PATH } from '#lib/cover-upload.ts';
import { isPublicHttpsRecipeUrl, sanitizeImportNotes } from '#lib/recipe-collection.ts';
import type { Recipe, RecipeIngredient } from '#lib/types.ts';

export const MAX_SERVINGS = 10_000;
export const MAX_COOKING_TIME = 100_000;
export const MAX_INGREDIENT_QUANTITY = 1_000_000;
export const MAX_SHOPPING_QUANTITY = 1_000_000;
export const MAX_NUTRITION_VALUE = 1_000_000;
export const MAX_DRAFT_INGREDIENTS = 60;
export const MAX_DRAFT_STEPS = 40;

export const NUTRITION_FIELDS: readonly [keyof Recipe['nutrition'], string][] = [
	['calories', 'Calories (kcal)'],
	['fat', 'Fat (g)'],
	['saturatedFat', 'Saturated fat (g)'],
	['sodium', 'Sodium (mg)'],
	['carbs', 'Carbohydrates (g)'],
	['fiber', 'Fiber (g)'],
	['sugar', 'Sugar (g)'],
	['protein', 'Protein (g)']
];

export type RecipeDraftBaseline = Pick<Recipe, 'servings' | 'ingredients' | 'nutrition'>;

export function createDraftBaseline(recipe: RecipeDraftBaseline): RecipeDraftBaseline {
	return {
		servings: recipe.servings,
		ingredients: recipe.ingredients.map((item) => ({
			name: item.name.trim(),
			quantity: item.quantity,
			unit: item.unit.trim()
		})),
		nutrition: { ...recipe.nutrition }
	};
}

export function isValidServings(value: unknown): value is number {
	return (
		typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SERVINGS
	);
}

export function isValidNutrition(nutrition: Recipe['nutrition'] | null | undefined): boolean {
	if (!nutrition || typeof nutrition !== 'object') return false;
	return NUTRITION_FIELDS.every(([key]) => {
		const value = nutrition[key];
		return (
			typeof value === 'number' &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_NUTRITION_VALUE
		);
	});
}

function sameIngredients(a: RecipeIngredient[], b: RecipeIngredient[]): boolean {
	if (a.length !== b.length) return false;
	return a.every(
		(item, index) =>
			item.name.trim() === b[index].name.trim() &&
			item.quantity === b[index].quantity &&
			item.unit.trim() === b[index].unit.trim()
	);
}

export function hasIngredientsOrServingsChanged(
	draft: Pick<Recipe, 'servings' | 'ingredients'>,
	baseline: Pick<Recipe, 'servings' | 'ingredients'>
): boolean {
	return (
		draft.servings !== baseline.servings ||
		!sameIngredients(draft.ingredients, baseline.ingredients)
	);
}

export function hasNutritionChanged(
	nutrition: Recipe['nutrition'],
	baselineNutrition: Recipe['nutrition']
): boolean {
	return NUTRITION_FIELDS.some(([key]) => nutrition[key] !== baselineNutrition[key]);
}

export function isDraftNutritionStale(
	draft: Pick<Recipe, 'servings' | 'ingredients' | 'nutrition'> & { nutritionStale?: boolean },
	baseline: RecipeDraftBaseline | null | undefined
): boolean {
	if (!baseline) return Boolean(draft.nutritionStale);
	if (hasNutritionChanged(draft.nutrition, baseline.nutrition)) return false;
	if (hasIngredientsOrServingsChanged(draft, baseline)) return true;
	return Boolean(draft.nutritionStale);
}

export type DraftValidationResult =
	| {
			ok: true;
			recipe: Recipe;
	  }
	| {
			ok: false;
			error: string;
			nutritionInvalid: boolean;
	  };

export function validateRecipeDraft(
	draft: Recipe,
	options?: { baseline?: RecipeDraftBaseline | null; assumptions?: string[] }
): DraftValidationResult {
	const id = typeof draft.id === 'string' ? draft.id.trim() : '';
	const title = typeof draft.title === 'string' ? draft.title.trim() : '';
	const image = typeof draft.image === 'string' ? draft.image.trim() : '';
	const source = typeof draft.source === 'string' ? draft.source.trim() : undefined;
	const imageValid =
		typeof draft.image === 'string' &&
		(!image || COVER_PATH.test(image) || isPublicHttpsRecipeUrl(image));
	const sourceValid =
		(draft.source === undefined || typeof draft.source === 'string') &&
		(!source || isPublicHttpsRecipeUrl(source));
	const tags = Array.isArray(draft.tags)
		? draft.tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean)
		: [];
	const tagsValid =
		Array.isArray(draft.tags) && tags.length <= 100 && tags.every((tag) => tag.length <= 100);
	const ratingValid =
		draft.rating === undefined ||
		(typeof draft.rating === 'number' &&
			Number.isFinite(draft.rating) &&
			draft.rating >= 0 &&
			draft.rating <= 5);
	const optionalFlagsValid =
		(draft.provenance === undefined ||
			draft.provenance === 'web-import' ||
			draft.provenance === 'ai-generated') &&
		(draft.hidden === undefined || typeof draft.hidden === 'boolean');
	const ingredients = Array.isArray(draft.ingredients)
		? draft.ingredients.map((item) => ({
				...item,
				name: typeof item.name === 'string' ? item.name.trim() : '',
				unit: typeof item.unit === 'string' ? item.unit.trim() : ''
			}))
		: [];
	const steps = Array.isArray(draft.steps)
		? draft.steps.map((step) => (typeof step === 'string' ? step.trim() : '')).filter(Boolean)
		: [];
	const nutritionValid = isValidNutrition(draft.nutrition);
	const coreValid =
		id.length >= 1 &&
		id.length <= 100 &&
		title.length >= 1 &&
		title.length <= 200 &&
		typeof draft.description === 'string' &&
		draft.description.length <= 10_000 &&
		typeof draft.cuisine === 'string' &&
		draft.cuisine.length <= 100 &&
		typeof draft.difficulty === 'string' &&
		draft.difficulty.length <= 80 &&
		imageValid &&
		sourceValid &&
		tagsValid &&
		ratingValid &&
		optionalFlagsValid &&
		typeof draft.time === 'number' &&
		Number.isInteger(draft.time) &&
		draft.time >= 1 &&
		draft.time <= MAX_COOKING_TIME &&
		isValidServings(draft.servings) &&
		ingredients.length >= 1 &&
		ingredients.length <= MAX_DRAFT_INGREDIENTS &&
		ingredients.every(
			(item) =>
				item.name.length >= 1 &&
				item.name.length <= 100 &&
				item.unit.length >= 1 &&
				item.unit.length <= 40 &&
				typeof item.quantity === 'number' &&
				Number.isFinite(item.quantity) &&
				item.quantity > 0 &&
				item.quantity <= MAX_INGREDIENT_QUANTITY
		) &&
		steps.length >= 1 &&
		steps.length <= MAX_DRAFT_STEPS &&
		steps.every((step) => step.length <= 10_000);

	if (!coreValid || !nutritionValid) {
		const error =
			!coreValid && !nutritionValid
				? 'Check the title, cooking time, whole servings (1–10,000), ingredient quantities, cooking steps, and nutrition values.'
				: !nutritionValid
					? 'Enter nutrition values between 0 and 1,000,000 for every field.'
					: !imageValid
						? 'Use a public HTTPS image URL, or leave it blank.'
						: !sourceValid
							? 'Use a public HTTPS source URL, or leave it blank.'
							: 'Add a title, whole cooking time and servings (1–10,000), at least one ingredient with a quantity and unit, and a cooking step.';
		return {
			ok: false,
			error,
			nutritionInvalid: !nutritionValid
		};
	}

	const nutritionStale = isDraftNutritionStale({ ...draft, ingredients }, options?.baseline);
	const { source: _rawSource, importNotes: rawImportNotes, ...rest } = draft;
	const importNotes =
		options?.assumptions !== undefined
			? sanitizeImportNotes(options.assumptions)
			: Array.isArray(rawImportNotes)
				? sanitizeImportNotes(rawImportNotes)
				: undefined;
	return {
		ok: true,
		recipe: {
			...rest,
			id,
			title,
			image,
			tags,
			ingredients,
			steps,
			nutrition: { ...draft.nutrition },
			...(source ? { source } : {}),
			...(importNotes !== undefined ? { importNotes } : {}),
			nutritionStale,
			saved: true
		}
	};
}
