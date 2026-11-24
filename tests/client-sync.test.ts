import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import {
	createKitchenPersistence,
	createKitchenSync,
	type SyncStatus
} from '../src/lib/client-sync.ts';
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
	const statuses: SyncStatus[] = [];
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

test('rapid edits stage synchronously per edit with immediate pending status and monotonic timestamps, including provisional contexts', () => {
	const user = makeUser();
	const base = createNewUserState();
	base.shopping.push({
		id: 'item-1',
		name: '',
		quantity: 1,
		unit: 'piece',
		checked: false
	});
	const storage = memoryStorage();
	let journalWrites = 0;
	const originalSet = storage.setItem;
	storage.setItem = (key, value) => {
		if (key.startsWith('flavorithm-pending-journal:')) journalWrites += 1;
		originalSet(key, value);
	};
	let currentState = structuredClone(base);
	const statuses: Array<{ ready: boolean; pending: boolean }> = [];
	let syncScheduled = 0;
	const controller = createKitchenSync({
		storage,
		getUser: () => user,
		getState: () => currentState,
		setState: (state) => {
			currentState = structuredClone(state);
		},
		onStatus: (status) => statuses.push({ ready: status.ready, pending: status.pending }),
		transport: () => transportFor(user, base)
	});
	const persistence = createKitchenPersistence({
		storage,
		getState: () => currentState,
		getUser: () => user,
		sync: controller,
		onAfterPersist: () => {
			syncScheduled += 1;
		}
	});

	// Provisional context (#121): edits before /api/state resolves are durably staged immediately.
	assert.equal(controller.prepare(user), true);
	currentState.shopping.push({
		id: 'provisional-item',
		name: 'Blueberries',
		quantity: 1,
		unit: 'pint',
		checked: false
	});
	assert.equal(persistence.persist(), true);
	assert.equal(journalWrites, 1);
	assert.equal(statuses.at(-1)?.ready, false);
	assert.equal(statuses.at(-1)?.pending, true);
	assert.equal(controller.snapshot()?.local.shopping.at(-1)?.name, 'Blueberries');

	// Initialize onto confirmed baseline and run a 12-edit typing burst.
	currentState = structuredClone(base);
	controller.initialize(user, structuredClone(base), 'v1');
	journalWrites = 0;
	syncScheduled = 0;
	statuses.length = 0;

	const typed = 'Strawberries';
	assert.equal(typed.length, 12);
	let previousUpdatedAt = 0;
	for (let index = 1; index <= typed.length; index += 1) {
		currentState.shopping[0].name = typed.slice(0, index);
		assert.equal(persistence.persist(), true);
		assert.equal(
			journalWrites,
			index,
			'each edit writes synchronously to the durable journal with zero crash loss window'
		);
		assert.equal(statuses.at(-1)?.pending, true);
		const snap = controller.snapshot();
		assert.equal(snap?.local.shopping[0].name, typed.slice(0, index));
		assert.ok((snap?.updatedAt ?? 0) > previousUpdatedAt);
		previousUpdatedAt = snap?.updatedAt ?? 0;
	}
	assert.equal(syncScheduled, typed.length);

	// Hard crash / process kill with zero pagehide/beforeunload events still recovers the final keystroke.
	const crashedReload = harness({ user, storage });
	assert.equal(crashedReload.controller.restore(user), true);
	assert.equal(crashedReload.state.shopping[0].name, 'Strawberries');
});

