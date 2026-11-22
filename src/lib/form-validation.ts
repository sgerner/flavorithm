import {
	MAX_COOKING_TIME,
	MAX_DRAFT_INGREDIENTS,
	MAX_DRAFT_STEPS,
	MAX_INGREDIENT_QUANTITY,
	MAX_NUTRITION_VALUE,
	MAX_SERVINGS,
	NUTRITION_FIELDS,
	isValidServings
} from './recipe-draft.ts';
import type { Recipe } from './types.ts';

export { NUTRITION_FIELDS };

export type FieldIds = {
	id: string;
	labelId: string;
	helpId: string;
	errorId: string;
};

export type FieldControlProps = {
	id: string;
	'aria-describedby'?: string;
	'aria-invalid': 'true' | 'false';
};

export type FieldAriaOptions = {
	hasHelp?: boolean;
	helpIds?: (string | false | null | undefined)[];
	error?: string | boolean | null;
	errorId?: string;
	invalid?: boolean;
};

export function fieldIds(baseId: string): FieldIds {
	const id = baseId.trim();
	return {
		id,
		labelId: `${id}-label`,
		helpId: `${id}-help`,
		errorId: `${id}-error`
	};
}

export function describeBy(...ids: (string | false | null | undefined)[]): string | undefined {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const raw of ids) {
		if (typeof raw !== 'string') continue;
		for (const token of raw.trim().split(/\s+/)) {
			if (token && !seen.has(token)) {
				seen.add(token);
				ordered.push(token);
			}
		}
	}
	return ordered.length ? ordered.join(' ') : undefined;
}

export function fieldAria(baseId: string, options: FieldAriaOptions = {}) {
	const ids = fieldIds(baseId);
	const resolvedErrorId = options.errorId?.trim() || ids.errorId;
	const hasErrorText = typeof options.error === 'string' && options.error.trim().length > 0;
	const isInvalid = Boolean(options.invalid || hasErrorText || options.error === true);
	const hasErrorId = hasErrorText || (isInvalid && Boolean(options.errorId?.trim()));
	const describedBy = describeBy(
		options.hasHelp ? ids.helpId : undefined,
		...(options.helpIds ?? []),
		hasErrorId ? resolvedErrorId : undefined
	);
	const props: FieldControlProps = {
		id: ids.id,
		...(describedBy ? { 'aria-describedby': describedBy } : {}),
		'aria-invalid': isInvalid ? 'true' : 'false'
	};
	return {
		...ids,
		errorId: resolvedErrorId,
		describedBy,
		invalid: isInvalid,
		props
	};
}

export function validateMealDate(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return 'Choose a date for this meal.';
	}
	const parsed = new Date(`${trimmed}T12:00:00`);
	if (Number.isNaN(parsed.getTime())) {
		return 'Choose a valid calendar date.';
	}
	return '';
}

export function validatePlannedServings(value: unknown): string {
	if (!isValidServings(value)) {
		return `Enter a whole number from 1 to ${MAX_SERVINGS.toLocaleString('en-US')} servings.`;
	}
	return '';
}

export function validateLeftoverServings(value: unknown, plannedServings: number): string {
	const max =
		Number.isInteger(plannedServings) && plannedServings >= 0 ? plannedServings : MAX_SERVINGS;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
		return `Enter a whole number from 0 to ${max.toLocaleString('en-US')} servings.`;
	}
	return '';
}

export function validateRecipeLink(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (trimmed.length > 2_048) {
		return 'Keep the recipe link under 2,048 characters.';
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
			return '';
		}
	} catch {
		// Fall through to validation error.
	}
	return 'Enter a valid http:// or https:// recipe link, or leave it blank.';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistrationName(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2 || trimmed.length > 80) {
		return 'Enter your name (2 to 80 characters).';
	}
	return '';
}

export function validateEmail(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) {
		return 'Enter a valid email address.';
	}
	return '';
}

