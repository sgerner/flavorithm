import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewUserState } from '../src/lib/data.ts';
import { createKitchenPersistence, createKitchenSync } from '../src/lib/client-sync.ts';
import type { AppState, User } from '../src/lib/types.ts';
import type { KitchenTransport } from '../src/lib/offline-sync.ts';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const makeUser = (id = 'user-a', householdId = 'home-a'): User => ({
	id,
	householdId,
	name: id,
	email: `${id}@example.test`
});

function harness(args: {
	user: User | null;
	storage?: ReturnType<typeof memoryStorage>;
	transport?: (user: User) => KitchenTransport;
	initial?: AppState;
}) {
	const storage = args.storage || memoryStorage();
	let currentUser = args.user;
	let currentState = structuredClone(args.initial || createNewUserState());
	const statuses: Array<{
		pending: boolean;
		syncing: boolean;
		conflicts: unknown[];
		error: string;
	}> = [];
	const setStates: AppState[] = [];
	const controller = createKitchenSync({
		storage,
		getUser: () => currentUser,
		getState: () => currentState,
		setState: (state) => {
			currentState = structuredClone(state);
			setStates.push(structuredClone(state));
		},
		onStatus: (status) => statuses.push(status),
		transport: (user) => {
			if (!args.transport) throw new Error('No transport configured');
			return args.transport(user);
		}
	});
	return {
		controller,
		storage,
		statuses,
		setStates,
		get user() {
			return currentUser;
		},
		set user(user: User | null) {
			currentUser = user;
		},
		get state() {
			return currentState;
		},
		set state(state: AppState) {
			currentState = structuredClone(state);
		}
	};
}

function transportFor(user: User, state: AppState, etag = 'v1'): KitchenTransport {
	let current = structuredClone(state);
	let currentEtag = etag;
	return {
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(current),
			etag: currentEtag,
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (next, _ifMatch) => {
			current = structuredClone(next);
			currentEtag = `${currentEtag}-saved`;
			return { state: structuredClone(current), etag: currentEtag };
		}
	};
}

test('a failed network sync keeps a durable queue that restores after reload', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 25;
	const storage = memoryStorage();
	const first = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				throw new Error('Network unavailable');
			},
			put: async (state) => ({ state, etag: 'unused' })
		})
	});
	first.controller.initialize(user, base, 'v1');
	first.controller.stage(local);
	assert.equal(first.controller.snapshot()?.local.preferences.maxTime, 25);
	await first.controller.sync();
	assert.equal(first.controller.snapshot()?.local.preferences.maxTime, 25);
	assert.match(first.statuses.at(-1)?.error || '', /Network unavailable/);

	const reloaded = harness({ user, storage });
	assert.equal(reloaded.controller.restore(user), true);
	assert.equal(reloaded.state.preferences.maxTime, 25);
	assert.equal(reloaded.controller.snapshot()?.local.preferences.maxTime, 25);
});

test('switching accounts while a GET is in flight prevents the stale callback from writing or restoring state', async () => {
	const userA = makeUser('user-a', 'home-a');
	const userB = makeUser('user-b', 'home-b');
	const baseA = createNewUserState();
	const localA = structuredClone(baseA);
	localA.preferences.maxTime = 18;
	const baseB = createNewUserState();
	baseB.preferences.allergies = 'sesame';
	const getA = deferred<{ state: AppState; etag: string; userId: string; householdId: string }>();
	let writesA = 0;
	const sync = harness({
		user: userA,
		transport: (user) =>
			user.id === userA.id
				? {
						identity: { userId: userA.id, householdId: userA.householdId },
						get: () => getA.promise,
						put: async (state) => {
							writesA += 1;
							return { state, etag: 'saved-a' };
						}
					}
				: transportFor(userB, baseB)
	});
	sync.controller.initialize(userA, baseA, 'a1');
	sync.controller.stage(localA);
	const inFlight = sync.controller.sync();
	await Promise.resolve();
	sync.user = userB;
	sync.controller.initialize(userB, baseB, 'b1');
	getA.resolve({
		state: localA,
		etag: 'a2',
		userId: userA.id,
		householdId: userA.householdId
	});
	await inFlight;
	assert.equal(writesA, 0);
	assert.equal(sync.state.preferences.allergies, 'sesame');
	assert.equal(sync.controller.snapshot(), null);
	assert.ok(
		[...sync.storage.values.keys()].some(
			(key) =>
				key.startsWith(
					`flavorithm-pending-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:`
				) && sync.storage.values.has(key)
		)
	);
});

