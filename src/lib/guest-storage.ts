import { HOST_CONNECTION_ID } from './ai-connections.ts';
import { COVER_PATH } from './cover-upload.ts';
import { createInitialState, createNewUserState, defaultPreferences, themes } from './data.ts';
import { backfillSampleData, clearSampleData } from './kitchen-workflows.ts';
import { readPendingJournal } from './offline-sync.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import type {
	AppState,
	Ingredient,
	Meal,
	Preferences,
	Recipe,
	RecipeIngredient,
	ShoppingItem,
	User
} from './types.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
	Partial<Pick<Storage, 'key' | 'length'>>;
type RemovableStorage = Pick<Storage, 'removeItem'>;

const GUEST_KITCHEN_KEY = 'flavorithm-guest-kitchen';
const GUEST_STARTED_KEY = 'flavorithm-started';
const validThemes = new Set<string>(themes);

/** Preserve ambiguous pre-isolation data without exposing it as a guest kitchen. */
export function quarantineLegacyKitchen(storage: StorageLike): void {
	try {
		const legacy = storage.getItem('flavorithm-kitchen');
		if (!legacy) return;
		const backup = storage.getItem('flavorithm-legacy-kitchen-backup');
		if (backup && backup !== legacy) return;
		if (!backup) storage.setItem('flavorithm-legacy-kitchen-backup', legacy);
		storage.removeItem('flavorithm-kitchen');
	} catch {
		// A failed backup must leave the original available for manual recovery.
	}
}

/** Remove saved guest kitchen state once it has been staged into an account or discarded. */
export function clearGuestKitchen(storage: RemovableStorage): void {
	try {
		storage.removeItem(GUEST_KITCHEN_KEY);
	} catch {
		// Restricted storage must not block account transitions.
	}
}

/** Clear all guest-only browser keys, including the sample-kitchen dismissal flag. */
export function clearGuestData(storage: RemovableStorage): void {
	clearGuestKitchen(storage);
	try {
		storage.removeItem(GUEST_STARTED_KEY);
	} catch {
		// Restricted storage must not block account transitions.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectCollection(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(isRecord);
}

function parseGuestState(raw: string | null): AppState | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		if (
			!isObjectCollection(parsed.pantry) ||
			!isObjectCollection(parsed.recipes) ||
			!isObjectCollection(parsed.meals) ||
			!isObjectCollection(parsed.shopping) ||
			!isRecord(parsed.preferences)
		) {
			return null;
		}
		const sanitized = sanitizeKitchenState(parsed);
		sanitized.preferences.theme = validThemes.has(sanitized.preferences.theme)
			? sanitized.preferences.theme
			: defaultPreferences.theme;
		return sanitized;
	} catch {
		return null;
	}
}

/** Restore a validated guest kitchen snapshot or fall back to a badged sample kitchen. */
export function restoreGuestKitchen(storage: StorageLike): {
	kitchen: AppState;
	showStarter: boolean;
} {
	quarantineLegacyKitchen(storage);
	let raw: string | null = null;
	try {
		raw = storage.getItem('flavorithm-guest-kitchen');
	} catch {
		raw = null;
	}
	const guest = parseGuestState(raw);
	if (guest) {
		let started = false;
		try {
			started = storage.getItem('flavorithm-started') === 'yes';
		} catch {
			started = false;
		}
		return {
			kitchen: started ? guest : backfillSampleData(guest),
			showStarter: !started
		};
	}
	try {
		storage.removeItem('flavorithm-started');
	} catch {
		// Ignore storage write errors while falling back to the sample kitchen.
	}
	return {
		kitchen: createInitialState(),
		showStarter: true
	};
}

export function teardownToGuestKitchen(options: {
	storage: StorageLike;
	preserveLastAccount?: boolean;
	clearSyncContext?: () => void;
	clearAIConnectionState?: () => void;
}): {
	kitchen: AppState;
	showStarter: boolean;
} {
	const guest = restoreGuestKitchen(options.storage);
	options.clearAIConnectionState?.();
	options.clearSyncContext?.();
	if (!options.preserveLastAccount) {
		try {
			options.storage.removeItem('flavorithm-last-account');
		} catch {
			// Ignore storage removal failures while restoring guest state.
		}
	}
	return guest;
}

