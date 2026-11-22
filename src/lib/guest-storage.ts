type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RemovableStorage = Pick<Storage, 'removeItem'>;

const GUEST_KITCHEN_KEY = 'flavorithm-guest-kitchen';
const GUEST_STARTED_KEY = 'flavorithm-started';

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

/** Remove saved guest kitchen state once it has been staged into an account or discarded. */
export function clearGuestKitchen(storage: RemovableStorage): void {
	try {
		storage.removeItem(GUEST_KITCHEN_KEY);
	} catch {
		// Restricted storage must not block account transitions.
	}
}

/** Clear all guest-only browser keys, including the sample-kitchen dismissal flag. */
export function clearGuestData(storage: RemovableStorage): void {
	clearGuestKitchen(storage);
	try {
		storage.removeItem(GUEST_STARTED_KEY);
	} catch {
		// Restricted storage must not block account transitions.
	}
}
