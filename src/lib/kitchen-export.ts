import { HOST_CONNECTION_ID } from '#lib/ai-connections.ts';
import { createNewUserState } from '#lib/data.ts';
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

export type KitchenExportFallbackReason =
	'offline' | 'session-expired' | 'timeout' | 'network-error' | 'invalid-server-state';

export class KitchenExportError extends Error {
	readonly reason: KitchenExportFallbackReason;
	readonly status?: number;

	constructor(reason: KitchenExportFallbackReason, message: string, status?: number) {
		super(message);
		this.name = 'KitchenExportError';
		this.reason = reason;
		if (status !== undefined) this.status = status;
	}
}

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
	fetcher?: typeof fetch;
	fetchAccountExport?: (signal?: AbortSignal) => Promise<ServerExportPayload | null>;
	timeoutMs?: number;
	maxAttempts?: number;
	now?: Date;
};

export type KitchenExportResult = {
	envelope: KitchenExportEnvelope;
	json: string;
	filename: string;
	notice: string;
	fallbackReason?: KitchenExportFallbackReason;
};

export const KITCHEN_EXPORT_FILENAME = 'flavorithm-kitchen.json';
export const ACCOUNT_EXPORT_TIMEOUT_MS = 30_000;
export const ACCOUNT_EXPORT_MAX_ATTEMPTS = 2;

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidAppState(value: unknown): value is AppState {
	if (!isRecordObject(value)) return false;
	const candidate = value as Partial<AppState>;
	if (
		!Array.isArray(candidate.pantry) ||
		!Array.isArray(candidate.recipes) ||
		!Array.isArray(candidate.meals) ||
		!Array.isArray(candidate.shopping) ||
		!isRecordObject(candidate.preferences)
	) {
		return false;
	}
	const prefs = candidate.preferences as Partial<Preferences>;
	return (
		typeof prefs.diet === 'string' &&
		typeof prefs.allergies === 'string' &&
		typeof prefs.maxTime === 'number' &&
		Number.isFinite(prefs.maxTime) &&
		typeof prefs.complexity === 'string' &&
		typeof prefs.theme === 'string' &&
		typeof prefs.dark === 'boolean' &&
		typeof prefs.provider === 'string' &&
		typeof prefs.model === 'string' &&
		candidate.pantry.every(isRecordObject) &&
		candidate.recipes.every(isRecordObject) &&
		candidate.meals.every(isRecordObject) &&
		candidate.shopping.every(isRecordObject)
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
	const isHostAccount = preferences.chatgptAccountId === HOST_CONNECTION_ID;
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
		model: isHostAccount && preferences.provider === 'chatgpt' ? '' : preferences.model
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
	if (typeof preferences.chatgptAccountId === 'string' && !isHostAccount) {
		sanitized.chatgptAccountId = preferences.chatgptAccountId;
	}
	if (typeof preferences.usePersonalAI === 'boolean') {
		sanitized.usePersonalAI = preferences.usePersonalAI;
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

function safeReadPendingJournal(storage: StorageReader | null | undefined, user: User) {
	if (!storage) return { records: [], error: '' };
	try {
		return readPendingJournal(storage, user);
	} catch {
		return { records: [], error: '' };
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

	const journal = safeReadPendingJournal(options.storage, user);
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

export function exportFallbackNotice(reason: KitchenExportFallbackReason): string {
	switch (reason) {
		case 'offline':
			return 'Offline device kitchen data exported as a local backup.';
		case 'session-expired':
			return 'Your session expired, so device kitchen data was exported. Sign in again to include account data.';
		case 'timeout':
			return 'The server took too long to respond, so device kitchen data was exported as a local backup.';
		case 'invalid-server-state':
			return 'Server account data could not be verified, so device kitchen data was exported as a local backup.';
		case 'network-error':
			return 'Could not reach the server, so device kitchen data was exported as a local backup.';
	}
}

export function exportNoticeForSource(
	source: KitchenExportSource,
	fallbackReason: KitchenExportFallbackReason = 'offline'
): string {
	switch (source) {
		case 'guest':
			return 'Guest kitchen data exported from this browser.';
		case 'offline':
			return exportFallbackNotice(fallbackReason);
		case 'account':
			return 'Merged account and kitchen data exported.';
	}
}

export function serializeKitchenExport(
	envelope: KitchenExportEnvelope,
	fallbackReason: KitchenExportFallbackReason = 'offline'
): KitchenExportResult {
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
		notice: exportNoticeForSource(normalized.source, fallbackReason),
		...(normalized.source === 'offline' ? { fallbackReason } : {})
	};
}

function isTimeoutError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== 'object') return false;
	const name = (error as { name?: unknown }).name;
	const code = (error as { code?: unknown }).code;
	return name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT';
}

function classifyExportError(error: unknown): KitchenExportFallbackReason {
	if (error instanceof KitchenExportError) return error.reason;
	if (typeof Response !== 'undefined' && error instanceof Response) {
		if (error.status === 401 || error.status === 403) return 'session-expired';
		if (error.status === 408) return 'timeout';
	}
	const status =
		error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
			? (error as { status: number }).status
			: undefined;
	if (status === 401 || status === 403) return 'session-expired';
	if (status === 408 || isTimeoutError(error)) return 'timeout';
	if (error instanceof Error) {
		const lower = error.message.toLowerCase();
		if (
			/\b(?:401|403)\b/.test(lower) ||
			lower.includes('authentication required') ||
			lower.includes('session expired') ||
			lower.includes('unauthorized')
		) {
			return 'session-expired';
		}
		if (lower.includes('timed out') || lower.includes('timeout')) {
			return 'timeout';
		}
	}
	return 'network-error';
}

function createExportTimeout(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
	}, timeoutMs);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer)
	};
}

