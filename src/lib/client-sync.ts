import { createNewUserState } from '#lib/data.ts';
import { sanitizeKitchenState } from '#lib/guest-storage.ts';
import type { AppState, User } from '#lib/types.ts';
import {
	clearPendingJournalRecords,
	isKitchenState,
	isKitchenStateShape,
	MAX_PENDING_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	readQuarantinedJournal,
	repairLegacyKitchenState,
	syncPendingKitchenJournal,
	type KitchenTransport,
	type PendingJournalRecord,
	type PendingKitchen,
	type QuarantinedJournalEntry,
	type SyncConflict,
	writePending,
	writePendingJournal
} from '#lib/offline-sync.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
	Partial<Pick<Storage, 'key' | 'length'>>;
export type SyncStatus = {
	ready: boolean;
	pending: boolean;
	syncing: boolean;
	conflicts: SyncConflict[];
	reviewedEtag: string | null;
	error: string;
};
export type KitchenBackupPayload =
	| AppState
	| {
			pending?: AppState;
			quarantined: QuarantinedJournalEntry[];
	  };
export const MAX_SYNC_CONTINUATIONS = 3;
type ConfirmedKitchen = {
	userId: string;
	householdId: string;
	state: AppState;
	rawState?: AppState;
	etag: string;
	updatedAt: number;
};
type Identity = { userId: string; householdId: string };
type MemoryRecord = { record: PendingJournalRecord; durable: boolean };
type LoadedJournal = {
	records: PendingJournalRecord[];
	durable: boolean;
	blocked: boolean;
	error: string;
};
type ActiveContext = {
	user: User;
	identity: Identity;
	key: string;
	generation: number;
	baseline: ConfirmedKitchen | null;
	legacyReference: AppState | null;
	confirmed: boolean;
	loading: boolean;
	loadError: string;
	viewState: AppState | null;
	pending: PendingKitchen | null;
	pendingDurable: boolean;
	blockedByStorage: boolean;
	syncing: boolean;
	initializedOnline: boolean;
	conflicts: SyncConflict[];
	storageAlert: string;
	validationError: boolean;
	retiredRecords: PendingJournalRecord[];
	reviewedEtag: string | null;
	reviewedState: AppState | null;
	error: string;
};

const WRITER_STORAGE_KEY = 'flavorithm-writer-id:v1';
const STAGE_QUOTA_ALERT =
	'Offline changes could not be saved on this device. Sync online or back up your changes before closing this tab.';
const confirmedKey = (identity: Identity) =>
	`flavorithm-confirmed:v1:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.householdId)}`;
const identityKey = (identity: Identity) => `${identity.userId}\u0000${identity.householdId}`;
const clone = <T>(value: T): T => {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value)) as T;
	}
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const enumerableStorage = (storage: StorageLike) =>
	typeof storage.length === 'number' && typeof storage.key === 'function';

