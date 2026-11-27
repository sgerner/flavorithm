import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import { completeMeal } from '../src/lib/kitchen-workflows.ts';
import {
	clearPendingJournalRecords,
	composePendingKitchenJournal,
	filterUnfoldedJournalRecords,
	isKitchenState,
	jsonEqual,
	MAX_QUARANTINED_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	readQuarantinedJournal,
	syncPendingKitchenJournal,
	type PendingJournalRecord,
	writePending,
	writePendingJournal
} from '../src/lib/offline-sync.ts';
import { validateKitchenState } from '../src/lib/state-schema.ts';
import type { AppState, Meal, Recipe } from '../src/lib/types.ts';

test('offline snapshots are isolated by both account and household', () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
	const user = { id: 'a', householdId: 'home', name: 'A', email: 'a@example.test' };
	const base = createNewUserState();
	writePending(storage, {
		userId: user.id,
		householdId: user.householdId,
		base,
		local: base,
		etag: 'v1',
		updatedAt: 1
	});
	const journal = readPendingJournal(storage, user);
	assert.equal(journal.records.length, 1);
	assert.equal(journal.error, '');
	assert.equal(readPendingJournal(storage, { ...user, id: 'b' }).records.length, 0);
	assert.equal(readPendingJournal(storage, { ...user, householdId: 'other' }).records.length, 0);
	clearPendingJournalRecords(storage, user, journal.records);
	assert.equal(readPendingJournal(storage, user).records.length, 0);
});

test('three-way merge preserves independent edits, additions and deletions', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.recipes[0].title = 'My title';
	remote.recipes[0].description = 'Household description';
	local.pantry.push({ id: 'local', name: 'rice', quantity: 1, unit: 'cup', category: 'Pantry' });
	remote.pantry.push({ id: 'remote', name: 'beans', quantity: 2, unit: 'can', category: 'Pantry' });
	remote.recipes.splice(1, 1);
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.conflicts.length, 0);
	assert.equal(result.state.recipes[0].title, 'My title');
	assert.equal(result.state.recipes[0].description, 'Household description');
	assert.equal(result.state.pantry.length, 2);
	assert.equal(result.state.recipes.length, base.recipes.length - 1);
	assert.equal(base.pantry.length, 0);
});

test('competing edits and delete-versus-edit require an explicit choice', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	remote.preferences.maxTime = 60;
	remote.recipes.shift();
	local.recipes[0].title = 'Keep this recipe';
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.conflicts.length, 2);
	assert.equal(mergeKitchenStates(base, local, remote, 'local').state.preferences.maxTime, 20);
	assert.equal(
		mergeKitchenStates(base, local, remote, 'local').state.recipes.find(
			(recipe) => recipe.id === base.recipes[0].id
		)?.title,
		'Keep this recipe'
	);
	assert.equal(
		mergeKitchenStates(base, local, remote, 'remote').state.recipes.length,
		remote.recipes.length
	);
});

test('concurrent recipe deletion and meal addition never creates orphaned plans', () => {
	const base = createNewUserState();
	const local = structuredClone(base),
		remote = structuredClone(base);
	local.meals.push({
		id: 'meal',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 2
	});
	remote.recipes.shift();
	const pending = mergeKitchenStates(base, local, remote);
	assert.ok(pending.conflicts.length);
	assert.equal(pending.state.meals[0]?.id, 'meal');
	assert.ok(pending.state.recipes.some((recipe) => recipe.id === pending.state.meals[0].recipeId));
	const resolved = mergeKitchenStates(base, local, remote, 'local').state;
	assert.ok(resolved.recipes.some((recipe) => recipe.id === resolved.meals[0].recipeId));
	assert.equal(mergeKitchenStates(base, local, remote, 'remote').state.meals.length, 0);
	const conflict = mergeKitchenStates(base, local, remote).conflicts.find((item) =>
		item.path.endsWith('.recipeId')
	);
	assert.equal(conflict?.local, `Meal planned; recipe available: ${base.recipes[0].title}`);
	assert.equal(conflict?.remote, 'Meal not planned; recipe removed');

	const oppositeLocal = structuredClone(base),
		oppositeRemote = structuredClone(base);
	oppositeLocal.recipes.shift();
	oppositeRemote.meals.push({
		id: 'remote-meal',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 2
	});
	const oppositeConflict = mergeKitchenStates(base, oppositeLocal, oppositeRemote).conflicts.find(
		(item) => item.path.endsWith('.recipeId')
	);
	assert.equal(oppositeConflict?.local, 'Meal not planned; recipe removed');
	assert.equal(
		oppositeConflict?.remote,
		`Meal planned; recipe available: ${base.recipes[0].title}`
	);
});

test('concurrent equal pantry deductions conflict, while identical snapshots remain idempotent', async () => {
	const base = createNewUserState();
	const recipe = base.recipes[0];
	recipe.servings = 2;
	recipe.ingredients = [{ name: 'flour', quantity: 1, unit: 'cup' }];
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 2, unit: 'cup', category: 'Pantry' }];
	base.meals = [
		{ id: 'meal-one', date: '2026-10-22', slot: 'Dinner', recipeId: recipe.id, servings: 2 },
		{ id: 'meal-two', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];
	const local = completeMeal(
		structuredClone(base),
		'meal-one',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-22T18:00:00.000Z')
	);
	const remote = completeMeal(
		structuredClone(base),
		'meal-two',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-10-23T18:00:00.000Z')
	);
	const result = mergeKitchenStates(base, local, remote);
	assert.equal(result.state.pantry[0].quantity, 1);
	assert.deepEqual(
		result.state.meals
			.filter((meal) => meal.completedAt)
			.map((meal) => meal.id)
			.sort(),
		['meal-one', 'meal-two']
	);
	assert.ok(result.conflicts.some((item) => item.path === 'kitchen.pantry[flour].quantity'));
	let writes = 0;
	const blocked = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'home', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({ state: remote, etag: 'current', userId: 'a', householdId: 'home' }),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(blocked.saved, false);
	assert.equal(writes, 0);
	assert.ok(blocked.conflicts.some((item) => item.path === 'kitchen.pantry[flour].quantity'));

	const identicalRetry = mergeKitchenStates(base, local, structuredClone(local));
	assert.equal(identicalRetry.conflicts.length, 0);
	assert.equal(identicalRetry.state.pantry[0].quantity, 1);
});

test('sync retries a changing ETag without losing independent remote edits', async () => {
	const base = createNewUserState(),
		local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	let writes = 0;
	const result = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'h', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'h' },
			get: async () => ({ state: remote, etag: `v${writes}`, userId: 'a', householdId: 'h' }),
			put: async (state, etag) => {
				assert.equal(etag, `v${writes}`);
				writes += 1;
				if (writes === 1) {
					remote.preferences.allergies = 'peanuts';
					throw Object.assign(new Error('Changed'), { status: 412 });
				}
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(result.state.preferences.maxTime, 20);
	assert.equal(result.state.preferences.allergies, 'peanuts');
	assert.equal(writes, 2);
});

test('sync never writes unresolved conflicts', async () => {
	const base = createNewUserState(),
		local = structuredClone(base),
		remote = structuredClone(base);
	local.preferences.maxTime = 20;
	remote.preferences.maxTime = 60;
	let writes = 0;
	const result = await syncPendingKitchenJournal(
		[
			{
				writerId: 'legacy-main',
				pending: { userId: 'a', householdId: 'h', base, local, etag: 'old', updatedAt: 0 },
				keys: []
			}
		],
		{
			identity: { userId: 'a', householdId: 'h' },
			get: async () => ({ state: remote, etag: 'new', userId: 'a', householdId: 'h' }),
			put: async (state) => {
				writes += 1;
				return { state, etag: 'saved' };
			}
		}
	);
	assert.equal(result.saved, false);
	assert.equal(writes, 0);
	assert.equal(result.conflicts.length, 1);
});

