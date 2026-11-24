import test from 'node:test';
import assert from 'node:assert/strict';
import { focusTrap } from '../src/lib/focus.ts';
import {
	canIdlePrefetch,
	createModalPreloader,
	scheduleIdleWarmup,
	type NavigatorConnectionLike
} from '../src/lib/modal-preloader.ts';

test('preloader deduplicates concurrent and repeated loads per modal key', async () => {
	let recipeCalls = 0;
	let importCalls = 0;
	const preloader = createModalPreloader({
		recipeDetail: async () => {
			recipeCalls += 1;
			await Promise.resolve();
			return { name: 'RecipeDetail' };
		},
		recipeImport: async () => {
			importCalls += 1;
			return { name: 'RecipeImport' };
		}
	});

	preloader.preload('recipeDetail');
	preloader.preload('recipeDetail');
	const [first, second] = await Promise.all([
		preloader.load('recipeDetail'),
		preloader.load('recipeDetail')
	]);
	const third = await preloader.load('recipeDetail');

	assert.equal(recipeCalls, 1);
	assert.equal(importCalls, 0);
	assert.equal(first, second);
	assert.equal(second, third);
	assert.equal(preloader.has('recipeDetail'), true);
	assert.equal(preloader.has('recipeImport'), false);
});

test('preloader evicts rejected promises so subsequent retry succeeds', async () => {
	let attempts = 0;
	const preloader = createModalPreloader({
		butlerChat: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('offline');
			return { ok: true };
		}
	});

	// Speculative hover preload swallows unhandled rejection and clears cache entry.
	preloader.preload('butlerChat');
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(attempts, 1);
	assert.equal(preloader.has('butlerChat'), false);

	const loaded = await preloader.load('butlerChat');
	assert.deepEqual(loaded, { ok: true });
	assert.equal(attempts, 2);
});

test('canIdlePrefetch respects online state, saveData, and slow-2g/2g across connection variants', () => {
	assert.equal(canIdlePrefetch(undefined), false);
	assert.equal(canIdlePrefetch({ onLine: false }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, mozConnection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, webkitConnection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { effectiveType: 'slow-2g' } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { effectiveType: '2g' } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, webkitConnection: { effectiveType: '2g' } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { effectiveType: '3g' } }), true);
	assert.equal(
		canIdlePrefetch({ onLine: true, connection: { saveData: false, effectiveType: '4g' } }),
		true
	);
	assert.equal(canIdlePrefetch({ onLine: true }), true);
});

test('saveData and 2g suppress both idle and hover/focus warming while keeping click load functional', async () => {
	let loads = 0;
	const preloader = createModalPreloader({
		butlerChat: async () => {
			loads += 1;
			return 'ButlerChat';
		}
	});

	const saveDataNav: NavigatorConnectionLike = { onLine: true, connection: { saveData: true } };
	const slowNav: NavigatorConnectionLike = { onLine: true, connection: { effectiveType: '2g' } };

	const idleCallbacks: Array<() => void> = [];
	const cancel = scheduleIdleWarmup(['butlerChat'], (key) => preloader.load(key), {
		nav: saveDataNav,
		requestIdle: (cb) => {
			idleCallbacks.push(cb);
			return idleCallbacks.length;
		},
		cancelIdle: () => {}
	});

	assert.equal(idleCallbacks.length, 0);
	assert.equal(preloader.warm('butlerChat', saveDataNav), false);
	assert.equal(preloader.warm('butlerChat', slowNav), false);
	assert.equal(preloader.warm('butlerChat', { onLine: false }), false);
	assert.equal(loads, 0);

	// Explicit click load still loads cleanly on demand, and normal connections allow hover warm.
	assert.equal(await preloader.load('butlerChat'), 'ButlerChat');
	assert.equal(loads, 1);
	assert.equal(
		preloader.warm('butlerChat', { onLine: true, connection: { saveData: false } }),
		true
	);
	assert.equal(loads, 1);
	cancel();
});

