import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialState, createNewUserState, defaultPreferences } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import { createKitchenSync } from '../src/lib/client-sync.ts';
import {
	entitledChatGPTAccountId,
	prepareGuestKitchenForAuth,
	reconcileChatGPTPreferences,
	runConcurrentModelCatalog,
	runHouseholdTransition,
	runLocalAuthenticateWorkflow,
	runOpenSettingsWorkflow,
	runReconnectWorkflow,
	runSampleCleanupWorkflow,
	runSignedInHydration
} from '../src/lib/client-workflows.ts';
import { clearGuestData, clearGuestKitchen } from '../src/lib/guest-storage.ts';
import {
	hasSampleData,
	normalizeIngredientName,
	promoteSampleIngredient,
	reconcileShoppingList
} from '../src/lib/kitchen-workflows.ts';
import type { AppState, Preferences, User } from '../src/lib/types.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}

test('signed-in startup dispatches /api/state and /api/connections/chatgpt concurrently and reconciles preferences after adoptKitchen', async () => {
	const stateDeferred = deferred<{ state: AppState }>();
	const connectionsDeferred = deferred<{
		host: null;
		accounts: Array<{ id: string; connected: boolean; planEnabled: boolean }>;
	}>();
	const events: string[] = [];
	let preferences: Preferences = { ...defaultPreferences, provider: 'chatgpt', model: 'gpt-4.1' };

	const hydration = runSignedInHydration({
		returnFromChatGPT: false,
		fetchState: () => {
			events.push('start:/api/state');
			return stateDeferred.promise;
		},
		fetchConnections: () => {
			events.push('start:/api/connections/chatgpt');
			return connectionsDeferred.promise;
		},
		adoptState: (saved) => {
			events.push('adoptKitchen');
			preferences = structuredClone(saved.state.preferences);
		},
		openSettings: async () => {
			events.push('openSettings');
		},
		onConnections: (result) => {
			events.push('reconcileChatGPT');
			reconcileChatGPTPreferences(preferences, result);
		},
		onConnectionsError: () => {
			events.push('connectionsError');
		}
	});

	assert.deepEqual(events, ['start:/api/connections/chatgpt', 'start:/api/state']);

	// Even when /api/connections/chatgpt finishes before /api/state, reconciliation waits until after adoptKitchen.
	connectionsDeferred.resolve({
		host: null,
		accounts: [{ id: 'acct-entitled', connected: true, planEnabled: true }]
	});
	await Promise.resolve();
	assert.deepEqual(events, ['start:/api/connections/chatgpt', 'start:/api/state']);

	const remoteState = createNewUserState();
	remoteState.preferences.provider = 'chatgpt';
	remoteState.preferences.chatgptAccountId = 'stale-account';
	stateDeferred.resolve({ state: remoteState });
	await hydration;

	assert.deepEqual(events, [
		'start:/api/connections/chatgpt',
		'start:/api/state',
		'adoptKitchen',
		'reconcileChatGPT'
	]);
	assert.equal(preferences.chatgptAccountId, 'acct-entitled');
});

test('returnFromChatGPT startup delegates to openSettings and skips a duplicate refreshConnections call', async () => {
	const events: string[] = [];
	await runSignedInHydration({
		returnFromChatGPT: true,
		fetchState: async () => {
			events.push('fetch:/api/state');
			return { state: createNewUserState() };
		},
		fetchConnections: async () => {
			events.push('duplicate:/api/connections/chatgpt');
			return { accounts: [] };
		},
		adoptState: () => {
			events.push('adoptKitchen');
		},
		openSettings: async () => {
			events.push('openSettings:/api/connections/chatgpt');
		},
		onConnections: () => {
			events.push('onConnections');
		},
		onConnectionsError: () => {
			events.push('onConnectionsError');
		}
	});

	assert.deepEqual(events, [
		'fetch:/api/state',
		'adoptKitchen',
		'openSettings:/api/connections/chatgpt'
	]);
});