function randomId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ||
		`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	);
}

/**
 * Allocate a fresh writer identifier per live controller/browsing context.
 * `sessionStorage` is cloned when a browser tab is duplicated, so reusing a stored value would let
 * two live tabs overwrite the same journal slot. Accessing `sessionStorage` is also wrapped in
 * `try/catch` because sandboxed or storage-blocked contexts can throw `SecurityError` on getter read.
 */
function resolveWriterId(session?: StorageLike | null): string {
	const id = randomId();
	try {
		const store =
			session !== undefined
				? session
				: typeof window !== 'undefined'
					? window.sessionStorage
					: globalThis.sessionStorage;
		store?.removeItem(WRITER_STORAGE_KEY);
	} catch {
		// Ignore blocked or unavailable sessionStorage in sandboxed contexts.
	}
	return id;
}

function isSameIdentity(user: User | null | undefined, identity: Identity): user is User {
	return !!user && user.id === identity.userId && user.householdId === identity.householdId;
}

function sameVersion(a: PendingKitchen, b: PendingKitchen): boolean {
	if (a.writerId && b.writerId && a.writerId !== b.writerId) return false;
	if (a.writeId && b.writeId) return a.writeId === b.writeId;
	return (
		a.updatedAt === b.updatedAt &&
		a.createdAt === b.createdAt &&
		a.etag === b.etag &&
		equal(a.base, b.base) &&
		equal(a.local, b.local)
	);
}

function sortRecords(records: PendingJournalRecord[]): PendingJournalRecord[] {
	return [...records].sort(
		(a, b) =>
			(a.pending.createdAt ?? a.pending.updatedAt) - (b.pending.createdAt ?? b.pending.updatedAt) ||
			a.writerId.localeCompare(b.writerId)
	);
}

function readConfirmed(storage: StorageLike, identity: Identity): ConfirmedKitchen | null {
	try {
		const value = JSON.parse(storage.getItem(confirmedKey(identity)) || 'null');
		if (
			value?.userId !== identity.userId ||
			value?.householdId !== identity.householdId ||
			!isKitchenStateShape(value.state) ||
			typeof value.etag !== 'string'
		) {
			return null;
		}
		const rawState = clone(value.state);
		const normalizedState = isKitchenState(rawState) ? rawState : sanitizeKitchenState(rawState);
		return {
			userId: value.userId,
			householdId: value.householdId,
			state: normalizedState,
			...(rawState !== normalizedState ? { rawState } : {}),
			etag: value.etag,
			updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
		};
	} catch {
		return null;
	}
}

function hasUnretiredJournalVersion(
	storage: StorageLike,
	records: PendingJournalRecord[]
): boolean {
	for (const record of records) {
		for (const entry of record.keys) {
			try {
				const raw = storage.getItem(entry.key);
				if (!raw) continue;
				const parsed = JSON.parse(raw) as PendingKitchen;
				if (
					parsed &&
					typeof parsed === 'object' &&
					parsed.userId === entry.pending.userId &&
					parsed.householdId === entry.pending.householdId &&
					sameVersion(parsed, entry.pending)
				) {
					return true;
				}
			} catch {
				return true;
			}
		}
	}
	return false;
}

/**
 * Coordinates local edits through a per-controller durable journal. Each tab owns one slot, so a
 * concurrent tab can never erase another tab's only offline copy. All writer deltas are reconciled
 * against the latest server snapshot before sync.
 */
export function createKitchenSync(options: {
	storage: StorageLike;
	sessionStorage?: StorageLike | null;
	getUser: () => User | null;
	getState: () => AppState;
	setState: (state: AppState) => void;
	onStatus: (status: SyncStatus) => void;
	transport: (user: User) => KitchenTransport;
}) {
	let active: ActiveContext | null = null;
	let generation = 0;
	const writerId = resolveWriterId(options.sessionStorage);
	const memoryRecords = new Map<string, Map<string, MemoryRecord>>();
	const baselines = new Map<string, ConfirmedKitchen>();

	const statusOf = (context: ActiveContext): SyncStatus => ({
		ready: context.confirmed && !context.loading,
		pending: !!context.pending,
		syncing: context.syncing || context.loading,
		conflicts: clone(context.conflicts),
		reviewedEtag: context.reviewedEtag,
		error: context.error
	});
	const isActive = (context: ActiveContext) =>
		active === context &&
		context.generation === generation &&
		isSameIdentity(options.getUser(), context.identity);
	const emitStatus = (context: ActiveContext) => {
		if (isActive(context)) options.onStatus(statusOf(context));
	};
	const setContextState = (context: ActiveContext, state: AppState) => {
		if (isActive(context)) {
			context.viewState = clone(state);
			options.setState(clone(state));
		}
	};

	function writerMemory(context: ActiveContext): Map<string, MemoryRecord> {
		let values = memoryRecords.get(context.key);
		if (!values) {
			values = new Map();
			memoryRecords.set(context.key, values);
		}
		return values;
	}

	function rememberRecord(
		context: ActiveContext,
		record: PendingJournalRecord,
		durable: boolean
	): void {
		writerMemory(context).set(record.writerId, { record: clone(record), durable });
	}

	function forgetAcknowledged(context: ActiveContext, records: PendingJournalRecord[]): void {
		const memory = writerMemory(context);
		for (const record of records) {
			const latest = memory.get(record.writerId);
			if (latest && sameVersion(latest.record.pending, record.pending))
				memory.delete(record.writerId);
		}
	}

	function loadJournal(context: ActiveContext): LoadedJournal {
		const durable = readPendingJournal(options.storage, context.user);
		const activeDurable = durable.records.filter(
			(record) =>
				!context.retiredRecords.some(
					(retired) =>
						retired.writerId === record.writerId && sameVersion(retired.pending, record.pending)
				)
		);
		context.retiredRecords = context.retiredRecords.filter((retired) =>
			durable.records.some(
				(record) =>
					record.writerId === retired.writerId && sameVersion(record.pending, retired.pending)
			)
		);
		const byWriter = new Map(activeDurable.map((record) => [record.writerId, record]));
		const memory = writerMemory(context);
		let blocked = !!durable.error;
		let error = durable.error;
		for (const [id, cached] of memory) {
			const stored = byWriter.get(id);
			if (cached.durable) {
				if (!stored) {
					// Another tab may have acknowledged and retired this writer's exact durable version.
					memory.delete(id);
					continue;
				}
				if (!sameVersion(cached.record.pending, stored.pending)) {
					const chosen =
						stored.pending.updatedAt >= cached.record.pending.updatedAt ? stored : cached.record;
					byWriter.set(id, chosen);
					memory.set(id, { record: clone(chosen), durable: true });
				} else {
					byWriter.set(id, stored);
					memory.set(id, { record: clone(stored), durable: true });
				}
			} else {
				blocked = true;
				error ||= STAGE_QUOTA_ALERT;
				const keys = stored
					? [
							...cached.record.keys,
							...stored.keys.filter(
								(entry) =>
									!cached.record.keys.some(
										(current) =>
											current.key === entry.key && sameVersion(current.pending, entry.pending)
									)
							)
						]
					: cached.record.keys;
				byWriter.set(id, { ...cached.record, keys });
			}
		}
		for (const record of byWriter.values()) {
			if (!memory.get(record.writerId))
				memory.set(record.writerId, { record: clone(record), durable: true });
		}
		const records = sortRecords([...byWriter.values()]);
		const allDurable =
			!blocked && records.every((record) => memory.get(record.writerId)?.durable !== false);
		return { records, durable: allDurable, blocked, error };
	}

	function aggregatePending(
		context: ActiveContext,
		records: PendingJournalRecord[],
		local: AppState
	): PendingKitchen | null {
		if (!records.length) return null;
		const ordered = sortRecords(records);
		const first = ordered[0].pending;
		return {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			base: clone(context.baseline?.state || first.base || createNewUserState()),
			local: clone(local),
			etag: context.baseline?.etag ?? first.etag ?? null,
			updatedAt: Math.max(...records.map((record) => record.pending.updatedAt))
		};
	}

	function updateAggregate(
		context: ActiveContext,
		loaded: LoadedJournal,
		seed: AppState,
		prefer?: 'local' | 'remote',
		setUI = false
	): { state: AppState; conflicts: SyncConflict[] } {
		const merged = mergePendingKitchenJournal(loaded.records, seed, prefer);
		const localState =
			!prefer && merged.conflicts.length
				? mergePendingKitchenJournal(loaded.records, seed, 'local').state
				: merged.state;
		context.pending = aggregatePending(context, loaded.records, localState);
		context.pendingDurable = loaded.durable;
		context.blockedByStorage = loaded.blocked;
		context.conflicts = clone(merged.conflicts);
		if (loaded.error) context.storageAlert ||= loaded.error;
		if (setUI) context.viewState = clone(localState);
		if (loaded.error || context.storageAlert) {
			context.error = loaded.error || context.storageAlert;
		} else if (context.confirmed || loaded.records.length) {
			context.error = '';
		} else {
			context.error = context.loadError;
		}
		if (setUI) setContextState(context, localState);
		return { state: localState, conflicts: merged.conflicts };
	}

	function saveBaseline(context: ActiveContext, state: AppState, etag: string): void {
		const rawState = clone(state);
		const normalizedState =
			isKitchenState(rawState) || !isKitchenStateShape(rawState)
				? rawState
				: sanitizeKitchenState(rawState);
		const baseline: ConfirmedKitchen = {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			state: normalizedState,
			...(rawState !== normalizedState ? { rawState } : {}),
			etag,
			updatedAt: Date.now()
		};
		context.baseline = baseline;
		if (rawState !== normalizedState) context.legacyReference = rawState;
		else context.legacyReference = null;
		baselines.set(context.key, baseline);
		options.storage.setItem(
			confirmedKey(context.identity),
			JSON.stringify({
				userId: baseline.userId,
				householdId: baseline.householdId,
				state: baseline.state,
				etag: baseline.etag,
				updatedAt: baseline.updatedAt
			})
		);
	}

	function activate(user: User): ActiveContext | null {
		const identity = { userId: user.id, householdId: user.householdId };
		if (!isSameIdentity(options.getUser(), identity)) return null;
		generation += 1;
		const key = identityKey(identity);
		const baseline = baselines.get(key) || readConfirmed(options.storage, identity);
		const context: ActiveContext = {
			user: clone(user),
			identity,
			key,
			generation,
			baseline,
			legacyReference: baseline?.rawState ? clone(baseline.rawState) : null,
			confirmed: false,
			loading: false,
			loadError: '',
			viewState: null,
			pending: null,
			pendingDurable: false,
			blockedByStorage: false,
			syncing: false,
			initializedOnline: false,
			conflicts: [],
			storageAlert: '',
			validationError: false,
			retiredRecords: [],
			reviewedEtag: null,
			reviewedState: null,
			error: ''
		};
		active = context;
		return context;
	}

	function acknowledge(context: ActiveContext, records: PendingJournalRecord[]): void {
		forgetAcknowledged(context, records);
		clearPendingJournalRecords(options.storage, context.user, records);
	}

	function rebaseNewerWriterRecords(
		context: ActiveContext,
		captured: PendingJournalRecord[],
		remaining: PendingJournalRecord[],
		serverState: AppState,
		etag: string
	): string {
		const included = new Map(captured.map((record) => [record.writerId, record]));
		for (const record of remaining) {
			const previous = included.get(record.writerId);
			if (!previous || sameVersion(previous.pending, record.pending)) continue;
			// This writer staged newer UI edits while its earlier snapshot was in flight. Rebase those
			// sequential edits onto the acknowledged state so they do not look like a false conflict
			// against the writer's own just-saved fields.
			const merged = mergeKitchenStates(
				previous.pending.local,
				record.pending.local,
				serverState,
				'local'
			);
			if (merged.conflicts.length) continue;
			const pending: PendingKitchen = {
				...record.pending,
				base: clone(serverState),
				local: clone(merged.state),
				etag,
				updatedAt: Date.now(),
				writeId: randomId()
			};
			const updated: PendingJournalRecord = {
				writerId: record.writerId,
				pending,
				keys: record.keys.map((entry) => ({
					key: entry.key,
					pending:
						entry.key.includes('flavorithm-pending-journal:') ||
						(!enumerableStorage(options.storage) &&
							entry.key ===
								`flavorithm-pending:${context.identity.userId}:${context.identity.householdId}`)
							? pending
							: entry.pending
				}))
			};
			try {
				if (enumerableStorage(options.storage)) writePendingJournal(options.storage, pending);
				else writePending(options.storage, pending);
				rememberRecord(context, updated, true);
			} catch {
				rememberRecord(context, updated, false);
				return 'Earlier edits were saved, but newer edits could not be rebased durably.';
			}
		}
		return '';
	}

	function prepare(user: User): boolean {
		const context = activate(user);
		if (!context) return false;
		context.loading = true;
		context.confirmed = false;
		context.loadError = '';
		const loaded = loadJournal(context);
		const seed = context.baseline?.state || loaded.records[0]?.pending.base || createNewUserState();
		if (loaded.records.length) {
			const merged = updateAggregate(context, loaded, seed, undefined, true);
			context.reviewedEtag = merged.conflicts.length ? (context.baseline?.etag ?? null) : null;
			context.reviewedState = merged.conflicts.length ? clone(seed) : null;
		} else {
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.viewState = clone(seed);
			if (loaded.error) context.storageAlert = loaded.error;
			context.error = loaded.error;
			context.blockedByStorage = loaded.blocked;
			setContextState(context, seed);
		}
		emitStatus(context);
		return true;
	}

	function failLoad(message = 'Could not load your kitchen.'): void {
		const context = active;
		if (!context || !isActive(context)) return;
		context.loading = false;
		context.confirmed = false;
		const nextError = message.trim() || 'Could not load your kitchen.';
		context.loadError = nextError;
		context.error = nextError;
		emitStatus(context);
	}

	function initialize(user: User, remoteState: AppState, etag: string): void {
		const previous = active;
		const context = activate(user);
		if (!context) return;
		context.confirmed = true;
		context.loading = false;
		context.loadError = '';
		context.initializedOnline = true;
		const normalizedRemote =
			isKitchenState(remoteState) || !isKitchenStateShape(remoteState)
				? remoteState
				: sanitizeKitchenState(remoteState);
		const carriedQuarantine =
			previous &&
			previous.key === context.key &&
			(!previous.initializedOnline || !!previous.pending) &&
			previous.storageAlert.includes('quarantined')
				? previous.storageAlert
				: '';
		let baselineError = '';
		try {
			saveBaseline(context, remoteState, etag);
		} catch {
			baselineError = 'The confirmed kitchen could not be saved for offline use.';
		}
		if (normalizedRemote !== remoteState) context.legacyReference = clone(remoteState);
		let loaded = loadJournal(context);
		let quarantineError = loaded.error || carriedQuarantine;
		let merged = updateAggregate(context, loaded, normalizedRemote);
		let retireError = '';
		if (
			!baselineError &&
			loaded.records.length &&
			!merged.conflicts.length &&
			equal(merged.state, normalizedRemote)
		) {
			try {
				acknowledge(context, loaded.records);
				loaded = loadJournal(context);
				quarantineError ||= loaded.error;
				merged = updateAggregate(context, loaded, normalizedRemote);
			} catch {
				context.retiredRecords.push(...clone(loaded.records));
				retireError =
					'The server already has these changes, but the saved offline journal could not be cleared.';
			}
		}
		const initAlert = baselineError || retireError || quarantineError;
		context.storageAlert = initAlert;
		context.error = initAlert;
		context.viewState = clone(merged.state);
		context.reviewedEtag = merged.conflicts.length ? etag : null;
		context.reviewedState = merged.conflicts.length ? clone(normalizedRemote) : null;
		setContextState(context, merged.state);
		emitStatus(context);
	}

	function restore(user: User): boolean {
		const context = activate(user);
		if (!context) return false;
		const loaded = loadJournal(context);
		context.storageAlert = loaded.error;
		if (loaded.records.length) {
			const seed =
				context.baseline?.state || loaded.records[0].pending.base || createNewUserState();
			const seedEtag = context.baseline?.etag ?? loaded.records[0].pending.etag ?? null;
			const merged = updateAggregate(context, loaded, seed, undefined, true);
			context.reviewedEtag = merged.conflicts.length ? seedEtag : null;
			context.reviewedState = merged.conflicts.length ? clone(seed) : null;
			emitStatus(context);
			return true;
		}
		if (context.baseline) {
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.viewState = clone(context.baseline.state);
			context.error = loaded.error || context.storageAlert;
			context.blockedByStorage = loaded.blocked;
			setContextState(context, context.baseline.state);
			emitStatus(context);
			return true;
		}
		const starter = createNewUserState();
		context.reviewedEtag = null;
		context.reviewedState = null;
		context.viewState = clone(starter);
		context.error = loaded.error;
		context.blockedByStorage = loaded.blocked;
		setContextState(context, starter);
		emitStatus(context);
		return false;
	}

	function stage(state: AppState): void {
		const context = active;
		if (!context || !isActive(context)) return;
		const next = clone(state);
		if (!isKitchenStateShape(next)) {
			context.validationError = true;
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		const loaded = loadJournal(context);
		if (loaded.error) context.storageAlert ||= loaded.error;
		const own = loaded.records.find((record) => record.writerId === writerId);
		const rawBase = clone(
			own?.pending.base || context.viewState || context.baseline?.state || createNewUserState()
		);
		const base = isKitchenState(rawBase) ? rawBase : sanitizeKitchenState(rawBase);
		const conflictSeed =
			context.reviewedState || context.baseline?.state || loaded.records[0]?.pending.base || base;
		const conflictSeedEtag = context.baseline?.etag ?? loaded.records[0]?.pending.etag ?? null;
		const syncReviewedConflictSeed = (conflicts: SyncConflict[]) => {
			if (!conflicts.length) {
				context.reviewedEtag = null;
				context.reviewedState = null;
			} else if (context.reviewedEtag === null) {
				context.reviewedEtag = conflictSeedEtag;
				context.reviewedState = clone(conflictSeed);
			}
		};
		if (!own && equal(next, context.viewState)) {
			const priorError = context.validationError ? '' : context.error;
			context.validationError = false;
			const merged = updateAggregate(context, loaded, conflictSeed);
			syncReviewedConflictSeed(merged.conflicts);
			context.error =
				loaded.error ||
				context.storageAlert ||
				priorError ||
				(!context.confirmed && !loaded.records.length ? context.loadError : '');
			emitStatus(context);
			return;
		}
		const reference =
			context.legacyReference && !isKitchenState(context.legacyReference)
				? context.legacyReference
				: rawBase;
		const validatedNext = repairLegacyKitchenState(next, reference);
		if (!validatedNext) {
			context.validationError = true;
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		if (own && (equal(next, own.pending.local) || equal(validatedNext, own.pending.local))) {
			const priorError = context.validationError ? '' : context.error;
			context.validationError = false;
			context.viewState = next;
			const merged = updateAggregate(context, loaded, conflictSeed);
			syncReviewedConflictSeed(merged.conflicts);
			context.error =
				loaded.error ||
				context.storageAlert ||
				priorError ||
				(!context.confirmed && !loaded.records.length ? context.loadError : '');
			emitStatus(context);
			return;
		}
		context.validationError = false;
		if (own && (equal(next, own.pending.base) || equal(validatedNext, own.pending.base))) {
			try {
				acknowledge(context, [own]);
				const after = loadJournal(context);
				const preservedAlert =
					context.storageAlert && context.storageAlert !== STAGE_QUOTA_ALERT
						? context.storageAlert
						: '';
				context.storageAlert = after.error || preservedAlert;
				context.viewState = next;
				const merged = updateAggregate(
					context,
					after,
					context.reviewedState ||
						context.baseline?.state ||
						after.records[0]?.pending.base ||
						validatedNext
				);
				syncReviewedConflictSeed(merged.conflicts);
				context.error = context.storageAlert;
			} catch {
				context.storageAlert =
					'The reverted offline changes could not be removed from this device.';
				context.error = context.storageAlert;
			}
			emitStatus(context);
			return;
		}
		if (!own && loaded.records.length >= MAX_PENDING_JOURNAL_ENTRIES) {
			context.blockedByStorage = true;
			context.error = `This device has reached its ${MAX_PENDING_JOURNAL_ENTRIES}-writer offline journal limit. Reconnect and sync before making more offline edits.`;
			emitStatus(context);
			return;
		}

		const now = Date.now();
		const pending: PendingKitchen = {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			base,
			local: validatedNext,
			etag: own?.pending.etag ?? (context.baseline?.etag || null),
			createdAt: own?.pending.createdAt ?? now,
			updatedAt: now,
			writerId,
			writeId: randomId()
		};
		context.viewState = next;
		let durable = false;
		let persistenceError = '';
		try {
			if (enumerableStorage(options.storage)) {
				writePendingJournal(options.storage, pending);
			} else {
				// Minimal Storage shims retain the single-slot legacy format; real localStorage journals
				// use one full snapshot per writer to avoid doubling storage usage.
				writePending(options.storage, pending);
			}
			durable = true;
		} catch {
			persistenceError = STAGE_QUOTA_ALERT;
		}
		const journalStorageKey = enumerableStorage(options.storage)
			? `flavorithm-pending-journal:v1:${encodeURIComponent(context.identity.userId)}:${encodeURIComponent(context.identity.householdId)}:${encodeURIComponent(writerId)}`
			: `flavorithm-pending:${context.identity.userId}:${context.identity.householdId}`;
		const ownRecord: PendingJournalRecord = {
			writerId,
			pending,
			keys: [
				{
					key: journalStorageKey,
					pending
				}
			]
		};
		rememberRecord(context, ownRecord, durable);
		const after = loadJournal(context);
		const preservedAlert =
			context.storageAlert && context.storageAlert !== STAGE_QUOTA_ALERT
				? context.storageAlert
				: '';
		context.storageAlert =
			persistenceError || (durable ? after.error || preservedAlert : context.storageAlert);
		const aggregate = updateAggregate(
			context,
			after,
			context.reviewedState || context.baseline?.state || after.records[0]?.pending.base || base
		);
		// Stage is driven by the UI's current state. Keep it as the view even if a different tab has
		// additional queued deltas that are not reflected in this tab yet.
		context.viewState = next;
		context.error = persistenceError || after.error || context.storageAlert;
		if (aggregate.conflicts.length) context.conflicts = clone(aggregate.conflicts);
		syncReviewedConflictSeed(aggregate.conflicts);
		emitStatus(context);
	}

	async function runSync(
		prefer?: 'local' | 'remote',
		expectedEtag?: string | null,
		continuationDepth = 0
	): Promise<void> {
		const context = active;
		if (!context || !isActive(context) || context.syncing) return;
		const loaded = loadJournal(context);
		const persistentAlert =
			(loaded.error && loaded.error !== STAGE_QUOTA_ALERT ? loaded.error : '') ||
			(context.storageAlert && context.storageAlert !== STAGE_QUOTA_ALERT
				? context.storageAlert
				: '');
		if (loaded.error) context.storageAlert ||= loaded.error;
		if (!loaded.records.length) {
			context.pending = null;
			context.pendingDurable = false;
			context.blockedByStorage = !!loaded.error;
			context.conflicts = [];
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.error =
				loaded.error || context.storageAlert || (!context.confirmed ? context.loadError : '');
			emitStatus(context);
			return;
		}
		const seed = context.baseline?.state || loaded.records[0].pending.base || createNewUserState();
		context.pending = aggregatePending(
			context,
			loaded.records,
			mergePendingKitchenJournal(loaded.records, seed).state
		);
		context.pendingDurable = loaded.durable;
		context.blockedByStorage = loaded.blocked;
		const captured = clone(loaded.records);
		const pinnedEtag = prefer
			? expectedEtag !== undefined
				? expectedEtag
				: context.reviewedEtag
			: undefined;
		context.syncing = true;
		context.error = '';
		emitStatus(context);
		let shouldContinue = false;
		let saved = false;
		let savedEtag: string | null = null;
		let savedState: AppState | null = null;
		try {
			const raw = options.transport(clone(context.user));
			if (
				raw.identity.userId !== context.identity.userId ||
				raw.identity.householdId !== context.identity.householdId
			) {
				throw Object.assign(
					new Error('The sync connection belongs to a different account or household.'),
					{ status: 409 }
				);
			}
			const identity = { ...raw.identity };
			const guarded: KitchenTransport = {
				identity,
				get: async () => {
					if (!isActive(context))
						throw Object.assign(new Error('Kitchen account changed.'), { status: 409 });
					const result = await raw.get();
					if (!isActive(context))
						throw Object.assign(new Error('Kitchen account changed.'), { status: 409 });
					return result;
				},
				put: async (state, etag) => {
					if (!isActive(context))
						throw Object.assign(new Error('Kitchen account changed.'), { status: 409 });
					return raw.put(state, etag);
				}
			};
			const result = await syncPendingKitchenJournal(captured, guarded, prefer, pinnedEtag);
			if (!isActive(context)) return;
			if (!result.saved) {
				context.conflicts = clone(result.conflicts);
				context.reviewedEtag = result.conflicts.length ? result.etag : null;
				context.reviewedState =
					result.conflicts.length && result.remoteState ? clone(result.remoteState) : null;
				context.pending = aggregatePending(context, captured, result.state);
				if (result.staleEtag) {
					context.error = result.conflicts.length
						? 'Your household updated while you were reviewing changes. Review the latest conflicts and choose again.'
						: 'Your household updated before your choice could be applied. Retry sync to save your changes.';
				} else {
					context.error = 'Resolve the kitchen conflicts before syncing these changes.';
				}
				return;
			}
			context.confirmed = true;
			context.loading = false;
			context.loadError = '';
			saved = true;
			savedEtag = result.etag;
			savedState = clone(result.state);
			// Failure ordering after server acknowledgement:
			// 1. Write the new confirmed baseline first so a crash before journal cleanup never drops
			//    acknowledged edits between journal removal and baseline persistence.
			// 2. Retire acknowledged journal entries (and suppress any key whose removeItem threw or
			//    silently no-opped so sync cannot re-send an acknowledged version in a loop).
			// 3. If step 1 failed due to tight storage quota, retry saveBaseline now that journal space
			//    has been freed; if it still fails, drop any stale confirmed cache so an offline reload
			//    cannot silently revert to an older pre-save baseline.
			let baselineSaveError = '';
			try {
				saveBaseline(context, result.state, result.etag);
			} catch {
				baselineSaveError =
					'The server saved these changes, but the confirmed state could not be saved on this device.';
			}
			let retireError = '';
			forgetAcknowledged(context, captured);
			try {
				clearPendingJournalRecords(options.storage, context.user, captured);
				if (hasUnretiredJournalVersion(options.storage, captured)) {
					context.retiredRecords.push(...clone(captured));
					retireError =
						'The server saved these changes, but acknowledged journal entries could not be retired.';
				}
			} catch {
				context.retiredRecords.push(...clone(captured));
				retireError =
					'The server saved these changes, but acknowledged journal entries could not be retired.';
			}
			if (baselineSaveError) {
				try {
					saveBaseline(context, result.state, result.etag);
					baselineSaveError = '';
				} catch {
					try {
						options.storage.removeItem(confirmedKey(context.identity));
					} catch {
						// Ignore blocked or read-only storage when evicting stale confirmed state.
					}
				}
			}
			let remaining = loadJournal(context);
			const rebaseError = rebaseNewerWriterRecords(
				context,
				captured,
				remaining.records,
				result.state,
				result.etag
			);
			remaining = loadJournal(context);
			const remainingPersistent =
				remaining.error && remaining.error !== STAGE_QUOTA_ALERT ? remaining.error : '';
			const afterSaveError =
				baselineSaveError || retireError || rebaseError || remainingPersistent || persistentAlert;
			context.storageAlert = afterSaveError || remaining.error;
			const merged = updateAggregate(context, remaining, result.state);
			if (remaining.records.length) {
				context.viewState = clone(merged.state);
				context.error = afterSaveError || remaining.error;
				setContextState(context, merged.state);
				const hasNewerRecords = remaining.records.some(
					(record) =>
						!captured.some(
							(done) =>
								done.writerId === record.writerId && sameVersion(done.pending, record.pending)
						)
				);
				if (merged.conflicts.length) {
					shouldContinue = false;
					context.error =
						'Newer offline edits overlap saved changes. Review the conflicts before syncing.';
				} else if (hasNewerRecords && continuationDepth < MAX_SYNC_CONTINUATIONS) {
					shouldContinue = true;
				} else if (hasNewerRecords) {
					shouldContinue = false;
					context.error ||= 'Kitchen changes are updating rapidly. Retry sync to finish saving.';
				}
			} else {
				context.pending = null;
				context.pendingDurable = false;
				context.blockedByStorage = !!remaining.error;
				context.conflicts = [];
				context.viewState = clone(result.state);
				context.error = afterSaveError || remaining.error;
				setContextState(context, result.state);
			}
		} catch (error) {
			if (isActive(context)) {
				context.error = error instanceof Error ? error.message : 'Could not sync offline changes.';
			}
		} finally {
			if (isActive(context)) {
				if (saved) {
					context.reviewedEtag = context.conflicts.length ? savedEtag : null;
					context.reviewedState = context.conflicts.length && savedState ? clone(savedState) : null;
				}
				context.syncing = false;
				emitStatus(context);
				if (shouldContinue && context.pending && !context.conflicts.length) {
					void runSync(undefined, undefined, continuationDepth + 1);
				}
			}
		}
	}

	function sync(prefer?: 'local' | 'remote', expectedEtag?: string | null): Promise<void> {
		return runSync(prefer, expectedEtag, 0);
	}

	function clearContext(): void {
		generation += 1;
		active = null;
		options.onStatus({
			ready: false,
			pending: false,
			syncing: false,
			conflicts: [],
			reviewedEtag: null,
			error: ''
		});
	}

	function snapshot(): PendingKitchen | null {
		if (!active || !isActive(active)) return null;
		const loaded = loadJournal(active);
		if (!loaded.records.length) return null;
		const seed = active.baseline?.state || loaded.records[0].pending.base || createNewUserState();
		const merged = mergePendingKitchenJournal(loaded.records, seed, 'local');
		return aggregatePending(active, loaded.records, merged.state);
	}

	function quarantined(): QuarantinedJournalEntry[] {
		if (!active || !isActive(active)) return [];
		return readQuarantinedJournal(options.storage, active.user);
	}

	function exportBackup(): KitchenBackupPayload | null {
		if (!active || !isActive(active)) return null;
		const snap = snapshot();
		const quarantinedEntries = readQuarantinedJournal(options.storage, active.user);
		if (quarantinedEntries.length) {
			return {
				...(snap ? { pending: snap.local } : {}),
				quarantined: quarantinedEntries
			};
		}
		return snap ? snap.local : null;
	}

	return {
		prepare,
		failLoad,
		initialize,
		restore,
		stage,
		sync,
		snapshot,
		quarantined,
		exportBackup,
		clearContext
	};
}
