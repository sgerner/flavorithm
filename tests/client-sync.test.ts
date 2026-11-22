import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewUserState } from '../src/lib/data.ts';
import { createKitchenSync } from '../src/lib/client-sync.ts';
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
	sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
	reactiveStage?: boolean;
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
		sessionStorage: args.sessionStorage,
		getUser: () => currentUser,
		getState: () => currentState,
		setState: (state) => {
			currentState = structuredClone(state);
			setStates.push(structuredClone(state));
			if (args.reactiveStage) {
				const snapshot = JSON.stringify(currentState);
				queueMicrotask(() => {
					if (currentUser) controller.stage(JSON.parse(snapshot));
				});
			}
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

test('storage quota failure keeps edits pending in memory for backup and online sync', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const firstLocal = structuredClone(base);
	firstLocal.preferences.maxTime = 30;
	const latestLocal = structuredClone(base);
	latestLocal.preferences.maxTime = 20;
	const storage = memoryStorage();
	const originalSet = storage.setItem;
	let quotaExceeded = false;
	storage.setItem = (key, value) => {
		if (quotaExceeded && key.startsWith('flavorithm-pending-journal:')) {
			throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
		}
		originalSet(key, value);
	};
	let reads = 0;
	let writes = 0;
	const savedStates: AppState[] = [];
	const sync = harness({
		user,
		storage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				reads += 1;
				return {
					state: structuredClone(base),
					etag: 'v1',
					userId: user.id,
					householdId: user.householdId
				};
			},
			put: async (state) => {
				writes += 1;
				savedStates.push(structuredClone(state));
				return { state: structuredClone(state), etag: 'v2' };
			}
		})
	});
	sync.controller.initialize(user, base, 'v1');
	sync.controller.stage(firstLocal);
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		1
	);

	quotaExceeded = true;
	sync.controller.stage(latestLocal);
	assert.equal(sync.statuses.at(-1)?.pending, true);
	assert.match(sync.statuses.at(-1)?.error || '', /could not be saved on this device/);
	assert.equal(sync.controller.snapshot()?.local.preferences.maxTime, 20);

	await sync.controller.sync();
	assert.equal(reads, 1);
	assert.equal(writes, 1);
	assert.equal(savedStates.at(-1)?.preferences.maxTime, 20);
	assert.equal(sync.controller.snapshot(), null);
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.equal(sync.statuses.at(-1)?.error, '');
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);
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

test('stage rejects malformed kitchen snapshots at the client boundary before staging or syncing', async () => {
	const user = makeUser();
	const base = createNewUserState();
	let requests = 0;
	const sync = harness({
		user,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => {
				requests += 1;
				return { state: base, etag: 'v1', userId: user.id, householdId: user.householdId };
			},
			put: async (state) => {
				requests += 1;
				return { state, etag: 'v2' };
			}
		})
	});
	sync.controller.initialize(user, base, 'v1');

	const nullQuantity = structuredClone(base);
	nullQuantity.pantry.push({
		id: 'bad-qty',
		name: 'flour',
		quantity: null as unknown as number,
		unit: 'cup',
		category: 'Pantry'
	});
	sync.controller.stage(nullQuantity);
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.equal(sync.statuses.at(-1)?.error, 'The kitchen state is invalid and was not saved.');

	const longUnit = structuredClone(base);
	longUnit.pantry.push({
		id: 'bad-unit',
		name: 'sugar',
		quantity: 1,
		unit: 'u'.repeat(41),
		category: 'Pantry'
	});
	sync.controller.stage(longUnit);
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.equal(sync.statuses.at(-1)?.error, 'The kitchen state is invalid and was not saved.');

	const insecureImage = structuredClone(base);
	insecureImage.recipes[0].image = 'http://example.com/insecure.jpg';
	sync.controller.stage(insecureImage);
	assert.equal(sync.statuses.at(-1)?.error, 'The kitchen state is invalid and was not saved.');

	const badEffort = structuredClone(base);
	badEffort.preferences.reasoning = { effort: 'x-high' };
	sync.controller.stage(badEffort);
	assert.equal(sync.statuses.at(-1)?.error, 'The kitchen state is invalid and was not saved.');

	assert.equal(sync.controller.snapshot(), null);
	assert.equal(
		[...sync.storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);
	await sync.controller.sync();
	assert.equal(requests, 0);

	const valid = structuredClone(base);
	valid.pantry.push({ id: 'ok', name: 'flour', quantity: 0, unit: 'cup', category: 'Pantry' });
	sync.controller.stage(valid);
	assert.equal(sync.statuses.at(-1)?.pending, true);
	assert.equal(sync.statuses.at(-1)?.error, '');
});