test('openSettings dispatches refreshAuth, refreshConnections, and loadModelCatalog in 1 concurrent HTTP stage', async () => {
	const authDeferred = deferred<{ stateLoaded: boolean }>();
	const connectionsDeferred = deferred<void>();
	const catalogDeferred = deferred<{ providers: [] }>();
	const accountDeferred = deferred<{
		providers: [{ models: Array<{ id: string; name: string; vision: boolean }> }];
	}>();
	const started: string[] = [];
	const preferences: Preferences = {
		...defaultPreferences,
		provider: 'chatgpt',
		chatgptAccountId: 'acct-1'
	};
	const accounts = [{ id: 'acct-1', connected: true, planEnabled: true }];
	let accountModels: Array<{ id: string }> = [];

	const workflow = runOpenSettingsWorkflow({
		initialUserId: 'user-1',
		getCurrentUserId: () => 'user-1',
		refreshAuth: () => {
			started.push('GET /api/auth');
			return authDeferred.promise;
		},
		loadConnectionsAndCatalog: () => {
			const connTask = (() => {
				started.push('GET /api/connections/chatgpt');
				return connectionsDeferred.promise;
			})();
			return runConcurrentModelCatalog({
				connectionsTask: connTask,
				isCurrent: () => true,
				getEntitledAccountId: () => entitledChatGPTAccountId(preferences, accounts),
				fetchPublicCatalog: () => {
					started.push('GET /api/models');
					return catalogDeferred.promise;
				},
				fetchAccountCatalog: (accountId) => {
					started.push(`GET /api/models?connection=chatgpt&accountId=${accountId}`);
					return accountDeferred.promise;
				},
				onResult: ({ account }) => {
					if (account.status === 'fulfilled')
						accountModels = account.value?.providers[0]?.models || [];
				}
			});
		},
		onError: (err) => {
			throw err;
		}
	});

	assert.deepEqual(started, [
		'GET /api/auth',
		'GET /api/connections/chatgpt',
		'GET /api/models',
		'GET /api/models?connection=chatgpt&accountId=acct-1'
	]);

	connectionsDeferred.resolve();
	catalogDeferred.resolve({ providers: [] });
	accountDeferred.resolve({
		providers: [{ models: [{ id: 'gpt-5', name: 'GPT-5', vision: true }] }]
	});
	authDeferred.resolve({ stateLoaded: false });
	await workflow;

	assert.equal(started.length, 4);
	assert.deepEqual(
		accountModels.map((m) => m.id),
		['gpt-5']
	);
});

