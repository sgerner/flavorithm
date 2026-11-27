import { createNewUserState } from '#lib/data.ts';
import { sanitizeKitchenState } from '#lib/guest-storage.ts';
import type { AppState, User } from '#lib/types.ts';
import {
	causallyIncludesDelta,
	clearPendingJournalRecords,
	composePendingKitchenJournal,
	filterUnfoldedJournalRecords,
	type FoldedJournalRef,
	isKitchenState,
	isKitchenStateShape,
	isRecordFoldedInto,
	jsonEqual,
	MAX_PENDING_JOURNAL_ENTRIES,
	mergeKitchenStates,
	mergePendingKitchenJournal,
	orderPendingJournalRecords,
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
export type KitchenBackupPayload =
	| AppState
	| {
			pending?: AppState;
			quarantined: QuarantinedJournalEntry[];
	  };
export const MAX_SYNC_CONTINUATIONS = 3;
export const DEFAULT_WRITER_LEASE_TTL_MS = 120_000;

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
type WriterLease = {
	ownerId: string;
	updatedAt: number;
	expiresAt: number;
};
type OwnDurableTracker = {
	record: PendingJournalRecord;
	baselineEtag: string | null;
	baselineUpdatedAt: number;
	getStateAtStage: AppState | null;
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
	ownDurable: OwnDurableTracker | null;
	reviewedEtag: string | null;
	reviewedState: AppState | null;
	error: string;
};

const WRITER_STORAGE_KEY = 'flavorithm-writer-id:v1';
const WRITER_LEASE_PREFIX = 'flavorithm-writer-lease:v1:';
const writerLeaseKey = (id: string) => `${WRITER_LEASE_PREFIX}${encodeURIComponent(id)}`;
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
					(sameVersion(parsed, entry.pending) ||
						(!parsed.writeId &&
							!entry.pending.writeId &&
							parsed.updatedAt === entry.pending.updatedAt &&
							parsed.createdAt === entry.pending.createdAt &&
							parsed.etag === entry.pending.etag))
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
		} catch {
			// Ignore blocked or non-enumerable storage during lease maintenance.
		}
	}

	function hasActiveForeignLease(id: string, now = nowOf()): boolean {
		const lease = readLease(id, now);
		return !!lease && lease.ownerId !== ownerId;
	}

	// Scrub any legacy sessionStorage writer-id key without reading or adopting it: sessionStorage is
	// cloned when duplicating a tab, so each live controller allocates its own lease-checked writerId.
	try {
		const sessionStore =
			options.sessionStorage !== undefined
				? options.sessionStorage
				: typeof window !== 'undefined'
					? window.sessionStorage
					: globalThis.sessionStorage;
		sessionStore?.removeItem(WRITER_STORAGE_KEY);
	} catch {
		// Ignore blocked or unavailable sessionStorage in sandboxed contexts.
	}

	purgeExpiredLeases();
	let writerId =
		options.writerId && !hasActiveForeignLease(options.writerId) ? options.writerId : randomId();
	let leaseHeld = false;
	let restagingFromWake = false;

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
		} catch {
			// Ignore quota or read-only storage errors when refreshing advisory leases.
		}
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
		} catch {
			// Ignore storage errors when releasing advisory leases.
		}
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

	function safeReadGetState(): AppState | null {
		try {
			const current = options.getState();
			return isKitchenStateShape(current) ? clone(current) : null;
		} catch {
			return null;
		}
	}

	function trackOwnDurable(context: ActiveContext, record: PendingJournalRecord): void {
		context.ownDurable = {
			record: clone(record),
			baselineEtag: context.baseline?.etag ?? null,
			baselineUpdatedAt: context.baseline?.updatedAt ?? 0,
			getStateAtStage: safeReadGetState()
		};
	}

	function isAcknowledgedByStoredBaseline(
		ownDurable: OwnDurableTracker,
		storedConfirmed: ConfirmedKitchen | null
	): boolean {
		if (!storedConfirmed) return false;
		if (storedConfirmed.etag !== ownDurable.baselineEtag) return true;
		if (
			storedConfirmed.updatedAt > ownDurable.baselineUpdatedAt &&
			causallyIncludesDelta(
				ownDurable.record.pending.base,
				ownDurable.record.pending.local,
				storedConfirmed.state
			)
		) {
			return true;
		}
		return false;
	}

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
		if (durable && record.writerId === writerId) {
			trackOwnDurable(context, record);
		}
	}

	function forgetAcknowledged(context: ActiveContext, records: PendingJournalRecord[]): void {
		const memory = writerMemory(context);
		for (const record of records) {
			const latest = memory.get(record.writerId);
			if (latest && sameVersion(latest.record.pending, record.pending)) {
				memory.delete(record.writerId);
			}
			if (
				context.ownDurable &&
				context.ownDurable.record.writerId === record.writerId &&
				sameVersion(context.ownDurable.record.pending, record.pending)
			) {
				context.ownDurable = null;
			}
		}
	}

	function addRetiredRecords(context: ActiveContext, records: PendingJournalRecord[]): void {
		for (const record of records) {
			const exists = context.retiredRecords.some(
				(item) => item.writerId === record.writerId && sameVersion(item.pending, record.pending)
			);
			if (!exists) context.retiredRecords.push(clone(record));
		}
	}

	function retireJournalRecords(
		context: ActiveContext,
		records: PendingJournalRecord[],
		failureMessage: string
	): string {
		const targets = [...records, ...context.retiredRecords];
		if (!targets.length) return '';
		forgetAcknowledged(context, targets);
		let threw = false;
		try {
			clearPendingJournalRecords(options.storage, context.user, targets);
		} catch {
			threw = true;
		}
		const unretiredNew = records.filter((record) =>
			hasUnretiredJournalVersion(options.storage, [record])
		);
		const unretiredPrior = context.retiredRecords.filter((record) =>
			hasUnretiredJournalVersion(options.storage, [record])
		);
		context.retiredRecords = [];
		addRetiredRecords(context, [...unretiredPrior, ...unretiredNew]);
		return threw || unretiredNew.length ? failureMessage : '';
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
					// Another tab may have acknowledged or compacted this writer's exact durable version.
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
		if (latest?.rawState && !context.legacyReference) {
			context.legacyReference = clone(latest.rawState);
		}
		return latest;
	}

	function syncInitialOwnDurable(context: ActiveContext, loaded: LoadedJournal): void {
		const unfoldedOwn = filterUnfoldedJournalRecords(loaded.records).find(
			(record) => record.writerId === writerId
		);
		if (unfoldedOwn && writerMemory(context).get(writerId)?.durable !== false) {
			trackOwnDurable(context, unfoldedOwn);
		} else if (!unfoldedOwn) {
			context.ownDurable = null;
		}
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
			updatedAt: nowOf()
		};
		context.baseline = baseline;
		if (rawState !== normalizedState) context.legacyReference = rawState;
		else context.legacyReference = null;
		baselines.set(context.key, baseline);
		try {
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
		const baseline = resolveLatestBaseline(identity, key);
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
			ownDurable: null,
			reviewedEtag: null,
			reviewedState: null,
			error: ''
		};
		active = context;
		return context;
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
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		syncInitialOwnDurable(context, loaded);
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
		syncInitialOwnDurable(context, loaded);
		let quarantineError = loaded.error || carriedQuarantine;
		let merged = updateAggregate(context, loaded, normalizedRemote);
		let retireError = '';
		if (
			!baselineError &&
			loaded.records.length &&
			!merged.conflicts.length &&
			equal(merged.state, normalizedRemote)
		) {
			retireError = retireJournalRecords(
				context,
				loaded.records,
				'The server already has these changes, but the saved offline journal could not be cleared.'
			);
			loaded = loadJournal(context);
			quarantineError ||= loaded.error;
			merged = updateAggregate(context, loaded, normalizedRemote);
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
		const baseline = refreshBaseline(context);
		const loaded = loadJournal(context);
		syncInitialOwnDurable(context, loaded);
		context.storageAlert = loaded.error;
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
			context.error = loaded.error || context.storageAlert;
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
		// Preserve both newly folded peers and transitive foldedFrom lineages so a frozen peer woken
		// after multi-hop compaction (A -> B -> C) still sees its snapshot listed in foldedFrom.
		for (const record of newlyFolded) {
			addRef({
				writerId: record.writerId,
				...(record.pending.writeId ? { writeId: record.pending.writeId } : {}),
				updatedAt: record.pending.updatedAt,
				...(record.pending.createdAt !== undefined ? { createdAt: record.pending.createdAt } : {})
			});
			for (const inherited of record.pending.foldedFrom ?? []) {
				addRef(inherited);
			}
		}
		for (const inherited of ownBefore?.pending.foldedFrom ?? []) {
			addRef(inherited);
		}
		return refs.length ? refs : undefined;
	}

	function findCompactionPlan(
		context: ActiveContext,
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
		const observedState = effectiveOwn?.pending.local ?? viewBase;
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
				(causallyIncludesDelta(record.pending.base, record.pending.local, viewBase) &&
					causallyIncludesDelta(record.pending.base, record.pending.local, observedState))
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
				createdAt: effectiveOwn?.pending.createdAt ?? now,
				updatedAt: now,
				writerId,
				...(effectiveOwn?.pending.foldedFrom
					? { foldedFrom: clone(effectiveOwn.pending.foldedFrom) }
					: {})
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
			const uncompactedAll = composePendingKitchenJournal([
				...peers,
				{
					...syntheticStep,
					pending: { ...syntheticStep.pending, base: defaultBaseSource, local: next }
				}
			]);
			if (!composed || composed.conflicts.length > 0 || !uncompactedAll) {
				return {
					foldableAncestors: [],
					alreadyFoldedPeers,
					base: clone(defaultBaseSource),
					etag: defaultEtag,
					anchoredToBaseline: !!baseline && equal(defaultBaseSource, baseline.state)
				};
			}
			const previewFoldedFrom = buildFoldedRefs(effectiveOwn, candidates);
			if (baseline) {
				const alignedComposedBase = context.confirmed
					? alignRevertedBaselinePantryQuantities(composed.base, priorLocal, next, baseline.state)
					: composed.base;
				const onBaseline = mergeKitchenStates(alignedComposedBase, composed.local, baseline.state);
				const compactedAnchored = composePendingKitchenJournal([
					...remainingPeers,
					{
						...syntheticStep,
						pending: {
							...syntheticStep.pending,
							base: baseline.state,
							local: next,
							etag: baseline.etag,
							...(previewFoldedFrom ? { foldedFrom: previewFoldedFrom } : {})
						}
					}
				]);
				const expectedOnBaseline = mergeKitchenStates(
					uncompactedAll.base,
					uncompactedAll.local,
					baseline.state
				);
				if (
					!onBaseline.conflicts.length &&
					equal(onBaseline.state, next) &&
					preservesPeersOnBaseline(remainingPeers, alignedComposedBase) &&
					compactedAnchored &&
					!expectedOnBaseline.conflicts.length &&
					compactedAnchored.conflicts.length === uncompactedAll.conflicts.length &&
					equal(compactedAnchored.local, expectedOnBaseline.state)
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
			const firstOrdered = composed.ordered[0]?.pending;
			const compactedDirect = composePendingKitchenJournal([
				...remainingPeers,
				{
					...syntheticStep,
					pending: {
						...syntheticStep.pending,
						base: composed.base,
						local: next,
						etag: firstOrdered?.etag ?? defaultEtag,
						...(previewFoldedFrom ? { foldedFrom: previewFoldedFrom } : {})
					}
				}
			]);
			if (
				equal(composed.local, next) &&
				compactedDirect &&
				compactedDirect.conflicts.length === uncompactedAll.conflicts.length &&
				equal(compactedDirect.base, uncompactedAll.base) &&
				equal(compactedDirect.local, uncompactedAll.local)
			) {
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
		if (!isKitchenStateShape(next)) {
			context.validationError = true;
			context.error = 'The kitchen state is invalid and was not saved.';
			emitStatus(context);
			return;
		}
		const baseline = refreshBaseline(context);
		const trackedBeforeLoad = context.ownDurable ? clone(context.ownDurable) : null;
		const loaded = loadJournal(context);
		if (loaded.error) context.storageAlert ||= loaded.error;
		const unfoldedRecords = filterUnfoldedJournalRecords(loaded.records);
		const unfoldedSet = new Set(unfoldedRecords);
		const alreadyFoldedPeers = loaded.records.filter(
			(record) => record.writerId !== writerId && !unfoldedSet.has(record)
		);
		const own = loaded.records.find((record) => record.writerId === writerId);
		const effectiveOwn = own && unfoldedSet.has(own) ? own : undefined;
		let unacknowledgedVanishedBase: AppState | null = null;
		if (!effectiveOwn && trackedBeforeLoad) {
			const storedConfirmed = readConfirmed(options.storage, context.identity);
			if (isAcknowledgedByStoredBaseline(trackedBeforeLoad, storedConfirmed)) {
				context.ownDurable = null;
			} else if (!isRecordFoldedInto(trackedBeforeLoad.record, loaded.records)) {
				unacknowledgedVanishedBase = clone(trackedBeforeLoad.record.pending.base);
			}
		}
		const firstPending = firstActivePending(loaded.records);
		const rawBase = clone(
			effectiveOwn?.pending.base ||
				unacknowledgedVanishedBase ||
				context.viewState ||
				baseline?.state ||
				createNewUserState()
		);
		const base = isKitchenState(rawBase) ? rawBase : sanitizeKitchenState(rawBase);
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
		const isReactiveEcho = Boolean(
			!unacknowledgedVanishedBase && stageOptions?.echo && equal(next, context.viewState)
		);
		const isUnchangedState =
			(!effectiveOwn && !unacknowledgedVanishedBase && equal(next, context.viewState)) ||
			Boolean(effectiveOwn && equal(next, effectiveOwn.pending.local));
		if (isReactiveEcho || isUnchangedState) {
			const priorError = context.validationError ? '' : context.error;
			context.validationError = false;
			if (!isReactiveEcho && effectiveOwn) context.viewState = next;
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
		if (effectiveOwn && equal(validatedNext, effectiveOwn.pending.local)) {
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

		const plan = findCompactionPlan(
			context,
			unfoldedRecords,
			alreadyFoldedPeers,
			effectiveOwn,
			base,
			validatedNext
		);
		const latestBaseline = context.baseline;
		const matchesBaseline =
			!context.syncing &&
			((plan.anchoredToBaseline &&
				!!latestBaseline &&
				(equal(next, latestBaseline.state) || equal(validatedNext, latestBaseline.state))) ||
				equal(next, plan.base) ||
				equal(validatedNext, plan.base));
		if (matchesBaseline) {
			context.ownDurable = null;
			const toRetire = [
				...(own ? [own] : []),
				...plan.foldableAncestors,
				...plan.alreadyFoldedPeers
			];
			const retireError = retireJournalRecords(
				context,
				toRetire,
				'The reverted offline changes could not be removed from this device.'
			);
			const after = loadJournal(context);
			const afterFirst = firstActivePending(after.records);
			const preservedAlert =
				context.storageAlert && context.storageAlert !== STAGE_QUOTA_ALERT
					? context.storageAlert
					: '';
			context.storageAlert = retireError || after.error || preservedAlert;
			context.viewState = next;
			const merged = updateAggregate(
				context,
				after,
				context.reviewedState || latestBaseline?.state || afterFirst?.base || validatedNext
			);
			context.viewState = next;
			syncReviewedConflictSeed(merged.conflicts);
			context.error = context.storageAlert;
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
		const foldedFrom = buildFoldedRefs(own, ancestorsToRetire);
		const pending: PendingKitchen = {
			userId: context.identity.userId,
			householdId: context.identity.householdId,
			base: plan.base,
			local: validatedNext,
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
		if (durable) {
			rememberRecord(context, ownRecord, true);
			if (ancestorsToRetire.length || context.retiredRecords.length) {
				const retireError = retireJournalRecords(
					context,
					ancestorsToRetire,
					'Compacted offline journal entries could not be retired on this device.'
				);
				if (retireError) persistenceError ||= retireError;
			}
		} else {
			rememberRecord(context, ownRecord, false);
		}
		const after = loadJournal(context);
		const afterFirst = firstActivePending(after.records);
		const preservedAlert =
			context.storageAlert && context.storageAlert !== STAGE_QUOTA_ALERT
				? context.storageAlert
				: '';
		context.storageAlert =
			persistenceError || (durable ? after.error || preservedAlert : context.storageAlert);
		const aggregate = updateAggregate(
			context,
			after,
			context.reviewedState || latestBaseline?.state || afterFirst?.base || base
		);
		// Stage is driven by the UI's current state. Keep it as the view even if a different tab has
		// additional queued deltas that are not reflected in this tab yet.
		context.viewState = next;
		context.error = persistenceError || after.error || context.storageAlert;
		if (aggregate.conflicts.length) context.conflicts = clone(aggregate.conflicts);
		syncReviewedConflictSeed(aggregate.conflicts);
		emitStatus(context);
	}

	function refreshLease(): void {
		if (!leaseHeld && !active) return;
		acquireOrRefreshLease();
		if (restagingFromWake || !active || !isActive(active) || active.syncing || !active.ownDurable) {
			return;
		}
		const tracked = clone(active.ownDurable);
		const durable = readPendingJournal(options.storage, active.user);
		const activeDurable = durable.records.filter(
			(record) =>
				!active!.retiredRecords.some(
					(retired) =>
						retired.writerId === record.writerId && sameVersion(retired.pending, record.pending)
				)
		);
		const unfolded = filterUnfoldedJournalRecords(activeDurable);
		if (
			unfolded.some(
				(record) =>
					record.writerId === tracked.record.writerId &&
					sameVersion(record.pending, tracked.record.pending)
			) ||
			unfolded.some((record) => record.writerId === writerId)
		) {
			return;
		}
		const storedConfirmed = readConfirmed(options.storage, active.identity);
		if (isAcknowledgedByStoredBaseline(tracked, storedConfirmed)) {
			active.ownDurable = null;
			const baseline = refreshBaseline(active);
			const loaded = loadJournal(active);
			const firstPending = firstActivePending(loaded.records);
			const seed = baseline?.state || firstPending?.base || createNewUserState();
			updateAggregate(active, loaded, seed);
			emitStatus(active);
			return;
		}
		if (isRecordFoldedInto(tracked.record, activeDurable)) {
			return;
		}
		const liveState = safeReadGetState();
		const hasNewLiveEdit =
			liveState !== null &&
			(tracked.getStateAtStage === null || !equal(liveState, tracked.getStateAtStage));
		const candidateState = hasNewLiveEdit
			? liveState
			: clone(active.viewState ?? tracked.record.pending.local);
		restagingFromWake = true;
		try {
			writerMemory(active).delete(writerId);
			active.ownDurable = null;
			active.viewState = clone(tracked.record.pending.base);
			stage(candidateState);
		} finally {
			restagingFromWake = false;
		}
	}

	async function runSync(
		prefer?: 'local' | 'remote',
		expectedEtag?: string | null,
		continuationDepth = 0
	): Promise<void> {
		const context = active;
		if (!context || !isActive(context) || context.syncing) return;
		acquireOrRefreshLease();
		const baseline = refreshBaseline(context);
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
		const firstPending = firstActivePending(loaded.records) ?? loaded.records[0].pending;
		const seed = baseline?.state || firstPending.base || createNewUserState();
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
				shouldContinue = false;
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
			const retireError = retireJournalRecords(
				context,
				captured,
				'The server saved these changes, but acknowledged journal entries could not be retired.'
			);
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
			shouldContinue = false;
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
		clearContext,
		refreshLease,
		releaseLease
	};
}
