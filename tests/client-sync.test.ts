import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewUserState, seedRecipes } from '../src/lib/data.ts';
import { createKitchenSync } from '../src/lib/client-sync.ts';
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
	const statuses: Array<{
		pending: boolean;
		syncing: boolean;
		conflicts: unknown[];
		reviewedEtag: string | null;
		error: string;
	}> = [];
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

	// Case 2: Same-tab reloads reusing sessionStorage writerId
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
	const savedWriterId = tabSession.getItem('flavorithm-writer-id:v1');
	assert.ok(savedWriterId);

	for (let reload = 1; reload <= 65; reload += 1) {
		const reloaded = harness({ user, storage: reloadStorage, sessionStorage: tabSession });
		assert.equal(tabSession.getItem('flavorithm-writer-id:v1'), savedWriterId);
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

test('duplicated tabs disambiguate cloned sessionStorage via active leases and never retire a live peer slot', () => {
	let clock = 1_000;
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const tabASession = memoryStorage();

	const tabA = harness({
		user,
		storage,
		sessionStorage: tabASession,
		now: () => clock,
		leaseTtlMs: 10_000
	});
	tabA.controller.initialize(user, base, 'v1');
	const editA = structuredClone(base);
	editA.pantry.push({ id: 'tab-a', name: 'oats', quantity: 2, unit: 'cup', category: 'Pantry' });
	tabA.controller.stage(editA);
	const writerA = tabASession.getItem('flavorithm-writer-id:v1');
	assert.ok(writerA);

	// Simulate browser "Duplicate Tab" cloning sessionStorage while tabA is still mounted and leased.
	const tabBSession = memoryStorage();
	tabBSession.setItem('flavorithm-writer-id:v1', writerA);
	clock += 5_000;
	tabA.controller.refreshLease();
	clock += 6_000; // Past original 10s window, but within refreshed lease window!

	const tabB = harness({
		user,
		storage,
		sessionStorage: tabBSession,
		now: () => clock,
		leaseTtlMs: 10_000
	});
	const writerB = tabBSession.getItem('flavorithm-writer-id:v1');
	assert.ok(writerB);
	assert.notEqual(writerB, writerA);

	assert.equal(tabB.controller.restore(user), true);
	const editB = structuredClone(tabB.state);
	editB.shopping.push({ id: 'tab-b', name: 'tea', quantity: 1, unit: 'box', checked: false });
	tabB.controller.stage(editB);

	// Live tabA's journal slot must remain intact while tabA holds an active lease.
	const journalKeysWhileLive = [...storage.values.keys()].filter((key) =>
		key.startsWith('flavorithm-pending-journal:')
	);
	assert.equal(journalKeysWhileLive.length, 2);

	// Once tabA closes (clearContext releases lease), staging in tabB compacts tabA into tabB's baseline-anchored entry.
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

test('reconnecting with a reused sessionStorage writerId preserves conflicts across reactive viewState echoes', async () => {
	const user = makeUser();
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'Flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const storage = memoryStorage();
	const tabSession = memoryStorage();
	const server = structuredClone(base);
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
			server.pantry = structuredClone(state.pantry);
			return { state: structuredClone(server), etag: 'v3' };
		}
	});

	const tab = harness({ user, storage, sessionStorage: tabSession, transport });
	tab.controller.initialize(user, base, 'v1');
	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	tab.controller.stage(stepOne);
	tab.controller.releaseLease();

	const reloaded = harness({ user, storage, sessionStorage: tabSession, transport });
	reloaded.controller.restore(user);
	const stepTwo = structuredClone(reloaded.state);
	stepTwo.pantry[0].quantity = 1;
	reloaded.controller.stage(stepTwo);

	// Simulate reconnectKitchen: initialize(user, server, 'v2') sets UI state, and Svelte $effect echoes stage(reloaded.state).
	reloaded.controller.initialize(user, server, 'v2');
	reloaded.controller.stage(structuredClone(reloaded.state));
	await reloaded.controller.sync();

	assert.equal(puts, 0);
	assert.equal(reloaded.statuses.at(-1)?.conflicts.length, 1);

	await reloaded.controller.sync('remote');
	assert.equal(puts, 1);
	assert.equal(server.pantry[0].quantity, 3);
	assert.equal(reloaded.controller.snapshot(), null);
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
