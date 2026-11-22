import { createInitialState, defaultPreferences, themes } from '#lib/data.ts';
import { readPendingJournal } from '#lib/offline-sync.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
	Partial<Pick<Storage, 'key' | 'length'>>;

const validThemes = new Set<string>(themes);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isObjectCollection(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every(isPlainObject);
}

function normalizeGuestPreferences(value: Record<string, unknown>): Preferences {
	const base = structuredClone(defaultPreferences);
	const merged = { ...base, ...(value as Partial<Preferences>) };
	merged.theme =
		typeof value.theme === 'string' && validThemes.has(value.theme) ? value.theme : base.theme;
	merged.dark = typeof value.dark === 'boolean' ? value.dark : base.dark;
	return merged;
}

function parseGuestState(raw: string | null): AppState | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return null;
		if (
			!isObjectCollection(parsed.pantry) ||
			!isObjectCollection(parsed.recipes) ||
			!isObjectCollection(parsed.meals) ||
			!isObjectCollection(parsed.shopping) ||
			!isPlainObject(parsed.preferences)
		) {
			return null;
		}
		return {
			pantry: parsed.pantry as AppState['pantry'],
			recipes: parsed.recipes as AppState['recipes'],
			meals: parsed.meals as AppState['meals'],
			shopping: parsed.shopping as AppState['shopping'],
			preferences: normalizeGuestPreferences(parsed.preferences)
		};
	} catch {
		return null;
	}
}

/** Preserve ambiguous pre-isolation data without exposing it as a guest kitchen. */
export function quarantineLegacyKitchen(storage: StorageLike): void {
	try {
		const legacy = storage.getItem('flavorithm-kitchen');
		if (!legacy) return;
		const backup = storage.getItem('flavorithm-legacy-kitchen-backup');
		if (backup && backup !== legacy) return;
		if (!backup) storage.setItem('flavorithm-legacy-kitchen-backup', legacy);
		storage.removeItem('flavorithm-kitchen');
	} catch {
		// A failed backup must leave the original available for manual recovery.
	}
}

/** Restore a validated guest kitchen snapshot or fall back to a badged sample kitchen. */
export function restoreGuestKitchen(storage: StorageLike): {
	kitchen: AppState;
	showStarter: boolean;
} {
	quarantineLegacyKitchen(storage);
	let raw: string | null = null;
	try {
		raw = storage.getItem('flavorithm-guest-kitchen');
	} catch {
		raw = null;
	}
	const guest = parseGuestState(raw);
	if (guest) {
		let started = false;
		try {
			started = storage.getItem('flavorithm-started') === 'yes';
		} catch {
			started = false;
		}
		return {
			kitchen: guest,
			showStarter: !started
		};
	}
	try {
		storage.removeItem('flavorithm-started');
	} catch {
		// Ignore storage write errors while falling back to the sample kitchen.
	}
	return {
		kitchen: createInitialState(),
		showStarter: true
	};
}

export function teardownToGuestKitchen(options: {
	storage: StorageLike;
	preserveLastAccount?: boolean;
	clearSyncContext?: () => void;
	clearAIConnectionState?: () => void;
}): {
	kitchen: AppState;
	showStarter: boolean;
} {
	const guest = restoreGuestKitchen(options.storage);
	options.clearAIConnectionState?.();
	options.clearSyncContext?.();
	if (!options.preserveLastAccount) {
		try {
			options.storage.removeItem('flavorithm-last-account');
		} catch {
			// Ignore storage removal failures while restoring guest state.
		}
	}
	return guest;
}

export function readCachedAccount(storage: StorageLike): User | null {
	try {
		const parsed: unknown = JSON.parse(storage.getItem('flavorithm-last-account') || 'null');
		if (
			!isPlainObject(parsed) ||
			typeof parsed.id !== 'string' ||
			!parsed.id ||
			typeof parsed.householdId !== 'string' ||
			!parsed.householdId ||
			typeof parsed.name !== 'string' ||
			typeof parsed.email !== 'string'
		) {
			return null;
		}
		return {
			id: parsed.id,
			name: parsed.name,
			email: parsed.email,
			householdId: parsed.householdId,
			...(typeof parsed.emailVerified === 'boolean' ? { emailVerified: parsed.emailVerified } : {})
		};
	} catch {
		return null;
	}
}

/** Restore the last local account in expired-session mode when unsynced journal deltas exist. */
export function restoreExpiredSessionAccount(storage: StorageLike): User | null {
	const cached = readCachedAccount(storage);
	if (!cached) return null;
	const journal = readPendingJournal(storage, cached);
	return journal.records.length > 0 ? cached : null;
}

export function clearAccountStorage(storage: StorageLike, userId: string): void {
	if (!userId) return;
	const encodedId = encodeURIComponent(userId);
	const matchesUserKey = (key: string) =>
		key.startsWith('flavorithm-') &&
		key !== 'flavorithm-guest-kitchen' &&
		key !== 'flavorithm-started' &&
		key !== 'flavorithm-legacy-kitchen-backup' &&
		(key.includes(`:${userId}:`) ||
			key.includes(`:${encodedId}:`) ||
			key === `flavorithm-voice:${userId}` ||
			key === `flavorithm-voice:${encodedId}`);
	try {
		if (typeof storage.length === 'number' && typeof storage.key === 'function') {
			const toRemove: string[] = [];
			for (let index = 0; index < storage.length; index += 1) {
				const key = storage.key(index);
				if (key && matchesUserKey(key)) toRemove.push(key);
			}
			for (const key of toRemove) storage.removeItem(key);
			return;
		}
		for (const key of Object.keys(storage)) {
			if (matchesUserKey(key)) storage.removeItem(key);
		}
	} catch {
		// Best-effort local cleanup after server account deletion.
	}
}

export function resolveLocalAuthTransition(options: {
	previousMode: string;
	nextMode: string;
	previousUser: User | null;
	nextUser: User | null;
}): {
	managedAuth: boolean;
	modeChanged: boolean;
	localSessionExpired: boolean;
	changedIdentity: boolean;
} {
	const managedAuth = options.nextMode !== 'local';
	const modeChanged = options.previousMode !== options.nextMode;
	const localSessionExpired = !managedAuth && Boolean(options.previousUser) && !options.nextUser;
	const changedIdentity =
		!localSessionExpired &&
		Boolean(
			(options.previousUser &&
				(options.previousUser.id !== options.nextUser?.id ||
					options.previousUser.householdId !== options.nextUser?.householdId)) ||
			(modeChanged && managedAuth && options.nextUser)
		);
	return { managedAuth, modeChanged, localSessionExpired, changedIdentity };
}

export function resolveRegistrationGuestSeed(
	storage: StorageLike,
	currentKitchen: AppState,
	options: { sessionExpired: boolean; user: User | null }
): AppState {
	if (options.sessionExpired || options.user) {
		return restoreGuestKitchen(storage).kitchen;
	}
	return structuredClone(currentKitchen);
}
