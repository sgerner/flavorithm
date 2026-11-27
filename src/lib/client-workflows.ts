import {
	HOST_CONNECTION_ID,
	type ConnectionModel,
	type ConnectionProvider
} from '#lib/ai-connections.ts';
import { createNewUserState, defaultPreferences } from '#lib/data.ts';
import { sanitizeKitchenState } from '#lib/guest-storage.ts';
import { clearSampleData, hasSampleData } from '#lib/kitchen-workflows.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

type StarterStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type ChatGPTAccountSummary = {
	id: string;
	connected: boolean;
	planEnabled: boolean;
};

export type ChatGPTConnectionSummary = {
	host?: { model: string } | null;
	accounts: ChatGPTAccountSummary[];
};

export type SettledValue<T> =
	{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

function settle<T>(promise: Promise<T>): Promise<SettledValue<T>> {
	return promise.then(
		(value) => ({ status: 'fulfilled' as const, value }),
		(reason) => ({ status: 'rejected' as const, reason })
	);
}

/** Reconcile saved AI preferences against the latest server ChatGPT connection status. */
export function reconcileChatGPTPreferences(
	preferences: Preferences,
	chatGPT: ChatGPTConnectionSummary
): void {
	const personalAccounts = chatGPT.accounts.filter((account) => account.id !== HOST_CONNECTION_ID);
	if (preferences.chatgptAccountId === HOST_CONNECTION_ID) {
		preferences.chatgptAccountId = undefined;
		if (preferences.provider === 'chatgpt') preferences.model = '';
	}
	if (
		personalAccounts.length &&
		(preferences.provider === 'chatgpt' || preferences.chatgptAccountId) &&
		!personalAccounts.some((account) => account.id === preferences.chatgptAccountId)
	) {
		preferences.chatgptAccountId =
			personalAccounts.find((account) => account.connected && account.planEnabled)?.id ||
			personalAccounts[0]?.id;
	} else if (!personalAccounts.length && preferences.chatgptAccountId) {
		preferences.chatgptAccountId = undefined;
	}
}

const fallbackNotifiedUsers = new Set<string>();

/** True when a user has saved non-default personal AI settings beyond starter defaults or sanitized host state. */
export function hasSavedPersonalAIConfig(
	preferences: Pick<Preferences, 'provider' | 'model' | 'chatgptAccountId' | 'reasoning'>,
	chatGPT?: ChatGPTConnectionSummary
): boolean {
	if (preferences.chatgptAccountId && preferences.chatgptAccountId !== HOST_CONNECTION_ID) {
		return true;
	}
	if (
		preferences.provider === 'chatgpt' &&
		chatGPT?.accounts.some((account) => account.id !== HOST_CONNECTION_ID && account.connected)
	) {
		return true;
	}
	if (
		preferences.provider !== defaultPreferences.provider &&
		!(preferences.provider === 'chatgpt' && !preferences.model)
	) {
		return true;
	}
	if (preferences.model && preferences.model !== defaultPreferences.model) {
		return true;
	}
	return Boolean(
		preferences.reasoning &&
		(preferences.reasoning.effort !== undefined ||
			preferences.reasoning.enabled !== undefined ||
			preferences.reasoning.budgetTokens !== undefined)
	);
}

/** True when Host AI is active and an existing user with saved personal AI settings has no explicit usePersonalAI choice yet. */
export function shouldNotifyHostAIDefault(
	preferences: Pick<
		Preferences,
		'provider' | 'model' | 'chatgptAccountId' | 'reasoning' | 'usePersonalAI'
	>,
	chatGPT: ChatGPTConnectionSummary
): boolean {
	return (
		Boolean(chatGPT.host) &&
		preferences.usePersonalAI === undefined &&
		hasSavedPersonalAIConfig(preferences, chatGPT)
	);
}

/** Record and return true once per user when Host AI becomes the default over a saved personal AI configuration. */
export function consumeHostAIDefaultNotice(options: {
	userId: string;
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	preferences: Pick<
		Preferences,
		'provider' | 'model' | 'chatgptAccountId' | 'reasoning' | 'usePersonalAI'
	>;
	chatGPT: ChatGPTConnectionSummary;
}): boolean {
	if (!options.userId || !shouldNotifyHostAIDefault(options.preferences, options.chatGPT)) {
		return false;
	}
	const key = `flavorithm-host-ai-notice:${options.userId}:v1`;
	if (!options.storage) {
		if (fallbackNotifiedUsers.has(options.userId)) return false;
		fallbackNotifiedUsers.add(options.userId);
		return true;
	}
	try {
		if (options.storage.getItem(key) === '1') return false;
		options.storage.setItem(key, '1');
		return true;
	} catch {
		if (fallbackNotifiedUsers.has(options.userId)) return false;
		fallbackNotifiedUsers.add(options.userId);
		return true;
	}
}

/** Return the selected ChatGPT account ID only when ChatGPT plan inference is active and entitled. */
export function entitledChatGPTAccountId(
	preferences: Pick<Preferences, 'provider' | 'chatgptAccountId' | 'usePersonalAI'>,
	accounts: ChatGPTAccountSummary[],
	host?: { model: string } | null
): string | null {
	if (host && !preferences.usePersonalAI) return null;
	const accountId = preferences.chatgptAccountId;
	if (preferences.provider !== 'chatgpt' || !accountId || accountId === HOST_CONNECTION_ID) {
		return null;
	}
	const account = accounts.find((candidate) => candidate.id === accountId);
	return account?.connected && account.planEnabled ? accountId : null;
}

/**
 * Hydrate a signed-in session after GET /api/auth confirms the user:
 * - Fetches /api/state and (unless returning from ChatGPT OAuth) /api/connections/chatgpt in parallel.
 * - Adopts the kitchen before reconciling ChatGPT preferences so adopted preferences are never overwritten.
 * - Skips a duplicate connections check when returnFromChatGPT delegates to openSettings().
 */
export async function runSignedInHydration<TState, TConnections>(options: {
	returnFromChatGPT: boolean;
	fetchState: () => Promise<TState>;
	fetchConnections: () => Promise<TConnections>;
	adoptState: (saved: TState) => void;
	openSettings: () => Promise<void>;
	onConnections: (result: TConnections) => void;
	onConnectionsError: (error: unknown) => void;
}): Promise<void> {
	const connectionsTask = options.returnFromChatGPT ? null : settle(options.fetchConnections());
	const saved = await options.fetchState();
	options.adoptState(saved);
	if (options.returnFromChatGPT) {
		await options.openSettings();
		return;
	}
	if (!connectionsTask) return;
	const connections = await connectionsTask;
	if (connections.status === 'fulfilled') options.onConnections(connections.value);
	else options.onConnectionsError(connections.reason);
}

/**
 * Overlap model catalog loading with an optional connections refresh. If refreshConnections
 * changes chatgptAccountId or enables an unqueried activeChatGPTAccount, immediately fetch
 * entitled ChatGPT models for that account before completing catalog loading.
 */
export async function runConcurrentModelCatalog(options: {
	connectionsTask?: Promise<void>;
	isCurrent: () => boolean;
	getEntitledAccountId: () => string | null;
	fetchPublicCatalog: () => Promise<{ providers: ConnectionProvider[] }>;
	fetchAccountCatalog: (
		accountId: string
	) => Promise<{ providers: Array<{ models: ConnectionModel[] }> }>;
	onResult: (result: {
		catalog: SettledValue<{ providers: ConnectionProvider[] }>;
		account: SettledValue<{ providers: Array<{ models: ConnectionModel[] }> } | null>;
	}) => void;
}): Promise<void> {
	const initialAccountId = options.getEntitledAccountId();
	const catalogTask = settle(options.fetchPublicCatalog());
	let accountTask: Promise<
		SettledValue<{ providers: Array<{ models: ConnectionModel[] }> } | null>
	> | null = initialAccountId ? settle(options.fetchAccountCatalog(initialAccountId)) : null;
	let connectionError: unknown = null;
	let hasConnectionError = false;

	if (options.connectionsTask) {
		const connResult = await settle(options.connectionsTask);
		if (!options.isCurrent()) return;
		if (connResult.status === 'rejected') {
			hasConnectionError = true;
			connectionError = connResult.reason;
		} else {
			const nextAccountId = options.getEntitledAccountId();
			if (nextAccountId && nextAccountId !== initialAccountId) {
				accountTask = settle(options.fetchAccountCatalog(nextAccountId));
			} else if (!nextAccountId) {
				accountTask = null;
			}
		}
	}

	const [catalog, account] = await Promise.all([
		catalogTask,
		accountTask ?? Promise.resolve({ status: 'fulfilled' as const, value: null })
	]);
	if (!options.isCurrent()) return;
	options.onResult({ catalog, account });
	if (hasConnectionError) throw connectionError;
}

/**
 * Run refreshAuth, refreshConnections, and loadModelCatalog concurrently when opening Settings
 * for a signed-in user, while handling identity changes or offline auth errors cleanly.
 */
export async function runOpenSettingsWorkflow(options: {
	initialUserId: string | null;
	getCurrentUserId: () => string | null;
	refreshAuth: () => Promise<{ stateLoaded?: boolean }>;
	loadConnectionsAndCatalog: () => Promise<void>;
	onReadyToFocus?: () => Promise<void>;
	onAuthError?: (error: unknown) => void;
	onError: (error: unknown) => void;
}): Promise<void> {
	const authTask = settle(options.refreshAuth());
	const initialCatalogTask = options.initialUserId
		? settle(options.loadConnectionsAndCatalog())
		: null;

	if (options.onReadyToFocus) {
		await options.onReadyToFocus();
	}

	const authResult = await authTask;
	if (authResult.status === 'rejected') {
		options.onAuthError?.(authResult.reason);
	}
	const currentUserId = options.getCurrentUserId();
	if (!currentUserId) return;

	const authReloadedState =
		authResult.status === 'fulfilled' && Boolean(authResult.value.stateLoaded);
	if (!initialCatalogTask || authReloadedState || currentUserId !== options.initialUserId) {
		if (options.onReadyToFocus) {
			await options.onReadyToFocus();
		}
		try {
			await options.loadConnectionsAndCatalog();
		} catch (error) {
			if (options.getCurrentUserId()) options.onError(error);
		}
		return;
	}

	const catalogResult = await initialCatalogTask;
	if (catalogResult.status === 'rejected' && options.getCurrentUserId() === options.initialUserId) {
		options.onError(catalogResult.reason);
	}
}

/**
 * Execute a household join or leave transition, skipping duplicate /api/state when refreshAuth
 * already adopted the new household kitchen and applying roster fields from POST /api/household.
 */
export async function runHouseholdTransition<
	TRoster extends {
		members?: unknown[];
		invites?: unknown[];
		canManage?: boolean;
	},
	TState
>(options: {
	mutateHousehold: () => Promise<TRoster>;
	onMutated: () => void;
	refreshAuth: () => Promise<{ stateLoaded?: boolean }>;
	fetchState: () => Promise<TState>;
	adoptState: (state: TState) => void;
	applyRoster: (roster: TRoster) => void;
}): Promise<void> {
	const roster = await options.mutateHousehold();
	options.onMutated();
	options.applyRoster(roster);
	const auth = await options.refreshAuth();
	if (!auth.stateLoaded) {
		const state = await options.fetchState();
		options.adoptState(state);
	}
}

/**
 * Reconcile connectivity restoration without clobbering refreshAuth's adopted context or
 * repeating /api/state before syncPendingKitchenJournal.
 */
export async function runReconnectWorkflow<TState = { state?: AppState | null }>(options: {
	hadPreviousUser: boolean;
	refreshAuth: () => Promise<{ stateLoaded?: boolean }>;
	getCurrentUser: () => User | null;
	onSignedOut: () => void;
	restoreContext: (user: User) => void;
	hasPendingEdits: () => boolean;
	fetchState: () => Promise<TState>;
	adoptState: (latest: TState) => void;
	retrySync: () => Promise<void>;
}): Promise<void> {
	const auth = await options.refreshAuth();
	const currentUser = options.getCurrentUser();
	if (!currentUser) {
		options.onSignedOut();
		return;
	}
	if (!options.hadPreviousUser && !auth.stateLoaded) {
		options.restoreContext(currentUser);
	}
	if (!auth.stateLoaded && !options.hasPendingEdits()) {
		const latest = await options.fetchState();
		options.adoptState(latest);
	}
	await options.retrySync();
}

/**
 * Selectively clear untouched sample records in place and register a snapshot-guarded Undo
 * callback that restores removed sample items and guest starter-banner state if unchanged.
 */
export function runSampleCleanupWorkflow(options: {
	commitInlineEdits: () => void;
	getKitchen: () => AppState;
	setKitchen: (next: AppState) => void;
	onCleaned: () => void;
	onUndoRestore: (restored: AppState) => void;
	getShowStarter: () => boolean;
	setShowStarter: (show: boolean) => void;
	isGuest: () => boolean;
	storage: StarterStorage;
	closeSettingsIfOpen: () => void;
	notify: (message: string, undo?: () => void) => void;
	now?: Date;
}): boolean {
	options.commitInlineEdits();
	const current = options.getKitchen();
	if (!hasSampleData(current)) {
		options.setShowStarter(false);
		if (options.isGuest()) options.storage.setItem('flavorithm-started', 'yes');
		return false;
	}
	const previousKitchen = sanitizeKitchenState(JSON.parse(JSON.stringify(current)));
	const wasShowingStarter = options.getShowStarter();
	const previousStarted = options.isGuest() ? options.storage.getItem('flavorithm-started') : null;
	const cleaned = clearSampleData(previousKitchen, options.now);
	options.setKitchen(cleaned);
	options.onCleaned();
	const appliedSnapshot = JSON.stringify(options.getKitchen());
	options.setShowStarter(false);
	if (options.isGuest()) options.storage.setItem('flavorithm-started', 'yes');
	options.closeSettingsIfOpen();
	options.notify('Sample data cleared.', () => {
		if (JSON.stringify(options.getKitchen()) === appliedSnapshot) {
			options.onUndoRestore(previousKitchen);
			if (wasShowingStarter && options.isGuest()) {
				options.setShowStarter(true);
				if (previousStarted === null) options.storage.removeItem('flavorithm-started');
				else options.storage.setItem('flavorithm-started', previousStarted);
			}
			options.notify('Sample data restored.');
		} else {
			options.notify('Your kitchen changed again. Review the current values before editing.');
		}
	});
	return true;
}

/**
 * Sanitize and strip untouched sample records from a guest kitchen before local registration,
 * or return null for sign-in so guest items never leak into an existing account.
 */
export function prepareGuestKitchenForAuth(
	authMode: string,
	kitchen: AppState,
	now?: Date
): AppState | null {
	if (authMode !== 'register') return null;
	return clearSampleData(sanitizeKitchenState(JSON.parse(JSON.stringify(kitchen))), now);
}

/**
 * Execute local sign-in or registration, stripping untouched sample data on registration while
 * leaving the live guest kitchen untouched if /api/auth fails.
 */
export async function runLocalAuthenticateWorkflow(options: {
	authMode: string;
	getKitchen: () => AppState;
	authenticateRequest: () => Promise<{ user: User }>;
	onAuthenticated: (user: User, initialKitchen: AppState) => void;
	stageGuestKitchen: (guestKitchen: AppState) => void;
	hasSyncError: () => boolean;
	clearGuestStorage: () => void;
	fetchState: () => Promise<{ state?: AppState | null }>;
	createState: (state: AppState) => Promise<{ state?: AppState | null }>;
	adoptKitchen: (state: AppState) => void;
	hasPendingSnapshot: () => boolean;
	syncKitchen: () => Promise<void>;
	isOnline: () => boolean;
	retrySync: () => Promise<void>;
	failStateLoad: (message: string) => void;
	now?: Date;
}): Promise<{ user: User; guestKitchen: AppState | null; stateLoaded: boolean }> {
	const guestKitchen = prepareGuestKitchenForAuth(
		options.authMode,
		options.getKitchen(),
		options.now
	);
	const result = await options.authenticateRequest();
	const authenticatedUser = result.user;
	options.onAuthenticated(authenticatedUser, guestKitchen ?? createNewUserState());
	if (guestKitchen) {
		options.stageGuestKitchen(guestKitchen);
		if (!options.hasSyncError()) {
			options.clearGuestStorage();
		}
	}
	let stateLoaded = false;
	try {
		const saved = await options.fetchState();
		if (guestKitchen) {
			options.adoptKitchen(saved.state || createNewUserState());
			if (!saved.state && !options.hasPendingSnapshot()) {
				const created = await options.createState(guestKitchen);
				options.adoptKitchen(created.state || guestKitchen);
			} else {
				await options.syncKitchen();
			}
		} else if (saved.state) {
			options.adoptKitchen(saved.state);
			if (options.isOnline() && options.hasPendingSnapshot()) await options.retrySync();
		} else {
			const initial = createNewUserState();
			const created = await options.createState(initial);
			options.adoptKitchen(created.state || initial);
			if (options.isOnline() && options.hasPendingSnapshot()) await options.retrySync();
		}
		stateLoaded = true;
	} catch (stateError) {
		options.failStateLoad((stateError as Error).message);
	}
	return { user: authenticatedUser, guestKitchen, stateLoaded };
}
