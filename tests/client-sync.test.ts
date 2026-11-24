import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createNewUserState, seedRecipes } from '../src/lib/data.ts';
import { createKitchenSync, type SyncStatus } from '../src/lib/client-sync.ts';
import { MAX_RECIPES } from '../src/lib/recipe-collection.ts';
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
	sessionStorage?: ReturnType<typeof memoryStorage>;
	writerId?: string;
	now?: () => number;
	leaseTtlMs?: number;
	transport?: (user: User) => KitchenTransport;
	initial?: AppState;
}) {
	const storage = args.storage || memoryStorage();
	let currentUser = args.user;
	let currentState = structuredClone(args.initial || createNewUserState());
	const statuses: SyncStatus[] = [];
	const setStates: AppState[] = [];
	const controller = createKitchenSync({
		storage,
		sessionStorage: args.sessionStorage,
		writerId: args.writerId,
		now: args.now,
		leaseTtlMs: args.leaseTtlMs,
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

function quotaMemoryStorage(maxBytes: number) {
	const values = new Map<string, string>();
	let peakBytes = 0;
	const currentBytes = () =>
		[...values.entries()].reduce(
			(sum, [k, v]) => sum + Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8'),
			0
		);
	return {
		values,
		get bytes() {
			return currentBytes();
		},
		get peakBytes() {
			return peakBytes;
		},
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			const previous = values.get(key);
			values.set(key, value);
			const total = currentBytes();
			if (total > maxBytes) {
				if (previous === undefined) values.delete(key);
				else values.set(key, previous);
				throw new Error('QuotaExceededError');
			}
			if (total > peakBytes) peakBytes = total;
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}

test('staging edits across 65 offline reloads keeps 1 journal entry and fits within 5 MiB for 250 recipes', () => {
	const user = makeUser();
	const base = createNewUserState();
	base.recipes = Array.from({ length: MAX_RECIPES }, (_, index) => ({
		...structuredClone(seedRecipes[index % seedRecipes.length]),
		id: `recipe-${index}`
	}));
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 100, unit: 'cup', category: 'Pantry' }];
	const fiveMiB = 5 * 1024 * 1024;

	// Case 1: Reopen cycles without sessionStorage (unleased ancestor compaction)
	const reopenStorage = quotaMemoryStorage(fiveMiB);
	const initial = harness({ user, storage: reopenStorage, initial: base });
	initial.controller.initialize(user, base, 'v1');
	const firstEdit = structuredClone(base);
	firstEdit.pantry[0].quantity = 99;
	initial.controller.stage(firstEdit);
	initial.controller.releaseLease();

	for (let reload = 1; reload <= 65; reload += 1) {
		const reopened = harness({ user, storage: reopenStorage });
		assert.equal(reopened.controller.restore(user), true);
		assert.equal(reopened.state.pantry[0].quantity, 100 - reload);
		const next = structuredClone(reopened.state);
		next.pantry[0].quantity = 100 - reload - 1;
		reopened.controller.stage(next);
		assert.equal(reopened.statuses.at(-1)?.error, '');
		const journalKeys = [...reopenStorage.values.keys()].filter((key) =>
			key.startsWith('flavorithm-pending-journal:')
		);
		assert.equal(journalKeys.length, 1);
		reopened.controller.releaseLease();
	}
	assert.ok(reopenStorage.peakBytes < fiveMiB);

	// Case 2: Same-tab reloads with shared sessionStorage still mint unique context writerIds and compact released slots
	const reloadStorage = quotaMemoryStorage(fiveMiB);
	const tabSession = memoryStorage();
	const mounted = harness({
		user,
		storage: reloadStorage,
		sessionStorage: tabSession,
		initial: base
	});
	mounted.controller.initialize(user, base, 'v1');
	mounted.controller.stage(firstEdit);
	mounted.controller.releaseLease();

	for (let reload = 1; reload <= 65; reload += 1) {
		const reloaded = harness({ user, storage: reloadStorage, sessionStorage: tabSession });
		assert.equal(reloaded.controller.restore(user), true);
		const next = structuredClone(reloaded.state);
		next.pantry[0].quantity = 100 - reload - 1;
		reloaded.controller.stage(next);
		const journalKeys = [...reloadStorage.values.keys()].filter((key) =>
			key.startsWith('flavorithm-pending-journal:')
		);
		assert.equal(journalKeys.length, 1);
		reloaded.controller.releaseLease();
	}
	assert.ok(reloadStorage.peakBytes < fiveMiB);
});

test('duplicated tabs keep distinct writer slots even after a frozen tab lease lapses and never lose live edits', async () => {
	let clock = 1_000;
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const sharedSession = memoryStorage();
	let server = structuredClone(base);
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v1',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			server = structuredClone(state);
			return { state: structuredClone(server), etag: 'v2' };
		}
	});

	const tabA = harness({
		user,
		storage,
		sessionStorage: sharedSession,
		now: () => clock,
		leaseTtlMs: 120_000,
		transport
	});
	tabA.controller.initialize(user, base, 'v1');
	const editA = structuredClone(base);
	editA.pantry.push({ id: 'tab-a', name: 'oats', quantity: 2, unit: 'cup', category: 'Pantry' });
	tabA.controller.stage(editA);
	const [slotA] = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.ok(slotA);

	// Freeze tabA past its 120s lease TTL without releasing or closing it, then duplicate tabA sharing sessionStorage.
	clock += 180_000;
	const tabB = harness({
		user,
		storage,
		sessionStorage: sharedSession,
		now: () => clock,
		leaseTtlMs: 120_000,
		transport
	});
	assert.equal(tabB.controller.restore(user), true);
	const editB = structuredClone(tabB.state);
	editB.shopping.push({ id: 'tab-b', name: 'tea', quantity: 1, unit: 'box', checked: false });
	tabB.controller.stage(editB);
	const [slotB] = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.ok(slotB);
	assert.notEqual(slotB, slotA, 'duplicated tab must never adopt a frozen live tab writerId');

	// Now tabA wakes up from freeze and stages another edit (removing oats and adding almonds), while tabB also edits.
	clock += 1_000;
	const editA2 = structuredClone(base);
	editA2.pantry.push({
		id: 'almonds',
		name: 'almonds',
		quantity: 1,
		unit: 'bag',
		category: 'Pantry'
	});
	tabA.controller.stage(editA2);

	clock += 1_000;
	const editB2 = structuredClone(editB);
	editB2.shopping[0].quantity = 3;
	tabB.controller.stage(editB2);

	const liveJournalKeys = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.equal(liveJournalKeys.length, 2);
	assert.ok(liveJournalKeys.includes(slotA));
	assert.ok(liveJournalKeys.includes(slotB));

	// Syncing reconciles both live slots: tabA's oats deletion + almonds addition and tabB's tea quantity 3 survive.
	await tabB.controller.sync();
	assert.deepEqual(
		server.pantry.map((item) => item.id),
		['almonds']
	);
	assert.equal(server.shopping.find((item) => item.id === 'tab-b')?.quantity, 3);
});