test('scheduleIdleWarmup warms queued chunks sequentially and cancels pending callbacks on teardown', async () => {
	const warmed: string[] = [];
	const scheduled = new Map<number, () => void>();
	const cancelled: number[] = [];
	let nextId = 1;

	const stop = scheduleIdleWarmup(
		['recipeDetail', 'recipeImport', 'butlerChat'],
		async (key) => {
			warmed.push(key);
		},
		{
			nav: { onLine: true, connection: { saveData: false } },
			requestIdle: (cb) => {
				const id = nextId++;
				scheduled.set(id, cb);
				return id;
			},
			cancelIdle: (id) => {
				cancelled.push(id);
				scheduled.delete(id);
			}
		}
	);

	assert.equal(scheduled.size, 1);
	const firstCallback = scheduled.get(1)!;
	scheduled.delete(1);
	firstCallback();
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(warmed, ['recipeDetail']);
	assert.equal(scheduled.has(2), true);

	// Teardown cancels pending idle callback and prevents remaining chunks from warming.
	stop();
	assert.deepEqual(cancelled, [2]);
	assert.equal(scheduled.size, 0);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(warmed, ['recipeDetail']);
});

test('scheduleIdleWarmup falls back to setTimeout when requestIdleCallback is unavailable and clears timer on stop', async (t) => {
	const host = globalThis as Record<string, unknown>;
	const prevRequestIdle = Object.getOwnPropertyDescriptor(host, 'requestIdleCallback');
	const prevCancelIdle = Object.getOwnPropertyDescriptor(host, 'cancelIdleCallback');
	Object.defineProperty(host, 'requestIdleCallback', {
		value: undefined,
		configurable: true,
		writable: true
	});
	Object.defineProperty(host, 'cancelIdleCallback', {
		value: undefined,
		configurable: true,
		writable: true
	});
	t.after(() => {
		if (prevRequestIdle) Object.defineProperty(host, 'requestIdleCallback', prevRequestIdle);
		else Reflect.deleteProperty(host, 'requestIdleCallback');
		if (prevCancelIdle) Object.defineProperty(host, 'cancelIdleCallback', prevCancelIdle);
		else Reflect.deleteProperty(host, 'cancelIdleCallback');
	});

	const warmed: string[] = [];
	let releaseSecond!: () => void;
	const secondGate = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});

	const stop = scheduleIdleWarmup(
		['recipeDetail', 'recipeImport', 'butlerChat'],
		async (key) => {
			warmed.push(key);
			if (key === 'recipeImport') await secondGate;
		},
		{
			nav: { onLine: true, connection: { saveData: false } },
			fallbackDelay: 5
		}
	);

	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.deepEqual(warmed, ['recipeDetail', 'recipeImport']);

	// Release second item so the third timer is scheduled, then immediately cancel before it fires.
	releaseSecond();
	await Promise.resolve();
	await Promise.resolve();
	stop();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(warmed, ['recipeDetail', 'recipeImport']);
});