test('edits staged during an in-flight save are rebased and then synced without being dropped', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const firstEdit = structuredClone(base);
	firstEdit.preferences.maxTime = 20;
	const latestEdit = structuredClone(firstEdit);
	latestEdit.preferences.allergies = 'walnuts';
	const firstPut = deferred<{ state: AppState; etag: string }>();
	const secondPut = deferred<void>();
	let server = structuredClone(base);
	let putCount = 0;
	const sync = harness({
		user,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: putCount === 0 ? 'v1' : 'v2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				putCount += 1;
				if (putCount === 1) {
					server = structuredClone(state);
					return firstPut.promise;
				}
				server = structuredClone(state);
				secondPut.resolve();
				return { state: structuredClone(server), etag: 'v3' };
			}
		})
	});
	sync.controller.initialize(user, base, 'v1');
	sync.controller.stage(firstEdit);
	const inFlight = sync.controller.sync();
	await Promise.resolve();
	sync.state = latestEdit;
	sync.controller.stage(latestEdit);
	firstPut.resolve({ state: structuredClone(firstEdit), etag: 'v2' });
	await inFlight;
	await secondPut.promise;
	for (let attempt = 0; attempt < 10 && sync.controller.snapshot(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(putCount, 2);
	assert.equal(sync.controller.snapshot(), null);
	assert.equal(sync.state.preferences.maxTime, 20);
	assert.equal(sync.state.preferences.allergies, 'walnuts');
});

test('unresolved conflicts retain the queue until an explicit resolution is chosen', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 20;
	const remote = structuredClone(base);
	remote.preferences.maxTime = 60;
	let writes = 0;
	const sync = harness({
		user,
		transport: () => {
			const transport = transportFor(user, remote, 'v2');
			return {
				...transport,
				put: async (state) => {
					writes += 1;
					return { state, etag: 'v3' };
				}
			};
		}
	});
	sync.controller.initialize(user, base, 'v1');
	sync.controller.stage(local);
	await sync.controller.sync();
	assert.ok(sync.controller.snapshot());
	assert.equal(writes, 0);
	assert.ok(sync.statuses.at(-1)?.conflicts.length);

	await sync.controller.sync('local');
	assert.equal(writes, 1);
	assert.equal(sync.controller.snapshot(), null);
	assert.equal(sync.statuses.at(-1)?.conflicts.length, 0);
});

test('storage failure blocks network sync and reports that the edit was not saved', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 30;
	const storage = memoryStorage();
	const originalSet = storage.setItem;
	storage.setItem = (key, value) => {
		if (key.startsWith('flavorithm-pending-journal:')) throw new Error('Storage full');
		originalSet(key, value);
	};
	let reads = 0;
	const sync = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				reads += 1;
				return { state: base, etag: 'v1', userId: user.id, householdId: user.householdId };
			},
			put: async (state) => ({ state, etag: 'v2' })
		})
	});
	sync.controller.initialize(user, base, 'v1');
	sync.controller.stage(local);
	await sync.controller.sync();
	assert.equal(reads, 0);
	assert.match(sync.statuses.at(-1)?.error || '', /could not be saved|not safely saved/);
});

test('separate offline writers survive destroy and reload, then sync their disjoint changes', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const server = structuredClone(base);
	let writes = 0;
	const transport = () => {
		const connection = transportFor(user, server, 'v1');
		return {
			...connection,
			put: async (state: AppState) => {
				writes += 1;
				server.pantry = structuredClone(state.pantry);
				server.recipes = structuredClone(state.recipes);
				server.meals = structuredClone(state.meals);
				server.shopping = structuredClone(state.shopping);
				server.preferences = structuredClone(state.preferences);
				return { state: structuredClone(server), etag: 'v2' };
			}
		};
	};
	const tabA = harness({ user, storage, transport });
	const tabB = harness({ user, storage, transport });
	tabA.controller.initialize(user, base, 'v1');
	tabB.controller.initialize(user, base, 'v1');
	const editA = structuredClone(base);
	editA.pantry.push({ id: 'tab-a', name: 'rice', quantity: 2, unit: 'cup', category: 'Pantry' });
	const editB = structuredClone(base);
	editB.shopping.push({ id: 'tab-b', name: 'lemons', quantity: 3, unit: 'piece', checked: false });
	tabA.controller.stage(editA);
	tabB.controller.stage(editB);
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		2
	);
	tabA.controller.clearContext();
	tabB.controller.clearContext();

	const reloaded = harness({ user, storage, transport });
	assert.equal(reloaded.controller.restore(user), true);
	assert.deepEqual(
		reloaded.state.pantry.map((item) => item.id),
		['tab-a']
	);
	assert.deepEqual(
		reloaded.state.shopping.map((item) => item.id),
		['tab-b']
	);
	await reloaded.controller.sync();
	assert.equal(writes, 1);
	assert.equal(reloaded.controller.snapshot(), null);
	assert.deepEqual(
		server.pantry.map((item) => item.id),
		['tab-a']
	);
	assert.deepEqual(
		server.shopping.map((item) => item.id),
		['tab-b']
	);
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);
});