test('sync rejects pending snapshots from another account or household before any request', async () => {
	const base = createNewUserState();
	let reads = 0;
	let writes = 0;
	const transport = {
		identity: { userId: 'b', householdId: 'new-home' },
		get: async () => {
			reads += 1;
			return {
				state: base,
				etag: 'current',
				userId: 'b',
				householdId: 'new-home'
			};
		},
		put: async (state: typeof base) => {
			writes += 1;
			return { state, etag: 'saved' };
		}
	};
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'old-home',
							base,
							local: base,
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				transport
			),
		{ status: 409 }
	);
	assert.equal(reads, 0);
	assert.equal(writes, 0);
});

test('sync rejects a GET response for another identity before writing', async () => {
	const base = createNewUserState();
	let writes = 0;
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'home',
							base,
							local: structuredClone(base),
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				{
					identity: { userId: 'a', householdId: 'home' },
					get: async () => ({
						state: base,
						etag: 'current',
						userId: 'a',
						householdId: 'other-home'
					}),
					put: async (state) => {
						writes += 1;
						return { state, etag: 'saved' };
					}
				}
			),
		{ status: 409 }
	);
	assert.equal(writes, 0);
});

test('sync rechecks its identity after GET before PUT', async () => {
	const base = createNewUserState();
	const identity = { userId: 'a', householdId: 'home' };
	let writes = 0;
	await assert.rejects(
		() =>
			syncPendingKitchenJournal(
				[
					{
						writerId: 'legacy-main',
						pending: {
							userId: 'a',
							householdId: 'home',
							base,
							local: structuredClone(base),
							etag: 'old',
							updatedAt: 0
						},
						keys: []
					}
				],
				{
					identity,
					get: async () => {
						identity.userId = 'b';
						return {
							state: base,
							etag: 'current',
							userId: 'a',
							householdId: 'home'
						};
					},
					put: async (state) => {
						writes += 1;
						return { state, etag: 'saved' };
					}
				}
			),
		{ status: 409 }
	);
	assert.equal(writes, 0);
});

function journalRecord(
	writerId: string,
	base: ReturnType<typeof createNewUserState>,
	local: ReturnType<typeof createNewUserState>,
	createdAt: number
): PendingJournalRecord {
	const pending = {
		userId: 'a',
		householdId: 'home',
		base: structuredClone(base),
		local: structuredClone(local),
		etag: 'v1',
		createdAt,
		updatedAt: createdAt,
		writerId,
		writeId: `${writerId}-${createdAt}`
	};
	return {
		writerId,
		pending,
		keys: [{ key: `flavorithm-pending-journal:v1:a:home:${writerId}`, pending }]
	};
}

test('sequential journal edits crossing a household value emit 1 conflict and send 0 unconfirmed PUTs', async () => {
	const base = createNewUserState();
	base.meals = [
		{ id: 'dinner', date: '2026-10-22', slot: 'Dinner', recipeId: base.recipes[0].id, servings: 2 }
	];
	const firstStep = structuredClone(base);
	firstStep.meals[0].servings = 4;
	const secondStep = structuredClone(firstStep);
	secondStep.meals[0].servings = 6;
	const remote = structuredClone(base);
	remote.meals[0].servings = 4;

	let puts = 0;
	const records = [
		journalRecord('w1', base, firstStep, 10),
		journalRecord('w2', firstStep, secondStep, 20)
	];
	const result = await syncPendingKitchenJournal(records, {
		identity: { userId: 'a', householdId: 'home' },
		get: async () => ({
			state: structuredClone(remote),
			etag: 'v2',
			userId: 'a',
			householdId: 'home'
		}),
		put: async (state) => {
			puts += 1;
			return { state, etag: 'v3' };
		}
	});
	assert.equal(puts, 0);
	assert.equal(result.saved, false);
	assert.equal(result.conflicts.length, 1);
	assert.deepEqual(result.conflicts[0], {
		path: 'kitchen.meals[dinner].servings',
		local: 6,
		remote: 4
	});
});

test('chained pantry deductions honor prefer = remote while preserving disjoint additions', async () => {
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	stepOne.pantry.push({
		id: 'olive-oil',
		name: 'olive oil',
		quantity: 1,
		unit: 'bottle',
		category: 'Pantry'
	});
	const stepTwo = structuredClone(stepOne);
	stepTwo.pantry[0].quantity = 1;

	const server = structuredClone(base);
	server.pantry[0].quantity = 3;
	const records = [
		journalRecord('w1', base, stepOne, 10),
		journalRecord('w2', stepOne, stepTwo, 20)
	];

	const savedStates: Array<ReturnType<typeof createNewUserState>> = [];
	const transport = {
		identity: { userId: 'a', householdId: 'home' },
		get: async () => ({
			state: structuredClone(server),
			etag: 'v2',
			userId: 'a',
			householdId: 'home'
		}),
		put: async (state: ReturnType<typeof createNewUserState>) => {
			savedStates.push(structuredClone(state));
			return { state, etag: 'v3' };
		}
	};
	const preview = await syncPendingKitchenJournal(records, transport);
	assert.equal(preview.saved, false);
	assert.equal(preview.etag, 'v2');
	const resolved = await syncPendingKitchenJournal(records, transport, 'remote', preview.etag);
	assert.equal(resolved.saved, true);
	assert.equal(savedStates.length, 1);
	assert.equal(savedStates[0].pantry.find((item) => item.id === 'flour')?.quantity, 3);
	assert.ok(savedStates[0].pantry.some((item) => item.id === 'olive-oil'));
});

test('reverting an offline pantry edit alongside a new item merges cleanly against a changed server quantity', () => {
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	stepOne.pantry.push({
		id: 'garlic',
		name: 'garlic',
		quantity: 2,
		unit: 'bulb',
		category: 'Produce'
	});
	const stepTwo = structuredClone(stepOne);
	stepTwo.pantry[0].quantity = 4;

	const remote = structuredClone(base);
	remote.pantry[0].quantity = 2;

	const merged = mergePendingKitchenJournal(
		[journalRecord('w1', base, stepOne, 10), journalRecord('w2', stepOne, stepTwo, 20)],
		remote
	);
	assert.equal(merged.conflicts.length, 0);
	assert.equal(merged.state.pantry.find((item) => item.id === 'flour')?.quantity, 2);
	assert.ok(merged.state.pantry.some((item) => item.id === 'garlic'));
});