test('refreshAISettings and changeConnection fetch entitled ChatGPT models when refreshConnections changes chatgptAccountId or enables an unqueried account', async () => {
	// Subcase A: unqueried activeChatGPTAccount becomes planEnabled during refreshConnections.
	const preferencesA: Preferences = {
		...defaultPreferences,
		provider: 'chatgpt',
		chatgptAccountId: 'acct-pending'
	};
	let accountsA = [{ id: 'acct-pending', connected: true, planEnabled: false }];
	const callsA: string[] = [];
	const catalogA = deferred<{ providers: [] }>();
	let modelsA: string[] = [];

	const runA = runConcurrentModelCatalog({
		connectionsTask: Promise.resolve().then(() => {
			callsA.push('resolved:/api/connections/chatgpt');
			accountsA = [{ id: 'acct-pending', connected: true, planEnabled: true }];
		}),
		isCurrent: () => true,
		getEntitledAccountId: () => entitledChatGPTAccountId(preferencesA, accountsA),
		fetchPublicCatalog: () => {
			callsA.push('start:/api/models');
			return catalogA.promise;
		},
		fetchAccountCatalog: async (accountId) => {
			callsA.push(`start:/api/models?connection=chatgpt&accountId=${accountId}`);
			return {
				providers: [{ models: [{ id: 'codex-mini', name: 'Codex Mini', vision: true }] }]
			};
		},
		onResult: ({ account }) => {
			if (account.status === 'fulfilled')
				modelsA = (account.value?.providers[0]?.models || []).map((m) => m.id);
		}
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	// Follow-up account catalog request starts immediately after connections settle, before slow /api/models finishes.
	assert.deepEqual(callsA, [
		'start:/api/models',
		'resolved:/api/connections/chatgpt',
		'start:/api/models?connection=chatgpt&accountId=acct-pending'
	]);
	catalogA.resolve({ providers: [] });
	await runA;
	assert.deepEqual(modelsA, ['codex-mini']);

	// Subcase B: refreshConnections switches chatgptAccountId from acct-old to acct-new.
	const preferencesB: Preferences = {
		...defaultPreferences,
		provider: 'chatgpt',
		chatgptAccountId: 'acct-old'
	};
	let accountsB = [{ id: 'acct-old', connected: true, planEnabled: true }];
	const callsB: string[] = [];
	let modelsB: string[] = [];

	await runConcurrentModelCatalog({
		connectionsTask: Promise.resolve().then(() => {
			accountsB = [{ id: 'acct-new', connected: true, planEnabled: true }];
			reconcileChatGPTPreferences(preferencesB, { accounts: accountsB });
		}),
		isCurrent: () => true,
		getEntitledAccountId: () => entitledChatGPTAccountId(preferencesB, accountsB),
		fetchPublicCatalog: async () => ({ providers: [] }),
		fetchAccountCatalog: async (accountId) => {
			callsB.push(accountId);
			return {
				providers: [
					{ models: [{ id: `model-${accountId}`, name: `Model ${accountId}`, vision: false }] }
				]
			};
		},
		onResult: ({ account }) => {
			if (account.status === 'fulfilled')
				modelsB = (account.value?.providers[0]?.models || []).map((m) => m.id);
		}
	});

	assert.deepEqual(callsB, ['acct-old', 'acct-new']);
	assert.deepEqual(modelsB, ['model-acct-new']);
});

test('join and leaveHousehold perform 1 /api/state read via refreshAuth and 0 GET /api/household reads', async () => {
	for (const action of ['join', 'leave'] as const) {
		const requests: string[] = [];
		let appliedRoster: unknown = null;
		let adoptedCount = 0;

		await runHouseholdTransition({
			mutateHousehold: async () => {
				requests.push(`POST /api/household (${action})`);
				return {
					members: [{ id: 'u1', name: 'Alex', email: 'alex@example.test', role: 'owner' }],
					invites: [],
					canManage: action === 'leave'
				};
			},
			onMutated: () => {},
			refreshAuth: async () => {
				requests.push('GET /api/auth');
				requests.push('GET /api/state');
				adoptedCount += 1;
				return { stateLoaded: true };
			},
			fetchState: async () => {
				requests.push('DUPLICATE GET /api/state');
				return { state: createNewUserState() };
			},
			adoptState: () => {
				adoptedCount += 1;
			},
			applyRoster: (roster) => {
				appliedRoster = roster;
			}
		});

		assert.deepEqual(requests, [
			`POST /api/household (${action})`,
			'GET /api/auth',
			'GET /api/state'
		]);
		assert.equal(adoptedCount, 1);
		assert.deepEqual(appliedRoster, {
			members: [{ id: 'u1', name: 'Alex', email: 'alex@example.test', role: 'owner' }],
			invites: [],
			canManage: action === 'leave'
		});
	}
});

test('reconnectKitchen performs 1 /api/state read whether household identity changed or pending offline edits sync', async () => {
	// Scenario 1: Household identity changed during refreshAuth -> keeps adopted context and performs 1 /api/state read.
	const storage1 = memoryStorage();
	let currentUser1: User | null = {
		id: 'user-1',
		householdId: 'home-old',
		name: 'Cook',
		email: 'cook@example.test'
	};
	let currentState1 = createNewUserState();
	let stateReads1 = 0;
	const sync1 = createKitchenSync({
		storage: storage1,
		getUser: () => currentUser1,
		getState: () => currentState1,
		setState: (next) => {
			currentState1 = structuredClone(next);
		},
		onStatus: () => {},
		transport: (owner) => ({
			identity: { userId: owner.id, householdId: owner.householdId },
			get: async () => {
				stateReads1 += 1;
				return {
					state: structuredClone(currentState1),
					etag: 'v2',
					userId: owner.id,
					householdId: owner.householdId
				};
			},
			put: async (next) => ({ state: next, etag: 'v3' })
		})
	});
	sync1.initialize(currentUser1, currentState1, 'v1');

	const adoptedHomeState = createNewUserState();
	adoptedHomeState.pantry.push({
		id: 'shared-salt',
		name: 'Sea salt',
		quantity: 1,
		unit: 'box',
		category: 'Pantry'
	});

	await runReconnectWorkflow({
		hadPreviousUser: true,
		refreshAuth: async () => {
			sync1.clearContext();
			currentUser1 = { ...currentUser1!, householdId: 'home-new' };
			stateReads1 += 1;
			sync1.initialize(currentUser1, adoptedHomeState, 'new-v1');
			return { stateLoaded: true };
		},
		getCurrentUser: () => currentUser1,
		onSignedOut: () => sync1.clearContext(),
		restoreContext: (u) => sync1.restore(u),
		hasPendingEdits: () => Boolean(sync1.snapshot()),
		fetchState: async () => {
			stateReads1 += 1;
			return { state: adoptedHomeState };
		},
		adoptState: (latest) => sync1.initialize(currentUser1!, latest.state!, 'dup'),
		retrySync: () => sync1.sync()
	});

	assert.equal(stateReads1, 1);
	assert.equal(currentState1.pantry[0]?.name, 'Sea salt');
	// Confirm adopted context was kept (staging an edit works without "kitchen has not loaded" error).
	const edited1 = structuredClone(currentState1);
	edited1.preferences.maxTime = 30;
	sync1.stage(edited1);
	assert.equal(sync1.snapshot()?.local.preferences.maxTime, 30);

	// Scenario 2: Same household with pending offline journal edits -> skips pre-sync /api/state so retrySync reads /api/state once.
	const storage2 = memoryStorage();
	const user2: User = {
		id: 'user-2',
		householdId: 'home-2',
		name: 'Baker',
		email: 'baker@example.test'
	};
	const base2 = createNewUserState();
	let serverState2 = structuredClone(base2);
	let uiState2 = structuredClone(base2);
	let stateReads2 = 0;
	let stateWrites2 = 0;

	const sync2 = createKitchenSync({
		storage: storage2,
		getUser: () => user2,
		getState: () => uiState2,
		setState: (next) => {
			uiState2 = structuredClone(next);
		},
		onStatus: () => {},
		transport: (owner) => ({
			identity: { userId: owner.id, householdId: owner.householdId },
			get: async () => {
				stateReads2 += 1;
				return {
					state: structuredClone(serverState2),
					etag: 'etag-1',
					userId: owner.id,
					householdId: owner.householdId
				};
			},
			put: async (next) => {
				stateWrites2 += 1;
				serverState2 = structuredClone(next);
				return { state: structuredClone(serverState2), etag: 'etag-2' };
			}
		})
	});
	sync2.initialize(user2, base2, 'etag-1');
	const offlineEdit = structuredClone(base2);
	offlineEdit.pantry.push({
		id: 'offline-flour',
		name: 'Bread flour',
		quantity: 2,
		unit: 'kg',
		category: 'Pantry'
	});
	sync2.stage(offlineEdit);
	assert.ok(sync2.snapshot());

	await runReconnectWorkflow({
		hadPreviousUser: true,
		refreshAuth: async () => ({ stateLoaded: false }),
		getCurrentUser: () => user2,
		onSignedOut: () => sync2.clearContext(),
		restoreContext: (u) => sync2.restore(u),
		hasPendingEdits: () => Boolean(sync2.snapshot()),
		fetchState: async () => {
			stateReads2 += 1;
			return { state: serverState2 };
		},
		adoptState: (latest) => sync2.initialize(user2, latest.state!, 'etag-1'),
		retrySync: () => sync2.sync()
	});

	assert.equal(stateReads2, 1);
	assert.equal(stateWrites2, 1);
	assert.equal(sync2.snapshot(), null);
	assert.equal(serverState2.pantry[0]?.name, 'Bread flour');
});

test('runSampleCleanupWorkflow clears sample records in place, restores via Undo, and guards post-cleanup edits', () => {
	const storage = memoryStorage();
	let kitchen = createInitialState();
	// Promote one sample staple and add a real manual shopping item.
	kitchen.pantry = kitchen.pantry.map((item) =>
		item.id === 'pantry-eggs' ? promoteSampleIngredient({ ...item, quantity: 6 }) : item
	);
	kitchen.shopping.push({
		id: 'manual-coffee',
		name: 'coffee beans',
		quantity: 1,
		unit: 'bag',
		checked: false
	});

	let showStarter = true;
	let guestMode = true;
	let modal = 'settings';
	let inlineCommitted = 0;
	let cleanedHooks = 0;
	let undoRestores = 0;
	const notifications: Array<{ message: string; undo?: () => void }> = [];

	const cleaned = runSampleCleanupWorkflow({
		commitInlineEdits: () => {
			inlineCommitted += 1;
		},
		getKitchen: () => kitchen,
		setKitchen: (next) => {
			kitchen = next;
		},
		onCleaned: () => {
			cleanedHooks += 1;
		},
		onUndoRestore: (restored) => {
			undoRestores += 1;
			kitchen = restored;
		},
		getShowStarter: () => showStarter,
		setShowStarter: (show) => {
			showStarter = show;
		},
		isGuest: () => guestMode,
		storage,
		closeSettingsIfOpen: () => {
			if (modal === 'settings') modal = '';
		},
		notify: (message, undo) => {
			notifications.push({ message, undo });
		}
	});

	assert.equal(cleaned, true);
	assert.equal(inlineCommitted, 1);
	assert.equal(cleanedHooks, 1);
	assert.equal(modal, '');
	assert.equal(showStarter, false);
	assert.equal(storage.getItem('flavorithm-started'), 'yes');
	assert.equal(hasSampleData(kitchen), false);
	assert.deepEqual(
		kitchen.pantry.map((item) => ({ id: item.id, quantity: item.quantity })),
		[{ id: 'pantry-eggs', quantity: 6 }]
	);
	assert.deepEqual(
		kitchen.shopping.map((item) => item.id),
		['manual-coffee']
	);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].message, 'Sample data cleared.');
	assert.equal(typeof notifications[0].undo, 'function');

	// Undo while kitchen is unchanged restores sample records, starter banner, and unstarted storage state.
	notifications[0].undo!();
	assert.equal(undoRestores, 1);
	assert.equal(hasSampleData(kitchen), true);
	assert.equal(kitchen.pantry.length, 7);
	assert.equal(kitchen.meals.length, 3);
	assert.equal(showStarter, true);
	assert.equal(storage.getItem('flavorithm-started'), null);
	assert.equal(notifications.at(-1)?.message, 'Sample data restored.');

	// Re-run cleanup after user already dismissed starter banner ('flavorithm-started' === 'yes'), then mutate kitchen before Undo.
	storage.setItem('flavorithm-started', 'yes');
	showStarter = false;
	runSampleCleanupWorkflow({
		commitInlineEdits: () => {},
		getKitchen: () => kitchen,
		setKitchen: (next) => {
			kitchen = next;
		},
		onCleaned: () => {},
		onUndoRestore: (restored) => {
			kitchen = restored;
		},
		getShowStarter: () => showStarter,
		setShowStarter: (show) => {
			showStarter = show;
		},
		isGuest: () => guestMode,
		storage,
		closeSettingsIfOpen: () => {},
		notify: (message, undo) => {
			notifications.push({ message, undo });
		}
	});
	const secondUndo = notifications.at(-1)?.undo;
	assert.equal(typeof secondUndo, 'function');

	// Mutating the kitchen invalidates the Undo snapshot so user edits are not overwritten.
	kitchen.shopping.push({
		id: 'new-oat-milk',
		name: 'oat milk',
		quantity: 1,
		unit: 'carton',
		checked: false
	});
	secondUndo!();
	assert.equal(hasSampleData(kitchen), false);
	assert.equal(
		kitchen.shopping.some((item) => item.id === 'new-oat-milk'),
		true
	);
	assert.equal(
		notifications.at(-1)?.message,
		'Your kitchen changed again. Review the current values before editing.'
	);

	// Calling runSampleCleanupWorkflow when no sample data remains is a safe no-op that marks started.
	const countBeforeNoop = notifications.length;
	showStarter = true;
	storage.removeItem('flavorithm-started');
	const noopResult = runSampleCleanupWorkflow({
		commitInlineEdits: () => {},
		getKitchen: () => kitchen,
		setKitchen: (next) => {
			kitchen = next;
		},
		onCleaned: () => {},
		onUndoRestore: () => {},
		getShowStarter: () => showStarter,
		setShowStarter: (show) => {
			showStarter = show;
		},
		isGuest: () => guestMode,
		storage,
		closeSettingsIfOpen: () => {},
		notify: (message, undo) => {
			notifications.push({ message, undo });
		}
	});
	assert.equal(noopResult, false);
	assert.equal(showStarter, false);
	assert.equal(storage.getItem('flavorithm-started'), 'yes');
	assert.equal(notifications.length, countBeforeNoop);
});

