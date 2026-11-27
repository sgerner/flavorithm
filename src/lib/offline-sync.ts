import { buildShoppingList } from '#lib/domain.ts';
import { sanitizeKitchenState } from '#lib/guest-storage.ts';
import {
	clampLeftoverServings,
	convertCompatibleQuantity,
	reconcileShoppingList
} from '#lib/kitchen-workflows.ts';
import { isKitchenState, isKitchenStateShape } from '#lib/state-schema.ts';
import type { AppState, Ingredient, Meal, ShoppingItem, User } from '#lib/types.ts';

export { isKitchenState, isKitchenStateShape };

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
const quarantinePrefix = (user: Pick<User, 'id' | 'householdId'>) =>
	`flavorithm-quarantined-journal:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(user.householdId)}:`;
export const MAX_PENDING_JOURNAL_ENTRIES = 64;
export const MAX_QUARANTINED_JOURNAL_ENTRIES = 8;

export type PendingJournalRecord = {
	writerId: string;
	pending: PendingKitchen;
	/** Every durable copy of this writer's current snapshot, including the legacy mirror. */
	keys: Array<{ key: string; pending: PendingKitchen }>;
};
export type PendingJournalRead = { records: PendingJournalRecord[]; error: string };
export type QuarantinedJournalEntry = {
	key: string;
	slot: string;
	raw: string;
	parsed?: unknown;
};

/**
 * Validate a candidate kitchen snapshot while allowing untouched legacy fields already present in
 * `referenceBase` to heal via `sanitizeKitchenState`. Newly introduced invalid edits still return
 * `null` and are rejected.
 */
export function repairLegacyKitchenState(
	value: unknown,
	referenceBase?: AppState | null
): AppState | null {
	if (isKitchenState(value)) return value;
	if (!isKitchenStateShape(value)) return null;
	if (!referenceBase || !isKitchenStateShape(referenceBase) || isKitchenState(referenceBase)) {
		return null;
	}
	const sanitizedBase = sanitizeKitchenState(referenceBase);
	const candidate = mergeKitchenStates(referenceBase, value, sanitizedBase, 'local').state;
	return isKitchenState(candidate) ? candidate : null;
}

function listQuarantinedKeys(
	storage: StorageLike,
	user: Pick<User, 'id' | 'householdId'>
): string[] {
	if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return [];
	const prefix = quarantinePrefix(user);
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const storageKey = storage.key(index);
		if (storageKey?.startsWith(prefix)) keys.push(storageKey);
	}
	return keys;
}

function quarantineSlot(
	storage: StorageLike,
	user: Pick<User, 'id' | 'householdId'>,
	activeKey: string,
	slotId: string,
	raw: string
): void {
	const safeSlot = (slotId ? encodeURIComponent(slotId) : 'corrupt').slice(0, 120) || 'corrupt';
	const baseKey = `${quarantinePrefix(user)}${safeSlot}`;
	// Never truncate: a quarantined entry is the only copy of the user's unsynced edits.
	const boundedRaw = raw;
	try {
		const existingKeys = listQuarantinedKeys(storage, user);
		for (const existingKey of existingKeys) {
			if (storage.getItem(existingKey) === boundedRaw) {
				storage.removeItem(activeKey);
				return;
			}
		}
		let targetKey = `${baseKey}:${MAX_QUARANTINED_JOURNAL_ENTRIES}`;
		for (let suffix = 1; suffix <= MAX_QUARANTINED_JOURNAL_ENTRIES; suffix += 1) {
			const candidate = suffix === 1 ? baseKey : `${baseKey}:${suffix}`;
			const current = storage.getItem(candidate);
			if (current === null || current === boundedRaw) {
				targetKey = candidate;
				break;
			}
		}
		const evictable = existingKeys.filter((entry) => entry !== targetKey);
		const overflowCount =
			existingKeys.includes(targetKey) || existingKeys.length < MAX_QUARANTINED_JOURNAL_ENTRIES
				? 0
				: existingKeys.length - MAX_QUARANTINED_JOURNAL_ENTRIES + 1;
		try {
			if (storage.getItem(targetKey) !== boundedRaw) {
				storage.setItem(targetKey, boundedRaw);
			}
		} catch (writeError) {
			if (!evictable.length) throw writeError;
			storage.removeItem(evictable.shift()!);
			storage.setItem(targetKey, boundedRaw);
		}
		for (let i = 0; i < overflowCount && evictable.length > 0; i += 1) {
			storage.removeItem(evictable.shift()!);
		}
		storage.removeItem(activeKey);
	} catch {
		// Leave the original untouched for manual recovery if storage refuses writes or removals.
	}
}