test('same-timestamp dependent pantry deductions with peer shopping items replay after ancestors', () => {
	const ancestorBase = createNewUserState();
	ancestorBase.pantry = [
		{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }
	];
	const ancestorLocal = structuredClone(ancestorBase);
	ancestorLocal.pantry[0].quantity = 3;

	const dependentBase = structuredClone(ancestorLocal);
	dependentBase.shopping = [
		{ id: 'milk', name: 'milk', quantity: 1, unit: 'carton', checked: false }
	];
	const dependentLocal = structuredClone(dependentBase);
	dependentLocal.pantry[0].quantity = 1;

	// Use writerIds where dependent sorts lexicographically before ancestor at the same timestamp.
	const records = [
		journalRecord('a-dependent', dependentBase, dependentLocal, 1_000),
		journalRecord('z-ancestor', ancestorBase, ancestorLocal, 1_000)
	];

	const cleanRemote = structuredClone(ancestorBase);
	cleanRemote.shopping = structuredClone(dependentBase.shopping);
	const cleanMerged = mergePendingKitchenJournal(records, cleanRemote);
	assert.equal(cleanMerged.conflicts.length, 0);
	assert.equal(cleanMerged.state.pantry[0].quantity, 1);
	assert.equal(cleanMerged.state.shopping.length, 1);

	const competingRemote = structuredClone(cleanRemote);
	competingRemote.pantry[0].quantity = 2;
	const unresolved = mergePendingKitchenJournal(records, competingRemote);
	assert.equal(unresolved.conflicts.length, 1);
	assert.equal(unresolved.conflicts[0].local, 1);
	assert.equal(unresolved.conflicts[0].remote, 2);

	const resolvedLocal = mergePendingKitchenJournal(records, competingRemote, 'local');
	assert.equal(resolvedLocal.state.pantry[0].quantity, 1);
});

test('readPendingJournal quarantines unreadable or invalid slots under isolated keys and keeps valid edits', () => {
	const values = new Map<string, string>();
	const storage = {
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
	const userA = { id: 'user:a', householdId: 'home:a', name: 'A', email: 'a@example.test' };
	const userOtherHome = { ...userA, householdId: 'home:b' };
	const base = createNewUserState();
	const validLocal = structuredClone(base);
	validLocal.pantry.push({
		id: 'olive-oil',
		name: 'olive oil',
		quantity: 1,
		unit: 'bottle',
		category: 'Pantry'
	});
	writePendingJournal(storage, {
		userId: userA.id,
		householdId: userA.householdId,
		base,
		local: validLocal,
		etag: 'v1',
		createdAt: 10,
		updatedAt: 20,
		writerId: 'tab-valid',
		writeId: 'w1'
	});
	writePendingJournal(storage, {
		userId: userOtherHome.id,
		householdId: userOtherHome.householdId,
		base,
		local: validLocal,
		etag: 'v1',
		createdAt: 10,
		updatedAt: 20,
		writerId: 'tab-other-home',
		writeId: 'w2'
	});

	const prefixA = `flavorithm-pending-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:`;
	const quarantineA = `flavorithm-quarantined-journal:v1:${encodeURIComponent(userA.id)}:${encodeURIComponent(userA.householdId)}:`;
	storage.setItem(`${prefixA}tab-corrupt`, '{broken-json');

	const invalidLocal = structuredClone(base);
	(invalidLocal.pantry as unknown[]).push({
		id: 'bad',
		name: 'salt',
		quantity: null,
		unit: 'tsp',
		category: 'Spices'
	});
	storage.setItem(
		`${prefixA}tab-invalid`,
		JSON.stringify({
			userId: userA.id,
			householdId: userA.householdId,
			base,
			local: invalidLocal,
			etag: 'v1',
			updatedAt: 25,
			writerId: 'tab-invalid'
		})
	);
	storage.setItem(
		`${prefixA}tab-mismatch`,
		JSON.stringify({
			userId: userA.id,
			householdId: userA.householdId,
			base,
			local: validLocal,
			etag: 'v1',
			updatedAt: 30,
			writerId: 'different-writer'
		})
	);

	const loaded = readPendingJournal(storage, userA);
	assert.equal(loaded.records.length, 1);
	assert.equal(loaded.records[0].writerId, 'tab-valid');
	assert.match(loaded.error, /quarantined/);
	assert.equal(storage.getItem(`${prefixA}tab-corrupt`), null);
	assert.equal(storage.getItem(`${prefixA}tab-invalid`), null);
	assert.equal(storage.getItem(`${prefixA}tab-mismatch`), null);
	assert.equal(storage.getItem(`${quarantineA}tab-corrupt`), '{broken-json');
	assert.ok(storage.getItem(`${quarantineA}tab-invalid`)?.includes('"quantity":null'));
	assert.ok(storage.getItem(`${quarantineA}tab-mismatch`)?.includes('different-writer'));

	const otherHomeLoaded = readPendingJournal(storage, userOtherHome);
	assert.equal(otherHomeLoaded.records.length, 1);
	assert.equal(otherHomeLoaded.error, '');
	assert.equal(
		[...values.keys()].some((k) =>
			k.startsWith(
				`flavorithm-quarantined-journal:v1:${encodeURIComponent(userOtherHome.id)}:${encodeURIComponent(userOtherHome.householdId)}:`
			)
		),
		false
	);
});

test('isKitchenState shares the server appState schema without drift', async () => {
	process.env.FLAVORITHM_DB_PATH ??= ':memory:';
	const { validateAppState } = await import('../src/lib/server/db.ts');

	const starter = createInitialState();
	starter.recipes[0].sampleSaved = true;
	starter.preferences.usePersonalAI = true;
	assert.equal(isKitchenState(starter), true);
	assert.deepEqual(validateAppState(starter), starter);

	const valid = createNewUserState();
	valid.recipes.push({
		...starter.recipes[0],
		id: 'cover-recipe',
		image: `/api/recipe-covers/${'a'.repeat(64)}`,
		importNotes: ['a'.repeat(300)],
		sampleSaved: false
	});
	valid.pantry.push({
		id: 'sample-pantry',
		name: 'garlic',
		quantity: 3,
		unit: 'clove',
		category: 'Produce',
		sample: true
	});
	valid.shopping.push({
		id: 'sample-shop',
		name: 'lemons',
		quantity: 2,
		unit: 'piece',
		checked: false
	});
	valid.meals.push({
		id: 'sample-meal',
		date: '2026-04-01',
		slot: 'Dinner',
		recipeId: 'cover-recipe',
		servings: 2,
		sample: true
	});
	valid.preferences.reasoning = { effort: 'xhigh', enabled: true, budgetTokens: 1024 };
	assert.equal(isKitchenState(valid), true);
	assert.deepEqual(validateAppState(valid), valid);
	assert.deepEqual(validateKitchenState(valid), valid);

	const badCover = structuredClone(valid);
	badCover.recipes[0].image = `/recipe-covers/${'a'.repeat(64)}`;
	assert.equal(isKitchenState(badCover), false);
	assert.equal(validateAppState(badCover), null);

	const badNote = structuredClone(valid);
	badNote.recipes[0].importNotes = ['a'.repeat(301)];
	assert.equal(isKitchenState(badNote), false);
	assert.equal(validateAppState(badNote), null);

	const badEffort = structuredClone(valid);
	badEffort.preferences.reasoning = { effort: 'x-high' };
	assert.equal(isKitchenState(badEffort), false);
	assert.equal(validateAppState(badEffort), null);

	for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const badNumber = structuredClone(valid);
		badNumber.recipes[0].nutrition.calories = nonFinite;
		assert.equal(isKitchenState(badNumber), false);
		assert.equal(validateAppState(badNumber), null);
	}
});