export function readCachedAccount(storage: StorageLike): User | null {
	try {
		const parsed: unknown = JSON.parse(storage.getItem('flavorithm-last-account') || 'null');
		if (
			!isRecord(parsed) ||
			typeof parsed.id !== 'string' ||
			!parsed.id ||
			typeof parsed.householdId !== 'string' ||
			!parsed.householdId ||
			typeof parsed.name !== 'string' ||
			typeof parsed.email !== 'string'
		) {
			return null;
		}
		return {
			id: parsed.id,
			name: parsed.name,
			email: parsed.email,
			householdId: parsed.householdId,
			...(typeof parsed.emailVerified === 'boolean' ? { emailVerified: parsed.emailVerified } : {})
		};
	} catch {
		return null;
	}
}

/** Restore the last local account in expired-session mode when unsynced journal deltas exist. */
export function restoreExpiredSessionAccount(storage: StorageLike): User | null {
	const cached = readCachedAccount(storage);
	if (!cached) return null;
	const journal = readPendingJournal(storage, cached);
	return journal.records.length > 0 ? cached : null;
}

export function clearAccountStorage(storage: StorageLike, userId: string): void {
	if (!userId) return;
	const encodedId = encodeURIComponent(userId);
	const matchesUserKey = (key: string) =>
		key.startsWith('flavorithm-') &&
		key !== 'flavorithm-guest-kitchen' &&
		key !== 'flavorithm-started' &&
		key !== 'flavorithm-legacy-kitchen-backup' &&
		(key.includes(`:${userId}:`) ||
			key.includes(`:${encodedId}:`) ||
			key === `flavorithm-voice:${userId}` ||
			key === `flavorithm-voice:${encodedId}`);
	try {
		if (typeof storage.length === 'number' && typeof storage.key === 'function') {
			const toRemove: string[] = [];
			for (let index = 0; index < storage.length; index += 1) {
				const key = storage.key(index);
				if (key && matchesUserKey(key)) toRemove.push(key);
			}
			for (const key of toRemove) storage.removeItem(key);
			return;
		}
		for (const key of Object.keys(storage)) {
			if (matchesUserKey(key)) storage.removeItem(key);
		}
	} catch {
		// Best-effort local cleanup after server account deletion.
	}
}

export function resolveLocalAuthTransition(options: {
	previousMode: string;
	nextMode: string;
	previousUser: User | null;
	nextUser: User | null;
}): {
	managedAuth: boolean;
	modeChanged: boolean;
	localSessionExpired: boolean;
	changedIdentity: boolean;
} {
	const managedAuth = options.nextMode !== 'local';
	const modeChanged = options.previousMode !== options.nextMode;
	const localSessionExpired = !managedAuth && Boolean(options.previousUser) && !options.nextUser;
	const changedIdentity =
		!localSessionExpired &&
		Boolean(
			(options.previousUser &&
				(options.previousUser.id !== options.nextUser?.id ||
					options.previousUser.householdId !== options.nextUser?.householdId)) ||
			(modeChanged && managedAuth && options.nextUser)
		);
	return { managedAuth, modeChanged, localSessionExpired, changedIdentity };
}

export function resolveRegistrationGuestSeed(
	storage: StorageLike,
	currentKitchen: AppState,
	options: { sessionExpired: boolean; user: User | null }
): AppState {
	const seed =
		options.sessionExpired || options.user
			? restoreGuestKitchen(storage).kitchen
			: sanitizeKitchenState(currentKitchen);
	return clearSampleData(seed);
}

function parseFiniteNumber(value: unknown): number | undefined {
	const numeric =
		typeof value === 'number'
			? value
			: typeof value === 'string' && value.trim() !== ''
				? Number(value)
				: Number.NaN;
	if (!Number.isFinite(numeric)) return undefined;
	return Object.is(numeric, -0) ? 0 : numeric;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = parseFiniteNumber(value);
	if (parsed === undefined) return fallback;
	const clamped = Math.min(max, Math.max(min, parsed));
	return Object.is(clamped, -0) ? 0 : clamped;
}

function clampString(value: unknown, max: number, fallback = ''): string {
	return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function sanitizeId(value: unknown, prefix: string, index: number, usedIds: Set<string>): string {
	const base =
		(typeof value === 'string' ? value.trim().slice(0, 100) : '') || `${prefix}-${index + 1}`;
	let candidate = base;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		const tag = `-${suffix++}`;
		candidate = `${base.slice(0, Math.max(1, 100 - tag.length))}${tag}`;
	}
	usedIds.add(candidate);
	return candidate;
}