export function validatePassword(
	value: string,
	mode: 'register' | 'reset' | 'login' | 'delete'
): string {
	if (mode === 'register' || mode === 'reset') {
		if (value.length < 10 || value.length > 128) {
			return 'Use a password between 10 and 128 characters.';
		}
		return '';
	}
	if (value.length < 1 || value.length > 128) {
		return mode === 'delete'
			? 'Enter your current password to confirm account deletion.'
			: 'Enter your password.';
	}
	return '';
}

export function validatePantryInput(value: string): string {
	const items = value
		.split(/[,\n;]/)
		.map((entry) => entry.trim())
		.filter(Boolean);
	return items.length ? '' : 'Enter at least one ingredient to add to your pantry.';
}

export function validateInviteCode(value: string): string {
	return value.trim() ? '' : 'Enter an invitation code to join a household.';
}

export type IngredientFieldErrors = {
	name?: string;
	quantity?: string;
	unit?: string;
};

export type RecipeDraftValidation = {
	title: string;
	time: string;
	servings: string;
	cuisine: string;
	difficulty: string;
	description: string;
	image: string;
	tags: string;
	ingredientsList: string;
	ingredients: IngredientFieldErrors[];
	stepsList: string;
	steps: string[];
	nutrition: Partial<Record<keyof Recipe['nutrition'], string>>;
	hasNutritionErrors: boolean;
	hasDetailErrors: boolean;
	hasErrors: boolean;
	errorCount: number;
	summary: string;
};

export function emptyRecipeDraftValidation(): RecipeDraftValidation {
	return {
		title: '',
		time: '',
		servings: '',
		cuisine: '',
		difficulty: '',
		description: '',
		image: '',
		tags: '',
		ingredientsList: '',
		ingredients: [],
		stepsList: '',
		steps: [],
		nutrition: {},
		hasNutritionErrors: false,
		hasDetailErrors: false,
		hasErrors: false,
		errorCount: 0,
		summary: ''
	};
}