/** Read quarantined journal entries for this account/household so backups can export them. */
export function readQuarantinedJournal(
	storage: StorageLike,
	user: Pick<User, 'id' | 'householdId'>
): QuarantinedJournalEntry[] {
	const prefix = quarantinePrefix(user);
	const entries: QuarantinedJournalEntry[] = [];
	try {
		const keys =
			typeof storage.length === 'number' && typeof storage.key === 'function'
				? listQuarantinedKeys(storage, user).sort()
				: [`${prefix}legacy-main`];
		for (const storageKey of keys) {
			const raw = storage.getItem(storageKey);
			if (raw === null) continue;
			const rawSlot = storageKey.slice(prefix.length);
			let slot = rawSlot || 'corrupt';
			try {
				slot = decodeURIComponent(rawSlot) || 'corrupt';
			} catch {
				slot = rawSlot || 'corrupt';
			}
			let hasParsed = false;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
				hasParsed = true;
			} catch {
				hasParsed = false;
			}
			entries.push({
				key: storageKey,
				slot,
				raw,
				...(hasParsed ? { parsed } : {})
			});
		}
	} catch {
		return entries;
	}
	return entries;
}

function parsePending(value: unknown, user: User): PendingKitchen | null {
	if (
		!value ||
		typeof value !== 'object' ||
		(value as PendingKitchen).userId !== user.id ||
		(value as PendingKitchen).householdId !== user.householdId ||
		!isKitchenStateShape((value as PendingKitchen).base) ||
		!isKitchenStateShape((value as PendingKitchen).local) ||
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
	const candidate = value as PendingKitchen;
	if (isKitchenState(candidate.base) && isKitchenState(candidate.local)) {
		return candidate;
	}
	const repairedLocal = repairLegacyKitchenState(candidate.local, candidate.base);
	if (!repairedLocal) return null;
	return {
		...candidate,
		base: isKitchenState(candidate.base) ? candidate.base : sanitizeKitchenState(candidate.base),
		local: repairedLocal
	};
}

/** Read every per-writer durable delta, plus the old single-slot format for migration. */
export function readPendingJournal(storage: StorageLike, user: User): PendingJournalRead {
	const byWriter = new Map<string, PendingJournalRecord>();
	let error = '';
	if (typeof storage.length !== 'number' || typeof storage.key !== 'function') {
		let serialized: string | null = null;
		try {
			serialized = storage.getItem(key(user));
			if (serialized === null) return { records: [], error: '' };
			const pending = parsePending(JSON.parse(serialized), user);
			if (!pending) {
				quarantineSlot(storage, user, key(user), 'legacy-main', serialized);
				return {
					records: [],
					error: 'A saved offline snapshot could not be read safely and was quarantined.'
				};
			}
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
			if (serialized !== null) quarantineSlot(storage, user, key(user), 'legacy-main', serialized);
			return { records: [], error: 'Saved offline changes could not be read.' };
		}
	}
	try {
		const prefix = journalPrefix(user);
		const matchingKeys: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const storageKey = storage.key(index);
			if (storageKey?.startsWith(prefix)) matchingKeys.push(storageKey);
		}
		for (const storageKey of matchingKeys) {
			const rawSuffix = storageKey.slice(prefix.length);
			let raw: string | null = null;
			try {
				raw = storage.getItem(storageKey);
				if (raw === null) continue;
				const writerId = decodeURIComponent(rawSuffix);
				const pending = parsePending(JSON.parse(raw), user);
				if (!writerId || !pending || pending.writerId !== writerId) {
					quarantineSlot(storage, user, storageKey, writerId || rawSuffix || 'empty', raw);
					error ||= 'A saved offline journal entry could not be read safely and was quarantined.';
					continue;
				}
				byWriter.set(writerId, {
					writerId,
					pending,
					keys: [{ key: storageKey, pending }]
				});
			} catch {
				if (raw !== null) quarantineSlot(storage, user, storageKey, rawSuffix || 'corrupt', raw);
				error ||= 'A saved offline journal entry could not be read safely and was quarantined.';
			}
		}
		const mainKey = key(user);
		let serialized: string | null = null;
		try {
			serialized = storage.getItem(mainKey);
			if (serialized !== null) {
				const pending = parsePending(JSON.parse(serialized), user);
				if (!pending) {
					quarantineSlot(storage, user, mainKey, 'legacy-main', serialized);
					error ||= 'A saved offline snapshot could not be read safely and was quarantined.';
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
			if (serialized !== null) quarantineSlot(storage, user, mainKey, 'legacy-main', serialized);
			error ||= 'A saved offline snapshot could not be read safely and was quarantined.';
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
	return isKitchenState(value);
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
			const raw = storage.getItem(captured.key);
			if (raw === null) continue;
			let current: PendingKitchen | null = null;
			try {
				current = parsePending(JSON.parse(raw), user);
			} catch {
				current = null;
			}
			if (current && sameJournalVersion(current, captured.pending))
				storage.removeItem(captured.key);
		}
	}
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

function roundPantryQuantity(value: number): number {
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function newlyCompletedMeals(base: AppState, snapshot: AppState): Meal[] {
	const baseById = new Map(base.meals.map((meal) => [meal.id, meal]));
	return snapshot.meals.filter(
		(meal) =>
			Boolean(meal.completedAt) &&
			!baseById.get(meal.id)?.completedAt &&
			Boolean(meal.pantryDeductions?.length)
	);
}

function restoreMealPantryDeductions(base: AppState, snapshot: AppState): AppState {
	const completed = newlyCompletedMeals(base, snapshot);
	if (!completed.length) return snapshot;
	const restored = structuredClone(snapshot);
	const pantryById = new Map(restored.pantry.map((item) => [item.id, item]));
	for (const meal of completed) {
		for (const deduction of meal.pantryDeductions ?? []) {
			if (!Number.isFinite(deduction.quantity) || !(deduction.quantity > 0)) continue;
			const target = pantryById.get(deduction.pantryId);
			if (!target) continue;
			const delta = convertCompatibleQuantity(deduction.quantity, deduction.unit, target.unit);
			if (delta === undefined) continue;
			target.quantity = roundPantryQuantity(target.quantity + delta);
		}
	}
	return restored;
}

const isWeekScope = (sourceKey: unknown): sourceKey is string =>
	typeof sourceKey === 'string' && sourceKey.startsWith('week:');

function formatDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseWeekScopeDate(sourceKey: unknown): string | null {
	if (typeof sourceKey !== 'string') return null;
	const match = /^week:(\d{4}-\d{2}-\d{2})$/.exec(sourceKey);
	if (!match) return null;
	const parsed = new Date(`${match[1]}T12:00:00`);
	return Number.isFinite(parsed.getTime()) && formatDateKey(parsed) === match[1] ? match[1] : null;
}

function weekStartForDate(value: string): string | null {
	const cleaned = value.trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;
	const date = new Date(`${cleaned}T12:00:00`);
	if (!Number.isFinite(date.getTime()) || formatDateKey(date) !== cleaned) return null;
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return formatDateKey(date);
}

function refreshWeeklyScope(state: AppState, startDate: string): void {
	const start = new Date(`${startDate}T12:00:00`);
	if (!Number.isFinite(start.getTime()) || formatDateKey(start) !== startDate) return;
	const dates = new Set(
		Array.from({ length: 7 }, (_, index) => {
			const day = new Date(start);
			day.setDate(day.getDate() + index);
			return formatDateKey(day);
		})
	);
	const meals = state.meals.filter((meal) => !meal.completedAt && dates.has(meal.date));
	const recipes = state.recipes.filter((recipe) =>
		meals.some((meal) => meal.recipeId === recipe.id)
	);
	const additions = buildShoppingList(recipes, state.pantry, meals);
	state.shopping = reconcileShoppingList(state.shopping, additions, `week:${startDate}`);
}

const isShoppingEntityPath = /^kitchen\.shopping\[[^\]]+\]$/;
const isMealEntityPath = /^kitchen\.meals\[[^\]]+\]$/;

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

function applyMealPantryDeductions(
	pantry: Ingredient[],
	meals: Meal[],
	options?: {
		base: AppState;
		local: AppState;
		remote: AppState;
		prefer?: 'local' | 'remote';
		conflicts: DetailedConflict[];
	}
): Ingredient[] {
	if (!meals.length) return pantry;
	const result = pantry.map((item) => ({ ...item }));
	const pantryById = new Map(result.map((item) => [item.id, item]));
	const rawQuantityById = new Map(result.map((item) => [item.id, item.quantity]));
	const clampedIds = new Set<string>();
	const incompatibleIds = new Set<string>();
	const missingIds = new Set<string>();

	for (const meal of meals) {
		for (const deduction of meal.pantryDeductions ?? []) {
			if (!Number.isFinite(deduction.quantity) || !(deduction.quantity > 0)) continue;
			const target = pantryById.get(deduction.pantryId);
			if (!target) {
				missingIds.add(deduction.pantryId);
				continue;
			}
			const delta = convertCompatibleQuantity(deduction.quantity, deduction.unit, target.unit);
			if (delta === undefined) {
				incompatibleIds.add(target.id);
				continue;
			}
			const previousRaw = rawQuantityById.get(target.id) ?? target.quantity;
			const rawDiff = previousRaw - delta;
			const nextRaw = Math.abs(rawDiff) <= 1e-9 ? 0 : roundPantryQuantity(rawDiff);
			rawQuantityById.set(target.id, nextRaw);
			const nextClamped = roundPantryQuantity(Math.max(0, nextRaw));
			target.quantity = nextClamped;
			if (nextClamped !== nextRaw) {
				clampedIds.add(target.id);
			}
		}
	}

	if (!options || equal(options.local, options.remote)) {
		return result;
	}

	const { base, local, remote, prefer, conflicts } = options;
	const localById = new Map(local.pantry.map((item) => [item.id, item]));
	const remoteById = new Map(remote.pantry.map((item) => [item.id, item]));
	const bothBranchesDiverged = !equal(local, base) && !equal(remote, base);

	for (const pantryId of missingIds) {
		const localItem = localById.get(pantryId);
		const remoteItem = remoteById.get(pantryId);
		if (!bothBranchesDiverged || Boolean(localItem) === Boolean(remoteItem)) continue;
		const itemSegments: PathSegment[] = [
			{ kind: 'prop', key: 'pantry' },
			{ kind: 'id', id: pantryId }
		];
		if (!conflicts.some((entry) => segmentsStartWith(entry.segments, itemSegments))) {
			conflicts.push({
				path: `kitchen.pantry[${pantryId}]`,
				local: localItem ? structuredClone(localItem) : undefined,
				remote: remoteItem ? structuredClone(remoteItem) : undefined,
				segments: itemSegments
			});
		}
		const chosen = prefer === 'local' ? localItem : remoteItem;
		if (chosen && !pantryById.has(pantryId)) {
			const cloned = structuredClone(chosen);
			result.push(cloned);
			pantryById.set(pantryId, cloned);
		}
	}

	for (const pantryId of incompatibleIds) {
		const localItem = localById.get(pantryId);
		const remoteItem = remoteById.get(pantryId);
		if (!bothBranchesDiverged) continue;
		const itemSegments: PathSegment[] = [
			{ kind: 'prop', key: 'pantry' },
			{ kind: 'id', id: pantryId }
		];
		for (let index = conflicts.length - 1; index >= 0; index -= 1) {
			if (
				!equal(conflicts[index].segments, itemSegments) &&
				segmentsStartWith(itemSegments, conflicts[index].segments)
			) {
				conflicts.splice(index, 1);
			}
		}
		if (!conflicts.some((entry) => segmentsStartWith(entry.segments, itemSegments))) {
			conflicts.push({
				path: `kitchen.pantry[${pantryId}]`,
				local: localItem ? structuredClone(localItem) : undefined,
				remote: remoteItem ? structuredClone(remoteItem) : undefined,
				segments: itemSegments
			});
		}
		const chosen = prefer === 'local' ? localItem : remoteItem;
		const index = result.findIndex((item) => item.id === pantryId);
		if (chosen && index !== -1) {
			const cloned = structuredClone(chosen);
			result[index] = cloned;
			pantryById.set(pantryId, cloned);
		} else if (!chosen && index !== -1) {
			result.splice(index, 1);
			pantryById.delete(pantryId);
		}
	}

	for (const pantryId of clampedIds) {
		const target = pantryById.get(pantryId);
		if (!target) continue;
		const quantitySegments: PathSegment[] = [
			{ kind: 'prop', key: 'pantry' },
			{ kind: 'id', id: pantryId },
			{ kind: 'prop', key: 'quantity' }
		];
		const localQuantity = localById.get(pantryId)?.quantity;
		const remoteQuantity = remoteById.get(pantryId)?.quantity;
		if (!conflicts.some((entry) => segmentsStartWith(entry.segments, quantitySegments))) {
			conflicts.push({
				path: `kitchen.pantry[${pantryId}].quantity`,
				local: localQuantity,
				remote: remoteQuantity,
				segments: quantitySegments
			});
		}
		if (prefer === 'local' && typeof localQuantity === 'number') {
			target.quantity = localQuantity;
		} else if (prefer === 'remote' && typeof remoteQuantity === 'number') {
			target.quantity = remoteQuantity;
		}
	}

	return result;
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
	const localNormalized = restoreMealPantryDeductions(base, local);
	const remoteNormalized = restoreMealPantryDeductions(base, remote);
	const planningInputsChanged =
		!equal(local.meals, base.meals) ||
		!equal(remote.meals, base.meals) ||
		!equal(local.pantry, base.pantry) ||
		!equal(remote.pantry, base.pantry) ||
		!equal(local.recipes, base.recipes) ||
		!equal(remote.recipes, base.recipes);
	const refreshedWeekScopes = new Map<string, 'local' | 'remote'>();

	const merge = (
		old: unknown,
		mine: unknown,
		theirs: unknown,
		path: string,
		segments: PathSegment[]
	): unknown => {
		if (isShoppingEntityPath.test(path)) {
			const oldItem = old as ShoppingItem | undefined;
			const localItem = mine as ShoppingItem | undefined;
			const remoteItem = theirs as ShoppingItem | undefined;
			if (equal(localItem, remoteItem)) return localItem;
			if (!oldItem?.checked) {
				if (localItem?.checked && isWeekScope(localItem.sourceKey)) {
					if (equal(remoteItem, oldItem)) return localItem;
					if (
						!remoteItem ||
						(!remoteItem.checked && remoteItem.sourceKey === localItem.sourceKey)
					) {
						refreshedWeekScopes.set(localItem.sourceKey, 'remote');
						return localItem;
					}
				}
				if (remoteItem?.checked && isWeekScope(remoteItem.sourceKey)) {
					if (equal(localItem, oldItem)) return remoteItem;
					if (!localItem || (!localItem.checked && localItem.sourceKey === remoteItem.sourceKey)) {
						refreshedWeekScopes.set(remoteItem.sourceKey, 'local');
						return remoteItem;
					}
				}
			}
			if (equal(localItem, oldItem)) return remoteItem;
			if (equal(remoteItem, oldItem)) return localItem;
			if (
				planningInputsChanged &&
				!oldItem?.checked &&
				(!localItem || (!localItem.checked && Boolean(parseWeekScopeDate(localItem.sourceKey)))) &&
				(!remoteItem ||
					(!remoteItem.checked && Boolean(parseWeekScopeDate(remoteItem.sourceKey)))) &&
				Boolean(
					parseWeekScopeDate(localItem?.sourceKey ?? remoteItem?.sourceKey ?? oldItem?.sourceKey)
				)
			) {
				return prefer === 'local' ? localItem : (remoteItem ?? localItem);
			}
			return conflict(path, segments, localItem, remoteItem);
		}
		if (isMealEntityPath.test(path)) {
			if (equal(mine, theirs)) return mine;
			if (equal(mine, old)) return theirs;
			if (equal(theirs, old)) return mine;
			return conflict(path, segments, mine, theirs);
		}
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
	const state = structuredClone(
		merge(base, localNormalized, remoteNormalized, 'kitchen', [])
	) as AppState;
	reconcileOrphanedMeals(state, local, remote, conflicts, prefer);
	state.meals = state.meals.map((meal) => {
		if (!meal.completedAt) {
			if (meal.leftoverServings === undefined && meal.pantryDeductions === undefined) {
				return meal;
			}
			const next = { ...meal };
			delete next.leftoverServings;
			delete next.pantryDeductions;
			return next;
		}
		if (meal.leftoverServings === undefined) {
			if (!('leftoverServings' in meal)) return meal;
			const next = { ...meal };
			delete next.leftoverServings;
			return next;
		}
		const normalizedLeftovers = clampLeftoverServings(meal.leftoverServings, meal.servings);
		return normalizedLeftovers === meal.leftoverServings
			? meal
			: {
					...meal,
					leftoverServings: normalizedLeftovers
				};
	});

	const baseMealsById = new Map(base.meals.map((meal) => [meal.id, meal]));
	const acceptedNewCompletions = state.meals.filter(
		(meal) =>
			Boolean(meal.completedAt) &&
			!baseMealsById.get(meal.id)?.completedAt &&
			Boolean(meal.pantryDeductions?.length)
	);
	state.pantry = applyMealPantryDeductions(state.pantry, acceptedNewCompletions, {
		base,
		local,
		remote,
		prefer,
		conflicts
	});
	for (const entry of conflicts) {
		if (entry.path === 'kitchen.pantry' || entry.path.startsWith('kitchen.pantry[')) {
			entry.local = getAtSegments(local, entry.segments);
			entry.remote = getAtSegments(remote, entry.segments);
		}
	}

	if (!equal(local, remote)) {
		const reconciledScopes = new Set<string>();
		const stateInputsChanged =
			!equal(state.meals, base.meals) ||
			!equal(state.pantry, base.pantry) ||
			!equal(state.recipes, base.recipes);
		const bothBranchesDiverged = !equal(local, base) && !equal(remote, base);
		if ((stateInputsChanged || planningInputsChanged) && bothBranchesDiverged) {
			const affectedWeeks = new Set<string>();
			for (const item of [...base.shopping, ...local.shopping, ...remote.shopping]) {
				const startDate = parseWeekScopeDate(item.sourceKey);
				if (startDate) affectedWeeks.add(startDate);
			}
			const localPlanningChanged =
				!equal(local.meals, base.meals) ||
				!equal(local.pantry, base.pantry) ||
				!equal(local.recipes, base.recipes);
			const remotePlanningChanged =
				!equal(remote.meals, base.meals) ||
				!equal(remote.pantry, base.pantry) ||
				!equal(remote.recipes, base.recipes);
			if (localPlanningChanged && remotePlanningChanged) {
				for (const meal of state.meals) {
					if (meal.completedAt) continue;
					const previous = baseMealsById.get(meal.id);
					if (!previous || !equal(previous, meal)) {
						const startDate = weekStartForDate(meal.date);
						if (startDate) affectedWeeks.add(startDate);
					}
				}
			}
			for (const startDate of [...affectedWeeks].sort()) {
				refreshWeeklyScope(state, startDate);
				reconciledScopes.add(`week:${startDate}`);
			}
		}
		for (const [sourceKey, branch] of refreshedWeekScopes) {
			if (reconciledScopes.has(sourceKey)) continue;
			const sourceItems = (branch === 'local' ? local : remote).shopping.filter(
				(item) => item.sourceKey === sourceKey
			);
			state.shopping = reconcileShoppingList(state.shopping, sourceItems, sourceKey);
		}
	}

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

/** Apply independent writer snapshots in creation order while retaining conflicts between them. */
export function mergePendingKitchenJournal(
	records: PendingJournalRecord[],
	remote: AppState,
	prefer?: 'local' | 'remote'
): { state: AppState; conflicts: SyncConflict[] } {
	if (!records.length) return { state: structuredClone(remote), conflicts: [] };
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
	let composedBase = structuredClone(ordered[0].pending.base);
	let composedLocal = structuredClone(ordered[0].pending.local);
	const rawLocalConflicts: DetailedConflict[] = [];
	for (let index = 1; index < ordered.length; index += 1) {
		const record = ordered[index];
		const rebasedBase = mergeKitchenStates(
			composedLocal,
			composedBase,
			record.pending.base,
			'local'
		).state;
		const rebasedLocal = mergeKitchenStates(
			composedBase,
			composedLocal,
			record.pending.base,
			'local'
		).state;
		const step = mergeKitchenStatesDetailed(
			record.pending.base,
			record.pending.local,
			rebasedLocal,
			'local'
		);
		composedBase = rebasedBase;
		composedLocal = step.state;
		rawLocalConflicts.push(...step.conflicts);
	}
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

function prepareMergedStateForPut(mergedState: AppState, remoteState: AppState): AppState {
	if (isKitchenState(mergedState)) return mergedState;
	return repairLegacyKitchenState(mergedState, remoteState) ?? sanitizeKitchenState(mergedState);
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
			const result = await transport.put(
				prepareMergedStateForPut(resolved.state, remote.state),
				expectedEtag
			);
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
			const result = await transport.put(
				prepareMergedStateForPut(merged.state, remote.state),
				remote.etag
			);
			return { ...result, conflicts: [], saved: true };
		} catch (error) {
			if ((error as { status?: number }).status !== 412 || attempt === 2) throw error;
		}
	}
	throw new Error('Your household is changing quickly. Try syncing again.');
}
