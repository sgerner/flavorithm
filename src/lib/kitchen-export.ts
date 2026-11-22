import {
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	type PendingKitchen
} from '#lib/offline-sync.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

type StorageReader = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
	Partial<Pick<Storage, 'key' | 'length'>>;

export type KitchenExportSource = 'guest' | 'offline' | 'account';

export type KitchenExportEnvelope = {
	exportedAt: string;
	source: KitchenExportSource;
	hasPendingChanges: boolean;
	user?: User;
	state: AppState;
};

export type ServerExportPayload = {
	exportedAt?: string;
	user?: User | null;
	state?: AppState | null;
};

export type KitchenExportOptions = {
	state: AppState;
	user?: User | null;
	online?: boolean;
	pendingSnapshot?: PendingKitchen | null;
	hasPendingSync?: boolean;
	storage?: StorageReader | null;
	fetchAccountExport?: () => Promise<ServerExportPayload | null>;
	now?: Date;
};

export type KitchenExportResult = {
	envelope: KitchenExportEnvelope;
	json: string;
	filename: string;
	notice: string;
};

export const KITCHEN_EXPORT_FILENAME = 'flavorithm-kitchen.json';

function isValidAppState(value: unknown): value is AppState {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<AppState>;
	return (
		Array.isArray(candidate.pantry) &&
		Array.isArray(candidate.recipes) &&
		Array.isArray(candidate.meals) &&
		Array.isArray(candidate.shopping) &&
		Boolean(candidate.preferences) &&
		typeof candidate.preferences === 'object'
	);
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (!deepEqual(left[index], right[index])) return false;
		}
		return true;
	}
	if (typeof left === 'object' && typeof right === 'object') {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
		const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
		if (leftKeys.length !== rightKeys.length) return false;
		for (const key of leftKeys) {
			if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
			if (!deepEqual(leftRecord[key], rightRecord[key])) return false;
		}
		return true;
	}
	return false;
}

/** Allowlist public user fields so session or credential internals never enter exports. */
export function sanitizeExportUser(user: User | null | undefined): User | undefined {
	if (!user || typeof user !== 'object') return undefined;
	if (
		typeof user.id !== 'string' ||
		typeof user.name !== 'string' ||
		typeof user.email !== 'string' ||
		typeof user.householdId !== 'string'
	) {
		return undefined;
	}
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		householdId: user.householdId,
		...(typeof user.emailVerified === 'boolean' ? { emailVerified: user.emailVerified } : {})
	};
}

function sanitizePreferences(preferences: Preferences): Preferences {
	const sanitized: Preferences = {
		diet: preferences.diet,
		allergies: preferences.allergies,
		maxTime: preferences.maxTime,
		complexity: preferences.complexity,
		...(Array.isArray(preferences.cuisines) ? { cuisines: [...preferences.cuisines] } : {}),
		...(preferences.onboardingStatus === 'completed' || preferences.onboardingStatus === 'skipped'
			? { onboardingStatus: preferences.onboardingStatus }
			: {}),
		theme: preferences.theme,
		dark: Boolean(preferences.dark),
		provider: preferences.provider,
		model: preferences.model
	};
	if (preferences.reasoning && typeof preferences.reasoning === 'object') {
		const reasoning: NonNullable<Preferences['reasoning']> = {
			...(typeof preferences.reasoning.effort === 'string'
				? { effort: preferences.reasoning.effort }
				: {}),
			...(typeof preferences.reasoning.enabled === 'boolean'
				? { enabled: preferences.reasoning.enabled }
				: {}),
			...(typeof preferences.reasoning.budgetTokens === 'number'
				? { budgetTokens: preferences.reasoning.budgetTokens }
				: {})
		};
		if (Object.keys(reasoning).length > 0) sanitized.reasoning = reasoning;
	}
	if (preferences.ratings && typeof preferences.ratings === 'object') {
		const ratings: Record<string, number> = {};
		for (const [recipeId, score] of Object.entries(preferences.ratings)) {
			if (typeof score === 'number' && Number.isFinite(score)) ratings[recipeId] = score;
		}
		sanitized.ratings = ratings;
	}
	if (typeof preferences.chatgptAccountId === 'string') {
		sanitized.chatgptAccountId = preferences.chatgptAccountId;
	}
	return sanitized;
}

/** Deep-clone kitchen collections and strip any transient provider API keys or secrets. */
export function sanitizeKitchenState(state: AppState): AppState {
	return {
		pantry: structuredClone(state.pantry),
		recipes: structuredClone(state.recipes),
		meals: structuredClone(state.meals),
		shopping: structuredClone(state.shopping),
		preferences: sanitizePreferences(state.preferences)
	};
}

function readConfirmedBaseline(storage: StorageReader, user: User): AppState | null {
	try {
		const key = `flavorithm-confirmed:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(user.householdId)}`;
		const parsed = JSON.parse(storage.getItem(key) || 'null');
		if (
			parsed?.userId === user.id &&
			parsed?.householdId === user.householdId &&
			isValidAppState(parsed.state)
		) {
			return sanitizeKitchenState(parsed.state);
		}
		return null;
	} catch {
		return null;
	}
}