test('quarantine slots bound suffix and payload growth and expose entries for backup recovery', () => {
	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'user-q', householdId: 'home-q', name: 'Q', email: 'q@example.test' };
	const pendingPrefix = `flavorithm-pending-journal:v1:${user.id}:${user.householdId}:`;
	const quarantinePrefix = `flavorithm-quarantined-journal:v1:${user.id}:${user.householdId}:`;

	for (let round = 1; round <= MAX_QUARANTINED_JOURNAL_ENTRIES + 4; round += 1) {
		storage.setItem(`${pendingPrefix}same-slot`, JSON.stringify({ round, broken: true }));
		const loaded = readPendingJournal(storage, user);
		assert.match(loaded.error, /quarantined/);
	}

	const oversizedPayload = `{"corrupt":"${'x'.repeat(300_000)}"}`;
	storage.setItem(`${pendingPrefix}huge-slot`, oversizedPayload);
	readPendingJournal(storage, user);

	const quarantinedKeys = [...values.keys()].filter((entry) => entry.startsWith(quarantinePrefix));
	assert.ok(quarantinedKeys.length <= MAX_QUARANTINED_JOURNAL_ENTRIES);
	for (const keyName of quarantinedKeys) {
		const suffix = keyName.slice(quarantinePrefix.length);
		assert.doesNotMatch(suffix, /:\d{10,}$/);
	}

	const entries = readQuarantinedJournal(storage, user);
	assert.equal(entries.length, quarantinedKeys.length);
	const huge = entries.find((entry) => entry.slot.startsWith('huge-slot'));
	assert.ok(huge);
	assert.equal(huge.raw, oversizedPayload);
	assert.equal(storage.getItem(`${pendingPrefix}huge-slot`), null);
	assert.deepEqual(huge.parsed, JSON.parse(oversizedPayload));
	const parsedEntry = entries.find((entry) => entry.parsed !== undefined);
	assert.ok(parsedEntry);
});

test('legacy stored recipes in journal base or server state heal without blocking valid edits', async () => {
	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'legacy-u', householdId: 'legacy-h', name: 'L', email: 'l@example.test' };
	const legacyBase = createInitialState();
	legacyBase.recipes[0].image = 'http://legacy.example/soup.jpg';
	legacyBase.recipes[0].importNotes = ['n'.repeat(340)];
	(legacyBase.preferences as Record<string, unknown>).connectionId = 'host-chatgpt';
	legacyBase.preferences.reasoning = { effort: 'invalid-legacy' };

	const validLocal = structuredClone(legacyBase);
	validLocal.pantry.push({
		id: 'chickpeas',
		name: 'chickpeas',
		quantity: 2,
		unit: 'can',
		category: 'Pantry'
	});
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base: legacyBase,
		local: validLocal,
		etag: 'v1',
		createdAt: 1,
		updatedAt: 2,
		writerId: 'tab-legacy',
		writeId: 'w-legacy'
	});

	const loaded = readPendingJournal(storage, user);
	assert.equal(loaded.error, '');
	assert.equal(loaded.records.length, 1);
	assert.equal(isKitchenState(loaded.records[0].pending.local), true);

	const remoteWithLegacy = structuredClone(legacyBase);
	remoteWithLegacy.shopping.push({
		id: 'bread',
		name: 'sourdough',
		quantity: 1,
		unit: 'loaf',
		checked: false
	});

	let uploaded: unknown = null;
	const synced = await syncPendingKitchenJournal(loaded.records, {
		identity: { userId: user.id, householdId: user.householdId },
		get: async () => ({
			state: remoteWithLegacy,
			etag: 'v2',
			userId: user.id,
			householdId: user.householdId
		}),
		put: async (state) => {
			const validated = validateKitchenState(state);
			assert.ok(validated);
			uploaded = validated;
			return { state: validated, etag: 'v3' };
		}
	});
	assert.equal(synced.saved, true);
	assert.ok(uploaded);
	assert.equal(synced.state.recipes[0].image, '');
	assert.equal(synced.state.recipes[0].importNotes?.[0].length, 300);
	assert.equal(
		synced.state.pantry.some((item) => item.id === 'chickpeas'),
		true
	);
	assert.equal(
		synced.state.shopping.some((item) => item.id === 'bread'),
		true
	);
});

test('parsePending preserves valid foldedFrom through legacy repair and quarantines malformed foldedFrom', () => {
	const values = new Map<string, string>();
	const storage = {
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
	const user = { id: 'fold-u', householdId: 'fold-h', name: 'F', email: 'f@example.test' };
	const legacyBase = createInitialState();
	legacyBase.recipes[0].image = 'http://legacy.example/soup.jpg';
	legacyBase.preferences.reasoning = { effort: 'invalid-legacy' };

	const stepOne = structuredClone(legacyBase);
	stepOne.shopping.push({ id: 'oats', name: 'oats', quantity: 1, unit: 'bag', checked: false });
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base: legacyBase,
		local: stepOne,
		etag: 'v1',
		createdAt: 10,
		updatedAt: 10,
		writerId: 'tab-ancestor',
		writeId: 'w-anc'
	});

	const stepTwo = structuredClone(stepOne);
	stepTwo.shopping.push({ id: 'tea', name: 'tea', quantity: 2, unit: 'box', checked: false });
	writePendingJournal(storage, {
		userId: user.id,
		householdId: user.householdId,
		base: legacyBase,
		local: stepTwo,
		etag: 'v1',
		createdAt: 20,
		updatedAt: 20,
		writerId: 'tab-compacted',
		writeId: 'w-comp',
		foldedFrom: [{ writerId: 'tab-ancestor', writeId: 'w-anc', updatedAt: 10, createdAt: 10 }]
	});

	const prefix = `flavorithm-pending-journal:v1:${user.id}:${user.householdId}:`;
	storage.setItem(
		`${prefix}tab-bad-fold`,
		JSON.stringify({
			userId: user.id,
			householdId: user.householdId,
			base: legacyBase,
			local: stepTwo,
			etag: 'v1',
			createdAt: 30,
			updatedAt: 30,
			writerId: 'tab-bad-fold',
			writeId: 'w-bad',
			foldedFrom: [{ writerId: '', updatedAt: 10 }]
		})
	);

	const loaded = readPendingJournal(storage, user);
	assert.match(loaded.error, /quarantined/);
	assert.equal(storage.getItem(`${prefix}tab-bad-fold`), null);
	assert.equal(loaded.records.length, 2);
	const compacted = loaded.records.find((record) => record.writerId === 'tab-compacted');
	assert.ok(compacted);
	assert.equal(isKitchenState(compacted.pending.local), true);
	assert.deepEqual(compacted.pending.foldedFrom, [
		{ writerId: 'tab-ancestor', writeId: 'w-anc', updatedAt: 10, createdAt: 10 }
	]);
	assert.deepEqual(
		filterUnfoldedJournalRecords(loaded.records).map((record) => record.writerId),
		['tab-compacted']
	);
});

test('prefer syncs pin If-Match to reviewedEtag and halt without PUT when GET returns a newer ETag', async () => {
	const base = createNewUserState();
	base.pantry = [
		{ id: 'milk', name: 'milk', quantity: 1, unit: 'carton', category: 'Dairy' },
		{ id: 'eggs', name: 'eggs', quantity: 12, unit: 'piece', category: 'Dairy' }
	];
	const local = structuredClone(base);
	local.pantry[0].quantity = 2;
	local.pantry[1].quantity = 6;
	const remoteAtEtag3 = structuredClone(base);
	remoteAtEtag3.pantry[0].quantity = 4;
	remoteAtEtag3.pantry[1].quantity = 0;

	const record: PendingJournalRecord = {
		writerId: 'tab-1',
		pending: {
			userId: 'a',
			householdId: 'home',
			base,
			local,
			etag: 'etag-1',
			updatedAt: 1,
			writerId: 'tab-1'
		},
		keys: []
	};
	let puts = 0;
	const localChoiceResult = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({
				state: structuredClone(remoteAtEtag3),
				etag: 'etag-3',
				userId: 'a',
				householdId: 'home'
			}),
			put: async (state) => {
				puts += 1;
				return { state, etag: 'etag-4' };
			}
		},
		'local',
		'etag-2'
	);
	assert.equal(puts, 0);
	assert.equal(localChoiceResult.saved, false);
	assert.equal(localChoiceResult.staleEtag, true);
	assert.equal(localChoiceResult.etag, 'etag-3');
	assert.deepEqual(localChoiceResult.conflicts.map((item) => item.path).sort(), [
		'kitchen.pantry[eggs].quantity',
		'kitchen.pantry[milk].quantity'
	]);

	const journalResult = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => ({
				state: structuredClone(remoteAtEtag3),
				etag: 'etag-3',
				userId: 'a',
				householdId: 'home'
			}),
			put: async (state) => {
				puts += 1;
				return { state, etag: 'etag-4' };
			}
		},
		'remote',
		'etag-2'
	);
	assert.equal(puts, 0);
	assert.equal(journalResult.saved, false);
	assert.equal(journalResult.staleEtag, true);
	assert.equal(journalResult.etag, 'etag-3');
	assert.equal(journalResult.conflicts.length, 2);
});

