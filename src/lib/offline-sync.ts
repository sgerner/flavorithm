import type { AppState, User } from '#lib/types.ts';

export type SyncConflict = { path: string; local: unknown; remote: unknown };
export type FoldedJournalRef = {
	writerId: string;
	writeId?: string;
	updatedAt: number;
	createdAt?: number;
};
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
	/** Exact ancestor journal versions already folded into this compacted snapshot. */
	foldedFrom?: FoldedJournalRef[];
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

function isFoldedJournalRef(value: unknown): value is FoldedJournalRef {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const ref = value as Partial<FoldedJournalRef>;
	return (
		typeof ref.writerId === 'string' &&
		ref.writerId.length > 0 &&
		Number.isFinite(ref.updatedAt) &&
		(ref.writeId === undefined || typeof ref.writeId === 'string') &&
		(ref.createdAt === undefined || Number.isFinite(ref.createdAt))
	);
}

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
			typeof (value as PendingKitchen).writeId !== 'string') ||
		((value as PendingKitchen).foldedFrom !== undefined &&
			(!Array.isArray((value as PendingKitchen).foldedFrom) ||
				!(value as PendingKitchen).foldedFrom!.every(isFoldedJournalRef)))
	) {
		return null;
	}
	return value as PendingKitchen;
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
		jsonEqual(current.base, expected.base) &&
		jsonEqual(current.local, expected.local)
	);
}

/** Remove only captured versions; a peer's newer write in the same writer slot is retained. */
export function clearPendingJournalRecords(
	storage: StorageLike,
	user: User,
	records: PendingJournalRecord[]
): void {
	let firstError: unknown = null;
	let hasError = false;
	for (const record of records) {
		for (const captured of record.keys) {
			try {
				const current = parsePending(JSON.parse(storage.getItem(captured.key) || 'null'), user);
				if (current && sameJournalVersion(current, captured.pending))
					storage.removeItem(captured.key);
			} catch (error) {
				if (!hasError) {
					hasError = true;
					firstError = error;
				}
			}
		}
	}
	if (hasError) throw firstError;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a && typeof a === 'object' && typeof (a as { toJSON?: unknown }).toJSON === 'function') {
		a = (a as { toJSON: () => unknown }).toJSON();
	}
	if (b && typeof b === 'object' && typeof (b as { toJSON?: unknown }).toJSON === 'function') {
		b = (b as { toJSON: () => unknown }).toJSON();
	}
	if (a === b) return true;
	if (typeof a === 'number' && !Number.isFinite(a)) a = null;
	if (typeof b === 'number' && !Number.isFinite(b)) b = null;
	if (a === b) return true;
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i += 1) {
			const av = a[i] === undefined ? null : a[i];
			const bv = b[i] === undefined ? null : b[i];
			if (!jsonEqual(av, bv)) return false;
		}
		return true;
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const aKeys = Object.keys(aObj);
	const bKeys = Object.keys(bObj);
	let aDefined = 0;
	for (let i = 0; i < aKeys.length; i += 1) {
		const k = aKeys[i];
		const av = aObj[k];
		if (av === undefined) continue;
		aDefined += 1;
		if (!Object.hasOwn(bObj, k)) return false;
		const bv = bObj[k];
		if (bv === undefined || !jsonEqual(av, bv)) return false;
	}
	let bDefined = 0;
	for (let i = 0; i < bKeys.length; i += 1) {
		if (bObj[bKeys[i]] !== undefined) bDefined += 1;
	}
	return aDefined === bDefined;
}

const equal = jsonEqual;
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

function isIdRecord(item: unknown): item is Record<string, unknown> & { id: string } {
	return object(item) && typeof item.id === 'string';
}

function indexedById(items: unknown[]): Map<string, Record<string, unknown>> | null {
	if (!items.every(isIdRecord)) return null;
	if (new Set(items.map((item) => item.id)).size !== items.length) return null;
	return new Map(items.map((item) => [item.id, item]));
}

/**
 * True when `target` already incorporates every change between `base` and `local`, ignoring
 * independent edits or items on untouched fields and peer collections.
 */
