import test from 'node:test';
import assert from 'node:assert/strict';
import {
	canIdlePrefetch,
	createModalPreloader,
	scheduleIdleWarmup
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

test('canIdlePrefetch respects online state and saveData across connection variants', () => {
	assert.equal(canIdlePrefetch(undefined), false);
	assert.equal(canIdlePrefetch({ onLine: false }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, mozConnection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, webkitConnection: { saveData: true } }), false);
	assert.equal(canIdlePrefetch({ onLine: true, connection: { saveData: false } }), true);
	assert.equal(canIdlePrefetch({ onLine: true }), true);
});

test('saveData prevents background idle prefetching while keeping intent and click loading functional', async () => {
	let loads = 0;
	const preloader = createModalPreloader({
		butlerChat: async () => {
			loads += 1;
			return 'ButlerChat';
		}
	});

	const idleCallbacks: Array<() => void> = [];
	const cancel = scheduleIdleWarmup(['butlerChat'], (key) => preloader.load(key), {
		nav: { onLine: true, connection: { saveData: true } },
		requestIdle: (cb) => {
			idleCallbacks.push(cb);
			return idleCallbacks.length;
		},
		cancelIdle: () => {}
	});

	assert.equal(idleCallbacks.length, 0);
	assert.equal(loads, 0);

	// Direct pointer/focus intent or click still loads cleanly and deduplicates.
	preloader.preload('butlerChat');
	assert.equal(await preloader.load('butlerChat'), 'ButlerChat');
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