test('active foreign leases protect live peer journal slots until released', () => {
	let clock = 1_000;
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();

	const tabA = harness({
		user,
		storage,
		now: () => clock,
		leaseTtlMs: 10_000
	});
	tabA.controller.initialize(user, base, 'v1');
	const editA = structuredClone(base);
	editA.pantry.push({ id: 'tab-a', name: 'oats', quantity: 2, unit: 'cup', category: 'Pantry' });
	tabA.controller.stage(editA);

	clock += 5_000;
	tabA.controller.refreshLease();
	clock += 6_000; // Past original 10s window, but within refreshed lease window.

	const tabB = harness({
		user,
		storage,
		now: () => clock,
		leaseTtlMs: 10_000
	});
	assert.equal(tabB.controller.restore(user), true);
	const editB = structuredClone(tabB.state);
	editB.shopping.push({ id: 'tab-b', name: 'tea', quantity: 1, unit: 'box', checked: false });
	tabB.controller.stage(editB);

	const journalKeysWhileLive = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.equal(journalKeysWhileLive.length, 2);

	tabA.controller.clearContext();
	const editB2 = structuredClone(editB);
	editB2.shopping[0].quantity = 2;
	tabB.controller.stage(editB2);

	const journalKeysAfterClose = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.equal(journalKeysAfterClose.length, 1);
	assert.deepEqual(tabB.controller.snapshot()?.base, base);
	assert.deepEqual(
		tabB.controller.snapshot()?.local.pantry.map((item) => item.id),
		['tab-a']
	);
});

test('compacted reverts remove the writer journal entry when matching baseline and sync cleanly against household changes', async () => {
	const user = makeUser();
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const storage = memoryStorage();

	const first = harness({ user, storage });
	first.controller.initialize(user, base, 'v1');
	const deducted = structuredClone(base);
	deducted.pantry[0].quantity = 3;
	first.controller.stage(deducted);
	first.controller.clearContext();

	// Reload and revert completely back to confirmed baseline: journal entry must be removed.
	const revertedTab = harness({ user, storage });
	assert.equal(revertedTab.controller.restore(user), true);
	revertedTab.controller.stage(structuredClone(base));
	assert.equal(revertedTab.controller.snapshot(), null);
	assert.equal(revertedTab.statuses.at(-1)?.pending, false);
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);

	// Chained 4 -> 3 (+ new item) -> 4 across reload against server 2 merges with 0 conflicts.
	const withItem = structuredClone(deducted);
	withItem.pantry.push({ id: 'salt', name: 'salt', quantity: 1, unit: 'box', category: 'Pantry' });
	revertedTab.controller.stage(withItem);
	revertedTab.controller.clearContext();

	const server = structuredClone(base);
	server.pantry[0].quantity = 2;
	let puts = 0;
	const secondReload = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'v2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				puts += 1;
				server.pantry = structuredClone(state.pantry);
				return { state: structuredClone(server), etag: 'v3' };
			}
		})
	});
	secondReload.controller.restore(user);
	const revertedQuantity = structuredClone(secondReload.state);
	revertedQuantity.pantry.find((item) => item.id === 'flour')!.quantity = 4;
	secondReload.controller.stage(revertedQuantity);

	await secondReload.controller.sync();
	assert.equal(puts, 1);
	assert.equal(secondReload.statuses.at(-1)?.conflicts.length, 0);
	assert.equal(server.pantry.find((item) => item.id === 'flour')?.quantity, 2);
	assert.ok(server.pantry.some((item) => item.id === 'salt'));
});

test('chained reload edits detect intermediate household collisions and honor sync(remote)', async () => {
	const user = makeUser();
	const base = createNewUserState();
	base.meals = [
		{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: base.recipes[0].id, servings: 2 }
	];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const storage = memoryStorage();
	const server = structuredClone(base);
	server.meals[0].servings = 4;
	server.pantry[0].quantity = 3;
	let puts = 0;
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v2',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			puts += 1;
			server.meals = structuredClone(state.meals);
			server.pantry = structuredClone(state.pantry);
			return { state: structuredClone(server), etag: 'v3' };
		}
	});

	const first = harness({ user, storage, transport });
	first.controller.initialize(user, base, 'v1');
	const stepOne = structuredClone(base);
	stepOne.meals[0].servings = 4;
	stepOne.pantry[0].quantity = 3;
	stepOne.pantry.push({ id: 'rice', name: 'rice', quantity: 1, unit: 'bag', category: 'Pantry' });
	first.controller.stage(stepOne);
	first.controller.clearContext();

	const second = harness({ user, storage, transport });
	second.controller.restore(user);
	const stepTwo = structuredClone(second.state);
	stepTwo.meals[0].servings = 6;
	stepTwo.pantry[0].quantity = 1;
	second.controller.stage(stepTwo);

	await second.controller.sync();
	assert.equal(puts, 0);
	assert.equal(second.statuses.at(-1)?.conflicts.length, 2);

	await second.controller.sync('remote');
	assert.equal(puts, 1);
	assert.equal(server.meals[0].servings, 4);
	assert.equal(server.pantry.find((item) => item.id === 'flour')?.quantity, 3);
	assert.ok(server.pantry.some((item) => item.id === 'rice'));
});