export function validateRecipeDraftFields(
	draft: Recipe,
	options: {
		tagsText?: string;
		checkImage?: boolean;
		coverPathPattern?: RegExp;
	} = {}
): RecipeDraftValidation {
	const result = emptyRecipeDraftValidation();
	const failingLabels: string[] = [];
	const record = (label: string) => {
		result.errorCount += 1;
		if (failingLabels.length < 4) failingLabels.push(label);
	};

	const title = draft.title.trim();
	if (!title) {
		result.title = 'Enter a recipe title.';
		record('Title');
	} else if (title.length > 200) {
		result.title = 'Keep the title under 200 characters.';
		record('Title');
	}

	if (
		typeof draft.time !== 'number' ||
		!Number.isInteger(draft.time) ||
		draft.time < 1 ||
		draft.time > MAX_COOKING_TIME
	) {
		result.time = 'Enter a whole cooking time between 1 and 100,000 minutes.';
		record('Time (minutes)');
	}

	if (!isValidServings(draft.servings)) {
		result.servings = 'Enter whole servings between 1 and 10,000.';
		record('Servings');
	}

	if (draft.cuisine.trim().length > 100) {
		result.cuisine = 'Keep cuisine under 100 characters.';
		result.hasDetailErrors = true;
		record('Cuisine');
	}

	if (draft.difficulty.trim().length > 80) {
		result.difficulty = 'Keep difficulty under 80 characters.';
		result.hasDetailErrors = true;
		record('Difficulty');
	}

	if (draft.description.trim().length > 10_000) {
		result.description = 'Keep description under 10,000 characters.';
		result.hasDetailErrors = true;
		record('Description');
	}

	if (options.checkImage) {
		const image = draft.image.trim();
		if (image && !(options.coverPathPattern && options.coverPathPattern.test(image))) {
			let validUrl = false;
			try {
				const parsed = new URL(image);
				validUrl = parsed.protocol === 'https:' && !parsed.username && !parsed.password;
			} catch {
				validUrl = false;
			}
			if (!validUrl || image.length > 4_000) {
				result.image = 'Use a public HTTPS image URL, or leave it blank.';
				record('Image URL');
			}
		}
	}

	if (options.tagsText !== undefined) {
		const tags = [
			...new Set(
				options.tagsText
					.split(',')
					.map((tag) => tag.trim())
					.filter(Boolean)
			)
		];
		if (tags.length > 30) {
			result.tags = 'Use 30 tags or fewer.';
			record('Tags');
		} else if (tags.some((tag) => tag.length > 100)) {
			result.tags = 'Keep each tag under 100 characters.';
			record('Tags');
		}
	}

	if (!draft.ingredients.length) {
		result.ingredientsList = 'Add at least one ingredient.';
		record('Ingredients');
	} else if (draft.ingredients.length > MAX_DRAFT_INGREDIENTS) {
		result.ingredientsList = `Use ${MAX_DRAFT_INGREDIENTS} ingredients or fewer.`;
		record('Ingredients');
	}

	result.ingredients = draft.ingredients.map((item, index) => {
		const row: IngredientFieldErrors = {};
		const name = item.name.trim();
		const unit = item.unit.trim();
		if (!name) {
			row.name = `Enter a name for ingredient ${index + 1}.`;
			record(`Ingredient ${index + 1}`);
		} else if (name.length > 100) {
			row.name = `Keep ingredient ${index + 1} under 100 characters.`;
			record(`Ingredient ${index + 1}`);
		}
		if (
			typeof item.quantity !== 'number' ||
			!Number.isFinite(item.quantity) ||
			item.quantity <= 0 ||
			item.quantity > MAX_INGREDIENT_QUANTITY
		) {
			row.quantity = `Enter a quantity above 0 (up to 1,000,000) for ingredient ${index + 1}.`;
			record(`Quantity for ingredient ${index + 1}`);
		}
		if (!unit) {
			row.unit = `Enter a unit for ingredient ${index + 1}.`;
			record(`Unit for ingredient ${index + 1}`);
		} else if (unit.length > 40) {
			row.unit = `Keep the unit for ingredient ${index + 1} under 40 characters.`;
			record(`Unit for ingredient ${index + 1}`);
		}
		return row;
	});

	if (!draft.steps.length) {
		result.stepsList = 'Add at least one cooking step.';
		record('Steps');
	} else if (draft.steps.length > MAX_DRAFT_STEPS) {
		result.stepsList = `Use ${MAX_DRAFT_STEPS} cooking steps or fewer.`;
		record('Steps');
	}

	result.steps = draft.steps.map((step, index) => {
		const trimmed = step.trim();
		if (!trimmed) {
			record(`Step ${index + 1}`);
			return draft.steps.length > 1
				? `Enter instructions for step ${index + 1}, or remove the empty step.`
				: `Enter instructions for step ${index + 1}.`;
		}
		if (trimmed.length > 10_000) {
			record(`Step ${index + 1}`);
			return `Keep step ${index + 1} under 10,000 characters.`;
		}
		return '';
	});

	for (const [key, label] of NUTRITION_FIELDS) {
		const value = draft.nutrition[key];
		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			value < 0 ||
			value > MAX_NUTRITION_VALUE
		) {
			result.nutrition[key] = `Enter ${label.toLowerCase()} between 0 and 1,000,000.`;
			result.hasNutritionErrors = true;
			record(label);
		}
	}

	result.hasErrors = result.errorCount > 0;
	if (result.hasErrors) {
		const more = result.errorCount - failingLabels.length;
		result.summary =
			result.errorCount === 1
				? `Fix ${failingLabels[0]} before saving.`
				: `Fix ${result.errorCount} fields before saving: ${failingLabels.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
	}
	return result;
}
