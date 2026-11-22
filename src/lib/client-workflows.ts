import type { ConnectionModel, ConnectionProvider } from '#lib/ai-connections.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

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
	if (chatGPT.host) {
		preferences.provider = 'chatgpt';
		preferences.chatgptAccountId = 'host-chatgpt';
		preferences.model = chatGPT.host.model;
	}
	if (!chatGPT.accounts.some((account) => account.id === preferences.chatgptAccountId)) {
		preferences.chatgptAccountId =
			chatGPT.accounts.find((account) => account.connected && account.planEnabled)?.id ||
			chatGPT.accounts[0]?.id;
	}
}

/** Return the selected ChatGPT account ID only when ChatGPT plan inference is active and entitled. */
export function entitledChatGPTAccountId(
	preferences: Pick<Preferences, 'provider' | 'chatgptAccountId'>,
	accounts: ChatGPTAccountSummary[]
): string | null {
	const accountId = preferences.chatgptAccountId;
	if (preferences.provider !== 'chatgpt' || !accountId) return null;
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