test('reconnecting skips reactive echo calls while real user reverts clear or update pending journal edits', async () => {
	const user = makeUser();
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'Flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const storage = memoryStorage();
	const server = structuredClone(base);
	server.pantry[0].quantity = 3;
	server.pantry.push({ id: 'beans', name: 'Beans', quantity: 2, unit: 'can', category: 'Pantry' });
	let puts = 0;
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v2',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			puts += 1;
			server.pantry = structuredClone(state.pantry);
			server.preferences = structuredClone(state.preferences);
			return { state: structuredClone(server), etag: 'v3' };
		}
	});

	const tab = harness({ user, storage, transport });
	tab.controller.initialize(user, base, 'v1');
	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	tab.controller.stage(stepOne);
	tab.controller.releaseLease();

	const reloaded = harness({ user, storage, transport });
	reloaded.controller.restore(user);
	const stepTwo = structuredClone(reloaded.state);
	stepTwo.pantry[0].quantity = 1;
	reloaded.controller.stage(stepTwo);

	// 1. Reconnect: initialize sets UI state (merging beans: 2 alongside local flour: 1), and Svelte $effect echoes stage(..., { echo: true }).
	reloaded.controller.initialize(user, server, 'v2');
	reloaded.controller.stage(structuredClone(reloaded.state), { echo: true });
	await reloaded.controller.sync();

	assert.equal(puts, 0);
	assert.equal(reloaded.statuses.at(-1)?.conflicts.length, 1);
	assert.equal(reloaded.statuses.at(-1)?.conflicts[0].local, 1);
	assert.equal(reloaded.statuses.at(-1)?.conflicts[0].remote, 3);

	// 2. Real user revert to server state (no echo flag):
	// retires the offline journal entry so a subsequent sync('local') does not push 1.
	assert.equal(reloaded.state.pantry.find((item) => item.id === 'flour')?.quantity, 1);
	assert.equal(reloaded.state.pantry.find((item) => item.id === 'beans')?.quantity, 2);
	reloaded.controller.stage(structuredClone(server));
	assert.equal(reloaded.controller.snapshot(), null);
	assert.equal(reloaded.statuses.at(-1)?.pending, false);
	assert.equal(reloaded.statuses.at(-1)?.conflicts.length, 0);
	await reloaded.controller.sync('local');
	assert.equal(puts, 0);
	assert.equal(server.pantry.find((item) => item.id === 'flour')?.quantity, 3);

	// 2b. Two-conflict reconnect where user reverts flour to server's 3 while keeping allergies = 'sesame',
	// then resolves remaining conflict via sync('local'): pushes allergies = 'sesame' and flour = 3 (not 1).
	const dualStorage = memoryStorage();
	let dualServer = structuredClone(base);
	dualServer.pantry[0].quantity = 3;
	dualServer.preferences.allergies = 'peanuts';
	let dualPuts = 0;
	const dualTab = harness({
		user,
		storage: dualStorage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(dualServer),
				etag: 'd2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state: AppState) => {
				dualPuts += 1;
				dualServer = structuredClone(state);
				return { state: structuredClone(dualServer), etag: 'd3' };
			}
		})
	});
	dualTab.controller.initialize(user, base, 'd1');
	const dualOffline = structuredClone(base);
	dualOffline.pantry[0].quantity = 1;
	dualOffline.preferences.allergies = 'sesame';
	dualTab.controller.stage(dualOffline);
	dualTab.controller.initialize(user, dualServer, 'd2');
	dualTab.controller.stage(structuredClone(dualTab.state), { echo: true });
	assert.equal(dualTab.statuses.at(-1)?.conflicts.length, 2);

	const revertFlourKeepAllergies = structuredClone(dualTab.state);
	revertFlourKeepAllergies.pantry[0].quantity = 3;
	revertFlourKeepAllergies.preferences.allergies = 'sesame';
	dualTab.controller.stage(revertFlourKeepAllergies);
	assert.equal(dualTab.statuses.at(-1)?.conflicts.length, 1);
	assert.equal(dualTab.statuses.at(-1)?.conflicts[0].path, 'kitchen.preferences.allergies');
	await dualTab.controller.sync('local');
	assert.equal(dualPuts, 1);
	assert.equal(dualServer.pantry.find((item) => item.id === 'flour')?.quantity, 3);
	assert.equal(dualServer.preferences.allergies, 'sesame');
	assert.equal(dualTab.controller.snapshot(), null);

	// 3. Even when viewState already equals the displayed value (because a newer leased peer tab staged 60 while own slot holds 20),
	// a real user revert to that displayed value retires own's stale 20 instead of being swallowed as an echo.
	let clock = 5_000;
	const peerStorage = memoryStorage();
	let peerServer = structuredClone(base);
	peerServer.preferences.maxTime = 45;
	let peerPuts = 0;
	const peerTransport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(peerServer),
			etag: 'p2',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			peerPuts += 1;
			peerServer = structuredClone(state);
			return { state: structuredClone(peerServer), etag: 'p3' };
		}
	});
	const peerInitial = structuredClone(peerServer);
	const tabOwn = harness({
		user,
		storage: peerStorage,
		now: () => clock,
		transport: peerTransport
	});
	const tabPeer = harness({
		user,
		storage: peerStorage,
		now: () => clock,
		transport: peerTransport
	});
	tabOwn.controller.initialize(user, peerInitial, 'p1');
	tabPeer.controller.initialize(user, peerInitial, 'p1');

	const ownOffline = structuredClone(peerInitial);
	ownOffline.preferences.maxTime = 20;
	tabOwn.controller.stage(ownOffline);

	clock += 10;
	const peerOffline = structuredClone(peerInitial);
	peerOffline.preferences.maxTime = 60;
	tabPeer.controller.stage(peerOffline);

	// Server also reached 60; reconnecting tabOwn sets tabOwn.state (viewState) to 60 while tabOwn's own slot still has 20.
	peerServer.preferences.maxTime = 60;
	tabOwn.controller.initialize(user, peerServer, 'p2');
	assert.equal(tabOwn.state.preferences.maxTime, 60);
	tabOwn.controller.stage(structuredClone(tabOwn.state), { echo: true });
	assert.equal(tabOwn.statuses.at(-1)?.conflicts.length, 1);

	// User explicitly reverts tabOwn to the displayed 60 (no echo flag): own slot (20) is retired immediately, leaving only tabPeer's 60.
	assert.equal(
		[...peerStorage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		2
	);
	tabOwn.controller.stage(structuredClone(tabOwn.state));
	assert.equal(
		[...peerStorage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		1
	);
	assert.equal(tabOwn.statuses.at(-1)?.conflicts.length, 0);
	await tabOwn.controller.sync();
	assert.equal(peerPuts, 1);
	assert.equal(peerServer.preferences.maxTime, 60);
	assert.equal(tabOwn.controller.snapshot(), null);

	// 4. Partial revert after reconnect: reverting conflicted flour (1 -> 3) while keeping disjoint offline rice addition clears conflict and syncs cleanly.
	const partialStorage = memoryStorage();
	let partialServer = structuredClone(base);
	partialServer.pantry[0].quantity = 3;
	let partialPuts = 0;
	const partialTab = harness({
		user,
		storage: partialStorage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(partialServer),
				etag: 'v2',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state: AppState) => {
				partialPuts += 1;
				partialServer = structuredClone(state);
				return { state: structuredClone(partialServer), etag: 'v3' };
			}
		})
	});
	partialTab.controller.initialize(user, base, 'v1');
	const offlineWithRice = structuredClone(base);
	offlineWithRice.pantry[0].quantity = 1;
	offlineWithRice.pantry.push({
		id: 'rice',
		name: 'Rice',
		quantity: 1,
		unit: 'bag',
		category: 'Pantry'
	});
	partialTab.controller.stage(offlineWithRice);
	partialTab.controller.initialize(user, partialServer, 'v2');
	partialTab.controller.stage(structuredClone(partialTab.state), { echo: true });
	assert.equal(partialTab.statuses.at(-1)?.conflicts.length, 1);

	const revertedFlourKeepingRice = structuredClone(partialTab.state);
	revertedFlourKeepingRice.pantry.find((item) => item.id === 'flour')!.quantity = 3;
	partialTab.controller.stage(revertedFlourKeepingRice);
	assert.equal(partialTab.statuses.at(-1)?.conflicts.length, 0);
	assert.equal(partialTab.statuses.at(-1)?.pending, true);
	await partialTab.controller.sync();
	assert.equal(partialPuts, 1);
	assert.equal(partialServer.pantry.find((item) => item.id === 'flour')?.quantity, 3);
	assert.ok(partialServer.pantry.some((item) => item.id === 'rice'));
});