export function resolveClientKitchenState(options: {
	state: AppState;
	user?: User | null;
	pendingSnapshot?: PendingKitchen | null;
	hasPendingSync?: boolean;
	storage?: StorageReader | null;
}): {
	state: AppState;
	baseline: AppState | null;
	hasQueuedChanges: boolean;
} {
	const activeState = sanitizeKitchenState(options.state);
	const user = sanitizeExportUser(options.user);
	if (!user) {
		return {
			state: activeState,
			baseline: null,
			hasQueuedChanges: false
		};
	}

	const validSnapshot =
		options.pendingSnapshot &&
		options.pendingSnapshot.userId === user.id &&
		options.pendingSnapshot.householdId === user.householdId &&
		isValidAppState(options.pendingSnapshot.base) &&
		isValidAppState(options.pendingSnapshot.local)
			? options.pendingSnapshot
			: null;

	const journal = options.storage
		? readPendingJournal(options.storage, user)
		: { records: [], error: '' };
	const confirmedBaseline = options.storage ? readConfirmedBaseline(options.storage, user) : null;

	const baseState = validSnapshot
		? sanitizeKitchenState(validSnapshot.base)
		: journal.records.length > 0
			? sanitizeKitchenState(journal.records[0].pending.base)
			: confirmedBaseline;

	let queuedState: AppState | null = null;
	if (journal.records.length > 0 && baseState) {
		queuedState = sanitizeKitchenState(
			mergePendingKitchenJournal(journal.records, baseState, 'local').state
		);
	}
	if (validSnapshot && baseState) {
		const snapshotLocal = sanitizeKitchenState(validSnapshot.local);
		queuedState = queuedState
			? sanitizeKitchenState(
					mergeKitchenStates(baseState, snapshotLocal, queuedState, 'local').state
				)
			: snapshotLocal;
	}

	const mergedLocal =
		baseState && queuedState
			? sanitizeKitchenState(mergeKitchenStates(baseState, activeState, queuedState, 'local').state)
			: activeState;

	const hasQueuedChanges =
		Boolean(validSnapshot && !deepEqual(sanitizeKitchenState(validSnapshot.base), mergedLocal)) ||
		Boolean(journal.records.length > 0 && baseState && !deepEqual(baseState, mergedLocal)) ||
		Boolean(options.hasPendingSync);

	return {
		state: mergedLocal,
		baseline: baseState,
		hasQueuedChanges
	};
}

export function exportNoticeForSource(source: KitchenExportSource): string {
	switch (source) {
		case 'guest':
			return 'Guest kitchen data exported from this browser.';
		case 'offline':
			return 'Offline device kitchen data exported as a local backup.';
		case 'account':
			return 'Merged account and kitchen data exported.';
	}
}

export function serializeKitchenExport(envelope: KitchenExportEnvelope): KitchenExportResult {
	const sanitizedUser = sanitizeExportUser(envelope.user);
	const normalized: KitchenExportEnvelope = {
		exportedAt: envelope.exportedAt,
		source: envelope.source,
		hasPendingChanges: Boolean(envelope.hasPendingChanges),
		...(sanitizedUser ? { user: sanitizedUser } : {}),
		state: sanitizeKitchenState(envelope.state)
	};
	return {
		envelope: normalized,
		json: JSON.stringify(normalized, null, 2),
		filename: KITCHEN_EXPORT_FILENAME,
		notice: exportNoticeForSource(normalized.source)
	};
}

/**
 * Build a unified JSON export across guest sessions, offline signed-in sessions, and online
 * signed-in sessions with or without pending local edits.
 */
export async function exportKitchenArchive(
	options: KitchenExportOptions
): Promise<KitchenExportResult> {
	const exportedAt = (options.now ?? new Date()).toISOString();
	const clientUser = sanitizeExportUser(options.user);
	if (!clientUser) {
		return serializeKitchenExport({
			exportedAt,
			source: 'guest',
			hasPendingChanges: false,
			state: options.state
		});
	}

	const resolved = resolveClientKitchenState({
		state: options.state,
		user: clientUser,
		pendingSnapshot: options.pendingSnapshot,
		hasPendingSync: options.hasPendingSync,
		storage: options.storage
	});

	const isOnline =
		options.online ?? (typeof navigator === 'undefined' ? true : Boolean(navigator.onLine));

	if (!isOnline || !options.fetchAccountExport) {
		return serializeKitchenExport({
			exportedAt,
			source: 'offline',
			hasPendingChanges: resolved.hasQueuedChanges,
			user: clientUser,
			state: resolved.state
		});
	}

	try {
		const serverPayload = await options.fetchAccountExport();
		if (!serverPayload || typeof serverPayload !== 'object') {
			throw new Error('Missing server export payload');
		}
		const confirmedUser = serverPayload.user ? sanitizeExportUser(serverPayload.user) : clientUser;
		if (
			!confirmedUser ||
			confirmedUser.id !== clientUser.id ||
			confirmedUser.householdId !== clientUser.householdId
		) {
			throw new Error('Server export identity mismatch');
		}

		const serverState = isValidAppState(serverPayload.state)
			? sanitizeKitchenState(serverPayload.state)
			: null;
		const mergedState =
			serverState && resolved.baseline
				? sanitizeKitchenState(
						mergeKitchenStates(resolved.baseline, resolved.state, serverState, 'local').state
					)
				: resolved.state;

		const hasPendingChanges =
			resolved.hasQueuedChanges || Boolean(serverState && !deepEqual(mergedState, serverState));

		return serializeKitchenExport({
			exportedAt,
			source: 'account',
			hasPendingChanges,
			user: confirmedUser,
			state: mergedState
		});
	} catch {
		return serializeKitchenExport({
			exportedAt,
			source: 'offline',
			hasPendingChanges: resolved.hasQueuedChanges,
			user: clientUser,
			state: resolved.state
		});
	}
}