test('prefer syncs skip 412 retries and recompute conflicts against the latest server state', async () => {
	const base = createNewUserState();
	const local = structuredClone(base);
	local.preferences.maxTime = 20;
	local.preferences.allergies = 'sesame';
	const reviewedRemote = structuredClone(base);
	reviewedRemote.preferences.maxTime = 60;
	const newerRemote = structuredClone(reviewedRemote);
	newerRemote.preferences.allergies = 'peanuts';

	const record: PendingJournalRecord = {
		writerId: 'tab-1',
		pending: {
			userId: 'a',
			householdId: 'home',
			base,
			local,
			etag: 'etag-1',
			updatedAt: 1,
			writerId: 'tab-1'
		},
		keys: []
	};
	let gets = 0;
	const putEtags: string[] = [];
	const result = await syncPendingKitchenJournal(
		[record],
		{
			identity: { userId: 'a', householdId: 'home' },
			get: async () => {
				gets += 1;
				return gets === 1
					? {
							state: structuredClone(reviewedRemote),
							etag: 'etag-2',
							userId: 'a',
							householdId: 'home'
						}
					: {
							state: structuredClone(newerRemote),
							etag: 'etag-3',
							userId: 'a',
							householdId: 'home'
						};
			},
			put: async (_state, etag) => {
				putEtags.push(etag);
				throw Object.assign(new Error('Precondition Failed'), { status: 412 });
			}
		},
		'remote',
		'etag-2'
	);
	assert.deepEqual(putEtags, ['etag-2']);
	assert.equal(result.saved, false);
	assert.equal(result.staleEtag, true);
	assert.equal(result.etag, 'etag-3');
	assert.deepEqual(result.conflicts.map((item) => item.path).sort(), [
		'kitchen.preferences.allergies',
		'kitchen.preferences.maxTime'
	]);
});

test('mergePendingKitchenJournal anchors cross-tab conflict remote values to server state and preserves disjoint edits', () => {
	const base = createNewUserState();
	base.preferences.maxTime = 45;
	const tabA = structuredClone(base);
	tabA.preferences.maxTime = 25;
	tabA.pantry.push({ id: 'rice', name: 'rice', quantity: 2, unit: 'cup', category: 'Pantry' });
	const tabB = structuredClone(base);
	tabB.preferences.maxTime = 70;
	tabB.shopping.push({
		id: 'lemons',
		name: 'lemons',
		quantity: 3,
		unit: 'piece',
		checked: false
	});
	const remote = structuredClone(base);
	remote.pantry.push({ id: 'beans', name: 'beans', quantity: 1, unit: 'can', category: 'Pantry' });

	const records: PendingJournalRecord[] = [
		{
			writerId: 'tab-a',
			pending: {
				userId: 'a',
				householdId: 'home',
				base,
				local: tabA,
				etag: 'etag-1',
				createdAt: 1,
				updatedAt: 1,
				writerId: 'tab-a'
			},
			keys: []
		},
		{
			writerId: 'tab-b',
			pending: {
				userId: 'a',
				householdId: 'home',
				base,
				local: tabB,
				etag: 'etag-1',
				createdAt: 2,
				updatedAt: 2,
				writerId: 'tab-b'
			},
			keys: []
		}
	];

	const preview = mergePendingKitchenJournal(records, remote);
	assert.deepEqual(preview.conflicts, [
		{
			path: 'kitchen.preferences.maxTime',
			local: 70,
			remote: 45
		}
	]);
	assert.equal(preview.state.preferences.maxTime, 45);

	const chooseHousehold = mergePendingKitchenJournal(records, remote, 'remote');
	assert.equal(chooseHousehold.state.preferences.maxTime, 45);
	assert.deepEqual(chooseHousehold.state.pantry.map((item) => item.id).sort(), ['beans', 'rice']);
	assert.deepEqual(
		chooseHousehold.state.shopping.map((item) => item.id),
		['lemons']
	);

	const chooseMine = mergePendingKitchenJournal(records, remote, 'local');
	assert.equal(chooseMine.state.preferences.maxTime, 70);
	assert.deepEqual(chooseMine.state.pantry.map((item) => item.id).sort(), ['beans', 'rice']);
	assert.deepEqual(
		chooseMine.state.shopping.map((item) => item.id),
		['lemons']
	);

	const serverChanged = structuredClone(remote);
	serverChanged.preferences.maxTime = 60;
	const tripleConflict = mergePendingKitchenJournal(records, serverChanged);
	assert.deepEqual(tripleConflict.conflicts, [
		{
			path: 'kitchen.preferences.maxTime',
			local: 70,
			remote: 60
		}
	]);
});

test('jsonEqual ignores key order and undefined properties while preserving JSON null/array/number/toJSON semantics', () => {
	// Key order differs from JSON.stringify, while representing the same JSON object.
	const orderedA = { id: 'p-1', name: 'flour', quantity: 4, nested: { a: 1, b: 2 } };
	const orderedB = { nested: { b: 2, a: 1 }, quantity: 4, name: 'flour', id: 'p-1' };
	assert.notEqual(JSON.stringify(orderedA), JSON.stringify(orderedB));
	assert.equal(jsonEqual(orderedA, orderedB), true);

	// Undefined object properties match omitted properties, but never null or false.
	const withUndefined = { id: 'r-1', rating: undefined, notes: undefined };
	const omitted = { id: 'r-1' };
	assert.equal(jsonEqual(withUndefined, omitted), true);
	assert.equal(jsonEqual(omitted, withUndefined), true);
	assert.equal(jsonEqual(withUndefined, { id: 'r-1', rating: null }), false);
	assert.equal(jsonEqual(withUndefined, { id: 'r-1', rating: false }), false);

	// Arrays and non-finite numbers follow JSON serialization (undefined/NaN/Infinity -> null, -0 === 0).
	assert.equal(
		jsonEqual([1, undefined, NaN, Infinity, -Infinity], [1, null, null, null, null]),
		true
	);
	assert.equal(jsonEqual({ count: -0, bad: NaN }, { count: 0, bad: null }), true);
	assert.equal(jsonEqual([1, 2], [2, 1]), false);

	// Objects with toJSON (such as Date) compare their JSON representation, and Object.prototype keys never collide.
	assert.equal(jsonEqual(new Date(1_000), new Date(2_000)), false);
	assert.equal(jsonEqual(new Date('2026-10-22T00:00:00.000Z'), '2026-10-22T00:00:00.000Z'), true);
	assert.equal(jsonEqual({ toString: 'custom' }, {}), false);
	assert.equal(jsonEqual({}, { constructor: 'custom' }), false);

	// Reordered keys and undefined optional fields do not manufacture diffs in mergeKitchenStates.
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];
	const localReordered = structuredClone(base);
	localReordered.pantry = [
		{
			category: 'Pantry',
			unit: 'cup',
			quantity: 4,
			name: 'flour',
			id: 'flour',
			expires: undefined
		}
	];
	const remoteEdited = structuredClone(base);
	remoteEdited.pantry[0].quantity = 2;
	const merged = mergeKitchenStates(base, localReordered, remoteEdited);
	assert.equal(merged.conflicts.length, 0);
	assert.equal(merged.state.pantry[0].quantity, 2);
});