test('cross-tab competing edits surface conflicts and do not PUT until a choice is made', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const remote = structuredClone(base);
	let writes = 0;
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(remote),
			etag: 'v1',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			writes += 1;
			remote.preferences = structuredClone(state.preferences);
			return { state, etag: 'v2' };
		}
	});
	const tabA = harness({ user, storage, transport });
	const tabB = harness({ user, storage, transport });
	tabA.controller.initialize(user, base, 'v1');
	tabB.controller.initialize(user, base, 'v1');
	const localA = structuredClone(base);
	localA.preferences.maxTime = 25;
	const localB = structuredClone(base);
	localB.preferences.maxTime = 70;
	tabA.controller.stage(localA);
	tabB.controller.stage(localB);
	tabA.controller.clearContext();
	tabB.controller.clearContext();

	const reloaded = harness({ user, storage, transport });
	reloaded.controller.restore(user);
	assert.ok(reloaded.statuses.at(-1)?.conflicts.length);
	await reloaded.controller.sync();
	assert.equal(writes, 0);
	assert.ok(reloaded.controller.snapshot());
	assert.ok(reloaded.statuses.at(-1)?.conflicts.length);

	await reloaded.controller.sync('local');
	assert.equal(writes, 1);
	assert.equal(reloaded.controller.snapshot(), null);
});