test('compaction re-reads confirmedKey from storage instead of anchoring to a stale cross-tab in-memory baseline', async () => {
	let clock = 1_000;
	const user = makeUser();
	const s0 = createNewUserState();
	s0.preferences.maxTime = 60;
	const storage = memoryStorage();
	let server = structuredClone(s0);
	let currentEtag = 'v1';

	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(server),
			etag: currentEtag,
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			server = structuredClone(state);
			currentEtag = currentEtag === 'v1' ? 'v2' : 'v3';
			return { state: structuredClone(server), etag: currentEtag };
		}
	});

	// Tab A loads S0 (maxTime = 60, etag = 'v1') and keeps it in its in-memory baselines map.
	const tabA = harness({ user, storage, now: () => clock, transport });
	tabA.controller.initialize(user, s0, 'v1');

	// Tab B updates maxTime to 45 and syncs -> confirmedKey in storage advances to S1 (maxTime = 45, etag = 'v2').
	clock += 10;
	const tabB = harness({ user, storage, now: () => clock, transport });
	tabB.controller.initialize(user, s0, 'v1');
	const s1Edit = structuredClone(s0);
	s1Edit.preferences.maxTime = 45;
	tabB.controller.stage(s1Edit);
	await tabB.controller.sync();
	assert.equal(server.preferences.maxTime, 45);
	assert.equal(currentEtag, 'v2');

	// Tab B goes offline, edits maxTime back to 60 (matching Tab A's stale S0!) and closes.
	clock += 10;
	const offlineBackTo60 = structuredClone(server);
	offlineBackTo60.preferences.maxTime = 60;
	tabB.controller.stage(offlineBackTo60);
	tabB.controller.clearContext();

	// Part A: Tab A restores and stages an additional item while maxTime is 60.
	// If Tab A used its stale S0 (maxTime = 60, v1), it would drop maxTime: 45 -> 60 or anchor to v1.
	clock += 10;
	assert.equal(tabA.controller.restore(user), true);
	assert.equal(tabA.state.preferences.maxTime, 60);
	const withTea = structuredClone(tabA.state);
	withTea.shopping.push({ id: 'tea', name: 'tea', quantity: 1, unit: 'box', checked: false });
	tabA.controller.stage(withTea);

	const snap = tabA.controller.snapshot();
	assert.ok(snap);
	assert.equal(snap.etag, 'v2');
	assert.equal(snap.base.preferences.maxTime, 45);
	assert.equal(snap.local.preferences.maxTime, 60);

	// Part B: Even an already-mounted active controller (without calling restore/activate) re-reads confirmedKey in findCompactionPlan.
	const storage2 = memoryStorage();
	const activeTab = harness({ user, storage: storage2, now: () => clock, transport });
	activeTab.controller.initialize(user, s0, 'v1');
	const stepTo30 = structuredClone(s0);
	stepTo30.preferences.maxTime = 30;
	activeTab.controller.stage(stepTo30);

	// Another tab confirms maxTime = 30 at etag 'v2' in storage while activeTab stays mounted with stale ('v1', maxTime = 60) in memory.
	const peerSynced = harness({ user, storage: storage2, now: () => clock, transport });
	peerSynced.controller.initialize(user, stepTo30, 'v2');
	peerSynced.controller.clearContext();

	// activeTab now edits maxTime from 30 back to 60 without calling restore/initialize; it must not treat 60 as reverting to stale v1!
	const backTo60 = structuredClone(stepTo30);
	backTo60.preferences.maxTime = 60;
	activeTab.controller.stage(backTo60);
	const activeSnap = activeTab.controller.snapshot();
	assert.ok(activeSnap);
	assert.equal(activeSnap.etag, 'v2');
	assert.equal(activeSnap.base.preferences.maxTime, 30);
	assert.equal(activeSnap.local.preferences.maxTime, 60);
});