/**
 * Fetch `GET /api/export` with a 30s timeout and one retry on timeouts or transient server/network
 * failures while refusing to retry expired sessions or auth redirects.
 */
export async function fetchAccountExportPayload(
	fetcher: typeof fetch,
	options?: {
		timeoutMs?: number;
		maxAttempts?: number;
	}
): Promise<ServerExportPayload> {
	const timeoutMs =
		options?.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: ACCOUNT_EXPORT_TIMEOUT_MS;
	const maxAttempts =
		options?.maxAttempts && Number.isInteger(options.maxAttempts) && options.maxAttempts >= 1
			? options.maxAttempts
			: ACCOUNT_EXPORT_MAX_ATTEMPTS;

	let lastError: KitchenExportError | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const timeout = createExportTimeout(timeoutMs);
		const { signal } = timeout;
		try {
			let response: Response;
			try {
				response = await fetcher('/api/export', {
					headers: { Accept: 'application/json' },
					redirect: 'manual',
					signal
				});
			} catch (error) {
				const timedOut = isTimeoutError(error, signal);
				lastError = new KitchenExportError(
					timedOut ? 'timeout' : 'network-error',
					timedOut ? 'Account export request timed out' : 'Could not reach account export endpoint'
				);
				if (attempt < maxAttempts) continue;
				throw lastError;
			}

			if (
				response.status === 401 ||
				response.status === 403 ||
				response.type === 'opaqueredirect' ||
				response.redirected ||
				(response.status >= 300 && response.status < 400)
			) {
				throw new KitchenExportError(
					'session-expired',
					`Authentication required (${response.status || 401})`,
					response.status || 401
				);
			}

			if (response.status === 408 || response.status === 429 || response.status >= 500) {
				lastError = new KitchenExportError(
					response.status === 408 ? 'timeout' : 'network-error',
					`Export endpoint returned ${response.status}`,
					response.status
				);
				if (attempt < maxAttempts) continue;
				throw lastError;
			}

			if (!response.ok) {
				throw new KitchenExportError(
					'network-error',
					`Export endpoint returned ${response.status}`,
					response.status
				);
			}

			try {
				return (await response.json()) as ServerExportPayload;
			} catch (error) {
				if (isTimeoutError(error, signal)) {
					lastError = new KitchenExportError('timeout', 'Reading account export timed out');
					if (attempt < maxAttempts) continue;
					throw lastError;
				}
				throw new KitchenExportError(
					'invalid-server-state',
					'Account export returned invalid JSON'
				);
			}
		} finally {
			timeout.clear();
		}
	}

	throw lastError ?? new KitchenExportError('network-error', 'Account export failed');
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

	const accountLoader =
		options.fetchAccountExport ??
		(options.fetcher
			? () =>
					fetchAccountExportPayload(options.fetcher!, {
						timeoutMs: options.timeoutMs,
						maxAttempts: options.maxAttempts
					})
			: undefined);

	if (!isOnline || !accountLoader) {
		return serializeKitchenExport(
			{
				exportedAt,
				source: 'offline',
				hasPendingChanges: resolved.hasQueuedChanges,
				user: clientUser,
				state: resolved.state
			},
			'offline'
		);
	}

	try {
		let serverPayload: ServerExportPayload | null = null;
		if (options.fetchAccountExport) {
			const attempts =
				options.maxAttempts && Number.isInteger(options.maxAttempts) && options.maxAttempts >= 1
					? options.maxAttempts
					: 1;
			let lastAttemptError: unknown;
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				const timeout =
					options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
						? createExportTimeout(options.timeoutMs)
						: undefined;
				const signal = timeout?.signal;
				try {
					serverPayload = await options.fetchAccountExport(signal);
					lastAttemptError = undefined;
					break;
				} catch (error) {
					lastAttemptError = isTimeoutError(error, signal)
						? new KitchenExportError('timeout', 'Account export request timed out')
						: error;
					const reason = classifyExportError(lastAttemptError);
					if (reason === 'session-expired' || attempt >= attempts) {
						throw lastAttemptError;
					}
				} finally {
					timeout?.clear();
				}
			}
		} else {
			serverPayload = await accountLoader();
		}

		if (!serverPayload || typeof serverPayload !== 'object') {
			throw new KitchenExportError('invalid-server-state', 'Missing server export payload');
		}
		const confirmedUser =
			serverPayload.user !== undefined ? sanitizeExportUser(serverPayload.user) : clientUser;
		if (
			!confirmedUser ||
			confirmedUser.id !== clientUser.id ||
			confirmedUser.householdId !== clientUser.householdId
		) {
			throw new KitchenExportError('invalid-server-state', 'Server export identity mismatch');
		}

		if (!isValidAppState(serverPayload.state)) {
			throw new KitchenExportError(
				'invalid-server-state',
				'Server export state is missing or invalid'
			);
		}
		const serverState = sanitizeKitchenState(serverPayload.state);

		const mergeBase =
			resolved.baseline ?? (resolved.hasQueuedChanges ? createNewUserState() : null);
		const mergedState = mergeBase
			? sanitizeKitchenState(
					mergeKitchenStates(mergeBase, resolved.state, serverState, 'local').state
				)
			: serverState;

		return serializeKitchenExport({
			exportedAt,
			source: 'account',
			hasPendingChanges: resolved.hasQueuedChanges,
			user: confirmedUser,
			state: mergedState
		});
	} catch (error) {
		const fallbackReason = classifyExportError(error);
		return serializeKitchenExport(
			{
				exportedAt,
				source: 'offline',
				hasPendingChanges: resolved.hasQueuedChanges,
				user: clientUser,
				state: resolved.state
			},
			fallbackReason
		);
	}
}
