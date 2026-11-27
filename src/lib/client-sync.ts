import { createNewUserState } from '#lib/data.ts';
import type { AppState, User } from '#lib/types.ts';
import {
	clearPendingJournalRecords,
	MAX_PENDING_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	readPendingJournal,
	syncPendingKitchenJournal,
	type KitchenTransport,
	type PendingJournalRecord,
	type PendingKitchen,
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
type ConfirmedKitchen = {
	userId: string;
	householdId: string;
	state: AppState;
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
type EventTargetLike = {
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
	visibilityState?: string;
};
type QueuedSyncPass = {
	prefer?: 'local' | 'remote';
	expectedEtag?: string | null;
	promise: Promise<void>;
	resolve: () => void;
};
type ActiveContext = {
	user: User;
	identity: Identity;
	key: string;
	generation: number;
	baseline: ConfirmedKitchen | null;
	confirmed: boolean;
	loading: boolean;
	loadError: string;
	viewState: AppState | null;
	pending: PendingKitchen | null;
	pendingDurable: boolean;
	blockedByStorage: boolean;
	syncing: boolean;
	queuedSync: QueuedSyncPass | null;
	conflicts: SyncConflict[];
	reviewedEtag: string | null;
	reviewedState: AppState | null;
	error: string;
};

export const DEFAULT_SYNC_COALESCE_MS = 250;
const MAX_SYNC_CONTINUATIONS = 3;
const scheduleMicrotask: (callback: () => void) => void =
	typeof queueMicrotask === 'function'
		? queueMicrotask
		: (callback) => {
				void Promise.resolve().then(callback);
			};

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

function isState(value: unknown): value is AppState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<AppState>;
	return (
		Array.isArray(state.pantry) &&
		Array.isArray(state.recipes) &&
		Array.isArray(state.meals) &&
		Array.isArray(state.shopping) &&
		!!state.preferences &&
		typeof state.preferences === 'object'
	);
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
			!isState(value.state) ||
			typeof value.etag !== 'string'
		) {
			return null;
		}
		return value as ConfirmedKitchen;
	} catch {
		return null;
	}
}

/**
 * Coordinates local edits through a per-controller durable journal. Each tab owns one slot, so a
 * concurrent tab can never erase another tab's only offline copy. All writer deltas are reconciled
 * against the latest server snapshot before sync.
 */