test('leftover folded ancestors compose without concurrentPantryQuantity conflicts while preserving newer slot writes', () => {
	const base = createNewUserState();
	base.pantry = [{ id: 'flour', name: 'flour', quantity: 4, unit: 'cup', category: 'Pantry' }];

	const stepOne = structuredClone(base);
	stepOne.pantry[0].quantity = 3;
	const ancestor = journalRecord('z-ancestor', base, stepOne, 1_000);

	// Compacted record written at the same timestamp with lexicographically smaller writerId ('a-compacted' < 'z-ancestor')
	const stepTwo = structuredClone(stepOne);
	stepTwo.pantry.push({ id: 'rice', name: 'rice', quantity: 1, unit: 'bag', category: 'Pantry' });
	const compacted = journalRecord('a-compacted', base, stepTwo, 1_000);
	compacted.pending.foldedFrom = [
		{
			writerId: ancestor.writerId,
			writeId: ancestor.pending.writeId,
			updatedAt: ancestor.pending.updatedAt,
			createdAt: ancestor.pending.createdAt
		}
	];

	assert.deepEqual(
		filterUnfoldedJournalRecords([ancestor, compacted]).map((item) => item.writerId),
		['a-compacted']
	);
	const composed = composePendingKitchenJournal([ancestor, compacted]);
	assert.ok(composed);
	assert.equal(composed.conflicts.length, 0);
	assert.equal(composed.local.pantry.find((item) => item.id === 'flour')?.quantity, 3);
	assert.ok(composed.local.pantry.some((item) => item.id === 'rice'));

	// If z-ancestor later writes a newer version (different writeId), that newer write is not treated as folded.
	const newerAncestorState = structuredClone(stepOne);
	newerAncestorState.shopping.push({
		id: 'tea',
		name: 'tea',
		quantity: 1,
		unit: 'box',
		checked: false
	});
	const newerWrite = journalRecord('z-ancestor', stepOne, newerAncestorState, 1_001);
	const withNewer = mergePendingKitchenJournal([newerWrite, compacted], base);
	assert.equal(withNewer.conflicts.length, 0);
	assert.deepEqual(
		withNewer.state.shopping.map((item) => item.id),
		['tea']
	);
});

test('composePendingKitchenJournal and mergePendingKitchenJournal share orphaned-meal protection across cross-tab recipe deletion', () => {
	const base = createNewUserState();
	const deletedRecipe = structuredClone(base);
	deletedRecipe.recipes.shift();

	const plannedMeal = structuredClone(base);
	plannedMeal.meals.push({
		id: 'dinner',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: base.recipes[0].id,
		servings: 2
	});

	const records = [
		journalRecord('tab-delete', base, deletedRecipe, 10),
		journalRecord('tab-plan', base, plannedMeal, 20)
	];
	const composed = composePendingKitchenJournal(records);
	assert.ok(composed);
	assert.equal(composed.conflicts.length, 1);
	assert.equal(composed.conflicts[0].path, 'kitchen.meals[dinner].recipeId');

	const mergedKeepLocal = mergePendingKitchenJournal(records, deletedRecipe, 'local');
	assert.equal(mergedKeepLocal.state.meals.length, 1);
	assert.ok(mergedKeepLocal.state.recipes.some((item) => item.id === base.recipes[0].id));

	const mergedKeepRemote = mergePendingKitchenJournal(records, deletedRecipe, 'remote');
	assert.equal(mergedKeepRemote.state.meals.length, 0);
});

function createSeededRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(items: readonly T[], rng: () => number): T {
	return items[Math.floor(rng() * items.length)];
}

const PROPERTY_DATES = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
const PROPERTY_SLOTS = ['Breakfast', 'Lunch', 'Dinner'] as const;
const PROPERTY_UNITS = ['cup', 'piece', 'tbsp', 'lb'] as const;
const PROPERTY_MEAL_IDS = ['meal-0', 'meal-1', 'meal-2', 'meal-3', 'meal-4', 'meal-5'];
const PROPERTY_SHOP_IDS = ['shop-0', 'shop-1', 'shop-2', 'shop-3', 'shop-4', 'shop-5'];
const EXTRA_RECIPE_IDS = ['prop-recipe-4', 'prop-recipe-5'];

function makePropertyRecipe(template: Recipe, id: string, titleSuffix: string): Recipe {
	return {
		...structuredClone(template),
		id,
		title: `Property ${titleSuffix}`,
		saved: true,
		sampleSaved: false
	};
}

function createMealShoppingSeedState(rng: () => number): AppState {
	const starter = createInitialState();
	const state = createNewUserState();
	state.recipes = [0, 1, 2, 3].map((index) =>
		makePropertyRecipe(
			starter.recipes[index % starter.recipes.length],
			`prop-recipe-${index}`,
			`${index}`
		)
	);
	const initialMeals = Math.floor(rng() * 3);
	for (let i = 0; i < initialMeals; i += 1) {
		const id = PROPERTY_MEAL_IDS[i];
		const recipe = pick(state.recipes, rng);
		state.meals.push({
			id,
			date: pick(PROPERTY_DATES, rng),
			slot: pick(PROPERTY_SLOTS, rng),
			recipeId: recipe.id,
			servings: 1 + Math.floor(rng() * 4)
		});
	}
	const initialShop = Math.floor(rng() * 3);
	for (let i = 0; i < initialShop; i += 1) {
		const id = PROPERTY_SHOP_IDS[i];
		state.shopping.push({
			id,
			name: `Item ${i}`,
			quantity: 1 + Math.floor(rng() * 5),
			unit: pick(PROPERTY_UNITS, rng),
			checked: rng() < 0.3,
			...(rng() < 0.4 ? { sourceKey: `week:2026-11-02:${id}` } : {})
		});
	}
	return state;
}