test('partial retire failure when removeItem throws keeps leftover ancestors folded with 0 spurious pantry conflicts', async () => {
	let clock = 1_000;
	const user = makeUser();
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const storage = memoryStorage();
	let blockJournalRemove = false;
	const originalRemoveItem = storage.removeItem;
	storage.removeItem = (key: string) => {
		if (blockJournalRemove && key.startsWith('flavorithm-pending-journal:')) {
			throw new Error('Blocked journal removeItem');
		}
		originalRemoveItem(key);
	};

	let server = structuredClone(base);
	let puts = 0;
	const transport = () => ({
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v1',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state: AppState) => {
			puts += 1;
			server = structuredClone(state);
			return { state: structuredClone(server), etag: 'v2' };
		}
	});

	// Tab 1 stages flour: 4 -> 3 and closes.
	const tab1 = harness({ user, storage, now: () => clock, transport });
	tab1.controller.initialize(user, base, 'v1');
	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	tab1.controller.stage(stepOne);
	tab1.controller.clearContext();

	// Block removeItem so retiring Tab 1's ancestor fails after Tab 2 writes its compacted record.
	blockJournalRemove = true;
	clock += 10;
	const tab2 = harness({ user, storage, now: () => clock, transport });
	assert.equal(tab2.controller.restore(user), true);
	const stepTwo = structuredClone(tab2.state);
	stepTwo.pantry.push({ id: 'rice', name: 'rice', quantity: 1, unit: 'bag', category: 'Pantry' });
	tab2.controller.stage(stepTwo);

	const journalKeys = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.equal(journalKeys.length, 2, 'both compacted and unretired ancestor keys remain');
	assert.match(tab2.statuses.at(-1)?.error || '', /could not be retired/i);
	assert.equal(
		tab2.statuses.at(-1)?.conflicts.length,
		0,
		'leftover ancestor must not trigger concurrentPantryQuantity conflict'
	);
	tab2.controller.clearContext();

	// Reload into Tab 3 while removeItem still fails, chain another deduction (3 -> 1), then revert (1 -> 4) against server 2.
	clock += 10;
	const tab3 = harness({ user, storage, now: () => clock, transport });
	assert.equal(tab3.controller.restore(user), true);
	assert.equal(tab3.statuses.at(-1)?.conflicts.length, 0);
	const stepThree = structuredClone(tab3.state);
	stepThree.pantry.find((item) => item.id === 'flour')!.quantity = 1;
	tab3.controller.stage(stepThree);
	assert.equal(tab3.statuses.at(-1)?.conflicts.length, 0);

	const stepFourRevert = structuredClone(stepThree);
	stepFourRevert.pantry.find((item) => item.id === 'flour')!.quantity = 4;
	tab3.controller.stage(stepFourRevert);
	assert.equal(tab3.statuses.at(-1)?.conflicts.length, 0);

	// Server changed flour to 2; syncing after removeItem recovers must commit flour = 2 + rice with 0 conflicts and retire all keys.
	server.pantry[0].quantity = 2;
	blockJournalRemove = false;
	await tab3.controller.sync();
	assert.equal(puts, 1);
	assert.equal(tab3.statuses.at(-1)?.conflicts.length, 0);
	assert.equal(server.pantry.find((item) => item.id === 'flour')?.quantity, 2);
	assert.ok(server.pantry.some((item) => item.id === 'rice'));
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);
});

test('prepare, failLoad, and clearContext keep ready false until baseline confirmation', () => {
	const user = makeUser();
	const staleGuest = createInitialState();
	staleGuest.pantry.push({
		id: 'stale-item',
		name: 'leftover kale',
		quantity: 1,
		unit: 'bunch',
		category: 'Produce'
	});
	const sync = harness({ user, initial: staleGuest });
	assert.equal(sync.controller.prepare(user), true);
	assert.deepEqual(sync.state, createNewUserState());
	assert.deepEqual(sync.statuses.at(-1), {
		ready: false,
		pending: false,
		syncing: true,
		conflicts: [],
		reviewedEtag: null,
		error: ''
	});

	sync.controller.failLoad('Kitchen unavailable');
	assert.deepEqual(sync.statuses.at(-1), {
		ready: false,
		pending: false,
		syncing: false,
		conflicts: [],
		reviewedEtag: null,
		error: 'Kitchen unavailable'
	});

	// An unchanged stage call from a reactive effect must not erase the load error.
	sync.controller.stage(sync.state);
	assert.equal(sync.statuses.at(-1)?.ready, false);
	assert.equal(sync.statuses.at(-1)?.error, 'Kitchen unavailable');

	sync.controller.initialize(user, createNewUserState(), 'v1');
	assert.equal(sync.statuses.at(-1)?.ready, true);
	assert.equal(sync.statuses.at(-1)?.syncing, false);
	assert.equal(sync.statuses.at(-1)?.error, '');

	sync.controller.clearContext();
	assert.deepEqual(sync.statuses.at(-1), {
		ready: false,
		pending: false,
		syncing: false,
		conflicts: [],
		reviewedEtag: null,
		error: ''
	});
});