export function createKitchenSync(options: {
	storage: StorageLike;
	getUser: () => User | null;
	getState: () => AppState;
	setState: (state: AppState) => void;
	onStatus: (status: SyncStatus) => void;
	transport: (user: User) => KitchenTransport;
}) {
	let active: ActiveContext | null = null;
	let generation = 0;
	const writerId = randomId();
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
		const byWriter = new Map(durable.records.map((record) => [record.writerId, record]));
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
				error ||= 'Some offline changes are only in memory and are not safe to sync yet.';
				byWriter.set(id, cached.record);
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
		if (setUI) context.viewState = clone(localState);
		if (loaded.error) context.error = loaded.error;
		else if (context.confirmed || loaded.records.length) context.error = '';
		else context.error = context.loadError;
		if (setUI) setContextState(context, localState);
		return { state: localState, conflicts: merged.conflicts };
	}

	function saveBaseline(context: ActiveContext, state: AppState, etag: string): void {
		const baseline: ConfirmedKitchen = {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			state: clone(state),
			etag,
			updatedAt: Date.now()
		};
		context.baseline = baseline;
		baselines.set(context.key, baseline);
		options.storage.setItem(confirmedKey(context.identity), JSON.stringify(baseline));
	}

	function activate(user: User): ActiveContext | null {
		const identity = { userId: user.id, householdId: user.householdId };
		if (!isSameIdentity(options.getUser(), identity)) return null;
		const previousQueued = active?.queuedSync;
		if (active) active.queuedSync = null;
		generation += 1;
		const key = identityKey(identity);
		const context: ActiveContext = {
			user: clone(user),
			identity,
			key,
			generation,
			baseline: baselines.get(key) || readConfirmed(options.storage, identity),
			confirmed: false,
			loading: false,
			loadError: '',
			viewState: null,
			pending: null,
			pendingDurable: false,
			blockedByStorage: false,
			syncing: false,
			queuedSync: null,
			conflicts: [],
			reviewedEtag: null,
			reviewedState: null,
			error: ''
		};
		active = context;
		previousQueued?.resolve();
		return context;
	}

	function acknowledge(context: ActiveContext, records: PendingJournalRecord[]): void {
		clearPendingJournalRecords(options.storage, context.user, records);
		forgetAcknowledged(context, records);
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
			try {
				if (enumerableStorage(options.storage)) writePendingJournal(options.storage, pending);
				else writePending(options.storage, pending);
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
				rememberRecord(context, updated, true);
			} catch {
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
		const context = activate(user);
		if (!context) return;
		context.confirmed = true;
		context.loading = false;
		context.loadError = '';
		let baselineError = '';
		try {
			saveBaseline(context, remoteState, etag);
		} catch {
			baselineError = 'The confirmed kitchen could not be saved for offline use.';
		}
		let loaded = loadJournal(context);
		let merged = updateAggregate(context, loaded, remoteState);
		if (
			!baselineError &&
			loaded.records.length &&
			!merged.conflicts.length &&
			equal(merged.state, remoteState)
		) {
			try {
				acknowledge(context, loaded.records);
				loaded = loadJournal(context);
				merged = updateAggregate(context, loaded, remoteState);
			} catch {
				context.error =
					'The server already has these changes, but the saved offline journal could not be cleared.';
			}
		}
		context.viewState = clone(merged.state);
		context.reviewedEtag = merged.conflicts.length ? etag : null;
		context.reviewedState = merged.conflicts.length ? clone(remoteState) : null;
		setContextState(context, merged.state);
		if (baselineError) context.error = baselineError;
		emitStatus(context);
	}

	function restore(user: User): boolean {
		const context = activate(user);
		if (!context) return false;
		const loaded = loadJournal(context);
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
			context.error = loaded.error;
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
		if (!isState(next)) {
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		const loaded = loadJournal(context);
		const own = loaded.records.find((record) => record.writerId === writerId);
		const base = clone(
			own?.pending.base || context.viewState || context.baseline?.state || createNewUserState()
		);
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
		if (own && equal(next, own.pending.local)) {
			const previousError = context.error;
			context.viewState = next;
			const merged = updateAggregate(context, loaded, conflictSeed);
			if (!loaded.error && previousError) context.error = previousError;
			syncReviewedConflictSeed(merged.conflicts);
			emitStatus(context);
			return;
		}
		if (!own && equal(next, context.viewState)) {
			const previousError = context.error;
			const merged = updateAggregate(context, loaded, conflictSeed);
			if (!loaded.error && previousError) context.error = previousError;
			syncReviewedConflictSeed(merged.conflicts);
			emitStatus(context);
			return;
		}
		if (own && equal(next, own.pending.base)) {
			try {
				acknowledge(context, [own]);
				const after = loadJournal(context);
				context.viewState = next;
				const merged = updateAggregate(
					context,
					after,
					context.reviewedState || context.baseline?.state || after.records[0]?.pending.base || next
				);
				syncReviewedConflictSeed(merged.conflicts);
			} catch {
				context.error = 'The reverted offline changes could not be removed from this device.';
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
			local: next,
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
			persistenceError = 'Offline changes could not be saved on this device. Sync is paused.';
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
		if (durable) rememberRecord(context, ownRecord, true);
		else rememberRecord(context, ownRecord, false);
		const after = loadJournal(context);
		const aggregate = updateAggregate(
			context,
			after,
			context.reviewedState || context.baseline?.state || after.records[0]?.pending.base || base
		);
		// Stage is driven by the UI's current state. Keep it as the view even if a different tab has
		// additional queued deltas that are not reflected in this tab yet.
		context.viewState = next;
		if (persistenceError) context.error = persistenceError;
		else if (durable && !after.error) context.error = '';
		if (aggregate.conflicts.length) context.conflicts = clone(aggregate.conflicts);
		syncReviewedConflictSeed(aggregate.conflicts);
		emitStatus(context);
	}

	async function runSync(
		prefer?: 'local' | 'remote',
		expectedEtag?: string | null,
		continuationDepth = 0,
		isQueuedFollowUp = false
	): Promise<void> {
		const context = active;
		if (!context || !isActive(context)) return;
		if (context.syncing) {
			// Queue one follow-up pass whenever sync() arrives during an in-flight pass so a failed
			// or superseded pass is never silently hidden (#77 rule).
			if (!context.queuedSync) {
				let resolveQueued!: () => void;
				const promise = new Promise<void>((resolve) => {
					resolveQueued = resolve;
				});
				context.queuedSync = {
					prefer,
					expectedEtag,
					promise,
					resolve: resolveQueued
				};
			} else if (prefer !== undefined) {
				context.queuedSync.prefer = prefer;
				context.queuedSync.expectedEtag = expectedEtag;
			}
			return context.queuedSync.promise;
		}
		const loaded = loadJournal(context);
		if (!loaded.records.length) {
			const preservedPostSaveError =
				isQueuedFollowUp && context.confirmed && context.error ? context.error : '';
			context.pending = null;
			context.pendingDurable = false;
			context.blockedByStorage = !!loaded.error;
			context.conflicts = [];
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.error =
				loaded.error || (!context.confirmed ? context.loadError : preservedPostSaveError);
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
		if (!loaded.durable || loaded.blocked) {
			context.error ||= 'Offline changes are not safely saved on this device, so sync is paused.';
			emitStatus(context);
			return;
		}
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
			try {
				saveBaseline(context, result.state, result.etag);
			} catch {
				context.error =
					'The server saved these changes, but the confirmed state could not be saved on this device.';
				return;
			}
			let afterSaveError = '';
			try {
				acknowledge(context, captured);
			} catch {
				afterSaveError =
					'The server saved these changes, but acknowledged journal entries could not be retired.';
			}
			let remaining = loadJournal(context);
			afterSaveError ||= rebaseNewerWriterRecords(
				context,
				captured,
				remaining.records,
				result.state,
				result.etag
			);
			remaining = loadJournal(context);
			const merged = updateAggregate(context, remaining, result.state);
			if (remaining.records.length) {
				setContextState(context, merged.state);
				shouldContinue = remaining.durable && !remaining.blocked && merged.conflicts.length === 0;
				if (merged.conflicts.length) {
					context.error =
						'Newer offline edits overlap saved changes. Review the conflicts before syncing.';
				}
			} else {
				context.pending = null;
				context.pendingDurable = false;
				context.blockedByStorage = !!remaining.error;
				context.conflicts = [];
				context.viewState = clone(result.state);
				setContextState(context, result.state);
			}
			if (remaining.error) context.error = remaining.error;
			if (afterSaveError) context.error = afterSaveError;
		} catch (error) {
			if (isActive(context)) {
				context.error = error instanceof Error ? error.message : 'Could not sync offline changes.';
			}
		} finally {
			const queued = context.queuedSync;
			context.queuedSync = null;
			if (!isActive(context)) {
				queued?.resolve();
			} else {
				if (saved) {
					context.reviewedEtag = context.conflicts.length ? savedEtag : null;
					context.reviewedState = context.conflicts.length && savedState ? clone(savedState) : null;
				}
				context.syncing = false;
				emitStatus(context);
				if (queued) {
					void runSync(queued.prefer, queued.expectedEtag, 0, true).finally(() => {
						queued.resolve();
					});
				} else if (shouldContinue && context.pending && context.pendingDurable && !context.error) {
					if (continuationDepth < MAX_SYNC_CONTINUATIONS) {
						void runSync(undefined, undefined, continuationDepth + 1, false);
					} else {
						context.error = 'Kitchen changes are updating rapidly. Retry sync to finish saving.';
						emitStatus(context);
					}
				}
			}
		}
	}

	function sync(prefer?: 'local' | 'remote', expectedEtag?: string | null): Promise<void> {
		return runSync(prefer, expectedEtag, 0, false);
	}

	function clearContext(): void {
		const previousQueued = active?.queuedSync;
		if (active) active.queuedSync = null;
		generation += 1;
		active = null;
		previousQueued?.resolve();
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

	return { prepare, failLoad, initialize, restore, stage, sync, snapshot, clearContext };
}

/**
 * Persists reactive kitchen mutations once per tick via microtask coalescing (or immediately via
 * `persist()`/`flush()`), staging signed-in edits durably into the offline journal and writing
 * guest edits to localStorage once guest persistence is ready while retaining dirty state across
 * pre-auth windows and storage quota failures.
 */
export function createKitchenPersistence(options: {
	storage: StorageLike;
	getState: (context?: { coalesced?: boolean }) => AppState;
	getUser: () => User | null;
	isManagedAuth?: () => boolean;
	isGuestReady?: () => boolean;
	isKitchenLoaded?: () => boolean;
	sync: Pick<ReturnType<typeof createKitchenSync>, 'stage'>;
	onGuestQuotaError?: () => void;
	onAfterPersist?: () => void;
	onCancelScheduled?: () => void;
}) {
	let guestDirty = false;
	let scheduledPersist = false;
	let persistEpoch = 0;

	function guestReady(): boolean {
		return options.isGuestReady ? options.isGuestReady() : true;
	}

	function writeGuest(coalesced = false): boolean {
		if (!guestDirty || options.isManagedAuth?.()) return false;
		try {
			options.storage.setItem(
				'flavorithm-guest-kitchen',
				JSON.stringify(options.getState({ coalesced }))
			);
			guestDirty = false;
		} catch {
			options.onGuestQuotaError?.();
			return false;
		}
		options.onAfterPersist?.();
		return true;
	}

	function runPersist(coalesced: boolean): boolean {
		const managed = Boolean(options.isManagedAuth?.());
		const currentUser = options.getUser();
		if (managed && (!currentUser || !(options.isKitchenLoaded?.() ?? true))) {
			options.onCancelScheduled?.();
			return false;
		}
		if (currentUser) {
			guestDirty = false;
			options.sync.stage(options.getState({ coalesced }));
			options.onAfterPersist?.();
			return true;
		}
		if (!managed) {
			guestDirty = true;
			if (guestReady()) {
				return writeGuest(coalesced);
			}
		}
		return false;
	}

	function schedule(): void {
		if (scheduledPersist) return;
		scheduledPersist = true;
		const epoch = ++persistEpoch;
		scheduleMicrotask(() => {
			if (!scheduledPersist || epoch !== persistEpoch) return;
			scheduledPersist = false;
			runPersist(true);
		});
	}

	function persist(): boolean {
		scheduledPersist = false;
		persistEpoch += 1;
		return runPersist(false);
	}

	function flush(flushOptions?: { allowBeforeGuestReady?: boolean }): boolean {
		let persistedScheduled = false;
		if (scheduledPersist) {
			scheduledPersist = false;
			persistEpoch += 1;
			persistedScheduled = runPersist(true);
		}
		if (options.getUser()) {
			guestDirty = false;
			return persistedScheduled;
		}
		if (
			guestDirty &&
			!options.isManagedAuth?.() &&
			(guestReady() || flushOptions?.allowBeforeGuestReady)
		) {
			return writeGuest(false) || persistedScheduled;
		}
		return persistedScheduled;
	}

	function onGuestReady(): boolean {
		return flush();
	}

	function cancelScheduled(): void {
		scheduledPersist = false;
		persistEpoch += 1;
		options.onCancelScheduled?.();
	}

	function cancel(): void {
		cancelScheduled();
		guestDirty = false;
	}

	function hasPending(): boolean {
		return guestDirty || scheduledPersist;
	}

	function bindLifecycle(win?: EventTargetLike | null, doc?: EventTargetLike | null): () => void {
		const onVisibilityChange = () => {
			if (!doc?.visibilityState || doc.visibilityState === 'hidden') {
				flush();
			}
		};
		const onLifecycleFlush = () => {
			flush();
		};
		doc?.addEventListener('visibilitychange', onVisibilityChange);
		win?.addEventListener('visibilitychange', onVisibilityChange);
		win?.addEventListener('pagehide', onLifecycleFlush);
		win?.addEventListener('beforeunload', onLifecycleFlush);
		return () => {
			doc?.removeEventListener('visibilitychange', onVisibilityChange);
			win?.removeEventListener('visibilitychange', onVisibilityChange);
			win?.removeEventListener('pagehide', onLifecycleFlush);
			win?.removeEventListener('beforeunload', onLifecycleFlush);
		};
	}

	return {
		schedule,
		persist,
		flush,
		onGuestReady,
		cancelScheduled,
		cancel,
		hasPending,
		bindLifecycle
	};
}