test('offline cancellation stops pending idle warmup and online rescheduling warms only remaining uncached chunks', async () => {
	const loaded: string[] = [];
	const preloader = createModalPreloader({
		recipeDetail: async () => {
			loaded.push('recipeDetail');
			return 'detail';
		},
		recipeImport: async () => {
			loaded.push('recipeImport');
			return 'import';
		},
		butlerChat: async () => {
			loaded.push('butlerChat');
			return 'basil';
		}
	});
	const order = ['recipeDetail', 'recipeImport', 'butlerChat'] as const;
	const nav = { onLine: true, connection: { saveData: false } };
	const scheduled = new Map<number, () => void>();
	let nextId = 1;
	const schedulerOpts = {
		nav,
		requestIdle: (cb: () => void) => {
			const id = nextId++;
			scheduled.set(id, cb);
			return id;
		},
		cancelIdle: (id: number) => {
			scheduled.delete(id);
		}
	};

	let cancelWarmup = scheduleIdleWarmup(order, (key) => preloader.load(key), schedulerOpts);
	const first = scheduled.get(1)!;
	scheduled.delete(1);
	first();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(loaded, ['recipeDetail']);
	assert.equal(scheduled.size, 1);

	// Going offline cancels pending handle and suppresses new warmup while offline.
	nav.onLine = false;
	cancelWarmup();
	assert.equal(scheduled.size, 0);
	cancelWarmup = scheduleIdleWarmup(order, (key) => preloader.load(key), schedulerOpts);
	assert.equal(scheduled.size, 0);

	// Returning online reschedules warmup; already-cached recipeDetail is not fetched again.
	nav.onLine = true;
	cancelWarmup = scheduleIdleWarmup(order, (key) => preloader.load(key), schedulerOpts);
	while (scheduled.size > 0) {
		const [[id, cb]] = scheduled.entries();
		scheduled.delete(id);
		cb();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(loaded, ['recipeDetail', 'recipeImport', 'butlerChat']);
	cancelWarmup();
});

test('focusTrap preserves trigger focus and body overflow across synchronous fallback-to-modal handoffs', async (t) => {
	const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
	let activeElement: any = null;
	const body = {
		style: { overflow: 'auto' },
		focus() {
			activeElement = body;
		}
	};
	const docElement = {};
	const makeNode = (name: string, controls: any[] = []) => {
		const listeners = new Map<string, (e: any) => void>();
		const node: any = {
			name,
			isConnected: true,
			offsetParent: {},
			preventScrollCalls: 0,
			closest: () => null,
			querySelectorAll: () => controls,
			addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
			removeEventListener: (type: string) => listeners.delete(type),
			focus: (opts?: { preventScroll?: boolean }) => {
				if (opts?.preventScroll) node.preventScrollCalls += 1;
				activeElement = node;
			}
		};
		return node;
	};

	const trigger = makeNode('trigger');
	const fallbackClose = makeNode('fallbackClose');
	const fallbackDialog = makeNode('fallbackDialog', [fallbackClose]);
	const detailClose = makeNode('detailClose');
	const detailDialog = makeNode('detailDialog', [detailClose]);

	Object.defineProperty(globalThis, 'document', {
		value: {
			get activeElement() {
				return activeElement;
			},
			body,
			documentElement: docElement
		},
		configurable: true
	});
	t.after(() => {
		if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
		else Reflect.deleteProperty(globalThis, 'document');
	});

	activeElement = trigger;
	const fallbackTrap = focusTrap(fallbackDialog);
	assert.equal(body.style.overflow, 'hidden');
	await Promise.resolve();
	assert.equal(activeElement, fallbackClose);

	// Same-tick swap from fallback loading frame to hydrated lazy modal component:
	fallbackDialog.isConnected = false;
	fallbackTrap.destroy();
	const detailTrap = focusTrap(detailDialog);
	await Promise.resolve();
	assert.equal(activeElement, detailClose);
	assert.equal(body.style.overflow, 'hidden');

	// Closing the lazy modal restores focus to the original trigger and unlocks body overflow.
	detailDialog.isConnected = false;
	detailTrap.destroy();
	await Promise.resolve();
	assert.equal(activeElement, trigger);
	assert.equal(trigger.preventScrollCalls, 1);
	assert.equal(body.style.overflow, 'auto');

	// Opening when document.activeElement is document.body skips detached fallback focus and never clobbers explicit launcher focus on close.
	const launcher = makeNode('launcher');
	const instantFallbackClose = makeNode('instantFallbackClose');
	const instantFallback = makeNode('instantFallback', [instantFallbackClose]);
	const basilInput = makeNode('basilInput');
	const basilPanel = makeNode('basilPanel', [basilInput]);
	activeElement = body;
	const instantTrap = focusTrap(instantFallback);
	instantFallback.isConnected = false;
	instantTrap.destroy();
	const basilTrap = focusTrap(basilPanel);
	await Promise.resolve();
	assert.equal(activeElement, basilInput);
	basilPanel.isConnected = false;
	basilTrap.destroy();
	launcher.focus();
	await Promise.resolve();
	assert.equal(activeElement, launcher);
});