test('unconfirmed edits stage against createNewUserState, export via snapshot, and merge with remote state', async () => {
	const user = makeUser('user-join', 'shared-home');
	const priorHouseholdState = createNewUserState();
	priorHouseholdState.pantry.push({
		id: 'old-home-item',
		name: 'saffron',
		quantity: 1,
		unit: 'pinch',
		category: 'Spices'
	});
	const remoteHouseholdState = createNewUserState();
	remoteHouseholdState.pantry.push({
		id: 'shared-beans',
		name: 'black beans',
		quantity: 2,
		unit: 'can',
		category: 'Canned goods'
	});
	remoteHouseholdState.preferences.allergies = 'shellfish';

	const storage = memoryStorage();
	let server = structuredClone(remoteHouseholdState);
	const sync = harness({
		user,
		storage,
		initial: priorHouseholdState,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'shared-v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (next) => {
				server = structuredClone(next);
				return { state: structuredClone(server), etag: 'shared-v2' };
			}
		})
	});

	sync.controller.prepare(user);
	assert.equal(sync.state.pantry.length, 0);
	sync.controller.failLoad('503 Service Unavailable');
	assert.equal(sync.statuses.at(-1)?.ready, false);

	const provisionalEdit = structuredClone(sync.state);
	provisionalEdit.shopping.push({
		id: 'new-milk',
		name: 'oat milk',
		quantity: 1,
		unit: 'carton',
		checked: false
	});
	provisionalEdit.preferences.maxTime = 25;
	sync.controller.stage(provisionalEdit);

	const journalKeys = [...storage.values.keys()].filter((key) =>
		key.startsWith(
			`flavorithm-pending-journal:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(user.householdId)}:`
		)
	);
	assert.equal(journalKeys.length, 1);

	const exported = sync.controller.snapshot();
	assert.ok(exported);
	assert.equal(exported.etag, null);
	assert.deepEqual(exported.base, createNewUserState());
	assert.deepEqual(
		exported.local.shopping.map((item) => item.id),
		['new-milk']
	);

	await sync.controller.sync();
	assert.equal(sync.statuses.at(-1)?.ready, true);
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.equal(sync.statuses.at(-1)?.error, '');
	assert.equal(sync.controller.snapshot(), null);
	assert.deepEqual(
		server.pantry.map((item) => item.id),
		['shared-beans']
	);
	assert.deepEqual(
		server.shopping.map((item) => item.id),
		['new-milk']
	);
	assert.equal(server.preferences.allergies, 'shellfish');
	assert.equal(server.preferences.maxTime, 25);
});

test('guest signup staged into a provisional context keeps all guest items when GET /api/state fails', async () => {
	const user = makeUser('new-account', 'new-household');
	const guestKitchen = createInitialState();
	guestKitchen.pantry.push({
		id: 'guest-tahini',
		name: 'tahini',
		quantity: 1,
		unit: 'jar',
		category: 'Oils & condiments'
	});
	guestKitchen.shopping.push({
		id: 'guest-lemons',
		name: 'lemons',
		quantity: 4,
		unit: 'whole',
		checked: false
	});
	guestKitchen.preferences.diet = 'vegetarian';

	const storage = memoryStorage();
	let server = createNewUserState();
	const signupTab = harness({
		user,
		storage,
		initial: guestKitchen,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'init-v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (next) => {
				server = structuredClone(next);
				return { state: structuredClone(server), etag: 'init-v2' };
			}
		})
	});

	signupTab.controller.prepare(user);
	signupTab.state = guestKitchen;
	signupTab.controller.stage(guestKitchen);
	signupTab.controller.failLoad('Could not load your kitchen.');

	assert.equal(signupTab.statuses.at(-1)?.ready, false);
	assert.equal(signupTab.statuses.at(-1)?.pending, true);
	assert.equal(signupTab.statuses.at(-1)?.error, 'Could not load your kitchen.');
	assert.deepEqual(signupTab.controller.snapshot()?.local, guestKitchen);

	// Reload or sign-in on another controller before sync must also retain the full guest kitchen.
	const signedInAgain = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'init-v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (next) => {
				server = structuredClone(next);
				return { state: structuredClone(server), etag: 'init-v2' };
			}
		})
	});
	signedInAgain.controller.prepare(user);
	assert.deepEqual(signedInAgain.state, guestKitchen);
	signedInAgain.controller.initialize(user, createNewUserState(), 'init-v1');
	assert.deepEqual(signedInAgain.state, guestKitchen);
	await signedInAgain.controller.sync();

	assert.deepEqual(server, guestKitchen);
	assert.equal(signedInAgain.controller.snapshot(), null);
	assert.equal(signedInAgain.statuses.at(-1)?.ready, true);
});

test('proxy-wrapped user objects and conflicting initialize loads preserve local edits and snapshot values', () => {
	const rawUser = makeUser('proxy-user', 'proxy-home');
	const proxyUser = new Proxy(rawUser, {});
	const storage = memoryStorage();
	const sync = harness({ user: proxyUser, storage });

	assert.equal(sync.controller.prepare(proxyUser), true);
	const localEdit = createNewUserState();
	localEdit.preferences.maxTime = 15;
	localEdit.shopping.push({
		id: 'cardamom',
		name: 'cardamom pods',
		quantity: 1,
		unit: 'jar',
		checked: false
	});
	sync.controller.stage(localEdit);

	const remoteConflict = createNewUserState();
	remoteConflict.preferences.maxTime = 60;
	sync.controller.initialize(proxyUser, remoteConflict, 'v-remote');

	// Re-staging the UI state from a reactive effect must keep the conflict intact and retain local values for backup.
	sync.controller.stage(sync.state);
	assert.equal(sync.state.preferences.maxTime, 15);
	assert.equal(sync.statuses.at(-1)?.ready, true);
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'v-remote');
	assert.equal(sync.statuses.at(-1)?.conflicts.length, 1);
	assert.equal(sync.controller.snapshot()?.local.preferences.maxTime, 15);
	assert.deepEqual(
		sync.controller.snapshot()?.local.shopping.map((item) => item.id),
		['cardamom']
	);
});