function isPublicHttpsUrl(value: string): boolean {
	if (!value || value.length > 4_000) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

function sanitizeImage(value: unknown): string {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (COVER_PATH.test(trimmed) || isPublicHttpsUrl(trimmed)) return trimmed;
	return '';
}

function sanitizePantry(value: unknown, fallback: Ingredient[]): Ingredient[] {
	if (!Array.isArray(value)) return structuredClone(fallback);
	const result: Ingredient[] = [];
	const usedIds = new Set<string>();
	for (let i = 0; i < value.length && result.length < 1_000; i++) {
		const raw = value[i];
		if (!isRecord(raw)) continue;
		const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : '';
		if (!name) continue;
		const id = sanitizeId(raw.id, 'pantry', i, usedIds);
		const quantity = clampNumber(raw.quantity, 0, 1_000_000, 0);
		const unit = (typeof raw.unit === 'string' ? raw.unit.trim().slice(0, 40) : '') || 'piece';
		const category =
			typeof raw.category === 'string' ? raw.category.slice(0, 100) || 'Pantry' : 'Pantry';
		const expires = typeof raw.expires === 'string' ? raw.expires.trim().slice(0, 50) : '';
		const sample = typeof raw.sample === 'boolean' ? raw.sample : undefined;
		result.push({
			id,
			name,
			quantity,
			unit,
			category,
			...(expires ? { expires } : {}),
			...(sample !== undefined ? { sample } : {})
		});
	}
	return result;
}

function sanitizeRecipeIngredient(value: unknown): RecipeIngredient | null {
	if (!isRecord(value)) return null;
	const name = typeof value.name === 'string' ? value.name.trim().slice(0, 200) : '';
	if (!name) return null;
	return {
		name,
		quantity: clampNumber(value.quantity, 0, 1_000_000, 0),
		unit: clampString(value.unit, 40)
	};
}

function sanitizeRecipes(value: unknown, fallback: Recipe[]): Recipe[] {
	if (!Array.isArray(value)) return structuredClone(fallback);
	const result: Recipe[] = [];
	const usedIds = new Set<string>();
	for (let i = 0; i < value.length && result.length < MAX_RECIPES; i++) {
		const raw = value[i];
		if (!isRecord(raw)) continue;
		const id = sanitizeId(raw.id, 'recipe', i, usedIds);
		const title =
			(typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '') || 'Untitled recipe';
		const description = clampString(raw.description, 10_000);
		const image = sanitizeImage(raw.image);
		const time = clampNumber(raw.time, 0, 100_000, 0);
		const servings = clampNumber(raw.servings, 1, 10_000, 2);
		const difficulty = clampString(raw.difficulty, 80);
		const cuisine = clampString(raw.cuisine, 100);
		const tags = Array.isArray(raw.tags)
			? raw.tags
					.filter((tag): tag is string => typeof tag === 'string')
					.map((tag) => tag.slice(0, 100))
					.slice(0, 100)
			: [];
		const ingredients: RecipeIngredient[] = [];
		if (Array.isArray(raw.ingredients)) {
			for (const entry of raw.ingredients) {
				if (ingredients.length >= 250) break;
				const sanitized = sanitizeRecipeIngredient(entry);
				if (sanitized) ingredients.push(sanitized);
			}
		}
		const steps = Array.isArray(raw.steps)
			? raw.steps
					.filter((step): step is string => typeof step === 'string')
					.map((step) => step.slice(0, 10_000))
					.slice(0, 200)
			: [];
		const rawNutrition = isRecord(raw.nutrition) ? raw.nutrition : {};
		const nutrition = {
			calories: clampNumber(rawNutrition.calories, 0, 1_000_000, 0),
			fat: clampNumber(rawNutrition.fat, 0, 1_000_000, 0),
			saturatedFat: clampNumber(rawNutrition.saturatedFat, 0, 1_000_000, 0),
			sodium: clampNumber(rawNutrition.sodium, 0, 1_000_000, 0),
			carbs: clampNumber(rawNutrition.carbs, 0, 1_000_000, 0),
			fiber: clampNumber(rawNutrition.fiber, 0, 1_000_000, 0),
			sugar: clampNumber(rawNutrition.sugar, 0, 1_000_000, 0),
			protein: clampNumber(rawNutrition.protein, 0, 1_000_000, 0)
		};
		const sourceTrimmed = typeof raw.source === 'string' ? raw.source.trim() : '';
		const source = sourceTrimmed && isPublicHttpsUrl(sourceTrimmed) ? sourceTrimmed : undefined;
		const provenance =
			raw.provenance === 'web-import' ||
			raw.provenance === 'ai-generated' ||
			raw.provenance === 'manual'
				? raw.provenance
				: undefined;
		const importNotes = Array.isArray(raw.importNotes)
			? raw.importNotes
					.filter((note): note is string => typeof note === 'string')
					.map((note) => note.trim().slice(0, 300))
					.filter(Boolean)
					.slice(0, 30)
			: undefined;
		const nutritionStale = typeof raw.nutritionStale === 'boolean' ? raw.nutritionStale : undefined;
		const parsedRating = parseFiniteNumber(raw.rating);
		const rating = parsedRating !== undefined ? Math.min(5, Math.max(0, parsedRating)) : undefined;
		const saved = typeof raw.saved === 'boolean' ? raw.saved : undefined;
		const sampleSaved = typeof raw.sampleSaved === 'boolean' ? raw.sampleSaved : undefined;
		const hidden = typeof raw.hidden === 'boolean' ? raw.hidden : undefined;

		result.push({
			id,
			title,
			description,
			image,
			time,
			servings,
			difficulty,
			cuisine,
			tags,
			ingredients,
			steps,
			nutrition,
			...(source !== undefined ? { source } : {}),
			...(provenance !== undefined ? { provenance } : {}),
			...(importNotes !== undefined ? { importNotes } : {}),
			...(nutritionStale !== undefined ? { nutritionStale } : {}),
			...(rating !== undefined ? { rating } : {}),
			...(saved !== undefined ? { saved } : {}),
			...(sampleSaved !== undefined ? { sampleSaved } : {}),
			...(hidden !== undefined ? { hidden } : {})
		});
	}
	return result;
}

function sanitizeMeals(value: unknown, fallback: Meal[]): Meal[] {
	if (!Array.isArray(value)) return structuredClone(fallback);
	const result: Meal[] = [];
	const usedIds = new Set<string>();
	for (let i = 0; i < value.length && result.length < 1_000; i++) {
		const raw = value[i];
		if (!isRecord(raw)) continue;
		const id = sanitizeId(raw.id, 'meal', i, usedIds);
		const date = clampString(raw.date, 50);
		const slot = clampString(raw.slot, 100, 'Dinner');
		const recipeId = clampString(raw.recipeId, 100);
		const servings = clampNumber(raw.servings, 1, 10_000, 2);
		const completedAt =
			typeof raw.completedAt === 'string' && raw.completedAt.trim()
				? raw.completedAt.trim().slice(0, 50)
				: undefined;
		const parsedLeftovers = parseFiniteNumber(raw.leftoverServings);
		const leftoverServings =
			parsedLeftovers !== undefined ? Math.min(10_000, Math.max(0, parsedLeftovers)) : undefined;
		const sample = typeof raw.sample === 'boolean' ? raw.sample : undefined;
		result.push({
			id,
			date,
			slot,
			recipeId,
			servings,
			...(completedAt !== undefined ? { completedAt } : {}),
			...(leftoverServings !== undefined ? { leftoverServings } : {}),
			...(sample !== undefined ? { sample } : {})
		});
	}
	return result;
}

function sanitizeShopping(value: unknown, fallback: ShoppingItem[]): ShoppingItem[] {
	if (!Array.isArray(value)) return structuredClone(fallback);
	const result: ShoppingItem[] = [];
	const usedIds = new Set<string>();
	for (let i = 0; i < value.length && result.length < 1_000; i++) {
		const raw = value[i];
		if (!isRecord(raw)) continue;
		const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : '';
		if (!name) continue;
		const id = sanitizeId(raw.id, 'shopping', i, usedIds);
		const quantity = clampNumber(raw.quantity, 0, 1_000_000, 0);
		const unit = (typeof raw.unit === 'string' ? raw.unit.trim().slice(0, 40) : '') || 'piece';
		const checked = Boolean(raw.checked);
		const sourceKey =
			typeof raw.sourceKey === 'string' && raw.sourceKey.trim()
				? raw.sourceKey.trim().slice(0, 200)
				: undefined;
		result.push({
			id,
			name,
			quantity,
			unit,
			checked,
			...(sourceKey !== undefined ? { sourceKey } : {})
		});
	}
	return result;
}

function sanitizePreferences(value: unknown, fallback: Preferences): Preferences {
	if (!isRecord(value)) return structuredClone(fallback);
	const diet = clampString(value.diet, 200, fallback.diet);
	const allergies = clampString(value.allergies, 2_000, fallback.allergies);
	const maxTime = clampNumber(value.maxTime, 0, 100_000, fallback.maxTime);
	const complexity = clampString(value.complexity, 100, fallback.complexity);
	const cuisines = Array.isArray(value.cuisines)
		? value.cuisines
				.filter((item): item is string => typeof item === 'string')
				.map((item) => item.trim().slice(0, 80))
				.filter(Boolean)
				.slice(0, 8)
		: undefined;
	const onboardingStatus =
		value.onboardingStatus === 'completed' || value.onboardingStatus === 'skipped'
			? value.onboardingStatus
			: undefined;
	const theme =
		typeof value.theme === 'string' && value.theme.trim()
			? value.theme.trim().slice(0, 100)
			: fallback.theme;
	const dark = typeof value.dark === 'boolean' ? value.dark : fallback.dark;
	const provider = clampString(value.provider, 100, fallback.provider);
	const rawChatgptAccountId =
		typeof value.chatgptAccountId === 'string' && value.chatgptAccountId
			? value.chatgptAccountId.slice(0, 100)
			: undefined;
	const isHostAccount = rawChatgptAccountId === HOST_CONNECTION_ID;
	const chatgptAccountId = isHostAccount ? undefined : rawChatgptAccountId;
	const model =
		isHostAccount && provider === 'chatgpt' ? '' : clampString(value.model, 200, fallback.model);
	const usePersonalAI = typeof value.usePersonalAI === 'boolean' ? value.usePersonalAI : undefined;

	let reasoning: Preferences['reasoning'] | undefined;
	if (isRecord(value.reasoning)) {
		const effort =
			typeof value.reasoning.effort === 'string' && /^[a-z_]{1,24}$/.test(value.reasoning.effort)
				? value.reasoning.effort
				: undefined;
		const enabled =
			typeof value.reasoning.enabled === 'boolean' ? value.reasoning.enabled : undefined;
		const parsedBudget = parseFiniteNumber(value.reasoning.budgetTokens);
		const budgetTokens =
			parsedBudget !== undefined
				? Math.min(32_768, Math.max(0, Math.round(parsedBudget)))
				: undefined;
		if (effort !== undefined || enabled !== undefined || budgetTokens !== undefined) {
			reasoning = {
				...(effort !== undefined ? { effort } : {}),
				...(enabled !== undefined ? { enabled } : {}),
				...(budgetTokens !== undefined ? { budgetTokens } : {})
			};
		}
	}

	let ratings: Record<string, number> | undefined;
	if (isRecord(value.ratings)) {
		ratings = {};
		for (const [rawKey, rawScore] of Object.entries(value.ratings)) {
			const key = rawKey.trim().slice(0, 100);
			const parsed = parseFiniteNumber(rawScore);
			if (!key || parsed === undefined) continue;
			ratings[key] = Math.min(5, Math.max(0, parsed));
		}
	}

	return {
		diet,
		allergies,
		maxTime,
		complexity,
		...(cuisines !== undefined ? { cuisines } : {}),
		...(onboardingStatus !== undefined ? { onboardingStatus } : {}),
		theme,
		dark,
		provider,
		model,
		...(reasoning !== undefined ? { reasoning } : {}),
		...(chatgptAccountId !== undefined ? { chatgptAccountId } : {}),
		...(usePersonalAI !== undefined ? { usePersonalAI } : {}),
		...(ratings !== undefined ? { ratings } : {})
	};
}

/** Clamp a guest or client kitchen snapshot to match server persistence bounds. */
export function sanitizeKitchenState(value: unknown): AppState {
	if (!isRecord(value)) return createInitialState();
	const defaults = createInitialState();
	return {
		pantry: sanitizePantry(value.pantry, defaults.pantry),
		recipes: sanitizeRecipes(value.recipes, defaults.recipes),
		meals: sanitizeMeals(value.meals, defaults.meals),
		shopping: sanitizeShopping(value.shopping, defaults.shopping),
		preferences: sanitizePreferences(value.preferences, defaultPreferences)
	};
}

/**
 * Carry sanitized guest edits into a newly registered account, keeping them staged
 * locally in the pending journal when initial synchronization fails offline.
 */
export async function migrateGuestKitchenOnSignup(options: {
	guestState: unknown;
	loadInitialState: () => Promise<{ state: AppState | null; etag: string }>;
	adoptBaseline: (baseline: AppState, etag: string) => void;
	stage: (state: AppState) => void;
	sync: () => Promise<void>;
	hasPendingFailure: () => boolean;
}): Promise<{ state: AppState; synced: boolean }> {
	const sanitized = sanitizeKitchenState(options.guestState);
	let loadedBaseline = false;
	try {
		const initial = await options.loadInitialState();
		options.adoptBaseline(
			sanitizeKitchenState(initial.state || createNewUserState()),
			initial.etag
		);
		loadedBaseline = true;
	} catch {
		options.adoptBaseline(createNewUserState(), '');
	}
	options.stage(sanitized);
	if (!loadedBaseline) {
		return { state: sanitized, synced: false };
	}
	try {
		await options.sync();
	} catch {
		return { state: sanitized, synced: false };
	}
	return { state: sanitized, synced: !options.hasPendingFailure() };
}