function mutateMealsAndShoppingStep(
	current: AppState,
	baseline: AppState,
	rng: () => number,
	allowRecipeDelete = true
): AppState {
	const next = structuredClone(current);
	const ops = 1 + Math.floor(rng() * 3);
	for (let step = 0; step < ops; step += 1) {
		const action = Math.floor(rng() * 10);
		if (action <= 1) {
			// Plan or replace a meal for an available recipe.
			if (!next.recipes.length) continue;
			const mealId = pick(PROPERTY_MEAL_IDS, rng);
			const recipe = pick(next.recipes, rng);
			const meal: Meal = {
				id: mealId,
				date: pick(PROPERTY_DATES, rng),
				slot: pick(PROPERTY_SLOTS, rng),
				recipeId: recipe.id,
				servings: 1 + Math.floor(rng() * 6),
				...(rng() < 0.25
					? {
							completedAt: `2026-11-0${2 + Math.floor(rng() * 5)}T18:00:00.000Z`,
							leftoverServings: Math.floor(rng() * 3)
						}
					: {})
			};
			const existingIndex = next.meals.findIndex((entry) => entry.id === mealId);
			if (existingIndex === -1) next.meals.push(meal);
			else next.meals[existingIndex] = meal;
		} else if (action === 2 && next.meals.length) {
			// Update meal servings/slot/completion/leftovers.
			const target = pick(next.meals, rng);
			const kind = Math.floor(rng() * 3);
			if (kind === 0) {
				target.servings = 1 + ((target.servings % 6) + 1);
			} else if (kind === 1) {
				target.slot = pick(PROPERTY_SLOTS, rng);
				target.date = pick(PROPERTY_DATES, rng);
			} else {
				target.completedAt = '2026-11-06T19:30:00.000Z';
				target.leftoverServings = ((target.leftoverServings ?? 0) + 1) % 4;
			}
		} else if (action === 3 && next.meals.length) {
			// Delete a meal.
			const removeIndex = Math.floor(rng() * next.meals.length);
			next.meals.splice(removeIndex, 1);
		} else if (action === 4) {
			// Revert a meal back to baseline state (if its recipe still exists).
			const mealId = pick(PROPERTY_MEAL_IDS, rng);
			const baseMeal = baseline.meals.find((entry) => entry.id === mealId);
			const idx = next.meals.findIndex((entry) => entry.id === mealId);
			if (!baseMeal) {
				if (idx !== -1) next.meals.splice(idx, 1);
			} else if (next.recipes.some((recipe) => recipe.id === baseMeal.recipeId)) {
				if (idx === -1) next.meals.push(structuredClone(baseMeal));
				else next.meals[idx] = structuredClone(baseMeal);
			}
		} else if (action === 5) {
			// Add a recipe (and sometimes plan a meal for it).
			const extraId = pick(EXTRA_RECIPE_IDS, rng);
			if (!next.recipes.some((recipe) => recipe.id === extraId)) {
				const template = createInitialState().recipes[0];
				next.recipes.push(makePropertyRecipe(template, extraId, extraId));
				if (rng() < 0.6) {
					const mealId = pick(PROPERTY_MEAL_IDS, rng);
					const planned: Meal = {
						id: mealId,
						date: pick(PROPERTY_DATES, rng),
						slot: pick(PROPERTY_SLOTS, rng),
						recipeId: extraId,
						servings: 2
					};
					const idx = next.meals.findIndex((entry) => entry.id === mealId);
					if (idx === -1) next.meals.push(planned);
					else next.meals[idx] = planned;
				}
			}
		} else if (action === 6 && allowRecipeDelete && next.recipes.length > 2) {
			// Delete a recipe and locally drop any meals referencing it.
			const removable = next.recipes[Math.floor(rng() * next.recipes.length)];
			next.recipes = next.recipes.filter((recipe) => recipe.id !== removable.id);
			next.meals = next.meals.filter((meal) => meal.recipeId !== removable.id);
		} else if (action === 7) {
			// Add or update a shopping item.
			const shopId = pick(PROPERTY_SHOP_IDS, rng);
			const existing = next.shopping.find((item) => item.id === shopId);
			if (!existing) {
				next.shopping.push({
					id: shopId,
					name: `Ingredient ${shopId}`,
					quantity: 1 + Math.floor(rng() * 6),
					unit: pick(PROPERTY_UNITS, rng),
					checked: rng() < 0.5,
					...(rng() < 0.4 ? { sourceKey: `auto:${shopId}` } : {})
				});
			} else {
				if (rng() < 0.5) existing.checked = !existing.checked;
				else existing.quantity = Math.max(0.5, Math.round((existing.quantity + 1.5) * 10) / 10);
			}
		} else if (action === 8 && next.shopping.length) {
			// Delete a shopping item.
			next.shopping.splice(Math.floor(rng() * next.shopping.length), 1);
		} else {
			// Revert a shopping item back to baseline state.
			const shopId = pick(PROPERTY_SHOP_IDS, rng);
			const baseShop = baseline.shopping.find((item) => item.id === shopId);
			const idx = next.shopping.findIndex((item) => item.id === shopId);
			if (!baseShop) {
				if (idx !== -1) next.shopping.splice(idx, 1);
			} else if (idx === -1) {
				next.shopping.push(structuredClone(baseShop));
			} else {
				next.shopping[idx] = structuredClone(baseShop);
			}
		}
	}
	assert.equal(isKitchenState(next), true);
	return next;
}

function assertSameIdCollection(
	actual: Array<{ id: string }>,
	expected: Array<{ id: string }>,
	label: string
): void {
	assert.equal(
		new Set(actual.map((item) => item.id)).size,
		actual.length,
		`${label} must have unique IDs`
	);
	assert.equal(actual.length, expected.length, `${label} length mismatch`);
	const expectedById = new Map(expected.map((item) => [item.id, item]));
	for (const item of actual) {
		assert.equal(jsonEqual(item, expectedById.get(item.id)), true, `${label}[${item.id}] mismatch`);
	}
}

function assertNoOrphanedMeals(state: AppState): void {
	const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
	for (const meal of state.meals) {
		assert.ok(
			recipeIds.has(meal.recipeId),
			`Meal ${meal.id} references missing recipe ${meal.recipeId}`
		);
	}
}

test('same-timestamp meal deletion after peer creation and concurrent shopping edit never resurrects the meal', () => {
	const s0 = createInitialState();
	s0.meals = [];
	s0.shopping = [];

	// Peer P adds a shopping item at t = 5000.
	const peerLocal = structuredClone(s0);
	peerLocal.shopping.push({
		id: 'milk',
		name: 'Milk',
		quantity: 1,
		unit: 'bottle',
		checked: false
	});

	// Writer M plans a meal at t = 5000.
	const mealAdded = structuredClone(s0);
	mealAdded.meals.push({
		id: 'meal-dinner',
		date: '2026-11-04',
		slot: 'Dinner',
		recipeId: s0.recipes[0].id,
		servings: 2
	});

	// Writer A ('writer-a' < 'writer-m' < 'writer-p') sees both Peer P and Writer M at t = 5000 and deletes the meal.
	const bothVisible = structuredClone(mealAdded);
	bothVisible.shopping = structuredClone(peerLocal.shopping);
	const mealDeleted = structuredClone(bothVisible);
	mealDeleted.meals = [];

	const records = [
		journalRecord('writer-a', bothVisible, mealDeleted, 5_000),
		journalRecord('writer-m', s0, mealAdded, 5_000),
		journalRecord('writer-p', s0, peerLocal, 5_000)
	];
	const composed = composePendingKitchenJournal(records);
	assert.ok(composed);
	assert.equal(composed.conflicts.length, 0);
	assert.deepEqual(composed.local.meals, []);
	assert.deepEqual(
		composed.local.shopping.map((item) => item.id),
		['milk']
	);
});

test('orphaned meal reconciliation restores a shared deleted recipe once when multiple meals reference it', () => {
	const base = createInitialState();
	const sharedRecipe = base.recipes[0];
	base.meals = [
		{ id: 'meal-lunch', date: '2026-11-04', slot: 'Lunch', recipeId: sharedRecipe.id, servings: 2 },
		{
			id: 'meal-dinner',
			date: '2026-11-04',
			slot: 'Dinner',
			recipeId: sharedRecipe.id,
			servings: 3
		}
	];
	const local = structuredClone(base);
	local.recipes = local.recipes.filter((recipe) => recipe.id !== sharedRecipe.id);
	local.meals = [];

	const remote = structuredClone(base);
	remote.meals[0].servings = 4;
	remote.meals[1].servings = 5;

	const single = mergeKitchenStates(base, local, remote);
	assert.equal(single.state.recipes.filter((recipe) => recipe.id === sharedRecipe.id).length, 1);
	assert.equal(isKitchenState(single.state), true);

	const journalMerged = mergePendingKitchenJournal(
		[journalRecord('writer-del', base, local, 100)],
		remote
	);
	assert.equal(
		journalMerged.state.recipes.filter((recipe) => recipe.id === sharedRecipe.id).length,
		1
	);
	assert.equal(isKitchenState(journalMerged.state), true);
});