test('pre-auth guest edits flush on onGuestReady or pre-switch boundary, and quota failures retain guestDirty for retry', () => {
	// 1. Guest edit before /api/auth resolves flushes synchronously as soon as guestReady becomes true.
	const preAuthStorage = memoryStorage();
	const preAuthState = createNewUserState();
	let guestReady = false;
	const noopSync = createKitchenSync({
		storage: preAuthStorage,
		getUser: () => null,
		getState: () => preAuthState,
		setState: () => {},
		onStatus: () => {},
		transport: () => {
			throw new Error('unused');
		}
	});
	const preAuthPersistence = createKitchenPersistence({
		storage: preAuthStorage,
		getState: () => preAuthState,
		getUser: () => null,
		isGuestReady: () => guestReady,
		sync: noopSync
	});
	preAuthState.pantry.push({
		id: 'early-guest',
		name: 'saffron',
		quantity: 1,
		unit: 'pinch',
		category: 'Spices'
	});
	assert.equal(preAuthPersistence.persist(), false);
	assert.equal(preAuthPersistence.hasPending(), true);
	assert.equal(preAuthStorage.getItem('flavorithm-guest-kitchen'), null);

	guestReady = true;
	assert.equal(preAuthPersistence.onGuestReady(), true);
	assert.equal(preAuthPersistence.hasPending(), false);
	assert.equal(
		JSON.parse(preAuthStorage.getItem('flavorithm-guest-kitchen') || 'null')?.pantry[0]?.id,
		'early-guest'
	);

	// 2. Guest edit in the initial window before /api/auth resolves to a signed-in local user flushes before cancel.
	const switchStorage = memoryStorage();
	const switchState = createNewUserState();
	const switchPersistence = createKitchenPersistence({
		storage: switchStorage,
		getState: () => switchState,
		getUser: () => null,
		isGuestReady: () => false,
		isManagedAuth: () => false,
		sync: noopSync
	});
	switchState.preferences.allergies = 'lupin';
	switchPersistence.persist();
	assert.equal(switchPersistence.hasPending(), true);
	assert.equal(switchPersistence.flush({ allowBeforeGuestReady: true }), true);
	switchPersistence.cancel();
	assert.equal(
		JSON.parse(switchStorage.getItem('flavorithm-guest-kitchen') || 'null')?.preferences.allergies,
		'lupin'
	);

	// Managed auth never writes guest data even with allowBeforeGuestReady.
	const managedStorage = memoryStorage();
	const managedPersistence = createKitchenPersistence({
		storage: managedStorage,
		getState: () => switchState,
		getUser: () => null,
		isGuestReady: () => false,
		isManagedAuth: () => true,
		sync: noopSync
	});
	managedPersistence.persist();
	assert.equal(managedPersistence.flush({ allowBeforeGuestReady: true }), false);
	assert.equal(managedStorage.getItem('flavorithm-guest-kitchen'), null);

	// 3. Quota failure leaves guestDirty = true so subsequent flush / lifecycle events retry without another keystroke.
	for (const eventName of ['visibilitychange', 'pagehide', 'beforeunload'] as const) {
		const quotaStorage = memoryStorage();
		let failWrites = true;
		let quotaErrors = 0;
		const origSetItem = quotaStorage.setItem;
		quotaStorage.setItem = (key, value) => {
			if (failWrites && key === 'flavorithm-guest-kitchen') {
				throw new Error('QuotaExceededError');
			}
			origSetItem(key, value);
		};
		const guestState = createNewUserState();
		const win = eventBus();
		const doc = Object.assign(eventBus(), { visibilityState: 'visible' });
		const guestPersistence = createKitchenPersistence({
			storage: quotaStorage,
			getState: () => guestState,
			getUser: () => null,
			sync: noopSync,
			onGuestQuotaError: () => {
				quotaErrors += 1;
			}
		});
		const unbind = guestPersistence.bindLifecycle(win, doc);

		guestState.pantry.push({
			id: `quota-${eventName}`,
			name: 'olive oil',
			quantity: 2,
			unit: 'tbsp',
			category: 'Pantry'
		});
		assert.equal(guestPersistence.persist(), false);
		assert.equal(quotaErrors, 1);
		assert.equal(
			guestPersistence.hasPending(),
			true,
			'guestDirty remains true when setItem fails with quota error'
		);
		assert.equal(quotaStorage.getItem('flavorithm-guest-kitchen'), null);

		// Visibility changing to 'visible' does not clear pending; 'hidden' or unload retries and succeeds once freed.
		failWrites = false;
		if (eventName === 'visibilitychange') {
			doc.emit('visibilitychange');
			assert.equal(quotaStorage.getItem('flavorithm-guest-kitchen'), null);
			doc.visibilityState = 'hidden';
			doc.emit('visibilitychange');
		} else {
			win.emit(eventName);
		}
		assert.equal(guestPersistence.hasPending(), false);
		const savedGuest = JSON.parse(quotaStorage.getItem('flavorithm-guest-kitchen') || 'null');
		assert.equal(savedGuest?.pantry[0]?.id, `quota-${eventName}`);
		unbind();
	}
});

test('stage reads peer journal storage once and isolates rememberRecord, viewState, snapshot, and setState boundaries from caller mutation', async () => {
	const user = makeUser();
	const base = createNewUserState();
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
	const receivedSetStates: AppState[] = [];
	let server = structuredClone(base);
	const controller = createKitchenSync({
		storage: peerStorage,
		getUser: () => user,
		getState: () => currentState,
		setState: (next) => {
			receivedSetStates.push(next);
			currentState = structuredClone(next);
		},
		onStatus: () => {},
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
	controller.initialize(user, base, 'v1');

	const callerState = structuredClone(currentState);
	callerState.pantry.push({
		id: 'own-item',
		name: 'chickpeas',
		quantity: 2,
		unit: 'can',
		category: 'Pantry'
	});

	peerJournalReads = 0;
	controller.stage(callerState);
	assert.equal(
		peerJournalReads,
		1,
		'stored peer journal entries are read once during stage rather than twice'
	);

	// Mutate caller input, snapshot() output, and setState() input after staging; internal journal must stay intact.
	callerState.pantry[0].quantity = 999;
	callerState.preferences.allergies = 'mutated-caller';
	const exported = controller.snapshot();
	assert.ok(exported);
	assert.equal(exported.local.pantry[0].quantity, 2);
	exported.local.pantry[0].quantity = 888;
	if (receivedSetStates[0]) {
		receivedSetStates[0].preferences.diet = 'mutated-setState';
	}

	assert.equal(controller.snapshot()?.local.pantry[0].quantity, 2);
	assert.equal(controller.snapshot()?.local.preferences.allergies, base.preferences.allergies);

	await controller.sync();
	assert.equal(server.pantry[0]?.quantity, 2);
	assert.equal(server.shopping[0]?.id, 'peer-item');
});

test('finishing sync skips setState when server state matches active kitchen and rebases synchronous in-flight stage edits', async () => {
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

	// Verify a synchronous edit staged while PUT #1 is in flight is rebased and synced without overwriting liveState.
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
		})
	});
	controller.initialize(user, base, 'v1');
	setStateCalls.length = 0;
	liveState.preferences.maxTime = 30;
	controller.stage(liveState);
	const activeSync = controller.sync();
	await firstPutEntered.promise;

	// User types while PUT #1 is in flight; stage() persists immediately to the journal.
	liveState.preferences.allergies = 'pistachios';
	controller.stage(liveState);
	assert.equal(controller.snapshot()?.local.preferences.allergies, 'pistachios');

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
