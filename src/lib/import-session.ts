import { insertRecipes } from '#lib/recipe-collection.ts';
import {
	createDraftBaseline,
	isDraftNutritionStale,
	type RecipeDraftBaseline
} from '#lib/recipe-draft.ts';
import type { AppState, Recipe } from '#lib/types.ts';

export const MAX_IMPORT_TEXT_LENGTH = 20_000;

export type ImportSession = {
	url: string;
	text: string;
	photo: string;
	photoName: string;
	draft: Recipe | null;
	baseline: RecipeDraftBaseline | null;
	assumptions: string[];
	reviewingDraft: boolean;
};

export const emptyImportSession = (): ImportSession => ({
	url: '',
	text: '',
	photo: '',
	photoName: '',
	draft: null,
	baseline: null,
	assumptions: [],
	reviewingDraft: false
});

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function isReviewingImportDraft(
	session: ImportSession
): session is ImportSession & { draft: Recipe } {
	return Boolean(session.reviewingDraft && session.draft !== null);
}

export function cloneImportSession(session: ImportSession): ImportSession {
	const draft = session.draft ? deepClone(session.draft) : null;
	const baseline = draft && session.baseline ? deepClone(session.baseline) : null;
	return {
		url: session.url,
		text: session.text,
		photo: session.photo,
		photoName: session.photoName,
		draft,
		baseline,
		assumptions: [...session.assumptions],
		reviewingDraft: Boolean(session.reviewingDraft && draft !== null)
	};
}

export function hasUnsavedImportContent(session: ImportSession): boolean {
	return Boolean(
		session.url.trim() ||
		session.text.trim() ||
		session.photo ||
		session.draft !== null ||
		session.assumptions.length > 0
	);
}

export function replaceImportSessionWithUrl(
	current: ImportSession,
	url: string
): { session: ImportSession; previous: ImportSession | null } {
	const session: ImportSession = { ...emptyImportSession(), url };
	const replacedContent =
		hasUnsavedImportContent(current) &&
		(current.url !== url ||
			Boolean(current.text.trim()) ||
			Boolean(current.photo) ||
			current.draft !== null ||
			current.assumptions.length > 0);
	return {
		session,
		previous: replacedContent ? cloneImportSession(current) : null
	};
}

export function clearImportSourceInPlace(session: ImportSession): void {
	session.url = '';
	session.text = '';
	session.photo = '';
	session.photoName = '';
	session.reviewingDraft = false;
}

export function canAppendImportTranscript(options: {
	modal: string;
	currentSession: ImportSession;
	startedSession: ImportSession;
	currentUserId?: string;
	startedUserId?: string;
}): boolean {
	return (
		options.currentUserId === options.startedUserId &&
		options.modal === 'import' &&
		options.currentSession === options.startedSession &&
		!isReviewingImportDraft(options.currentSession)
	);
}

export function appendImportTranscript(existing: string, transcript: string): string {
	return [existing, transcript].filter(Boolean).join('\n').slice(0, MAX_IMPORT_TEXT_LENGTH);
}

export function stableKitchenSnapshot(value: unknown): string {
	return JSON.stringify(value, (_key, entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		return Object.fromEntries(
			Object.entries(entry)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
		);
	});
}

export function applyImportedRecipeSave(
	kitchen: AppState,
	session: ImportSession,
	recipe: Recipe
): {
	saved: Recipe;
	nextRecipes: Recipe[];
	nextSession: ImportSession;
	appliedSnapshot: string;
	rollback: (
		currentKitchen: AppState
	) => { ok: true; kitchen: AppState; session: ImportSession } | { ok: false };
} {
	const previousKitchen = deepClone(kitchen);
	const clonedRecipe = deepClone(recipe);
	const nutritionStale =
		clonedRecipe.nutritionStale ?? isDraftNutritionStale(clonedRecipe, session.baseline);
	const saved: Recipe = { ...clonedRecipe, saved: true, nutritionStale };
	const restoredDraft = deepClone(session.draft ?? saved);
	const restoredSession: ImportSession = {
		...cloneImportSession(session),
		draft: restoredDraft,
		baseline: session.baseline ? deepClone(session.baseline) : createDraftBaseline(restoredDraft),
		assumptions: [...(session.draft ? session.assumptions : (saved.importNotes ?? []))],
		reviewingDraft: true
	};
	const nextRecipes = insertRecipes(kitchen.recipes, [saved]);
	const appliedSnapshot = stableKitchenSnapshot({ ...previousKitchen, recipes: nextRecipes });
	return {
		saved,
		nextRecipes,
		nextSession: emptyImportSession(),
		appliedSnapshot,
		rollback(currentKitchen: AppState) {
			if (stableKitchenSnapshot(currentKitchen) !== appliedSnapshot) {
				return { ok: false };
			}
			return {
				ok: true,
				kitchen: deepClone(previousKitchen),
				session: cloneImportSession(restoredSession)
			};
		}
	};
}
