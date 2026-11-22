import type { Recipe } from './types.ts';

export const MAX_DRAFT_INGREDIENTS = 60;
export const MAX_DRAFT_STEPS = 40;

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

const NUTRITION_KEYS: (keyof Recipe['nutrition'])[] = [
	'calories',
	'fat',
	'saturatedFat',
	'sodium',
	'carbs',
	'fiber',
	'sugar',
	'protein'
];

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
	for (const key of NUTRITION_KEYS) {
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