export function causallyIncludesDelta(base: AppState, local: AppState, target: AppState): boolean {
	const includes = (old: unknown, mine: unknown, candidate: unknown): boolean => {
		if (equal(mine, old)) return true;
		if (equal(mine, candidate)) return true;
		if (mine === undefined || candidate === undefined) return false;
		if (object(mine) && object(candidate) && (old === undefined || object(old))) {
			for (const name of new Set([
				...Object.keys(old || {}),
				...Object.keys(mine),
				...Object.keys(candidate)
			])) {
				if (
					!includes(
						(old as Record<string, unknown> | undefined)?.[name],
						mine[name],
						candidate[name]
					)
				) {
					return false;
				}
			}
			return true;
		}
		if (Array.isArray(mine) && Array.isArray(candidate) && Array.isArray(old)) {
			const before = indexedById(old);
			const left = indexedById(mine);
			const right = indexedById(candidate);
			if (before && left && right) {
				for (const id of new Set([...before.keys(), ...left.keys()])) {
					if (!includes(before.get(id), left.get(id), right.get(id))) return false;
				}
				return true;
			}
		}
		return false;
	};
	return includes(base, local, target);
}

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

type PathSegment = { kind: 'prop'; key: string } | { kind: 'id'; id: string };
type DetailedConflict = SyncConflict & {
	segments: PathSegment[];
	orphanedMeal?: { mealId: string; recipeId: string };
};
export type KitchenSyncResult = {
	state: AppState;
	etag: string;
	conflicts: SyncConflict[];
	saved: boolean;
	staleEtag?: boolean;
	remoteState?: AppState;
};

function readChild(source: unknown, segment: PathSegment): unknown {
	if (segment.kind === 'prop') return object(source) ? source[segment.key] : undefined;
	if (!Array.isArray(source)) return undefined;
	return source.find((item) => object(item) && item.id === segment.id);
}

function assignChild(target: unknown, segment: PathSegment, value: unknown): void {
	if (segment.kind === 'prop') {
		if (!object(target)) return;
		if (value === undefined) delete target[segment.key];
		else target[segment.key] = structuredClone(value);
		return;
	}
	if (!Array.isArray(target)) return;
	const index = target.findIndex((item) => object(item) && item.id === segment.id);
	if (value === undefined) {
		if (index !== -1) target.splice(index, 1);
	} else if (index !== -1) {
		target[index] = structuredClone(value);
	} else {
		target.push(structuredClone(value));
	}
}

function matchesNextContainer(value: unknown, next: PathSegment): boolean {
	return next.kind === 'prop' ? object(value) : Array.isArray(value);
}

function getAtSegments(root: AppState, segments: PathSegment[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		current = readChild(current, segment);
		if (current === undefined) return undefined;
	}
	return structuredClone(current);
}

function restoreFromRemote(state: AppState, remote: AppState, segments: PathSegment[]): void {
	if (!segments.length) return;
	let stateCurrent: unknown = state;
	let remoteCurrent: unknown = remote;
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		const remoteChild = readChild(remoteCurrent, segment);
		if (index === segments.length - 1) {
			assignChild(stateCurrent, segment, remoteChild);
			return;
		}
		const nextSegment = segments[index + 1];
		const stateChild = readChild(stateCurrent, segment);
		if (
			!matchesNextContainer(remoteChild, nextSegment) ||
			!matchesNextContainer(stateChild, nextSegment)
		) {
			assignChild(stateCurrent, segment, remoteChild);
			return;
		}
		stateCurrent = stateChild;
		remoteCurrent = remoteChild;
	}
}

function segmentsStartWith(prefix: PathSegment[], full: PathSegment[]): boolean {
	if (prefix.length > full.length) return false;
	return prefix.every((segment, index) => {
		const other = full[index];
		return segment.kind === 'prop'
			? other.kind === 'prop' && segment.key === other.key
			: other.kind === 'id' && segment.id === other.id;
	});
}