test('an acknowledgement retires only captured journal versions, preserving a peer write made in flight', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const editA = structuredClone(base);
	editA.preferences.maxTime = 20;
	const editB = structuredClone(base);
	editB.pantry.push({ id: 'peer', name: 'oats', quantity: 1, unit: 'bag', category: 'Pantry' });
	const firstPut = deferred<{ state: AppState; etag: string }>();
	const secondGet = deferred<{
		state: AppState;
		etag: string;
		userId: string;
		householdId: string;
	}>();
	let server = structuredClone(base);
	let getCount = 0;
	let putCount = 0;
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => {
			getCount += 1;
			if (getCount === 1)
				return {
					state: structuredClone(server),
					etag: 'v1',
					userId: user.id,
					householdId: user.householdId
				};
			if (getCount === 2) return secondGet.promise;
			return {
				state: structuredClone(server),
				etag: 'v2',
				userId: user.id,
				householdId: user.householdId
			};
		},
		put: async (state: AppState) => {
			putCount += 1;
			if (putCount === 1) return firstPut.promise;
			server = structuredClone(state);
			return { state: structuredClone(server), etag: 'v3' };
		}
	});
	const tabA = harness({ user, storage, transport });
	const tabB = harness({ user, storage, transport });
	tabA.controller.initialize(user, base, 'v1');
	tabB.controller.initialize(user, base, 'v1');
	tabA.controller.stage(editA);
	const inFlight = tabA.controller.sync();
	await Promise.resolve();
	tabB.controller.stage(editB);
	const peerKey = [...storage.values.keys()].find(
		(key) =>
			key.startsWith('flavorithm-pending-journal:') && storage.values.get(key)?.includes('peer')
	);
	if (!peerKey) throw new Error('expected the peer tab to persist its journal entry');
	firstPut.resolve({ state: structuredClone(editA), etag: 'v2' });
	server = structuredClone(editA);
	await inFlight;
	for (let attempt = 0; attempt < 20 && getCount < 2; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(getCount, 2);
	assert.ok(
		storage.getItem(peerKey),
		'the peer journal entry must survive the older acknowledgement'
	);
	secondGet.resolve({
		state: structuredClone(server),
		etag: 'v2',
		userId: user.id,
		householdId: user.householdId
	});
	for (let attempt = 0; attempt < 30 && tabA.controller.snapshot(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(putCount, 2);
	assert.equal(server.preferences.maxTime, 20);
	assert.deepEqual(
		server.pantry.map((item) => item.id),
		['peer']
	);
	assert.equal(storage.getItem(peerKey), null);
});

function eventBus() {
	const listeners = new Map<string, Set<() => void>>();
	return {
		addEventListener: (type: string, listener: () => void) => {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(listener);
		},
		removeEventListener: (type: string, listener: () => void) => {
			listeners.get(type)?.delete(listener);
		},
		emit: (type: string) => {
			for (const listener of [...(listeners.get(type) || [])]) listener();
		}
	};
}

test('coalesced rapid edits emit pending immediately, skip synchronous storage writes while typing, and stage one snapshot after pause', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	let journalWrites = 0;
	const originalSet = storage.setItem;
	storage.setItem = (key, value) => {
		if (key.startsWith('flavorithm-pending-journal:')) journalWrites += 1;
		originalSet(key, value);
	};
	let currentState = structuredClone(base);
	currentState.shopping.push({
		id: 'item-1',
		name: '',
		quantity: 1,
		unit: 'piece',
		checked: false
	});
	const statuses: Array<{ pending: boolean }> = [];
	const controller = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (state) => {
			currentState = structuredClone(state);
		},
		onStatus: (status) => statuses.push({ pending: status.pending }),
		transport: () => transportFor(user, base),
		coalesceMs: 40
	});
	controller.initialize(user, structuredClone(currentState), 'v1');
	statuses.length = 0;

	const typed = 'Strawberries';
	assert.equal(typed.length, 12);
	for (let index = 1; index <= typed.length; index += 1) {
		currentState.shopping[0].name = typed.slice(0, index);
		controller.scheduleStage();
		if (index === 1) {
			assert.equal(statuses.at(-1)?.pending, true);
		}
	}
	assert.equal(
		journalWrites,
		0,
		'zero synchronous journal writes while continuous typing is active'
	);
	assert.equal(statuses.length, 1, 'pending status is emitted once at the start of the burst');

	await new Promise((resolve) => setTimeout(resolve, 70));
	assert.equal(journalWrites, 1, 'exactly one snapshot is staged after typing pauses');
	assert.equal(controller.snapshot()?.local.shopping[0].name, 'Strawberries');
});

test('visibilitychange, pagehide, and beforeunload flush pending guest and journal snapshots synchronously', () => {
	for (const eventName of ['visibilitychange', 'pagehide', 'beforeunload'] as const) {
		const guestStorage = memoryStorage();
		const guestState = createNewUserState();
		const win = eventBus();
		const doc = eventBus();
		const noopSync = createKitchenSync({
			storage: guestStorage,
			getUser: () => null,
			getState: () => guestState,
			setState: () => {},
			onStatus: () => {},
			transport: () => {
				throw new Error('unused');
			},
			coalesceMs: 5000
		});
		const guestPersistence = createKitchenPersistence({
			storage: guestStorage,
			getState: () => guestState,
			getUser: () => null,
			sync: noopSync,
			coalesceMs: 5000
		});
		const unbindGuest = guestPersistence.bindLifecycle(win, doc);
		guestState.pantry.push({
			id: `guest-${eventName}`,
			name: 'olive oil',
			quantity: 2,
			unit: 'tbsp',
			category: 'Pantry'
		});
		guestPersistence.schedule();
		assert.equal(guestStorage.getItem('flavorithm-guest-kitchen'), null);
		if (eventName === 'visibilitychange') doc.emit('visibilitychange');
		else win.emit(eventName);
		const savedGuest = JSON.parse(guestStorage.getItem('flavorithm-guest-kitchen') || 'null');
		assert.equal(savedGuest?.pantry[0]?.id, `guest-${eventName}`);
		unbindGuest();
		guestPersistence.cancel();

		const user = makeUser(`user-${eventName}`, 'home');
		const accountStorage = memoryStorage();
		let accountState = createNewUserState();
		const syncController = createKitchenSync({
			storage: accountStorage,
			getUser: () => user,
			getState: () => accountState,
			setState: (next) => {
				accountState = structuredClone(next);
			},
			onStatus: () => {},
			transport: () => transportFor(user, accountState),
			coalesceMs: 5000
		});
		syncController.initialize(user, structuredClone(accountState), 'v1');
		const accountPersistence = createKitchenPersistence({
			storage: accountStorage,
			getState: () => accountState,
			getUser: () => user,
			sync: syncController,
			coalesceMs: 5000
		});
		const accountWin = eventBus();
		const accountDoc = eventBus();
		const unbindAccount = accountPersistence.bindLifecycle(accountWin, accountDoc);
		accountState.preferences.allergies = `sesame-${eventName}`;
		accountPersistence.schedule();
		assert.equal(
			[...accountStorage.values.keys()].filter((key) =>
				key.startsWith('flavorithm-pending-journal:')
			).length,
			0
		);
		if (eventName === 'visibilitychange') accountDoc.emit('visibilitychange');
		else accountWin.emit(eventName);

		const reloaded = harness({ user, storage: accountStorage });
		assert.equal(reloaded.controller.restore(user), true);
		assert.equal(reloaded.state.preferences.allergies, `sesame-${eventName}`);
		unbindAccount();
		accountPersistence.cancel();
	}
});