test('advancing server ETag during review blocks sync(local) from writing and refreshes reviewedEtag with an alert', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 20;
	let remote = structuredClone(base);
	remote.preferences.maxTime = 60;
	let currentEtag = 'etag-2';
	const putCalls: Array<{ etag: string; state: AppState }> = [];

	const sync = harness({
		user,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(remote),
				etag: currentEtag,
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state, etag) => {
				putCalls.push({ etag, state: structuredClone(state) });
				remote = structuredClone(state);
				currentEtag = 'etag-4';
				return { state: structuredClone(remote), etag: currentEtag };
			}
		})
	});

	sync.controller.initialize(user, base, 'etag-1');
	sync.controller.stage(local);
	await sync.controller.sync();
	assert.equal(putCalls.length, 0);
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-2');
	assert.equal(sync.statuses.at(-1)?.conflicts.length, 1);

	// Partner updates another item while the user is reviewing etag-2.
	remote.pantry.push({ id: 'eggs', name: 'eggs', quantity: 12, unit: 'piece', category: 'Dairy' });
	currentEtag = 'etag-3';

	await sync.controller.sync('local');
	assert.equal(putCalls.length, 0);
	assert.ok(sync.controller.snapshot());
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-3');
	assert.equal(sync.statuses.at(-1)?.conflicts.length, 1);
	assert.match(sync.statuses.at(-1)?.error || '', /updated|review/i);

	// Reviewing the refreshed conflict at etag-3 and choosing local now commits with If-Match: etag-3.
	await sync.controller.sync('local');
	assert.equal(putCalls.length, 1);
	assert.equal(putCalls[0].etag, 'etag-3');
	assert.equal(putCalls[0].state.preferences.maxTime, 20);
	assert.deepEqual(
		putCalls[0].state.pantry.map((item) => item.id),
		['eggs']
	);
	assert.equal(sync.controller.snapshot(), null);
});

test('partner editing an independent field at etag-3 halts sync(remote), keeps local edits pending, and surfaces conflicts', async () => {
	const user = makeUser();
	const base = createNewUserState();
	base.pantry = [
		{ id: 'milk', name: 'milk', quantity: 1, unit: 'carton', category: 'Dairy' },
		{ id: 'eggs', name: 'eggs', quantity: 12, unit: 'piece', category: 'Dairy' }
	];
	const local = structuredClone(base);
	local.pantry[0].quantity = 2;
	local.pantry[1].quantity = 6;

	let remote = structuredClone(base);
	remote.pantry[0].quantity = 4;
	let currentEtag = 'etag-2';
	let writes = 0;

	const sync = harness({
		user,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(remote),
				etag: currentEtag,
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'etag-4' };
			}
		})
	});

	sync.controller.initialize(user, base, 'etag-1');
	sync.controller.stage(local);
	await sync.controller.sync();
	assert.equal(writes, 0);
	assert.deepEqual(sync.statuses.at(-1)?.conflicts, [
		{ path: 'kitchen.pantry[milk].quantity', local: 2, remote: 4 }
	]);
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-2');

	// Partner updates eggs at etag-3 while user clicks "Use household values" for the milk conflict.
	remote.pantry[1].quantity = 0;
	currentEtag = 'etag-3';

	await sync.controller.sync('remote');
	assert.equal(writes, 0);
	assert.equal(sync.controller.snapshot()?.local.pantry[1].quantity, 6);
	assert.equal(sync.statuses.at(-1)?.pending, true);
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-3');
	assert.match(sync.statuses.at(-1)?.error || '', /updated|review/i);
	assert.deepEqual(sync.statuses.at(-1)?.conflicts, [
		{ path: 'kitchen.pantry[milk].quantity', local: 2, remote: 4 },
		{ path: 'kitchen.pantry[eggs].quantity', local: 6, remote: 0 }
	]);
});

test('a 412 on PUT during conflict resolution does not retry against newer ETags and refreshes conflicts', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 20;
	local.preferences.allergies = 'soy';

	const remoteAtEtag2 = structuredClone(base);
	remoteAtEtag2.preferences.maxTime = 60;
	const remoteAtEtag3 = structuredClone(remoteAtEtag2);
	remoteAtEtag3.preferences.allergies = 'tree nuts';

	let getCalls = 0;
	const attemptedPutEtags: string[] = [];
	const sync = harness({
		user,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				getCalls += 1;
				return getCalls <= 2
					? {
							state: structuredClone(remoteAtEtag2),
							etag: 'etag-2',
							userId: user.id,
							householdId: user.householdId
						}
					: {
							state: structuredClone(remoteAtEtag3),
							etag: 'etag-3',
							userId: user.id,
							householdId: user.householdId
						};
			},
			put: async (_state, etag) => {
				attemptedPutEtags.push(etag);
				throw Object.assign(new Error('Precondition Failed'), { status: 412 });
			}
		})
	});

	sync.controller.initialize(user, base, 'etag-1');
	sync.controller.stage(local);
	await sync.controller.sync();
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-2');

	await sync.controller.sync('local');
	assert.deepEqual(attemptedPutEtags, ['etag-2']);
	assert.ok(sync.controller.snapshot());
	assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-3');
	assert.match(sync.statuses.at(-1)?.error || '', /updated|review/i);
	assert.equal(sync.statuses.at(-1)?.conflicts.length, 2);
});