test('reloading one offline tab five times reuses one writer slot in localStorage', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const sessionStorage = memoryStorage();

	const initialTab = harness({ user, storage, sessionStorage });
	initialTab.controller.initialize(user, base, 'v1');
	const firstEdit = structuredClone(base);
	firstEdit.preferences.maxTime = 15;
	initialTab.controller.stage(firstEdit);
	initialTab.controller.clearContext();

	for (let reload = 1; reload <= 5; reload += 1) {
		const tab = harness({ user, storage, sessionStorage });
		assert.equal(tab.controller.restore(user), true);
		const next = structuredClone(tab.state);
		next.preferences.maxTime = 15 + reload * 5;
		next.pantry = [{ id: 'salt', name: 'salt', quantity: reload, unit: 'tsp', category: 'Spices' }];
		tab.controller.stage(next);
		const journalKeys = [...storage.values.keys()].filter((key) =>
			key.startsWith('flavorithm-pending-journal:')
		);
		assert.equal(journalKeys.length, 1);
		tab.controller.clearContext();
	}

	const savedReloads: AppState[] = [];
	const onlineTab = harness({
		user,
		storage,
		sessionStorage,
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(base),
				etag: 'v1',
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (state) => {
				savedReloads.push(structuredClone(state));
				return { state: structuredClone(state), etag: 'v2' };
			}
		})
	});
	assert.equal(onlineTab.controller.restore(user), true);
	await onlineTab.controller.sync();
	assert.equal(savedReloads.at(-1)?.preferences.maxTime, 40);
	assert.equal(savedReloads.at(-1)?.pantry[0]?.quantity, 5);
	assert.equal(
		[...storage.values.keys()].filter((key) => key.startsWith('flavorithm-pending-journal:'))
			.length,
		0
	);

	const brokenSession = {
		getItem: () => {
			throw new Error('SecurityError');
		},
		setItem: () => {
			throw new Error('SecurityError');
		},
		removeItem: () => {
			throw new Error('SecurityError');
		}
	};
	const fallbackTab = harness({ user, storage, sessionStorage: brokenSession });
	fallbackTab.controller.initialize(user, base, 'v2');
	fallbackTab.controller.stage(firstEdit);
	assert.equal(fallbackTab.controller.snapshot()?.local.preferences.maxTime, 15);
});

test('online sync saves valid edits and quarantines a corrupt slot under isolated keys', async () => {
	const userA = makeUser('user-a', 'home-a');
	const userB = makeUser('user-b', 'home-b');
	const base = createNewUserState();
	const storage = memoryStorage();
	const savedQuarantine: AppState[] = [];
	const sync = harness({
		user: userA,
		storage,
		transport: () => ({
			identity: { userId: userA.id, householdId: userA.householdId },
			get: async () => ({
				state: structuredClone(base),
				etag: 'v1',
				userId: userA.id,
				householdId: userA.householdId
			}),
			put: async (state) => {
				savedQuarantine.push(structuredClone(state));
				return { state: structuredClone(state), etag: 'v2' };
			}
		})
	});
	sync.controller.initialize(userA, base, 'v1');
	const edit = structuredClone(base);
	edit.pantry.push({ id: 'beans', name: 'beans', quantity: 2, unit: 'can', category: 'Pantry' });
	sync.controller.stage(edit);

	const corruptKeyA = `flavorithm-pending-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:corrupt-writer`;
	const otherUserKey = `flavorithm-pending-journal:v1:${encodeURIComponent(userB.id)}:${encodeURIComponent(userB.householdId)}:peer-writer`;
	storage.setItem(corruptKeyA, '{not-valid-json');
	storage.setItem(otherUserKey, '{also-corrupt-for-other-user');

	await sync.controller.sync();
	assert.deepEqual(
		savedQuarantine.at(-1)?.pantry.map((item) => item.id),
		['beans']
	);
	assert.equal(storage.getItem(corruptKeyA), null);
	assert.equal(
		storage.getItem(
			`flavorithm-quarantined-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:corrupt-writer`
		),
		'{not-valid-json'
	);
	assert.equal(storage.getItem(otherUserKey), '{also-corrupt-for-other-user');
	assert.equal(sync.controller.snapshot(), null);
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.match(sync.statuses.at(-1)?.error || '', /quarantined/);
});

test('baselineError and afterSaveError remain visible after reactive microtasks flush', async () => {
	const user = makeUser();
	const base = createNewUserState();
	const storage = memoryStorage();
	const originalSet = storage.setItem;
	storage.setItem = (key, value) => {
		if (key.startsWith('flavorithm-confirmed:')) {
			throw new Error('QuotaExceededError');
		}
		originalSet(key, value);
	};

	const sync = harness({
		user,
		storage,
		reactiveStage: true,
		transport: () => transportFor(user, base, 'v1')
	});
	sync.controller.initialize(user, base, 'v1');
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(
		sync.statuses.at(-1)?.error,
		'The confirmed kitchen could not be saved for offline use.'
	);
	assert.equal(sync.statuses.at(-1)?.pending, false);

	const edited = structuredClone(base);
	edited.preferences.maxTime = 35;
	sync.state = edited;
	sync.controller.stage(edited);
	await sync.controller.sync();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(sync.statuses.at(-1)?.pending, false);
	assert.equal(
		sync.statuses.at(-1)?.error,
		'The server saved these changes, but the confirmed state could not be saved on this device.'
	);
});
