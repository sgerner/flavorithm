import { COVER_PATH } from '#lib/cover-upload.ts';
import type { Recipe } from '#lib/types.ts';

export const MAX_RECIPES = 250;
export const MAX_IMPORT_NOTES = 30;
export const MAX_IMPORT_NOTE_LENGTH = 300;

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

export function isPublicHttpsRecipeUrl(value: string): boolean {
	if (!value) return true;
	if (value.length > 4_000) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

export function sanitizeImportNotes(assumptions: string[]): string[] {
	return assumptions
		.map((note) =>
			typeof note === 'string' ? note.trim().slice(0, MAX_IMPORT_NOTE_LENGTH).trim() : ''
		)
		.filter(Boolean)
		.slice(0, MAX_IMPORT_NOTES);
}

/** Validate and normalize an imported recipe draft so it satisfies server persistence bounds. */
export function prepareImportedRecipe(
	draft: Recipe,
	assumptions: string[]
): { recipe: Recipe } | { error: string } {
	const id = draft.id.trim();
	const title = draft.title.trim();
	const description = draft.description.trim();
	const cuisine = draft.cuisine.trim();
	const difficulty = draft.difficulty.trim();
	const image = draft.image.trim();
	const source = draft.source?.trim();
	if (image && !COVER_PATH.test(image) && !isPublicHttpsRecipeUrl(image)) {
		return { error: 'Use a public HTTPS image URL, or leave it blank.' };
	}
	if (source && !isPublicHttpsRecipeUrl(source)) {
		return { error: 'Use a public HTTPS source URL, or leave it blank.' };
	}
	const tags = draft.tags.map((tag) => tag.trim()).filter(Boolean);
	const ingredients = draft.ingredients.map((item) => ({
		...item,
		name: item.name.trim(),
		unit: item.unit.trim()
	}));
	const steps = draft.steps.map((step) => step.trim()).filter(Boolean);
	const validNutrition =
		!!draft.nutrition &&
		typeof draft.nutrition === 'object' &&
		NUTRITION_KEYS.every((key) => {
			const value = draft.nutrition[key];
			return (
				typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
			);
		});
	const validRating =
		draft.rating === undefined ||
		(typeof draft.rating === 'number' &&
			Number.isFinite(draft.rating) &&
			draft.rating >= 0 &&
			draft.rating <= 5);
	const validOptionalFlags =
		(draft.provenance === undefined ||
			draft.provenance === 'web-import' ||
			draft.provenance === 'ai-generated') &&
		(draft.nutritionStale === undefined || typeof draft.nutritionStale === 'boolean') &&
		(draft.hidden === undefined || typeof draft.hidden === 'boolean');
	if (
		!id ||
		id.length > 100 ||
		!title ||
		title.length > 200 ||
		description.length > 10_000 ||
		cuisine.length > 100 ||
		difficulty.length > 80 ||
		typeof draft.time !== 'number' ||
		!Number.isFinite(draft.time) ||
		draft.time <= 0 ||
		draft.time > 100_000 ||
		typeof draft.servings !== 'number' ||
		!Number.isFinite(draft.servings) ||
		draft.servings < 1 ||
		draft.servings > 10_000 ||
		tags.length > 100 ||
		tags.some((tag) => tag.length > 100) ||
		!ingredients.length ||
		ingredients.length > 60 ||
		ingredients.some(
			(item) =>
				!item.name ||
				item.name.length > 200 ||
				!item.unit ||
				item.unit.length > 40 ||
				typeof item.quantity !== 'number' ||
				!Number.isFinite(item.quantity) ||
				item.quantity <= 0 ||
				item.quantity > 1_000_000
		) ||
		!steps.length ||
		steps.length > 40 ||
		steps.some((step) => step.length > 10_000) ||
		!validNutrition ||
		!validRating ||
		!validOptionalFlags
	) {
		return {
			error:
				'Add a valid title, time, servings, nutrition estimates, up to 60 ingredients with quantities and units, and up to 40 cooking steps.'
		};
	}
	const { source: _rawSource, ...rest } = draft;
	return {
		recipe: {
			...rest,
			id,
			title,
			description,
			image,
			cuisine,
			difficulty,
			tags,
			ingredients,
			steps,
			...(source ? { source } : {}),
			importNotes: sanitizeImportNotes(assumptions),
			saved: true
		}
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
