import type { AppState, User } from '#lib/types.ts';

export type SyncConflict = { path: string; local: unknown; remote: unknown };
export type PendingKitchen = {
	userId: string;
	householdId: string;
	base: AppState;
	local: AppState;
	etag: string | null;
	updatedAt: number;
	/** A per-tab/controller journal slot; absent on older pending snapshots. */
	writerId?: string;
	/** Stable ordering for deltas that were staged in sequence across tabs. */
	createdAt?: number;
	/** Distinguishes a newer write from an acknowledged snapshot in the same writer slot. */
	writeId?: string;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
	Partial<Pick<Storage, 'key' | 'length'>>;
const key = (user: Pick<User, 'id' | 'householdId'>) =>
	`flavorithm-pending:${user.id}:${user.householdId}`;
const journalPrefix = (user: Pick<User, 'id' | 'householdId'>) =>
	`flavorithm-pending-journal:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(user.householdId)}:`;
export const MAX_PENDING_JOURNAL_ENTRIES = 64;

export type PendingJournalRecord = {
	writerId: string;
	pending: PendingKitchen;
	/** Every durable copy of this writer's current snapshot, including the legacy mirror. */
	keys: Array<{ key: string; pending: PendingKitchen }>;
};
export type PendingJournalRead = { records: PendingJournalRecord[]; error: string };

function parsePending(value: unknown, user: User): PendingKitchen | null {
	if (
		!value ||
		typeof value !== 'object' ||
		(value as PendingKitchen).userId !== user.id ||
		(value as PendingKitchen).householdId !== user.householdId ||
		!isState((value as PendingKitchen).base) ||
		!isState((value as PendingKitchen).local) ||
		!(
			(value as PendingKitchen).etag === null || typeof (value as PendingKitchen).etag === 'string'
		) ||
		!Number.isFinite((value as PendingKitchen).updatedAt) ||
		((value as PendingKitchen).writerId !== undefined &&
			typeof (value as PendingKitchen).writerId !== 'string') ||
		((value as PendingKitchen).createdAt !== undefined &&
			!Number.isFinite((value as PendingKitchen).createdAt)) ||
		((value as PendingKitchen).writeId !== undefined &&
			typeof (value as PendingKitchen).writeId !== 'string')
	) {
		return null;
	}
	return value as PendingKitchen;
}

export function readPending(storage: StorageLike, user: User): PendingKitchen | null {
	try {
		return parsePending(JSON.parse(storage.getItem(key(user)) || 'null'), user);
	} catch {
		return null;
	}
}

/** Read every per-writer durable delta, plus the old single-slot format for migration. */
export function readPendingJournal(storage: StorageLike, user: User): PendingJournalRead {
	const byWriter = new Map<string, PendingJournalRecord>();
	let error = '';
	if (typeof storage.length !== 'number' || typeof storage.key !== 'function') {
		try {
			const serialized = storage.getItem(key(user));
			if (serialized === null) return { records: [], error: '' };
			const pending = parsePending(JSON.parse(serialized), user);
			if (!pending)
				return { records: [], error: 'A saved offline snapshot could not be read safely.' };
			return {
				records: [
					{
						writerId: pending.writerId || 'legacy-main',
						pending,
						keys: [{ key: key(user), pending }]
					}
				],
				error: ''
			};
		} catch {
			return { records: [], error: 'Saved offline changes could not be read.' };
		}
	}
	try {
		const prefix = journalPrefix(user);
		for (let index = 0; index < storage.length; index += 1) {
			const storageKey = storage.key(index);
			if (!storageKey?.startsWith(prefix)) continue;
			const writerId = decodeURIComponent(storageKey.slice(prefix.length));
			const pending = parsePending(JSON.parse(storage.getItem(storageKey) || 'null'), user);
			if (!writerId || !pending || pending.writerId !== writerId) {
				error ||= 'A saved offline journal entry could not be read safely.';
				continue;
			}
			byWriter.set(writerId, {
				writerId,
				pending,
				keys: [{ key: storageKey, pending }]
			});
		}
		const mainKey = key(user);
		const serialized = storage.getItem(mainKey);
		if (serialized !== null) {
			const pending = parsePending(JSON.parse(serialized), user);
			if (!pending) {
				error ||= 'A saved offline snapshot could not be read safely.';
			} else {
				const writerId = pending.writerId || 'legacy-main';
				const existing = byWriter.get(writerId);
				if (!existing) {
					byWriter.set(writerId, { writerId, pending, keys: [{ key: mainKey, pending }] });
				} else {
					existing.keys.push({ key: mainKey, pending });
					if (pending.updatedAt > existing.pending.updatedAt) existing.pending = pending;
				}
			}
		}
	} catch {
		error ||= 'Saved offline changes could not be enumerated.';
	}
	return {
		records: [...byWriter.values()].sort(
			(a, b) =>
				(a.pending.createdAt ?? a.pending.updatedAt) -
					(b.pending.createdAt ?? b.pending.updatedAt) || a.writerId.localeCompare(b.writerId)
		),
		error
	};
}

function isState(value: unknown): value is AppState {
	if (!value || typeof value !== 'object') return false;
	const state = value as AppState;
	return (
		['pantry', 'recipes', 'meals', 'shopping'].every((field) =>
			Array.isArray(state[field as keyof AppState])
		) &&
		!!state.preferences &&
		typeof state.preferences === 'object'
	);
}

/** One durable latest snapshot per account and household; never stores credentials. */
export function writePending(storage: StorageLike, pending: PendingKitchen): void {
	storage.setItem(
		key({ id: pending.userId, householdId: pending.householdId }),
		JSON.stringify(pending)
	);
}

export function writePendingJournal(storage: StorageLike, pending: PendingKitchen): void {
	if (!pending.writerId)
		throw new Error('A writer ID is required for a durable offline journal entry.');
	storage.setItem(
		`${journalPrefix({ id: pending.userId, householdId: pending.householdId })}${encodeURIComponent(pending.writerId)}`,
		JSON.stringify(pending)
	);
}

function sameJournalVersion(current: PendingKitchen, expected: PendingKitchen): boolean {
	if (current.writerId && expected.writerId && current.writerId !== expected.writerId) return false;
	if (current.writeId && expected.writeId) return current.writeId === expected.writeId;
	return (
		current.updatedAt === expected.updatedAt &&
		current.createdAt === expected.createdAt &&
		current.etag === expected.etag &&
		JSON.stringify(current.base) === JSON.stringify(expected.base) &&
		JSON.stringify(current.local) === JSON.stringify(expected.local)
	);
}

/** Remove only captured versions; a peer's newer write in the same writer slot is retained. */
export function clearPendingJournalRecords(
	storage: StorageLike,
	user: User,
	records: PendingJournalRecord[]
): void {
	for (const record of records) {
		for (const captured of record.keys) {
			const current = parsePending(JSON.parse(storage.getItem(captured.key) || 'null'), user);
			if (current && sameJournalVersion(current, captured.pending))
				storage.removeItem(captured.key);
		}
	}
}

export function clearPending(storage: StorageLike, user: User): void {
	storage.removeItem(key(user));
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

function hasEqualConcurrentPantryQuantityEdit(
	base: unknown,
	local: unknown,
	remote: unknown
): boolean {
	if (!Array.isArray(base) || !Array.isArray(local) || !Array.isArray(remote)) return false;
	const indexed = [base, local, remote].map((items) => {
		if (!items.every((item) => object(item) && typeof item.id === 'string')) return null;
		if (new Set(items.map((item) => item.id)).size !== items.length) return null;
		return new Map(items.map((item) => [item.id as string, item]));
	});
	if (indexed.some((items) => items === null)) return false;
	const [before, left, right] = indexed as Array<Map<string, Record<string, unknown>>>;
	for (const id of before.keys()) {
		const oldQuantity = before.get(id)?.quantity;
		const localQuantity = left.get(id)?.quantity;
		const remoteQuantity = right.get(id)?.quantity;
		if (
			typeof oldQuantity === 'number' &&
			typeof localQuantity === 'number' &&
			typeof remoteQuantity === 'number' &&
			!equal(localQuantity, oldQuantity) &&
			!equal(remoteQuantity, oldQuantity) &&
			equal(localQuantity, remoteQuantity)
		)
			return true;
	}
	return false;
}

function hasEqualConcurrentPantryItemQuantityEdit(
	base: unknown,
	local: unknown,
	remote: unknown
): boolean {
	if (!object(base) || !object(local) || !object(remote)) return false;
	const oldQuantity = base.quantity;
	const localQuantity = local.quantity;
	const remoteQuantity = remote.quantity;
	return (
		typeof oldQuantity === 'number' &&
		typeof localQuantity === 'number' &&
		typeof remoteQuantity === 'number' &&
		!equal(localQuantity, oldQuantity) &&
		!equal(remoteQuantity, oldQuantity) &&
		equal(localQuantity, remoteQuantity)
	);
}

function describeMealRecipe(snapshot: AppState, mealId: string, recipeId: string): string {
	const mealExists = snapshot.meals.some((meal) => meal.id === mealId);
	const recipe = snapshot.recipes.find((item) => item.id === recipeId);
	return `${mealExists ? 'Meal planned' : 'Meal not planned'}; ${recipe ? `recipe available: ${recipe.title}` : 'recipe removed'}`;
}

/** Merge disjoint field edits and additions; surface competing edits/deletions explicitly. */
export function mergeKitchenStates(
	base: AppState,
	local: AppState,
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: SyncConflict[] } {
	const conflicts: SyncConflict[] = [];
	const conflict = (path: string, mine: unknown, theirs: unknown) => {
		conflicts.push({ path, local: mine, remote: theirs });
		return prefer === 'local' ? mine : theirs;
	};
	const merge = (old: unknown, mine: unknown, theirs: unknown, path: string): unknown => {
		const descendIntoEqualPantry =
			path === 'kitchen.pantry' &&
			equal(mine, theirs) &&
			!equal(local, remote) &&
			hasEqualConcurrentPantryQuantityEdit(old, mine, theirs);
		const descendIntoEqualPantryItem =
			path.startsWith('kitchen.pantry[') &&
			path.endsWith(']') &&
			equal(mine, theirs) &&
			!equal(local, remote) &&
			hasEqualConcurrentPantryItemQuantityEdit(old, mine, theirs);
		const sameChangedPantryQuantity =
			path.startsWith('kitchen.pantry[') &&
			path.endsWith('].quantity') &&
			typeof old === 'number' &&
			typeof mine === 'number' &&
			typeof theirs === 'number' &&
			!equal(mine, old) &&
			!equal(theirs, old) &&
			equal(mine, theirs) &&
			!equal(local, remote);
		if (sameChangedPantryQuantity) return conflict(path, mine, theirs);
		if (equal(mine, theirs) && !descendIntoEqualPantry && !descendIntoEqualPantryItem) return mine;
		if (equal(mine, old)) return theirs;
		if (equal(theirs, old)) return mine;
		if (mine === undefined || theirs === undefined) return conflict(path, mine, theirs);
		if (object(mine) && object(theirs) && (old === undefined || object(old))) {
			const result: Record<string, unknown> = {};
			for (const name of new Set([
				...Object.keys(old || {}),
				...Object.keys(mine),
				...Object.keys(theirs)
			])) {
				const value = merge(
					(old as Record<string, unknown> | undefined)?.[name],
					mine[name],
					theirs[name],
					`${path}.${name}`
				);
				if (value !== undefined) result[name] = value;
			}
			return result;
		}
		if (Array.isArray(mine) && Array.isArray(theirs) && Array.isArray(old)) {
			const arrays = [old, mine, theirs];
			if (
				arrays.every((items) =>
					items.every((item) => object(item) && typeof item.id === 'string')
				) &&
				arrays.every((items) => new Set(items.map((item) => item.id)).size === items.length)
			) {
				const [before, left, right] = arrays.map(
					(items) => new Map(items.map((item) => [item.id, item]))
				);
				const result = [];
				for (const id of new Set([...right.keys(), ...left.keys(), ...before.keys()])) {
					const value = merge(before.get(id), left.get(id), right.get(id), `${path}[${id}]`);
					if (value !== undefined) result.push(value);
				}
				return result;
			}
		}
		return conflict(path, mine, theirs);
	};
	const state = structuredClone(merge(base, local, remote, 'kitchen')) as AppState;
	// Deleting a recipe while someone plans it must never create an orphaned meal.
	const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
	for (const meal of state.meals.filter((meal) => !recipeIds.has(meal.recipeId))) {
		conflicts.push({
			path: `kitchen.meals[${meal.id}].recipeId`,
			local: describeMealRecipe(local, meal.id, meal.recipeId),
			remote: describeMealRecipe(remote, meal.id, meal.recipeId)
		});
		if (prefer) {
			const recipe = (prefer === 'local' ? local : remote).recipes.find(
				(recipe) => recipe.id === meal.recipeId
			);
			if (recipe) {
				state.recipes.push(structuredClone(recipe));
				recipeIds.add(recipe.id);
			}
		}
	}
	state.meals = state.meals.filter((meal) => recipeIds.has(meal.recipeId));
	return { state, conflicts };
}

export type KitchenTransport = {
	identity: { userId: string; householdId: string };
	get: () => Promise<{
		state: AppState;
		etag: string;
		userId: string;
		householdId: string;
	}>;
	put: (state: AppState, etag: string) => Promise<{ state: AppState; etag: string }>;
};

function assertSameSyncIdentity(
	expected: { userId: string; householdId: string },
	actual: { userId: string; householdId: string }
): void {
	if (
		!expected.userId ||
		!expected.householdId ||
		actual.userId !== expected.userId ||
		actual.householdId !== expected.householdId
	) {
		throw Object.assign(
			new Error('These offline changes belong to a different account or household.'),
			{ status: 409 }
		);
	}
}

/** Always reconcile against current server state and use its ETag for the write. */
export async function syncPendingKitchen(
	pending: PendingKitchen,
	transport: KitchenTransport,
	prefer?: 'local' | 'remote'
): Promise<{ state: AppState; etag: string; conflicts: SyncConflict[]; saved: boolean }> {
	const identity = { ...transport.identity };
	assertSameSyncIdentity(identity, { userId: pending.userId, householdId: pending.householdId });
	const base = structuredClone(pending.base);
	const local = structuredClone(pending.local);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const remote = await transport.get();
		assertSameSyncIdentity(identity, remote);
		assertSameSyncIdentity(identity, transport.identity);
		const merged = mergeKitchenStates(base, local, remote.state, prefer);
		if (merged.conflicts.length && !prefer)
			return { state: merged.state, etag: remote.etag, conflicts: merged.conflicts, saved: false };
		try {
			const result = await transport.put(merged.state, remote.etag);
			return { ...result, conflicts: [], saved: true };
		} catch (error) {
			if ((error as { status?: number }).status !== 412 || attempt === 2) throw error;
		}
	}
	throw new Error('Your household is changing quickly. Try syncing again.');
}

/** Apply independent writer snapshots in creation order while retaining conflicts between them. */
export function mergePendingKitchenJournal(
	records: PendingJournalRecord[],
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: SyncConflict[] } {
	let state = structuredClone(remote);
	const conflicts: SyncConflict[] = [];
	const stableOrder = [...records].sort(
		(a, b) =>
			(a.pending.createdAt ?? a.pending.updatedAt) - (b.pending.createdAt ?? b.pending.updatedAt) ||
			a.writerId.localeCompare(b.writerId)
	);
	// Replay a writer's ancestor before a snapshot staged from that already-updated view, even when
	// both tabs receive the same millisecond timestamp.
	const dependencies = new Map(stableOrder.map((record) => [record.writerId, new Set<string>()]));
	for (const ancestor of stableOrder) {
		if (equal(ancestor.pending.base, ancestor.pending.local)) continue;
		for (const dependent of stableOrder) {
			if (ancestor === dependent) continue;
			const probe = mergeKitchenStates(
				ancestor.pending.base,
				ancestor.pending.local,
				dependent.pending.base
			);
			if (!probe.conflicts.length && equal(probe.state, dependent.pending.base)) {
				dependencies.get(dependent.writerId)?.add(ancestor.writerId);
			}
		}
	}
	const ordered: PendingJournalRecord[] = [];
	const remaining = new Map(stableOrder.map((record) => [record.writerId, record]));
	while (remaining.size) {
		const ready = stableOrder.filter(
			(record) =>
				remaining.has(record.writerId) &&
				[...(dependencies.get(record.writerId) || [])].every((id) => !remaining.has(id))
		);
		const next = ready[0] || stableOrder.find((record) => remaining.has(record.writerId))!;
		ordered.push(next);
		remaining.delete(next.writerId);
	}
	for (const record of ordered) {
		const merged = mergeKitchenStates(record.pending.base, record.pending.local, state, prefer);
		state = merged.state;
		conflicts.push(...merged.conflicts);
	}
	return { state, conflicts };
}

/** Reconcile every account-scoped writer delta against current server state before the write. */
export async function syncPendingKitchenJournal(
	records: PendingJournalRecord[],
	transport: KitchenTransport,
	prefer?: 'local' | 'remote'
): Promise<{ state: AppState; etag: string; conflicts: SyncConflict[]; saved: boolean }> {
	const identity = { ...transport.identity };
	if (!records.length) throw new Error('There are no offline changes to sync.');
	for (const record of records) {
		assertSameSyncIdentity(identity, {
			userId: record.pending.userId,
			householdId: record.pending.householdId
		});
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const remote = await transport.get();
		assertSameSyncIdentity(identity, remote);
		assertSameSyncIdentity(identity, transport.identity);
		const merged = mergePendingKitchenJournal(records, remote.state, prefer);
		if (merged.conflicts.length && !prefer)
			return { state: merged.state, etag: remote.etag, conflicts: merged.conflicts, saved: false };
		try {
			const result = await transport.put(merged.state, remote.etag);
			return { ...result, conflicts: merged.conflicts, saved: true };
		} catch (error) {
			if ((error as { status?: number }).status !== 412 || attempt === 2) throw error;
		}
	}
	throw new Error('Your household is changing quickly. Try syncing again.');
}