test('staging an edit during sync(local) or sync(remote) isolates the follow-up sync without leaking prefer', async () => {
	for (const choice of ['local', 'remote'] as const) {
		const user = makeUser(`user-${choice}`, `home-${choice}`);
		const base = createNewUserState();
		const firstLocal = structuredClone(base);
		firstLocal.preferences.maxTime = 20;
		const remoteConflict = structuredClone(base);
		remoteConflict.preferences.maxTime = 60;

		const firstPut = deferred<{ state: AppState; etag: string }>();
		const followUpGet = deferred<{
			state: AppState;
			etag: string;
			userId: string;
			householdId: string;
		}>();
		let server = structuredClone(remoteConflict);
		let currentEtag = 'etag-2';
		let getCount = 0;
		let putCount = 0;

		const sync = harness({
			user,
			transport: () => ({
				identity: { userId: user.id, householdId: user.householdId },
				get: async () => {
					getCount += 1;
					if (getCount === 3) return followUpGet.promise;
					return {
						state: structuredClone(server),
						etag: currentEtag,
						userId: user.id,
						householdId: user.householdId
					};
				},
				put: async (state) => {
					putCount += 1;
					if (putCount === 1) {
						server = structuredClone(state);
						return firstPut.promise;
					}
					server = structuredClone(state);
					return { state: structuredClone(server), etag: 'etag-5' };
				}
			})
		});

		sync.controller.initialize(user, base, 'etag-1');
		sync.controller.stage(firstLocal);
		await sync.controller.sync();
		assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-2');

		const resolving = sync.controller.sync(choice);
		await Promise.resolve();
		await Promise.resolve();

		// Stage a new allergy edit while the conflict resolution PUT is in flight.
		const stagedDuringSave = structuredClone(firstLocal);
		stagedDuringSave.preferences.allergies = 'sesame';
		sync.state = stagedDuringSave;
		sync.controller.stage(stagedDuringSave);

		const savedFirst = structuredClone(base);
		savedFirst.preferences.maxTime = choice === 'local' ? 20 : 60;
		server = structuredClone(savedFirst);
		currentEtag = 'etag-3';
		firstPut.resolve({ state: structuredClone(savedFirst), etag: 'etag-3' });
		await resolving;

		for (let attempt = 0; attempt < 20 && getCount < 3; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(getCount, 3);

		// Partner concurrently updates allergies on the server at etag-4; follow-up sync must pause!
		const partnerUpdated = structuredClone(savedFirst);
		partnerUpdated.preferences.allergies = 'peanuts';
		server = structuredClone(partnerUpdated);
		currentEtag = 'etag-4';
		followUpGet.resolve({
			state: structuredClone(partnerUpdated),
			etag: 'etag-4',
			userId: user.id,
			householdId: user.householdId
		});

		for (
			let attempt = 0;
			attempt < 20 && sync.statuses.at(-1)?.reviewedEtag !== 'etag-4';
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.equal(putCount, 1);
		assert.ok(sync.controller.snapshot());
		assert.equal(sync.statuses.at(-1)?.reviewedEtag, 'etag-4');
		assert.deepEqual(sync.statuses.at(-1)?.conflicts, [
			{
				path: 'kitchen.preferences.allergies',
				local: 'sesame',
				remote: 'peanuts'
			}
		]);
	}
});

test('two offline tabs staging 25 and 70 over server 45 report remote 45 and keep disjoint edits on both remote and local choices', async () => {
	for (const choice of ['remote', 'local'] as const) {
		const user = makeUser(`user-tabs-${choice}`, `home-tabs-${choice}`);
		const base = createNewUserState();
		base.preferences.maxTime = 45;
		const storage = memoryStorage();
		let server = structuredClone(base);
		let writes = 0;

		const transport = () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(server),
				etag: 'etag-1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state: AppState, etag: string) => {
				assert.equal(etag, 'etag-1');
				writes += 1;
				server = structuredClone(state);
				return { state: structuredClone(server), etag: 'etag-2' };
			}
		});

		const tabA = harness({ user, storage, transport });
		const tabB = harness({ user, storage, transport });
		tabA.controller.initialize(user, base, 'etag-1');
		tabB.controller.initialize(user, base, 'etag-1');

		const editA = structuredClone(base);
		editA.preferences.maxTime = 25;
		editA.pantry.push({ id: 'tab-a', name: 'rice', quantity: 2, unit: 'cup', category: 'Pantry' });

		const editB = structuredClone(base);
		editB.preferences.maxTime = 70;
		editB.shopping.push({
			id: 'tab-b',
			name: 'lemons',
			quantity: 3,
			unit: 'piece',
			checked: false
		});

		tabA.controller.stage(editA);
		tabB.controller.stage(editB);
		tabA.controller.clearContext();
		tabB.controller.clearContext();

		const reloaded = harness({ user, storage, transport });
		assert.equal(reloaded.controller.restore(user), true);
		assert.equal(reloaded.statuses.at(-1)?.reviewedEtag, 'etag-1');
		assert.deepEqual(reloaded.statuses.at(-1)?.conflicts, [
			{
				path: 'kitchen.preferences.maxTime',
				local: 70,
				remote: 45
			}
		]);

		await reloaded.controller.sync();
		assert.equal(writes, 0);
		assert.deepEqual(reloaded.statuses.at(-1)?.conflicts, [
			{
				path: 'kitchen.preferences.maxTime',
				local: 70,
				remote: 45
			}
		]);

		await reloaded.controller.sync(choice);
		assert.equal(writes, 1);
		assert.equal(reloaded.controller.snapshot(), null);
		assert.equal(server.preferences.maxTime, choice === 'remote' ? 45 : 70);
		assert.deepEqual(
			server.pantry.map((item) => item.id),
			['tab-a']
		);
		assert.deepEqual(
			server.shopping.map((item) => item.id),
			['tab-b']
		);
	}
});

test('initialize records reviewedEtag on conflicts and blocks stale resolution if the server advances again', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const offlineEdit = structuredClone(base);
	offlineEdit.preferences.maxTime = 20;

	const offlineTab = harness({ user, storage });
	offlineTab.controller.initialize(user, base, 'etag-1');
	offlineTab.controller.stage(offlineEdit);
	offlineTab.controller.clearContext();

	const remoteAtEtag2 = structuredClone(base);
	remoteAtEtag2.preferences.maxTime = 55;
	const remoteAtEtag3 = structuredClone(remoteAtEtag2);
	remoteAtEtag3.preferences.allergies = 'mustard';

	let writes = 0;
	const reconnected = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(remoteAtEtag3),
				etag: 'etag-3',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'etag-4' };
			}
		})
	});

	reconnected.controller.initialize(user, remoteAtEtag2, 'etag-2');
	assert.equal(reconnected.statuses.at(-1)?.reviewedEtag, 'etag-2');
	assert.equal(reconnected.statuses.at(-1)?.conflicts.length, 1);

	await reconnected.controller.sync('local');
	assert.equal(writes, 0);
	assert.equal(reconnected.statuses.at(-1)?.reviewedEtag, 'etag-3');
	assert.match(reconnected.statuses.at(-1)?.error || '', /updated|review/i);
});