test('runLocalAuthenticateWorkflow strips sample records on register, leaves live kitchen untouched on /api/auth failure, and skips guest staging on login', async () => {
	const now = new Date(2026, 10, 18, 12);
	const weekStart = '2026-11-16';
	const storage = memoryStorage();
	storage.setItem('flavorithm-guest-kitchen', '{"pantry":[]}');
	storage.setItem('flavorithm-started', 'yes');

	let liveKitchen = createInitialState();
	// Promote eggs, schedule a real Thursday meal, and generate weekly shopping while sample staples are present.
	liveKitchen.pantry = liveKitchen.pantry.map((item) =>
		item.id === 'pantry-eggs' ? promoteSampleIngredient({ ...item, quantity: 6 }) : item
	);
	liveKitchen.meals = [
		{
			id: 'meal-week-tue',
			date: '2026-11-17',
			slot: 'Dinner',
			recipeId: 'lemon-herb-chicken',
			servings: 2,
			sample: true
		},
		{
			id: 'user-orzo-dinner',
			date: '2026-11-19',
			slot: 'Dinner',
			recipeId: 'lemon-chickpea-orzo',
			servings: 2
		}
	];
	liveKitchen.shopping = reconcileShoppingList(
		[{ id: 'manual-tea', name: 'green tea', quantity: 1, unit: 'box', checked: false }],
		buildShoppingList(liveKitchen.recipes, liveKitchen.pantry, liveKitchen.meals, now),
		`week:${weekStart}`
	);

	// 1. Failed /api/auth leaves live guest kitchen, sample records, and guest storage untouched.
	let activeUser: User | null = null;
	await assert.rejects(
		() =>
			runLocalAuthenticateWorkflow({
				authMode: 'register',
				getKitchen: () => liveKitchen,
				authenticateRequest: async () => {
					throw new Error('Email is already registered');
				},
				onAuthenticated: (nextUser, initialKitchen) => {
					activeUser = nextUser;
					liveKitchen = initialKitchen;
				},
				stageGuestKitchen: () => {
					throw new Error('Should not stage on auth failure');
				},
				hasSyncError: () => false,
				clearGuestStorage: () => {
					clearGuestKitchen(storage);
					clearGuestData(storage);
				},
				fetchState: async () => ({ state: null }),
				createState: async (state) => ({ state }),
				adoptKitchen: () => {},
				hasPendingSnapshot: () => false,
				syncKitchen: async () => {},
				isOnline: () => true,
				retrySync: async () => {},
				failStateLoad: () => {},
				now
			}),
		/Email is already registered/
	);
	assert.equal(activeUser, null);
	assert.equal(hasSampleData(liveKitchen), true);
	assert.equal(storage.getItem('flavorithm-guest-kitchen'), '{"pantry":[]}');
	assert.equal(storage.getItem('flavorithm-started'), 'yes');

	// 2. Successful register strips untouched sample records, refreshes weekly shopping, stages into sync, and uploads clean state.
	const registeredUser: User = {
		id: 'user-reg',
		householdId: 'home-reg',
		name: 'Grace Hopper',
		email: 'grace@example.test'
	};
	let serverState: AppState | null = null;
	let serverEtag = '';
	let syncError = '';
	const sync = createKitchenSync({
		storage,
		getUser: () => activeUser,
		getState: () => liveKitchen,
		setState: (next) => {
			liveKitchen = structuredClone(next);
		},
		onStatus: (status) => {
			syncError = status.error;
		},
		transport: (owner) => ({
			identity: { userId: owner.id, householdId: owner.householdId },
			get: async () => ({
				state: structuredClone(serverState ?? createNewUserState()),
				etag: serverEtag,
				userId: owner.id,
				householdId: owner.householdId
			}),
			put: async (candidate) => {
				serverState = structuredClone(candidate);
				serverEtag = 'etag-reg-1';
				return { state: structuredClone(serverState), etag: serverEtag };
			}
		})
	});

	const regOutcome = await runLocalAuthenticateWorkflow({
		authMode: 'register',
		getKitchen: () => liveKitchen,
		authenticateRequest: async () => ({ user: registeredUser }),
		onAuthenticated: (nextUser, initialKitchen) => {
			liveKitchen = initialKitchen;
			activeUser = nextUser;
			sync.prepare(nextUser);
		},
		stageGuestKitchen: (cleanedGuest) => {
			liveKitchen = cleanedGuest;
			sync.stage(cleanedGuest);
		},
		hasSyncError: () => Boolean(syncError),
		clearGuestStorage: () => {
			clearGuestKitchen(storage);
			clearGuestData(storage);
		},
		fetchState: async () => ({ state: serverState }),
		createState: async (state) => {
			serverState = structuredClone(state);
			serverEtag = 'etag-reg-1';
			return { state: structuredClone(serverState) };
		},
		adoptKitchen: (state) => {
			sync.initialize(activeUser!, state, serverEtag);
		},
		hasPendingSnapshot: () => Boolean(sync.snapshot()),
		syncKitchen: async () => {
			await sync.sync();
		},
		isOnline: () => true,
		retrySync: async () => {
			await sync.sync();
		},
		failStateLoad: (msg) => sync.failLoad(msg),
		now
	});

	assert.equal(regOutcome.stateLoaded, true);
	assert.ok(regOutcome.guestKitchen);
	assert.equal(storage.getItem('flavorithm-guest-kitchen'), null);
	assert.equal(storage.getItem('flavorithm-started'), null);
	assert.equal(sync.snapshot(), null);
	assert.ok(serverState);
	const persistedState = serverState as AppState;
	assert.equal(hasSampleData(persistedState), false);
	assert.deepEqual(
		persistedState.pantry.map((item) => ({ id: item.id, quantity: item.quantity })),
		[{ id: 'pantry-eggs', quantity: 6 }]
	);
	assert.deepEqual(
		persistedState.meals.map((meal) => meal.id),
		['user-orzo-dinner']
	);
	assert.equal(
		persistedState.shopping.some((item) => item.id === 'manual-tea'),
		true
	);
	assert.equal(
		persistedState.shopping.some((item) => normalizeIngredientName(item.name) === 'chicken thigh'),
		false
	);
	assert.equal(
		persistedState.shopping.some((item) => normalizeIngredientName(item.name) === 'chickpea'),
		true
	);

	// 3. Login mode never stages guest sample/local kitchen into an existing account.
	const guestWithSample = createInitialState();
	assert.equal(prepareGuestKitchenForAuth('login', guestWithSample, now), null);
	let stagedOnLogin = false;
	const existingServerState = createNewUserState();
	existingServerState.pantry.push({
		id: 'acct-salt',
		name: 'sea salt',
		quantity: 1,
		unit: 'box',
		category: 'Spices'
	});
	let loginAdopted = null as AppState | null;
	const loginOutcome = await runLocalAuthenticateWorkflow({
		authMode: 'login',
		getKitchen: () => guestWithSample,
		authenticateRequest: async () => ({
			user: {
				id: 'existing-1',
				householdId: 'existing-home',
				name: 'Alan Turing',
				email: 'alan@example.test'
			}
		}),
		onAuthenticated: () => {},
		stageGuestKitchen: () => {
			stagedOnLogin = true;
		},
		hasSyncError: () => false,
		clearGuestStorage: () => {},
		fetchState: async () => ({ state: existingServerState }),
		createState: async (state) => ({ state }),
		adoptKitchen: (state) => {
			loginAdopted = state;
		},
		hasPendingSnapshot: () => false,
		syncKitchen: async () => {},
		isOnline: () => true,
		retrySync: async () => {},
		failStateLoad: () => {},
		now
	});
	assert.equal(loginOutcome.guestKitchen, null);
	assert.equal(loginOutcome.stateLoaded, true);
	assert.equal(stagedOnLogin, false);
	assert.deepEqual(
		loginAdopted?.pantry.map((item) => item.id),
		['acct-salt']
	);
});
