import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createStatusStore,
	formatPantryStatus,
	formatRecipeStatus,
	formatShoppingStatus,
	formatUndoAnnouncement,
	formatWebSearchStatus,
	isToastVisibleForOwner
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

test('Undo toasts announce Undo available and persist indefinitely for the active owner with zero automatic timeout', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = createStatusStore({ toastDurationMs: 4200, initialOwner: 'user-a:hh-1' });
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
	assert.equal(store.state.toast.owner, 'user-a:hh-1');
	assert.equal(typeof store.state.toast.undo, 'function');

	// Advance far beyond 10 seconds (e.g., 60 seconds) — Undo toast remains visible for the same owner
	t.mock.timers.tick(60_000);
	assert.ok(store.state.toast);
	assert.equal(store.state.toast.message, 'Planned meal removed.');

	assert.equal(store.runToastUndo('user-a:hh-1'), true);
	assert.equal(undone, 1);
	assert.equal(store.state.toast, null);

	store.reset();
});

test('toasts do not survive reset/logout and Undo after reset is a no-op', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = createStatusStore({ toastDurationMs: 4200, initialOwner: 'user-a:hh-1' });
	let undone = 0;

	store.notify('Olive oil removed.', () => {
		undone += 1;
	});
	assert.ok(store.state.toast);

	// Simulate sign-out / account deletion resetting the status store and transitioning to guest
	store.reset();
	store.setOwner('guest:');

	assert.equal(store.state.toast, null);
	assert.deepEqual(store.state.buffers, ['', '']);
	assert.equal(store.runToastUndo(), false);
	assert.equal(undone, 0);

	// Sign-out confirmation notification for guest still announces and auto-hides normally
	store.notify('Signed out. Your household is safely saved.');
	const guestState = store.state;
	assert.equal(guestState.version, 1);
	assert.equal(
		guestState.buffers[guestState.activeSlot],
		'Signed out. Your household is safely saved.'
	);
	assert.ok(guestState.toast);
	assert.equal(guestState.toast.owner, 'guest:');
	assert.equal(guestState.toast.undo, null);

	t.mock.timers.tick(4201);
	assert.equal(store.state.toast, null);

	store.reset();
});

test('cross-owner Undo toast is hidden with no visible Undo button and cross-owner Undo is a no-op', async () => {
	const store = createStatusStore({ toastDurationMs: 4200, initialOwner: 'user-a:hh-1' });
	let undone = 0;

	store.notify('Milk removed.', () => {
		undone += 1;
	});
	const userAToast = store.state.toast;
	assert.ok(userAToast);
	assert.equal(isToastVisibleForOwner(userAToast, 'user-a:hh-1'), true);
	assert.equal(isToastVisibleForOwner(userAToast, 'user-b:hh-2'), false);

	// Even before setOwner runs, a cross-owner Undo attempt (e.g. stale caller) is a no-op and hides the toast
	store.notify('Bread removed.', () => {
		undone += 1;
	});
	assert.equal(store.runToastUndo('user-b:hh-2'), false);
	assert.equal(undone, 0);
	assert.equal(store.state.toast, null);

	// Switching owner/household clears any active untimed Undo toast so User B sees neither banner nor Undo button
	store.notify('Eggs removed.', () => {
		undone += 1;
	});
	store.announceDeferred(() => '4 recipes shown.', 30);
	store.setOwner('user-b:hh-2');

	const userBState = store.state;
	assert.equal(userBState.owner, 'user-b:hh-2');
	assert.equal(userBState.toast, null);
	assert.equal(isToastVisibleForOwner(userBState.toast, 'user-b:hh-2'), false);
	assert.equal(store.runToastUndo(), false);
	assert.equal(undone, 0);

	// Stale in-flight async notification tagged with User A's owner is ignored after switching to User B
	store.notify(
		'3 ingredients added to your pantry.',
		() => {
			undone += 1;
		},
		{ owner: 'user-a:hh-1' }
	);
	assert.equal(store.state.toast, null);
	assert.equal(store.runToastUndo(), false);
	assert.equal(undone, 0);

	await wait(45);
	assert.equal(
		store.state.buffers[store.state.activeSlot],
		'',
		'Pending debounced search from previous owner does not fire for new owner'
	);

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
	assert.equal(
		formatUndoAnnouncement(
			'Device storage is full. Export your kitchen before leaving.',
			'Export now'
		),
		'Device storage is full. Export your kitchen before leaving. Export now available.'
	);

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
