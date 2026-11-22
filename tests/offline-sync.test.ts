import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewUserState } from '../src/lib/data.ts';
import { completeMeal } from '../src/lib/kitchen-workflows.ts';
import {
	clearPendingJournalRecords,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	syncPendingKitchenJournal,
	writePending,
	type PendingJournalRecord
} from '../src/lib/offline-sync.ts';

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