function reconcileOrphanedMeals(
	state: AppState,
	localBranch: AppState,
	remoteBranch: AppState,
	conflicts: DetailedConflict[],
	prefer?: 'local' | 'remote'
): void {
	// Deleting a recipe while someone plans it must never create an orphaned meal.
	const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
	for (const meal of state.meals.filter((meal) => !recipeIds.has(meal.recipeId))) {
		conflicts.push({
			path: `kitchen.meals[${meal.id}].recipeId`,
			local: describeMealRecipe(localBranch, meal.id, meal.recipeId),
			remote: describeMealRecipe(remoteBranch, meal.id, meal.recipeId),
			segments: [
				{ kind: 'prop', key: 'meals' },
				{ kind: 'id', id: meal.id },
				{ kind: 'prop', key: 'recipeId' }
			],
			orphanedMeal: { mealId: meal.id, recipeId: meal.recipeId }
		});
		// Keep the complete proposed meal available for review and backup until a choice is made.
		const candidates = prefer
			? (prefer === 'local' ? localBranch : remoteBranch).recipes
			: [...localBranch.recipes, ...remoteBranch.recipes];
		const recipe = candidates.find((item) => item.id === meal.recipeId);
		if (recipe) {
			state.recipes.push(structuredClone(recipe));
			recipeIds.add(recipe.id);
		}
	}
	state.meals = state.meals.filter((meal) => recipeIds.has(meal.recipeId));
}

function mergeKitchenStatesDetailed(
	base: AppState,
	local: AppState,
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: DetailedConflict[] } {
	const conflicts: DetailedConflict[] = [];
	const conflict = (path: string, segments: PathSegment[], mine: unknown, theirs: unknown) => {
		conflicts.push({
			path,
			local: mine === undefined ? undefined : structuredClone(mine),
			remote: theirs === undefined ? undefined : structuredClone(theirs),
			segments
		});
		return prefer === 'local' ? mine : theirs;
	};
	const merge = (
		old: unknown,
		mine: unknown,
		theirs: unknown,
		path: string,
		segments: PathSegment[]
	): unknown => {
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
		if (sameChangedPantryQuantity) return conflict(path, segments, mine, theirs);
		if (equal(mine, theirs) && !descendIntoEqualPantry && !descendIntoEqualPantryItem) return mine;
		if (equal(mine, old)) return theirs;
		if (equal(theirs, old)) return mine;
		if (mine === undefined || theirs === undefined) return conflict(path, segments, mine, theirs);
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
					`${path}.${name}`,
					[...segments, { kind: 'prop', key: name }]
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
					const value = merge(before.get(id), left.get(id), right.get(id), `${path}[${id}]`, [
						...segments,
						{ kind: 'id', id }
					]);
					if (value !== undefined) result.push(value);
				}
				return result;
			}
		}
		return conflict(path, segments, mine, theirs);
	};
	const state = structuredClone(merge(base, local, remote, 'kitchen', [])) as AppState;
	reconcileOrphanedMeals(state, local, remote, conflicts, prefer);
	return { state, conflicts };
}

