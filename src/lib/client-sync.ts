import { createNewUserState } from '#lib/data.ts';
import type { AppState, User } from '#lib/types.ts';
import {
	causallyIncludesDelta,
	clearPendingJournalRecords,
	composePendingKitchenJournal,
	filterUnfoldedJournalRecords,
	type FoldedJournalRef,
	jsonEqual,
	MAX_PENDING_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	orderPendingJournalRecords,
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
type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type StageOptions = {
	/** True only when echoing a state just pushed by `setState` from a reactive UI effect. */
	echo?: boolean;
};
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
type WriterLease = {
	ownerId: string;
	updatedAt: number;
	expiresAt: number;
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
	conflicts: SyncConflict[];
	reviewedEtag: string | null;
	reviewedState: AppState | null;
	error: string;
};

const WRITER_LEASE_PREFIX = 'flavorithm-writer-lease:v1:';
const writerLeaseKey = (id: string) => `${WRITER_LEASE_PREFIX}${encodeURIComponent(id)}`;
export const DEFAULT_WRITER_LEASE_TTL_MS = 120_000;

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
const equal = jsonEqual;
const enumerableStorage = (
	storage: StorageLike
): storage is StorageLike & Pick<Storage, 'key' | 'length'> =>
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

function firstActivePending(records: PendingJournalRecord[]): PendingKitchen | undefined {
	const unfolded = filterUnfoldedJournalRecords(records);
	return unfolded.length ? orderPendingJournalRecords(unfolded)[0].pending : undefined;
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
	sessionStorage?: SessionStorageLike | null;
	writerId?: string;
	now?: () => number;
	leaseTtlMs?: number;
	getUser: () => User | null;
	getState: () => AppState;
	setState: (state: AppState) => void;
	onStatus: (status: SyncStatus) => void;
	transport: (user: User) => KitchenTransport;
}) {
	let active: ActiveContext | null = null;
	let generation = 0;
	const nowOf = () => options.now?.() ?? Date.now();
	const leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? DEFAULT_WRITER_LEASE_TTL_MS);
	const ownerId = randomId();
	const memoryRecords = new Map<string, Map<string, MemoryRecord>>();
	const baselines = new Map<string, ConfirmedKitchen>();
	const unpersistedBaselines = new Set<string>();

	function readLease(id: string, now = nowOf()): WriterLease | null {
		try {
			const raw = options.storage.getItem(writerLeaseKey(id));
			if (!raw) return null;
			const parsed = JSON.parse(raw) as Partial<WriterLease> | null;
			if (
				!parsed ||
				typeof parsed !== 'object' ||
				typeof parsed.ownerId !== 'string' ||
				!Number.isFinite(parsed.updatedAt) ||
				!Number.isFinite(parsed.expiresAt) ||
				(parsed.expiresAt as number) <= now
			) {
				options.storage.removeItem(writerLeaseKey(id));
				return null;
			}
			return parsed as WriterLease;
		} catch {
			return null;
		}
	}

	function purgeExpiredLeases(now = nowOf()): void {
		if (!enumerableStorage(options.storage)) return;
		try {
			const expired: string[] = [];
			for (let index = 0; index < options.storage.length; index += 1) {
				const storageKey = options.storage.key(index);
				if (!storageKey?.startsWith(WRITER_LEASE_PREFIX)) continue;
				try {
					const parsed = JSON.parse(
						options.storage.getItem(storageKey) || 'null'
					) as Partial<WriterLease> | null;
					if (
						!parsed ||
						typeof parsed.ownerId !== 'string' ||
						!Number.isFinite(parsed.expiresAt) ||
						(parsed.expiresAt as number) <= now
					) {
						expired.push(storageKey);
					}
				} catch {
					expired.push(storageKey);
				}
			}
			for (const storageKey of expired) {
				options.storage.removeItem(storageKey);
			}
		} catch {}
	}

	function hasActiveForeignLease(id: string, now = nowOf()): boolean {
		const lease = readLease(id, now);
		return !!lease && lease.ownerId !== ownerId;
	}

	purgeExpiredLeases();
	// Each browsing context owns a unique writerId so a duplicated tab can never adopt a frozen live
	// tab's slot even after its lease TTL expires.
	let writerId =
		options.writerId && !hasActiveForeignLease(options.writerId) ? options.writerId : randomId();
	let leaseHeld = false;

	function acquireOrRefreshLease(): void {
		const now = nowOf();
		purgeExpiredLeases(now);
		if (hasActiveForeignLease(writerId, now)) {
			writerId = randomId();
		}
		try {
			const lease: WriterLease = {
				ownerId,
				updatedAt: now,
				expiresAt: now + leaseTtlMs
			};
			options.storage.setItem(writerLeaseKey(writerId), JSON.stringify(lease));
			leaseHeld = true;
		} catch {}
	}

	function refreshLease(): void {
		if (!leaseHeld && !active) return;
		acquireOrRefreshLease();
	}

	function releaseLease(): void {
		leaseHeld = false;
		try {
			const raw = options.storage.getItem(writerLeaseKey(writerId));
			if (!raw) return;
			const parsed = JSON.parse(raw) as Partial<WriterLease> | null;
			if (!parsed || parsed.ownerId === ownerId) {
				options.storage.removeItem(writerLeaseKey(writerId));
			}
		} catch {}
	}

	acquireOrRefreshLease();

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

	function resolveLatestBaseline(
		identity: Identity,
		key: string,
		current?: ConfirmedKitchen | null
	): ConfirmedKitchen | null {
		const stored = readConfirmed(options.storage, identity);
		const cached = current ?? baselines.get(key) ?? null;
		if (stored) {
			if (!cached || !unpersistedBaselines.has(key) || stored.updatedAt > cached.updatedAt) {
				baselines.set(key, stored);
				unpersistedBaselines.delete(key);
				return stored;
			}
		}
		return cached;
	}

	function refreshBaseline(context: ActiveContext): ConfirmedKitchen | null {
		const latest = resolveLatestBaseline(context.identity, context.key, context.baseline);
		context.baseline = latest;
		return latest;
	}

	function aggregatePending(
		context: ActiveContext,
		records: PendingJournalRecord[],
		local: AppState
	): PendingKitchen | null {
		if (!records.length) return null;
		const baseline = refreshBaseline(context);
		const first = firstActivePending(records) ?? orderPendingJournalRecords(records)[0].pending;
		return {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			base: clone(baseline?.state || first.base || createNewUserState()),
			local: clone(local),
			etag: baseline?.etag ?? first.etag ?? null,
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
			updatedAt: nowOf()
		};
		context.baseline = baseline;
		baselines.set(context.key, baseline);
		try {
			options.storage.setItem(confirmedKey(context.identity), JSON.stringify(baseline));
			unpersistedBaselines.delete(context.key);
		} catch (error) {
			unpersistedBaselines.add(context.key);
			throw error;
		}
	}

	function activate(user: User): ActiveContext | null {
		const identity = { userId: user.id, householdId: user.householdId };
		if (!isSameIdentity(options.getUser(), identity)) return null;
		acquireOrRefreshLease();
		generation += 1;
		const key = identityKey(identity);
		const context: ActiveContext = {
			user: clone(user),
			identity,
			key,
			generation,
			baseline: resolveLatestBaseline(identity, key),
			confirmed: false,
			loading: false,
			loadError: '',
			viewState: null,
			pending: null,
			pendingDurable: false,
			blockedByStorage: false,
			syncing: false,
			conflicts: [],
			reviewedEtag: null,
			reviewedState: null,
			error: ''
		};
		active = context;
		return context;
	}

	function acknowledge(context: ActiveContext, records: PendingJournalRecord[]): void {
		try {
			clearPendingJournalRecords(options.storage, context.user, records);
			forgetAcknowledged(context, records);
		} catch (error) {
			const removed = records.filter((record) =>
				record.keys.every((captured) => {
					try {
						const raw = options.storage.getItem(captured.key);
						if (raw === null) return true;
						const current = JSON.parse(raw) as PendingKitchen | null;
						return !current || !sameVersion(current, captured.pending);
					} catch {
						return false;
					}
				})
			);
			if (removed.length) forgetAcknowledged(context, removed);
			throw error;
		}
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
				updatedAt: nowOf(),
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
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		const firstPending = firstActivePending(loaded.records);
		const seed = baseline?.state || firstPending?.base || createNewUserState();
		if (loaded.records.length) {
			const merged = updateAggregate(context, loaded, seed, undefined, true);
			context.reviewedEtag = merged.conflicts.length ? (baseline?.etag ?? null) : null;
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
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		if (loaded.records.length) {
			const first = firstActivePending(loaded.records) ?? loaded.records[0].pending;
			const seed = baseline?.state || first.base || createNewUserState();
			const seedEtag = baseline?.etag ?? first.etag ?? null;
			const merged = updateAggregate(context, loaded, seed, undefined, true);
			context.reviewedEtag = merged.conflicts.length ? seedEtag : null;
			context.reviewedState = merged.conflicts.length ? clone(seed) : null;
			emitStatus(context);
			return true;
		}
		if (baseline) {
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.viewState = clone(baseline.state);
			context.error = loaded.error;
			context.blockedByStorage = loaded.blocked;
			setContextState(context, baseline.state);
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

	function alignRevertedBaselinePantryQuantities(
		sourceBase: AppState,
		priorLocal: AppState | null | undefined,
		nextState: AppState,
		confirmedState: AppState
	): AppState {
		if (!priorLocal) return sourceBase;
		const priorById = new Map(priorLocal.pantry.map((item) => [item.id, item]));
		const nextById = new Map(nextState.pantry.map((item) => [item.id, item]));
		const confirmedById = new Map(confirmedState.pantry.map((item) => [item.id, item]));
		let adjusted: AppState | null = null;
		for (let index = 0; index < sourceBase.pantry.length; index += 1) {
			const baseItem = sourceBase.pantry[index];
			const priorItem = priorById.get(baseItem.id);
			const nextItem = nextById.get(baseItem.id);
			const confirmedItem = confirmedById.get(baseItem.id);
			if (
				priorItem &&
				nextItem &&
				confirmedItem &&
				!equal(priorItem.quantity, confirmedItem.quantity) &&
				equal(nextItem.quantity, confirmedItem.quantity) &&
				!equal(baseItem.quantity, confirmedItem.quantity)
			) {
				adjusted ??= clone(sourceBase);
				adjusted.pantry[index].quantity = confirmedItem.quantity;
			}
		}
		return adjusted ?? sourceBase;
	}

	function buildFoldedRefs(
		loadedRecords: PendingJournalRecord[],
		ownBefore: PendingJournalRecord | undefined,
		newlyFolded: PendingJournalRecord[]
	): FoldedJournalRef[] | undefined {
		const refs: FoldedJournalRef[] = [];
		const addRef = (ref: FoldedJournalRef) => {
			if (ref.writerId === writerId) return;
			const exists = refs.some((item) =>
				item.writeId || ref.writeId
					? item.writerId === ref.writerId && item.writeId === ref.writeId
					: item.writerId === ref.writerId &&
						item.updatedAt === ref.updatedAt &&
						item.createdAt === ref.createdAt
			);
			if (!exists && refs.length < MAX_PENDING_JOURNAL_ENTRIES) {
				refs.push(ref);
			}
		};
		for (const record of newlyFolded) {
			addRef({
				writerId: record.writerId,
				...(record.pending.writeId ? { writeId: record.pending.writeId } : {}),
				updatedAt: record.pending.updatedAt,
				...(record.pending.createdAt !== undefined ? { createdAt: record.pending.createdAt } : {})
			});
			for (const inherited of record.pending.foldedFrom ?? []) {
				if (loadedRecords.some((candidate) => candidate.writerId === inherited.writerId)) {
					addRef(inherited);
				}
			}
		}
		for (const inherited of ownBefore?.pending.foldedFrom ?? []) {
			if (loadedRecords.some((candidate) => candidate.writerId === inherited.writerId)) {
				addRef(inherited);
			}
		}
		return refs.length ? refs : undefined;
	}

	function findCompactionPlan(
		context: ActiveContext,
		loaded: LoadedJournal,
		unfoldedRecords: PendingJournalRecord[],
		alreadyFoldedPeers: PendingJournalRecord[],
		effectiveOwn: PendingJournalRecord | undefined,
		viewBase: AppState,
		next: AppState
	): {
		foldableAncestors: PendingJournalRecord[];
		alreadyFoldedPeers: PendingJournalRecord[];
		base: AppState;
		etag: string | null;
		anchoredToBaseline: boolean;
	} {
		const now = nowOf();
		const baseline = refreshBaseline(context);
		const priorLocal = effectiveOwn?.pending.local ?? context.viewState;
		const rebasedOwnAnchor = (() => {
			if (!effectiveOwn) return null;
			if (baseline && effectiveOwn.pending.etag !== baseline.etag) {
				const rebased = mergeKitchenStates(
					effectiveOwn.pending.base,
					effectiveOwn.pending.local,
					baseline.state
				);
				if (!rebased.conflicts.length && equal(rebased.state, effectiveOwn.pending.local)) {
					return { base: clone(baseline.state), etag: baseline.etag };
				}
			}
			return { base: effectiveOwn.pending.base, etag: effectiveOwn.pending.etag };
		})();
		const rawDefaultBase = rebasedOwnAnchor?.base || viewBase;
		const defaultBaseSource =
			context.confirmed && baseline
				? alignRevertedBaselinePantryQuantities(rawDefaultBase, priorLocal, next, baseline.state)
				: rawDefaultBase;
		const defaultEtag = rebasedOwnAnchor ? rebasedOwnAnchor.etag : baseline?.etag || null;
		if (context.syncing) {
			return {
				foldableAncestors: [],
				alreadyFoldedPeers: [],
				base: clone(defaultBaseSource),
				etag: defaultEtag,
				anchoredToBaseline: !!baseline && equal(defaultBaseSource, baseline.state)
			};
		}

		const memory = writerMemory(context);
		const peers = unfoldedRecords.filter((record) => record.writerId !== writerId);
		const ancestorPeers = peers.filter(
			(record) =>
				equal(record.pending.base, record.pending.local) ||
				causallyIncludesDelta(record.pending.base, record.pending.local, viewBase)
		);
		const hasLeasedAncestor = ancestorPeers.some((record) =>
			hasActiveForeignLease(record.writerId, now)
		);
		if (hasLeasedAncestor) {
			return {
				foldableAncestors: [],
				alreadyFoldedPeers,
				base: clone(defaultBaseSource),
				etag: defaultEtag,
				anchoredToBaseline: false
			};
		}

		let candidates = ancestorPeers.filter(
			(record) =>
				memory.get(record.writerId)?.durable !== false &&
				!hasActiveForeignLease(record.writerId, now)
		);
		let changed = true;
		while (changed && candidates.length) {
			changed = false;
			const candidateIds = new Set(candidates.map((record) => record.writerId));
			const remainingPeers = peers.filter((record) => !candidateIds.has(record.writerId));
			candidates = candidates.filter((candidate) => {
				for (const other of remainingPeers) {
					if (
						!equal(candidate.pending.base, candidate.pending.local) &&
						causallyIncludesDelta(
							candidate.pending.base,
							candidate.pending.local,
							other.pending.base
						)
					) {
						changed = true;
						return false;
					}
					const pair = composePendingKitchenJournal([candidate, other]);
					if (pair && pair.conflicts.length > 0) {
						changed = true;
						return false;
					}
				}
				return true;
			});
		}

		const syntheticStep: PendingJournalRecord = {
			writerId,
			pending: {
				userId: context.identity.userId,
				householdId: context.identity.householdId,
				base: viewBase,
				local: next,
				etag: defaultEtag,
				createdAt: now,
				updatedAt: now,
				writerId
			},
			keys: []
		};

		const preservesPeersOnBaseline = (
			remainingPeers: PendingJournalRecord[],
			sourceStepBase: AppState
		): boolean => {
			if (!baseline) return false;
			if (!remainingPeers.length || equal(sourceStepBase, baseline.state)) return true;
			const originalStep: PendingJournalRecord = {
				...syntheticStep,
				pending: { ...syntheticStep.pending, base: sourceStepBase, local: next }
			};
			const anchoredStep: PendingJournalRecord = {
				...syntheticStep,
				pending: {
					...syntheticStep.pending,
					base: baseline.state,
					local: next,
					etag: baseline.etag
				}
			};
			const withOriginal = composePendingKitchenJournal([...remainingPeers, originalStep]);
			const withAnchored = composePendingKitchenJournal([...remainingPeers, anchoredStep]);
			return Boolean(
				withOriginal &&
				withAnchored &&
				!withAnchored.conflicts.length &&
				equal(withOriginal.local, withAnchored.local)
			);
		};

		if (candidates.length) {
			const candidateIds = new Set(candidates.map((record) => record.writerId));
			const remainingPeers = peers.filter((record) => !candidateIds.has(record.writerId));
			const composed = composePendingKitchenJournal([...candidates, syntheticStep]);
			if (!composed || composed.conflicts.length > 0) {
				return {
					foldableAncestors: [],
					alreadyFoldedPeers,
					base: clone(defaultBaseSource),
					etag: defaultEtag,
					anchoredToBaseline: !!baseline && equal(defaultBaseSource, baseline.state)
				};
			}
			if (baseline) {
				const alignedComposedBase = context.confirmed
					? alignRevertedBaselinePantryQuantities(composed.base, priorLocal, next, baseline.state)
					: composed.base;
				const onBaseline = mergeKitchenStates(alignedComposedBase, composed.local, baseline.state);
				if (
					!onBaseline.conflicts.length &&
					equal(onBaseline.state, next) &&
					preservesPeersOnBaseline(remainingPeers, alignedComposedBase)
				) {
					return {
						foldableAncestors: candidates,
						alreadyFoldedPeers,
						base: clone(baseline.state),
						etag: baseline.etag,
						anchoredToBaseline: true
					};
				}
			}
			if (equal(composed.local, next)) {
				const firstOrdered = composed.ordered[0]?.pending;
				return {
					foldableAncestors: candidates,
					alreadyFoldedPeers,
					base: composed.base,
					etag: firstOrdered?.etag ?? defaultEtag,
					anchoredToBaseline: !!baseline && equal(composed.base, baseline.state)
				};
			}
			return {
				foldableAncestors: [],
				alreadyFoldedPeers,
				base: clone(defaultBaseSource),
				etag: defaultEtag,
				anchoredToBaseline: !!baseline && equal(defaultBaseSource, baseline.state)
			};
		}

		if (baseline) {
			if (equal(defaultBaseSource, baseline.state)) {
				return {
					foldableAncestors: [],
					alreadyFoldedPeers,
					base: clone(baseline.state),
					etag: baseline.etag,
					anchoredToBaseline: true
				};
			}
			const onBaseline = mergeKitchenStates(defaultBaseSource, next, baseline.state);
			if (
				!onBaseline.conflicts.length &&
				equal(onBaseline.state, next) &&
				preservesPeersOnBaseline(peers, defaultBaseSource)
			) {
				return {
					foldableAncestors: [],
					alreadyFoldedPeers,
					base: clone(baseline.state),
					etag: baseline.etag,
					anchoredToBaseline: true
				};
			}
		}
		return {
			foldableAncestors: [],
			alreadyFoldedPeers,
			base: clone(defaultBaseSource),
			etag: defaultEtag,
			anchoredToBaseline: !!baseline && equal(defaultBaseSource, baseline.state)
		};
	}

	function stage(state: AppState, stageOptions?: StageOptions): void {
		const context = active;
		if (!context || !isActive(context)) return;
		acquireOrRefreshLease();
		const next = clone(state);
		if (!isState(next)) {
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		const unfoldedRecords = filterUnfoldedJournalRecords(loaded.records);
		const unfoldedSet = new Set(unfoldedRecords);
		const alreadyFoldedPeers = loaded.records.filter(
			(record) => record.writerId !== writerId && !unfoldedSet.has(record)
		);
		const own = loaded.records.find((record) => record.writerId === writerId);
		const effectiveOwn = own && unfoldedSet.has(own) ? own : undefined;
		const firstPending = firstActivePending(loaded.records);
		const base = clone(
			effectiveOwn?.pending.base || context.viewState || baseline?.state || createNewUserState()
		);
		const conflictSeed = context.reviewedState || baseline?.state || firstPending?.base || base;
		const conflictSeedEtag = baseline?.etag ?? firstPending?.etag ?? null;
		const syncReviewedConflictSeed = (conflicts: SyncConflict[]) => {
			if (!conflicts.length) {
				context.reviewedEtag = null;
				context.reviewedState = null;
			} else if (context.reviewedEtag === null) {
				context.reviewedEtag = conflictSeedEtag;
				context.reviewedState = clone(conflictSeed);
			}
		};
		const isReactiveEcho = Boolean(stageOptions?.echo && equal(next, context.viewState));
		const isUnchangedState =
			(!effectiveOwn && equal(next, context.viewState)) ||
			Boolean(effectiveOwn && equal(next, effectiveOwn.pending.local));
		if (isReactiveEcho || isUnchangedState) {
			const previousError = context.error;
			if (!isReactiveEcho && effectiveOwn) context.viewState = next;
			const merged = updateAggregate(context, loaded, conflictSeed);
			if (!loaded.error && previousError) context.error = previousError;
			syncReviewedConflictSeed(merged.conflicts);
			emitStatus(context);
			return;
		}

		const plan = findCompactionPlan(
			context,
			loaded,
			unfoldedRecords,
			alreadyFoldedPeers,
			effectiveOwn,
			base,
			next
		);
		const latestBaseline = context.baseline;
		const matchesBaseline =
			!context.syncing &&
			((plan.anchoredToBaseline && !!latestBaseline && equal(next, latestBaseline.state)) ||
				equal(next, plan.base));
		if (matchesBaseline) {
			const toRetire = [
				...(own ? [own] : []),
				...plan.foldableAncestors,
				...plan.alreadyFoldedPeers
			];
			try {
				if (toRetire.length) acknowledge(context, toRetire);
				const after = loadJournal(context);
				const afterFirst = firstActivePending(after.records);
				context.viewState = next;
				const merged = updateAggregate(
					context,
					after,
					context.reviewedState || latestBaseline?.state || afterFirst?.base || next
				);
				context.viewState = next;
				syncReviewedConflictSeed(merged.conflicts);
			} catch {
				context.error = 'The reverted offline changes could not be removed from this device.';
			}
			emitStatus(context);
			return;
		}

		const projectedEntries =
			loaded.records.length -
			plan.foldableAncestors.length -
			plan.alreadyFoldedPeers.length +
			(own ? 0 : 1);
		if (!own && projectedEntries > MAX_PENDING_JOURNAL_ENTRIES) {
			context.blockedByStorage = true;
			context.error = `This device has reached its ${MAX_PENDING_JOURNAL_ENTRIES}-writer offline journal limit. Reconnect and sync before making more offline edits.`;
			emitStatus(context);
			return;
		}

		const now = nowOf();
		const ancestorsToRetire = [...plan.foldableAncestors, ...plan.alreadyFoldedPeers];
		const foldedFrom = buildFoldedRefs(loaded.records, own, ancestorsToRetire);
		const pending: PendingKitchen = {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			base: plan.base,
			local: next,
			etag: plan.etag,
			createdAt: effectiveOwn?.pending.createdAt ?? now,
			updatedAt: now,
			writerId,
			writeId: randomId(),
			...(foldedFrom ? { foldedFrom } : {})
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
		if (durable) {
			rememberRecord(context, ownRecord, true);
			if (ancestorsToRetire.length) {
				try {
					acknowledge(context, ancestorsToRetire);
				} catch {
					persistenceError ||=
						'Compacted offline journal entries could not be retired on this device.';
				}
			}
		} else {
			rememberRecord(context, ownRecord, false);
		}
		const after = loadJournal(context);
		const afterFirst = firstActivePending(after.records);
		const aggregate = updateAggregate(
			context,
			after,
			context.reviewedState || latestBaseline?.state || afterFirst?.base || base
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

	async function sync(prefer?: 'local' | 'remote', expectedEtag?: string | null): Promise<void> {
		const context = active;
		if (!context || !isActive(context) || context.syncing) return;
		acquireOrRefreshLease();
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		if (!loaded.records.length) {
			context.pending = null;
			context.pendingDurable = false;
			context.blockedByStorage = !!loaded.error;
			context.conflicts = [];
			context.reviewedEtag = null;
			context.reviewedState = null;
			context.error = loaded.error || (!context.confirmed ? context.loadError : '');
			emitStatus(context);
			return;
		}
		const firstPending = firstActivePending(loaded.records) ?? loaded.records[0].pending;
		const seed = baseline?.state || firstPending.base || createNewUserState();
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
			if (isActive(context)) {
				if (saved) {
					context.reviewedEtag = context.conflicts.length ? savedEtag : null;
					context.reviewedState = context.conflicts.length && savedState ? clone(savedState) : null;
				}
				context.syncing = false;
				emitStatus(context);
				if (shouldContinue && context.pending && context.pendingDurable && !context.error) {
					void sync();
				}
			}
		}
	}

	function clearContext(): void {
		generation += 1;
		active = null;
		releaseLease();
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
		const baseline = refreshBaseline(active);
		const loaded = loadJournal(active);
		if (!loaded.records.length) return null;
		const firstPending = firstActivePending(loaded.records) ?? loaded.records[0].pending;
		const seed = baseline?.state || firstPending.base || createNewUserState();
		const merged = mergePendingKitchenJournal(loaded.records, seed, 'local');
		return aggregatePending(active, loaded.records, merged.state);
	}

	return {
		prepare,
		failLoad,
		initialize,
		restore,
		stage,
		sync,
		snapshot,
		clearContext,
		refreshLease,
		releaseLease
	};
}
