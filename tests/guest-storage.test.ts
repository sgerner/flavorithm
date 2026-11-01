import test from 'node:test';
import assert from 'node:assert/strict';
import { quarantineLegacyKitchen } from '../src/lib/guest-storage.ts';

function memoryStorage(values: Map<string, string>) {
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		}
	};
}

test('legacy data is backed up separately and never becomes a guest kitchen', () => {
	const values = new Map([['flavorithm-kitchen', '{"private":"legacy"}']]);
	quarantineLegacyKitchen(memoryStorage(values));
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), '{"private":"legacy"}');
	assert.equal(values.has('flavorithm-kitchen'), false);
	assert.equal(values.has('flavorithm-guest-kitchen'), false);
});

test('quota errors and an older distinct backup never destroy the only legacy copy', () => {
	const values = new Map([['flavorithm-kitchen', 'new legacy snapshot']]);
	quarantineLegacyKitchen({
		...memoryStorage(values),
		setItem: () => {
			throw new Error('Quota exceeded');
		}
	});
	assert.equal(values.get('flavorithm-kitchen'), 'new legacy snapshot');
	values.set('flavorithm-legacy-kitchen-backup', 'older snapshot');
	quarantineLegacyKitchen(memoryStorage(values));
	assert.equal(values.get('flavorithm-kitchen'), 'new legacy snapshot');
	assert.equal(values.get('flavorithm-legacy-kitchen-backup'), 'older snapshot');
});