test('stage reads peer journal storage once per flush and avoids structuredClone after JSON.parse', () => {
	const user = makeUser();
	const base = createNewUserState();
	const singleWriterStorage = memoryStorage();
	let singleState = structuredClone(base);
	const singleController = createKitchenSync({
		storage: singleWriterStorage,
		getUser: () => user,
		getState: () => singleState,
		setState: (next) => {
			singleState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => transportFor(user, base)
	});
	singleController.initialize(user, base, 'v1');

	singleState = structuredClone(base);
	singleState.pantry.push({
		id: 'single-item',
		name: 'lentils',
		quantity: 1,
		unit: 'bag',
		category: 'Pantry'
	});
	const singleParsed = JSON.parse(JSON.stringify(singleState)) as AppState;
	let clonesOnSingleFlush = 0;
	const originalStructuredClone = globalThis.structuredClone;
	globalThis.structuredClone = (<T>(value: T): T => {
		if ((value as unknown) === singleParsed) clonesOnSingleFlush += 1;
		return originalStructuredClone(value);
	}) as typeof structuredClone;
	try {
		singleController.stage(singleParsed, { clone: false });
	} finally {
		globalThis.structuredClone = originalStructuredClone;
	}
	assert.equal(
		clonesOnSingleFlush,
		0,
		'parsed snapshot is not cloned a second time with structuredClone'
	);

	const peerStorage = memoryStorage();
	const peer = harness({ user, storage: peerStorage });
	peer.controller.initialize(user, base, 'v1');
	const peerEdit = structuredClone(base);
	peerEdit.shopping.push({
		id: 'peer-item',
		name: 'garlic',
		quantity: 3,
		unit: 'cloves',
		checked: false
	});
	peer.controller.stage(peerEdit);

	let peerJournalReads = 0;
	const originalGetItem = peerStorage.getItem;
	peerStorage.getItem = (key) => {
		if (key.startsWith('flavorithm-pending-journal:')) peerJournalReads += 1;
		return originalGetItem(key);
	};

	let currentState = structuredClone(base);
	const controller = createKitchenSync({
		storage: peerStorage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			currentState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => transportFor(user, base)
	});
	controller.initialize(user, base, 'v1');

	currentState = structuredClone(base);
	currentState.pantry.push({
		id: 'own-item',
		name: 'chickpeas',
		quantity: 2,
		unit: 'can',
		category: 'Pantry'
	});
	const parsedSnapshot = JSON.parse(JSON.stringify(currentState)) as AppState;

	peerJournalReads = 0;
	controller.stage(parsedSnapshot, { clone: false });
	assert.equal(
		peerJournalReads,
		1,
		'stored peer journal entries are read once during stage rather than twice'
	);
});

test('finishing sync skips setState when server state matches active kitchen and flushes coalesced in-flight edits before rebasing', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const firstEdit = structuredClone(base);
	firstEdit.preferences.maxTime = 25;
	let server = structuredClone(base);
	const syncMatching = harness({
		user,
		initial: base,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				server = structuredClone(state);
				return { state: structuredClone(server), etag: 'v2' };
			}
		})
	});
	syncMatching.controller.initialize(user, base, 'v1');
	syncMatching.setStates.length = 0;
	syncMatching.state = firstEdit;
	syncMatching.controller.stage(firstEdit);
	await syncMatching.controller.sync();
	assert.equal(
		syncMatching.setStates.length,
		0,
		'setState is skipped when synced state already matches active kitchen'
	);

	// Verify setState IS called when the server has an independent remote delta.
	server.shopping.push({
		id: 'remote-item',
		name: 'milk',
		quantity: 1,
		unit: 'carton',
		checked: false
	});
	const secondLocal = structuredClone(syncMatching.state);
	secondLocal.preferences.allergies = 'hazelnuts';
	syncMatching.state = secondLocal;
	syncMatching.controller.stage(secondLocal);
	await syncMatching.controller.sync();
	assert.equal(syncMatching.setStates.length, 1);
	assert.equal(syncMatching.state.shopping[0]?.id, 'remote-item');
	assert.equal(syncMatching.state.preferences.allergies, 'hazelnuts');

	// Now verify an in-flight coalesced (unflushed) edit is flushed before post-sync rebasing and never overwritten.
	const firstPutEntered = deferred<void>();
	const firstPut = deferred<{ state: AppState; etag: string }>();
	const secondPut = deferred<void>();
	let putCount = 0;
	let inFlightServer = structuredClone(base);
	let liveState = structuredClone(base);
	const setStateCalls: AppState[] = [];
	const controller = createKitchenSync({
		storage: memoryStorage(),
		getUser: () => user,
		getState: () => liveState,
		setState: (next) => {
			liveState = structuredClone(next);
			setStateCalls.push(structuredClone(next));
		},
		onStatus: () => {},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(inFlightServer),
				etag: putCount === 0 ? 'v1' : 'v2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				putCount += 1;
				inFlightServer = structuredClone(state);
				if (putCount === 1) {
					firstPutEntered.resolve();
					return firstPut.promise;
				}
				secondPut.resolve();
				return { state: structuredClone(inFlightServer), etag: 'v3' };
			}
		}),
		coalesceMs: 5000
	});
	controller.initialize(user, base, 'v1');
	setStateCalls.length = 0;
	liveState.preferences.maxTime = 30;
	controller.stage(structuredClone(liveState));
	const activeSync = controller.sync();
	await firstPutEntered.promise;

	// User types while PUT #1 is in flight; coalesce timer (5000 ms) has NOT fired yet.
	liveState.preferences.allergies = 'pistachios';
	controller.scheduleStage();
	assert.equal(controller.hasUnflushed(), true);

	firstPut.resolve({ state: structuredClone(inFlightServer), etag: 'v2' });
	await activeSync;
	await secondPut.promise;
	for (let attempt = 0; attempt < 10 && controller.snapshot(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.equal(putCount, 2);
	assert.equal(liveState.preferences.maxTime, 30);
	assert.equal(liveState.preferences.allergies, 'pistachios');
	assert.equal(inFlightServer.preferences.allergies, 'pistachios');
	assert.equal(
		setStateCalls.length,
		0,
		'live kitchen proxy was never overwritten during rebase or completion'
	);
});

test('snapshot flushes pending edits for export and clearContext cancels pending timers on auth changes', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	let liveState = structuredClone(base);
	const controller = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => liveState,
		setState: (next) => {
			liveState = structuredClone(next);
		},
		onStatus: () => {},
		transport: () => transportFor(user, base),
		coalesceMs: 5000
	});
	controller.initialize(user, base, 'v1');
	liveState.preferences.diet = 'vegan';
	controller.scheduleStage();
	assert.equal(controller.snapshot()?.local.preferences.diet, 'vegan');

	// Schedule another edit, then clearContext as on logout before coalesceMs elapses.
	const storage2 = memoryStorage();
	let currentUser: User | null = user;
	let state2 = structuredClone(base);
	const controller2 = createKitchenSync({
		storage: storage2,
		getUser: () => currentUser,
		getState: () => state2,
		setState: () => {},
		onStatus: () => {},
		transport: () => transportFor(user, base),
		coalesceMs: 30
	});
	controller2.initialize(user, base, 'v1');
	state2.preferences.allergies = 'shellfish';
	controller2.scheduleStage();
	currentUser = null;
	controller2.clearContext();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(
		[...storage2.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0,
		'cancelled coalesce timer never writes after logout'
	);
});