/** Merge disjoint field edits and additions; surface competing edits/deletions explicitly. */
export function mergeKitchenStates(
	base: AppState,
	local: AppState,
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: SyncConflict[] } {
	const merged = mergeKitchenStatesDetailed(base, local, remote, prefer);
	return {
		state: merged.state,
		conflicts: merged.conflicts.map(({ path, local: mine, remote: theirs }) => ({
			path,
			local: mine,
			remote: theirs
		}))
	};
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

function matchesFoldedRef(record: PendingJournalRecord, ref: FoldedJournalRef): boolean {
	if (record.writerId !== ref.writerId) return false;
	if (ref.writeId !== undefined || record.pending.writeId !== undefined) {
		return Boolean(ref.writeId && record.pending.writeId && ref.writeId === record.pending.writeId);
	}
	return record.pending.updatedAt === ref.updatedAt && record.pending.createdAt === ref.createdAt;
}

/**
 * Omit exact ancestor journal versions that were already folded into a surviving compacted entry,
 * so a partial retirement failure (`removeItem` error) never replays or conflicts against itself.
 */
export function filterUnfoldedJournalRecords(
	records: PendingJournalRecord[]
): PendingJournalRecord[] {
	if (records.length <= 1) return records;
	const byRecency = [...records].sort(
		(a, b) =>
			b.pending.updatedAt - a.pending.updatedAt ||
			(b.pending.createdAt ?? b.pending.updatedAt) - (a.pending.createdAt ?? a.pending.updatedAt) ||
			b.writerId.localeCompare(a.writerId)
	);
	const foldsMap = new Map<PendingJournalRecord, Set<PendingJournalRecord>>(
		byRecency.map((record) => [record, new Set()])
	);
	let hasAnyFoldEdge = false;
	for (const compactor of byRecency) {
		for (const ref of compactor.pending.foldedFrom ?? []) {
			for (const candidate of byRecency) {
				if (candidate === compactor) continue;
				if (matchesFoldedRef(candidate, ref)) {
					foldsMap.get(compactor)!.add(candidate);
					hasAnyFoldEdge = true;
				}
			}
		}
	}
	if (!hasAnyFoldEdge) return records;
	for (let i = 0; i < byRecency.length; i += 1) {
		for (let j = i + 1; j < byRecency.length; j += 1) {
			const newer = byRecency[i];
			const older = byRecency[j];
			if (foldsMap.get(newer)!.has(older) && foldsMap.get(older)!.has(newer)) {
				foldsMap.get(older)!.delete(newer);
			}
		}
	}
	const surviving = new Set<PendingJournalRecord>();
	const folded = new Set<PendingJournalRecord>();
	const settled = () => surviving.size + folded.size >= byRecency.length;
	while (!settled()) {
		const remaining = byRecency.filter((record) => !surviving.has(record) && !folded.has(record));
		const root =
			remaining.find((candidate) =>
				remaining.every((other) => other === candidate || !foldsMap.get(other)!.has(candidate))
			) || remaining[0];
		surviving.add(root);
		const queue = [...foldsMap.get(root)!];
		while (queue.length) {
			const target = queue.shift()!;
			if (surviving.has(target) || folded.has(target)) continue;
			folded.add(target);
			for (const nested of foldsMap.get(target)!) {
				if (!surviving.has(nested) && !folded.has(nested)) queue.push(nested);
			}
		}
	}
	return records.filter((record) => !folded.has(record));
}

/** Order journal snapshots by causal inclusion first and creation order second. */
export function orderPendingJournalRecords(
	records: PendingJournalRecord[]
): PendingJournalRecord[] {
	const stableOrder = [...records].sort(
		(a, b) =>
			(a.pending.createdAt ?? a.pending.updatedAt) - (b.pending.createdAt ?? b.pending.updatedAt) ||
			a.writerId.localeCompare(b.writerId)
	);
	// Replay a writer's ancestor before a snapshot staged from that already-updated view, even when
	// both tabs receive the same millisecond timestamp or carry peer collection items.
	const dependencies = new Map(stableOrder.map((record) => [record.writerId, new Set<string>()]));
	for (const ancestor of stableOrder) {
		if (equal(ancestor.pending.base, ancestor.pending.local)) continue;
		for (const dependent of stableOrder) {
			if (ancestor === dependent) continue;
			if (
				causallyIncludesDelta(ancestor.pending.base, ancestor.pending.local, dependent.pending.base)
			) {
				dependencies.get(dependent.writerId)?.add(ancestor.writerId);
			}
		}
	}
	for (let i = 0; i < stableOrder.length; i += 1) {
		for (let j = i + 1; j < stableOrder.length; j += 1) {
			const earlier = stableOrder[i].writerId;
			const later = stableOrder[j].writerId;
			if (dependencies.get(earlier)?.has(later) && dependencies.get(later)?.has(earlier)) {
				dependencies.get(earlier)?.delete(later);
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
	return ordered;
}

function composeDeltaPair(
	firstBase: AppState,
	firstLocal: AppState,
	secondBase: AppState,
	secondLocal: AppState,
	prefer?: 'local' | 'remote'
): { base: AppState; local: AppState; conflicts: DetailedConflict[] } {
	const conflicts: DetailedConflict[] = [];
	const chooseConflict = (
		path: string,
		segments: PathSegment[],
		b1: unknown,
		l1: unknown,
		b2: unknown,
		l2: unknown
	): { base: unknown; local: unknown } => {
		conflicts.push({
			path,
			local: l2 === undefined ? undefined : structuredClone(l2),
			remote: l1 === undefined ? undefined : structuredClone(l1),
			segments
		});
		return prefer === 'local'
			? { base: b1 !== undefined ? b1 : b2, local: l2 }
			: { base: b1, local: l1 };
	};
	const compose = (
		b1: unknown,
		l1: unknown,
		b2: unknown,
		l2: unknown,
		path: string,
		segments: PathSegment[]
	): { base: unknown; local: unknown } => {
		if (equal(l2, b2)) return { base: b1, local: l1 };
		if (equal(l1, b1)) return { base: b2, local: l2 };
		if (equal(b2, l1)) return { base: b1, local: l2 };

		if (object(l1) && object(l2)) {
			if (object(b1) && object(b2)) {
				const nextBase: Record<string, unknown> = {};
				const nextLocal: Record<string, unknown> = {};
				for (const name of new Set([
					...Object.keys(b1),
					...Object.keys(l1),
					...Object.keys(b2),
					...Object.keys(l2)
				])) {
					const entry = compose(b1[name], l1[name], b2[name], l2[name], `${path}.${name}`, [
						...segments,
						{ kind: 'prop', key: name }
					]);
					if (entry.base !== undefined) nextBase[name] = entry.base;
					if (entry.local !== undefined) nextLocal[name] = entry.local;
				}
				return { base: nextBase, local: nextLocal };
			}
			if (b1 === undefined && b2 === undefined) {
				const nextLocal: Record<string, unknown> = {};
				for (const name of new Set([...Object.keys(l1), ...Object.keys(l2)])) {
					const entry = compose(undefined, l1[name], undefined, l2[name], `${path}.${name}`, [
						...segments,
						{ kind: 'prop', key: name }
					]);
					if (entry.local !== undefined) nextLocal[name] = entry.local;
				}
				return { base: undefined, local: nextLocal };
			}
		}

		if (Array.isArray(b1) && Array.isArray(l1) && Array.isArray(b2) && Array.isArray(l2)) {
			const b1Map = indexedById(b1);
			const l1Map = indexedById(l1);
			const b2Map = indexedById(b2);
			const l2Map = indexedById(l2);
			if (b1Map && l1Map && b2Map && l2Map) {
				const entries = new Map<string, { base: unknown; local: unknown }>();
				for (const id of new Set([
					...l1Map.keys(),
					...l2Map.keys(),
					...b1Map.keys(),
					...b2Map.keys()
				])) {
					entries.set(
						id,
						compose(b1Map.get(id), l1Map.get(id), b2Map.get(id), l2Map.get(id), `${path}[${id}]`, [
							...segments,
							{ kind: 'id', id }
						])
					);
				}
				const nextBase = [];
				for (const id of new Set([
					...b1Map.keys(),
					...b2Map.keys(),
					...l1Map.keys(),
					...l2Map.keys()
				])) {
					const value = entries.get(id)?.base;
					if (value !== undefined) nextBase.push(value);
				}
				const nextLocal = [];
				for (const id of new Set([
					...l1Map.keys(),
					...l2Map.keys(),
					...b1Map.keys(),
					...b2Map.keys()
				])) {
					const value = entries.get(id)?.local;
					if (value !== undefined) nextLocal.push(value);
				}
				return { base: nextBase, local: nextLocal };
			}
		}

		const concurrentPantryQuantity =
			path.startsWith('kitchen.pantry[') &&
			path.endsWith('].quantity') &&
			typeof b1 === 'number' &&
			typeof l1 === 'number' &&
			typeof b2 === 'number' &&
			typeof l2 === 'number' &&
			!equal(firstLocal, secondLocal);
		if (equal(l1, l2) && !concurrentPantryQuantity) {
			return { base: b1, local: l1 };
		}
		return chooseConflict(path, segments, b1, l1, b2, l2);
	};

	const composed = compose(firstBase, firstLocal, secondBase, secondLocal, 'kitchen', []);
	const base = structuredClone(composed.base) as AppState;
	const local = structuredClone(composed.local) as AppState;
	reconcileOrphanedMeals(local, secondLocal, firstLocal, conflicts, prefer);
	return { base, local, conflicts };
}

function composePendingKitchenJournalDetailed(
	records: PendingJournalRecord[],
	prefer?: 'local' | 'remote'
): {
	ordered: PendingJournalRecord[];
	base: AppState;
	local: AppState;
	conflicts: DetailedConflict[];
} | null {
	const unfolded = filterUnfoldedJournalRecords(records);
	if (!unfolded.length) return null;
	const ordered = orderPendingJournalRecords(unfolded);
	let effectiveBase = structuredClone(ordered[0].pending.base);
	let effectiveLocal = structuredClone(ordered[0].pending.local);
	const rawConflicts: DetailedConflict[] = [];
	for (let index = 1; index < ordered.length; index += 1) {
		const record = ordered[index];
		const step = composeDeltaPair(
			effectiveBase,
			effectiveLocal,
			record.pending.base,
			record.pending.local,
			prefer
		);
		effectiveBase = step.base;
		effectiveLocal = step.local;
		rawConflicts.push(...step.conflicts);
	}
	return { ordered, base: effectiveBase, local: effectiveLocal, conflicts: rawConflicts };
}

/** Compose ordered journal records into a single (effectiveBase, effectiveLocal) delta. */
export function composePendingKitchenJournal(
	records: PendingJournalRecord[],
	prefer?: 'local' | 'remote'
): {
	ordered: PendingJournalRecord[];
	base: AppState;
	local: AppState;
	conflicts: SyncConflict[];
} | null {
	const composed = composePendingKitchenJournalDetailed(records, prefer);
	if (!composed) return null;
	const conflicts: SyncConflict[] = [];
	for (const conflict of composed.conflicts) {
		const entry: SyncConflict = {
			path: conflict.path,
			local: conflict.local,
			remote: conflict.remote
		};
		const existingIndex = conflicts.findIndex((item) => item.path === conflict.path);
		if (existingIndex >= 0) conflicts[existingIndex] = entry;
		else conflicts.push(entry);
	}
	return {
		ordered: composed.ordered,
		base: composed.base,
		local: composed.local,
		conflicts
	};
}

/** Compose writer snapshots into a net baseline/local delta and reconcile once against remote. */
export function mergePendingKitchenJournal(
	records: PendingJournalRecord[],
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: SyncConflict[] } {
	const composed = composePendingKitchenJournalDetailed(records, 'local');
	if (!composed) return { state: structuredClone(remote), conflicts: [] };
	const {
		ordered,
		base: composedBase,
		local: composedLocal,
		conflicts: rawLocalConflicts
	} = composed;
	const remoteMerged = mergeKitchenStatesDetailed(composedBase, composedLocal, remote, prefer);
	if (!rawLocalConflicts.length) {
		return {
			state: remoteMerged.state,
			conflicts: remoteMerged.conflicts.map(({ path, local: mine, remote: theirs }) => ({
				path,
				local: mine,
				remote: theirs
			}))
		};
	}
	const localConflicts: DetailedConflict[] = [];
	for (const candidate of rawLocalConflicts) {
		if (
			localConflicts.some((existing) => segmentsStartWith(existing.segments, candidate.segments))
		) {
			continue;
		}
		for (let index = localConflicts.length - 1; index >= 0; index -= 1) {
			if (segmentsStartWith(candidate.segments, localConflicts[index].segments)) {
				localConflicts.splice(index, 1);
			}
		}
		localConflicts.push(candidate);
	}
	const state = structuredClone(remoteMerged.state);
	const combined: DetailedConflict[] = [];
	for (const localConflict of localConflicts) {
		if (
			remoteMerged.conflicts.some((remoteConflict) =>
				segmentsStartWith(remoteConflict.segments, localConflict.segments)
			)
		) {
			continue;
		}
		if (localConflict.orphanedMeal) {
			const { mealId, recipeId } = localConflict.orphanedMeal;
			const localPreview = structuredClone(composedLocal);
			const localMeals = ordered.flatMap((record) => record.pending.local.meals);
			const plannedMeal = localMeals.find((item) => item.id === mealId);
			if (plannedMeal && !localPreview.meals.some((item) => item.id === mealId)) {
				localPreview.meals.push(structuredClone(plannedMeal));
			}
			combined.push({
				...localConflict,
				local: describeMealRecipe(localPreview, mealId, recipeId),
				remote: describeMealRecipe(remote, mealId, recipeId)
			});
			if (prefer === 'remote') {
				restoreFromRemote(state, remote, [
					{ kind: 'prop', key: 'meals' },
					{ kind: 'id', id: mealId }
				]);
				restoreFromRemote(state, remote, [
					{ kind: 'prop', key: 'recipes' },
					{ kind: 'id', id: recipeId }
				]);
			} else if (!prefer) {
				if (plannedMeal && !state.meals.some((item) => item.id === mealId)) {
					state.meals.push(structuredClone(plannedMeal));
				}
				const candidates = [
					...ordered.flatMap((record) => record.pending.local.recipes),
					...remote.recipes
				];
				const recipe = candidates.find((item) => item.id === recipeId);
				if (recipe && !state.recipes.some((item) => item.id === recipeId)) {
					state.recipes.push(structuredClone(recipe));
				}
			}
		} else {
			combined.push({
				...localConflict,
				local: getAtSegments(composedLocal, localConflict.segments),
				remote: getAtSegments(remote, localConflict.segments)
			});
			if (prefer !== 'local') {
				restoreFromRemote(state, remote, localConflict.segments);
			}
		}
	}
	for (const remoteConflict of remoteMerged.conflicts) {
		if (
			combined.some((existing) => segmentsStartWith(existing.segments, remoteConflict.segments))
		) {
			continue;
		}
		combined.push(remoteConflict);
	}
	const recipeIds = new Set(state.recipes.map((recipe) => recipe.id));
	state.meals = state.meals.filter((meal) => recipeIds.has(meal.recipeId));
	return {
		state,
		conflicts: combined.map(({ path, local: mine, remote: theirs }) => ({
			path,
			local: mine,
			remote: theirs
		}))
	};
}

/** Reconcile every account-scoped writer delta against current server state before the write. */
export async function syncPendingKitchenJournal(
	records: PendingJournalRecord[],
	transport: KitchenTransport,
	prefer?: 'local' | 'remote',
	reviewedEtag?: string | null
): Promise<KitchenSyncResult> {
	const identity = { ...transport.identity };
	if (!records.length) throw new Error('There are no offline changes to sync.');
	for (const record of records) {
		assertSameSyncIdentity(identity, {
			userId: record.pending.userId,
			householdId: record.pending.householdId
		});
	}
	if (prefer) {
		const expectedEtag =
			reviewedEtag !== undefined ? reviewedEtag : (records[0]?.pending.etag ?? null);
		const remote = await transport.get();
		assertSameSyncIdentity(identity, remote);
		assertSameSyncIdentity(identity, transport.identity);
		if (typeof expectedEtag !== 'string' || remote.etag !== expectedEtag) {
			const recomputed = mergePendingKitchenJournal(records, remote.state);
			return {
				state: recomputed.state,
				etag: remote.etag,
				conflicts: recomputed.conflicts,
				saved: false,
				staleEtag: true,
				remoteState: structuredClone(remote.state)
			};
		}
		const resolved = mergePendingKitchenJournal(records, remote.state, prefer);
		try {
			const result = await transport.put(resolved.state, expectedEtag);
			return { ...result, conflicts: [], saved: true };
		} catch (error) {
			if ((error as { status?: number }).status !== 412) throw error;
			const latest = await transport.get();
			assertSameSyncIdentity(identity, latest);
			assertSameSyncIdentity(identity, transport.identity);
			const recomputed = mergePendingKitchenJournal(records, latest.state);
			return {
				state: recomputed.state,
				etag: latest.etag,
				conflicts: recomputed.conflicts,
				saved: false,
				staleEtag: true,
				remoteState: structuredClone(latest.state)
			};
		}
	}
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const remote = await transport.get();
		assertSameSyncIdentity(identity, remote);
		assertSameSyncIdentity(identity, transport.identity);
		const merged = mergePendingKitchenJournal(records, remote.state);
		if (merged.conflicts.length) {
			return {
				state: merged.state,
				etag: remote.etag,
				conflicts: merged.conflicts,
				saved: false,
				remoteState: structuredClone(remote.state)
			};
		}
		try {
			const result = await transport.put(merged.state, remote.etag);
			return { ...result, conflicts: [], saved: true };
		} catch (error) {
			if ((error as { status?: number }).status !== 412 || attempt === 2) throw error;
		}
	}
	throw new Error('Your household is changing quickly. Try syncing again.');
}
