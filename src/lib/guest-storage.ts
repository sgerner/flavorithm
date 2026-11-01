type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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
