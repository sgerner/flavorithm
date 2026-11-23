import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createStatusStore,
	formatPantryStatus,
	formatRecipeStatus,
	formatShoppingStatus,
	formatUndoAnnouncement,
	formatWebSearchStatus
} from '../src/lib/status.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('alternates between two polite status buffers so consecutive identical notifications always mutate', () => {
	const store = createStatusStore({ toastDurationMs: 100 });
	assert.deepEqual(store.state.buffers, ['', '']);

	store.notify('Invite code copied.');
	assert.equal(store.state.activeSlot, 0);
	assert.deepEqual(store.state.buffers, ['Invite code copied.', '']);
	assert.equal(store.state.version, 1);

	store.notify('Invite code copied.');
	assert.equal(store.state.activeSlot, 1);
	assert.deepEqual(store.state.buffers, ['', 'Invite code copied.']);
	assert.equal(store.state.version, 2);

	store.notify('Invite code copied.');
	assert.equal(store.state.activeSlot, 0);
	assert.deepEqual(store.state.buffers, ['Invite code copied.', '']);
	assert.equal(store.state.version, 3);

	store.reset();
});

test('debounces rapid search announcements and cancels pending debounce on immediate filter or toast', async () => {
	const store = createStatusStore({ toastDurationMs: 100 });
	let currentCount = 6;

	store.announceDeferred(() => `${currentCount} recipes shown.`, 40);
	currentCount = 3;
	store.announceDeferred(() => `${currentCount} recipes shown.`, 40);
	currentCount = 0;
	store.announceDeferred(() => formatRecipeStatus(currentCount, 'discover', false, true), 40);

	assert.equal(store.state.version, 0);
	await wait(65);
	assert.equal(store.state.version, 1);
	assert.equal(
		store.state.buffers[store.state.activeSlot],
		'No recipes found. Try another search or generate recipes.'
	);

	// Immediate announcement cancels pending debounce so stale search counts never overwrite it
	store.announceDeferred(() => '99 recipes shown.', 40);
	store.announce('2 ingredients expiring soon.');
	assert.equal(store.state.version, 2);
	assert.equal(store.state.buffers[store.state.activeSlot], '2 ingredients expiring soon.');

	await wait(65);
	assert.equal(store.state.version, 2);
	assert.equal(store.state.buffers[store.state.activeSlot], '2 ingredients expiring soon.');

	store.reset();
});

test('Undo toasts announce Undo available and persist indefinitely with zero automatic timeout', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = createStatusStore({ toastDurationMs: 4200 });
	let undone = 0;

	store.notify('Planned meal removed.', () => {
		undone += 1;
	});

	assert.equal(
		store.state.buffers[store.state.activeSlot],
		'Planned meal removed. Undo available.'
	);
	assert.ok(store.state.toast);
	assert.equal(store.state.toast.message, 'Planned meal removed.');
	assert.equal(typeof store.state.toast.undo, 'function');

	// Advance far beyond 10 seconds (e.g., 60 seconds) — Undo toast must remain visible
	t.mock.timers.tick(60_000);
	assert.ok(store.state.toast);
	assert.equal(store.state.toast.message, 'Planned meal removed.');

	store.runToastUndo();
	assert.equal(undone, 1);
	assert.equal(store.state.toast, null);

	store.reset();
});

test('standard informational toasts auto-hide after 4.2s and pause on hover or focus', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = createStatusStore({ toastDurationMs: 4200 });

	store.notify('Preferences saved.');
	assert.ok(store.state.toast);
	const versionAfterNotify = store.state.version;

	t.mock.timers.tick(2000);
	store.setToastHovered(true);
	t.mock.timers.tick(10_000);
	assert.ok(store.state.toast, 'Toast stays visible while hovered');

	store.setToastFocused(true);
	store.setToastHovered(false);
	t.mock.timers.tick(10_000);
	assert.ok(store.state.toast, 'Toast stays visible while focused');

	store.setToastFocused(false);
	t.mock.timers.tick(4199);
	assert.ok(store.state.toast);
	t.mock.timers.tick(2);
	assert.equal(store.state.toast, null, 'Toast hides visually after 4.2s once unfocused');
	assert.equal(store.state.version, versionAfterNotify, 'Visual auto-hide does not re-announce');

	store.reset();
});

test('tracks modal announcer stack and scopes active announcements to topmost open modal', async () => {
	const store = createStatusStore({ toastDurationMs: 100 });
	assert.equal(store.state.activeScope, 'root');

	const closeButler = store.registerModal('butler');
	assert.equal(store.state.activeScope, 'butler');

	const closeSettings = store.registerModal('settings');
	assert.equal(store.state.activeScope, 'settings');
	assert.equal(store.state.freshInCurrentTurn, false);

	store.notify('Code copied.');
	assert.equal(store.state.freshInCurrentTurn, true);
	await Promise.resolve();
	assert.equal(store.state.freshInCurrentTurn, false);

	closeSettings();
	assert.equal(store.state.activeScope, 'butler');

	closeButler();
	assert.equal(store.state.activeScope, 'root');

	store.reset();
});

test('formats recipe, pantry, online search, and Undo status messages clearly', () => {
	assert.equal(formatUndoAnnouncement('Olive oil removed.'), 'Olive oil removed. Undo available.');
	assert.equal(formatUndoAnnouncement('Changes applied'), 'Changes applied. Undo available.');

	assert.equal(formatRecipeStatus(1, 'discover', false, false), '1 recipe shown.');
	assert.equal(formatRecipeStatus(4, 'saved', true, false), '4 saved recipes shown.');
	assert.equal(
		formatRecipeStatus(0, 'saved', false, false),
		'No saved recipes yet. Tap the bookmark on any recipe to keep it close.'
	);
	assert.equal(
		formatRecipeStatus(0, 'saved', true, true),
		'No saved recipes found. Try another search or filter.'
	);

	assert.equal(
		formatPantryStatus(0, 0, 'all'),
		'No ingredients yet. Add a few things from your fridge to get started.'
	);
	assert.equal(
		formatPantryStatus(0, 5, 'expired'),
		'No matching ingredients. Try another expiry filter or update a best-before date.'
	);
	assert.equal(formatPantryStatus(2, 5, 'soon'), '2 ingredients expiring soon.');
	assert.equal(formatPantryStatus(1, 5, 'expired'), '1 expired ingredient.');
	assert.equal(formatPantryStatus(3, 5, 'all', true), '3 matching ingredients shown.');
	assert.equal(
		formatPantryStatus(0, 5, 'all', true),
		'No matching ingredients. Try another search, category, or expiry filter.'
	);

	assert.equal(formatShoppingStatus(0, 0, 0, 'all'), 'Your shopping list is empty.');
	assert.equal(formatShoppingStatus(0, 3, 3, 'unpurchased'), 'All 3 items purchased.');
	assert.equal(formatShoppingStatus(2, 4, 2, 'unpurchased'), '2 unpurchased items shown.');
	assert.equal(formatShoppingStatus(4, 4, 2, 'all'), '4 shopping items shown.');

	assert.equal(
		formatWebSearchStatus(0),
		'No online recipes found. Try another search or import a link.'
	);
	assert.equal(formatWebSearchStatus(3), '3 online recipes found.');
});
