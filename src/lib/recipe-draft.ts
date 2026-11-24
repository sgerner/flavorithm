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

export function insertDraftItem<T>(
	items: readonly T[],
	afterIndex: number,
	item: T,
	limit: number
): { items: T[]; index: number } | null {
	if (items.length >= limit) return null;
	const index = Math.max(0, Math.min(items.length, afterIndex + 1));
	const next = [...items];
	next.splice(index, 0, item);
	return { items: next, index };
}

export function moveDraftItem<T>(
	items: readonly T[],
	index: number,
	direction: -1 | 1
): { items: T[]; index: number } | null {
	const targetIndex = index + direction;
	if (index < 0 || index >= items.length || targetIndex < 0 || targetIndex >= items.length) {
		return null;
	}
	const next = [...items];
	[next[index], next[targetIndex]] = [next[targetIndex], next[index]];
	return { items: next, index: targetIndex };
}

export type RecipeEditorSnapshot = {
	draft: Recipe;
	tagsText: string;
};

export function hasRecipeEditorChanges(
	initial: RecipeEditorSnapshot,
	current: RecipeEditorSnapshot
): boolean {
	const a = initial.draft;
	const b = current.draft;
	if (
		a.title !== b.title ||
		!Object.is(a.time, b.time) ||
		!Object.is(a.servings, b.servings) ||
		a.cuisine !== b.cuisine ||
		a.difficulty !== b.difficulty ||
		a.description !== b.description ||
		a.image !== b.image ||
		initial.tagsText !== current.tagsText ||
		a.ingredients.length !== b.ingredients.length ||
		a.steps.length !== b.steps.length
	) {
		return true;
	}
	for (let i = 0; i < a.ingredients.length; i++) {
		const left = a.ingredients[i];
		const right = b.ingredients[i];
		if (
			left.name !== right.name ||
			!Object.is(left.quantity, right.quantity) ||
			left.unit !== right.unit
		) {
			return true;
		}
	}
	for (let i = 0; i < a.steps.length; i++) {
		if (a.steps[i] !== b.steps[i]) return true;
	}
	for (const [key] of NUTRITION_FIELDS) {
		if (!Object.is(a.nutrition[key], b.nutrition[key])) return true;
	}
	return false;
}

type DisclosureLike = {
	open: boolean;
	parentElement: { closest(selector: string): unknown } | null;
};

export function openClosedImportNotes(control: { closest(selector: string): unknown }): boolean {
	let opened = false;
	let current = control.closest('details.import-notes') as DisclosureLike | null;
	while (current && typeof current === 'object' && 'open' in current) {
		if (!current.open) {
			current.open = true;
			opened = true;
		}
		current = (current.parentElement?.closest('details.import-notes') ??
			null) as DisclosureLike | null;
	}
	return opened;
}

export function controlLabelText(control: {
	getAttribute(name: string): string | null;
	closest(selector: string): unknown;
}): string {
	const aria = control.getAttribute('aria-label')?.trim();
	if (aria) return aria;
	const label = control.closest('label') as {
		cloneNode?: (deep?: boolean) => {
			querySelectorAll?: (selector: string) => Iterable<{ remove(): void }>;
			textContent?: string | null;
		};
		textContent?: string | null;
	} | null;
	if (label?.cloneNode) {
		const clone = label.cloneNode(true);
		if (clone.querySelectorAll) {
			for (const child of clone.querySelectorAll('input, textarea, select')) {
				child.remove();
			}
		}
		const text = clone.textContent?.trim();
		if (text) return text;
	} else if (label?.textContent?.trim()) {
		return label.textContent.trim();
	}
	return 'this field';
}

export function describeInvalidControl(control: {
	type?: string;
	min?: string;
	max?: string;
	validationMessage?: string;
	validity?: {
		valueMissing?: boolean;
		badInput?: boolean;
		rangeUnderflow?: boolean;
		rangeOverflow?: boolean;
	};
	getAttribute(name: string): string | null;
	closest(selector: string): unknown;
}): string {
	const name = controlLabelText(control);
	if (control.type === 'number') {
		const min = control.min !== undefined && control.min !== '' ? Number(control.min) : null;
		const max = control.max !== undefined && control.max !== '' ? Number(control.max) : null;
		if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max)) {
			if (min === 0) {
				return `Enter a number from 0 to ${max.toLocaleString('en-US')} for ${name}.`;
			}
			if (min >= 1) {
				return `Enter a number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} for ${name}.`;
			}
			return `Enter a quantity greater than 0 and up to ${max.toLocaleString('en-US')} for ${name}.`;
		}
	}
	if (control.validity?.valueMissing) {
		return `Enter a value for ${name}.`;
	}
	const detail = control.validationMessage?.trim();
	return detail ? `${name}: ${detail}` : `Check the value for ${name}.`;
}

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
	const title = typeof draft.title === 'string' ? draft.title.trim() : '';
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
		title.length >= 1 &&
		title.length <= 200 &&
		typeof draft.description === 'string' &&
		draft.description.length <= 10_000 &&
		typeof draft.cuisine === 'string' &&
		draft.cuisine.length <= 100 &&
		typeof draft.difficulty === 'string' &&
		draft.difficulty.length <= 80 &&
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
					: 'Add a title, whole cooking time and servings (1–10,000), at least one ingredient with a quantity and unit, and a cooking step.';
		return {
			ok: false,
			error,
			nutritionInvalid: !nutritionValid
		};
	}

	const nutritionStale = isDraftNutritionStale({ ...draft, ingredients }, options?.baseline);
	return {
		ok: true,
		recipe: {
			...draft,
			title,
			description: draft.description.trim().slice(0, 10_000),
			cuisine: draft.cuisine.trim().slice(0, 100),
			difficulty: draft.difficulty.trim().slice(0, 80),
			ingredients,
			steps,
			nutrition: { ...draft.nutrition },
			...(options?.assumptions !== undefined
				? {
						importNotes: options.assumptions
							.map((note) => note.trim().slice(0, 300))
							.filter(Boolean)
							.slice(0, 30)
					}
				: {}),
			nutritionStale,
			saved: true
		}
	};
}
