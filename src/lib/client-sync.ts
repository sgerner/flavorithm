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
type SyncStatus = { pending: boolean; syncing: boolean; conflicts: SyncConflict[]; error: string };
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
type ActiveContext = {
	user: User;
	identity: Identity;
	key: string;
	generation: number;
	baseline: ConfirmedKitchen | null;
	viewState: AppState | null;
	pending: PendingKitchen | null;
	pendingDurable: boolean;
	blockedByStorage: boolean;
	syncing: boolean;
	conflicts: SyncConflict[];
	error: string;
};

const confirmedKey = (identity: Identity) =>
	`flavorithm-confirmed:v1:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.householdId)}`;
const identityKey = (identity: Identity) => `${identity.userId}\u0000${identity.householdId}`;
const clone = <T>(value: T): T => structuredClone(value);
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
		pending: !!context.pending,
		syncing: context.syncing,
		conflicts: clone(context.conflicts),
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
			base: clone(context.baseline?.state || first.base),
			local: clone(local),
			etag: context.baseline?.etag || first.etag,
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
		context.pending = aggregatePending(context, loaded.records, merged.state);
		context.pendingDurable = loaded.durable;
		context.blockedByStorage = loaded.blocked;
		context.conflicts = clone(merged.conflicts);
		if (setUI) context.viewState = clone(merged.state);
		if (!loaded.error) context.error = '';
		else context.error = loaded.error;
		if (setUI) setContextState(context, merged.state);
		return merged;
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
		generation += 1;
		const key = identityKey(identity);
		const context: ActiveContext = {
			user: clone(user),
			identity,
			key,
			generation,
			baseline: baselines.get(key) || readConfirmed(options.storage, identity),
			viewState: null,
			pending: null,
			pendingDurable: false,
			blockedByStorage: false,
			syncing: false,
			conflicts: [],
			error: ''
		};
		active = context;
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

	function initialize(user: User, remoteState: AppState, etag: string): void {
		const context = activate(user);
		if (!context) return;
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
		setContextState(context, merged.state);
		if (baselineError) context.error = baselineError;
		emitStatus(context);
	}

	function restore(user: User): boolean {
		const context = activate(user);
		if (!context) return false;
		const loaded = loadJournal(context);
		if (!context.baseline && loaded.records.length) {
			const first = loaded.records[0].pending;
			context.baseline = {
				userId: context.identity.userId,
				householdId: context.identity.householdId,
				state: clone(first.base),
				etag: first.etag || '',
				updatedAt: first.createdAt ?? first.updatedAt
			};
		}
		if (loaded.records.length && context.baseline) {
			const merged = updateAggregate(context, loaded, context.baseline.state, undefined, true);
			emitStatus(context);
			return true;
		}
		if (context.baseline) {
			context.viewState = clone(context.baseline.state);
			setContextState(context, context.baseline.state);
			emitStatus(context);
			return true;
		}
		context.error = loaded.error;
		emitStatus(context);
		return false;
	}

	function stage(state: AppState): void {
		const context = active;
		if (!context || !isActive(context)) return;
		context.error = '';
		const next = clone(state);
		if (!isState(next)) {
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		const loaded = loadJournal(context);
		const own = loaded.records.find((record) => record.writerId === writerId);
		const base = own?.pending.base || context.viewState || context.baseline?.state;
		if (!base) {
			context.error = 'The kitchen has not loaded, so offline changes cannot be saved yet.';
			emitStatus(context);
			return;
		}
		if (own && equal(next, own.pending.local)) {
			context.viewState = next;
			updateAggregate(context, loaded, context.baseline?.state || base);
			emitStatus(context);
			return;
		}
		if (!own && equal(next, context.viewState)) {
			updateAggregate(context, loaded, context.baseline?.state || base);
			emitStatus(context);
			return;
		}
		if (own && equal(next, own.pending.base)) {
			try {
				acknowledge(context, [own]);
				const after = loadJournal(context);
				context.viewState = next;
				updateAggregate(context, after, context.baseline?.state || next);
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
			base: clone(own?.pending.base || context.viewState || context.baseline!.state),
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
		const aggregate = updateAggregate(context, after, context.baseline?.state || base);
		// Stage is driven by the UI's current state. Keep it as the view even if a different tab has
		// additional queued deltas that are not reflected in this tab yet.
		context.viewState = next;
		if (persistenceError) context.error = persistenceError;
		else if (durable && !after.error) context.error = '';
		if (aggregate.conflicts.length) context.conflicts = clone(aggregate.conflicts);
		emitStatus(context);
	}

	async function sync(prefer?: 'local' | 'remote'): Promise<void> {
		const context = active;
		if (!context || !isActive(context) || context.syncing) return;
		const loaded = loadJournal(context);
		if (!loaded.records.length) {
			context.pending = null;
			context.pendingDurable = false;
			context.blockedByStorage = !!loaded.error;
			context.error = loaded.error;
			emitStatus(context);
			return;
		}
		context.pending = aggregatePending(
			context,
			loaded.records,
			mergePendingKitchenJournal(
				loaded.records,
				context.baseline?.state || loaded.records[0].pending.base
			).state
		);
		context.pendingDurable = loaded.durable;
		context.blockedByStorage = loaded.blocked;
		if (!loaded.durable || loaded.blocked) {
			context.error ||= 'Offline changes are not safely saved on this device, so sync is paused.';
			emitStatus(context);
			return;
		}
		const captured = clone(loaded.records);
		context.syncing = true;
		context.error = '';
		emitStatus(context);
		let shouldContinue = false;
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
			const result = await syncPendingKitchenJournal(captured, guarded, prefer);
			if (!isActive(context)) return;
			if (!result.saved) {
				context.conflicts = clone(result.conflicts);
				context.pending = aggregatePending(context, captured, result.state);
				context.error = 'Resolve the kitchen conflicts before syncing these changes.';
				return;
			}
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
			if (isActive(context)) {
				context.syncing = false;
				emitStatus(context);
				if (shouldContinue && context.pending && context.pendingDurable && !context.error) {
					void sync(prefer);
				}
			}
		}
	}

	function clearContext(): void {
		generation += 1;
		active = null;
		options.onStatus({ pending: false, syncing: false, conflicts: [], error: '' });
	}

	function snapshot(): PendingKitchen | null {
		if (!active || !isActive(active)) return null;
		const loaded = loadJournal(active);
		if (!loaded.records.length) return null;
		const seed = active.baseline?.state || loaded.records[0].pending.base;
		const merged = mergePendingKitchenJournal(loaded.records, seed);
		return aggregatePending(active, loaded.records, merged.state);
	}

	return { initialize, restore, stage, sync, snapshot, clearContext };
}