test('property: sequential multi-writer meal and shopping journals match single-delta merges across 200 seeds', () => {
	const writerPool = ['writer-z', 'writer-a', 'writer-m', 'writer-b', 'writer-q', 'writer-c'];
	for (let seed = 1; seed <= 200; seed += 1) {
		const rng = createSeededRng(seed * 977);
		const s0 = createMealShoppingSeedState(rng);
		const stepCount = 3 + Math.floor(rng() * 4);
		const sameTimestamp = seed % 2 === 0;
		const states: AppState[] = [s0];
		for (let i = 0; i < stepCount; i += 1) {
			let candidate = mutateMealsAndShoppingStep(states[states.length - 1], s0, rng, true);
			// At identical timestamps without foldedFrom metadata, an exact A -> B -> A full-snapshot
			// cycle is symmetric with B -> A -> B; monotonic timestamps test full state cycles, while
			// same-timestamp seeds test causal ordering across distinct states (including field reverts).
			if (sameTimestamp) {
				for (let retry = 0; retry < 5; retry += 1) {
					const revisitsPrior = states
						.slice(0, -1)
						.some((prior) => jsonEqual(prior, candidate) && !jsonEqual(states.at(-1), candidate));
					if (!revisitsPrior) break;
					candidate = mutateMealsAndShoppingStep(states[states.length - 1], s0, rng, true);
				}
				if (
					states
						.slice(0, -1)
						.some((prior) => jsonEqual(prior, candidate) && !jsonEqual(states.at(-1), candidate))
				) {
					continue;
				}
			}
			states.push(candidate);
		}
		const actualSteps = states.length - 1;
		if (!actualSteps) continue;
		const sk = states[states.length - 1];
		const records: PendingJournalRecord[] = [];
		for (let i = 0; i < actualSteps; i += 1) {
			const writerId = writerPool[i % writerPool.length];
			const ts = sameTimestamp ? 5_000 : 5_000 + i * 10;
			records.push(journalRecord(writerId, states[i], states[i + 1], ts));
		}
		// Present records in shuffled order when timestamps are distinct or tied to exercise causal ordering.
		const shuffled = [...records].sort(() => rng() - 0.5);

		const composed = composePendingKitchenJournal(shuffled);
		assert.ok(composed, `seed ${seed}: expected non-null composed journal`);
		assert.equal(
			composed.conflicts.length,
			0,
			`seed ${seed}: sequential chain had local conflicts`
		);
		assertSameIdCollection(composed.local.recipes, sk.recipes, `seed ${seed} composed recipes`);
		assertSameIdCollection(composed.local.meals, sk.meals, `seed ${seed} composed meals`);
		assertSameIdCollection(composed.local.shopping, sk.shopping, `seed ${seed} composed shopping`);
		assertNoOrphanedMeals(composed.local);

		// Diverge remote state (including intermediate-state collisions every 5th seed).
		const remote =
			seed % 5 === 0
				? structuredClone(states[1])
				: mutateMealsAndShoppingStep(mutateMealsAndShoppingStep(s0, s0, rng, true), s0, rng, true);

		for (const prefer of [undefined, 'local', 'remote'] as const) {
			const fromJournal = mergePendingKitchenJournal(shuffled, remote, prefer);
			const fromSingleDelta = mergeKitchenStates(s0, sk, remote, prefer);
			assert.equal(
				isKitchenState(fromJournal.state),
				true,
				`seed ${seed} (${prefer}) invalid state`
			);
			assertNoOrphanedMeals(fromJournal.state);
			assertSameIdCollection(
				fromJournal.state.recipes,
				fromSingleDelta.state.recipes,
				`seed ${seed} (${prefer}) merged recipes`
			);
			assertSameIdCollection(
				fromJournal.state.meals,
				fromSingleDelta.state.meals,
				`seed ${seed} (${prefer}) merged meals`
			);
			assertSameIdCollection(
				fromJournal.state.shopping,
				fromSingleDelta.state.shopping,
				`seed ${seed} (${prefer}) merged shopping`
			);
			const sortConflicts = (items: typeof fromJournal.conflicts) =>
				[...items].sort((a, b) => a.path.localeCompare(b.path));
			assert.equal(
				jsonEqual(sortConflicts(fromJournal.conflicts), sortConflicts(fromSingleDelta.conflicts)),
				true,
				`seed ${seed} (${prefer}) conflict mismatch`
			);
		}
	}
});

test('property: concurrent and folded multi-writer meal and shopping DAGs preserve schema and orphan invariants across 150 seeds', async () => {
	for (let seed = 1; seed <= 150; seed += 1) {
		const rng = createSeededRng(seed * 1_301 + 17);
		const s0 = createMealShoppingSeedState(rng);
		const branchA1 = mutateMealsAndShoppingStep(s0, s0, rng, true);
		const branchA2 = mutateMealsAndShoppingStep(branchA1, s0, rng, true);
		const branchB1 = mutateMealsAndShoppingStep(s0, s0, rng, true);
		const remote = mutateMealsAndShoppingStep(s0, s0, rng, true);

		const recA1 = journalRecord('tab-a1', s0, branchA1, 100);
		const recCompactedA = journalRecord('tab-a2', s0, branchA2, 110);
		recCompactedA.pending.foldedFrom = [
			{
				writerId: recA1.writerId,
				writeId: recA1.pending.writeId,
				updatedAt: recA1.pending.updatedAt,
				createdAt: recA1.pending.createdAt
			}
		];
		const recB1 = journalRecord('tab-b1', s0, branchB1, 105);

		// Including leftover folded ancestor recA1 must be idempotent with [recCompactedA, recB1].
		const withoutFolded = [recCompactedA, recB1];
		const withFolded = [recA1, recCompactedA, recB1];

		for (const prefer of [undefined, 'local', 'remote'] as const) {
			const mergedClean = mergePendingKitchenJournal(withoutFolded, remote, prefer);
			const mergedWithLeftover = mergePendingKitchenJournal(withFolded, remote, prefer);
			assert.equal(isKitchenState(mergedClean.state), true, `seed ${seed} (${prefer}) invalid`);
			assertNoOrphanedMeals(mergedClean.state);
			assert.equal(
				jsonEqual(mergedClean, mergedWithLeftover),
				true,
				`seed ${seed} (${prefer}) leftover folded ancestor changed merge output`
			);
		}

		// Syncing with explicit preference must always upload a valid state without orphaned meals.
		const choice = seed % 2 === 0 ? 'local' : 'remote';
		let uploaded: AppState | null = null;
		const synced = await syncPendingKitchenJournal(
			withFolded,
			{
				identity: { userId: 'a', householdId: 'home' },
				get: async () => ({
					state: structuredClone(remote),
					etag: 'etag-r',
					userId: 'a',
					householdId: 'home'
				}),
				put: async (state) => {
					uploaded = validateKitchenState(state);
					assert.ok(uploaded, `seed ${seed}: uploaded state failed schema validation`);
					assertNoOrphanedMeals(uploaded);
					return { state: structuredClone(uploaded), etag: 'etag-next' };
				}
			},
			choice,
			'etag-r'
		);
		assert.equal(synced.saved, true);
		assert.ok(uploaded);
	}
});
