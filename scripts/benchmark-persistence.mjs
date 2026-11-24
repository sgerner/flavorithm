import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import {
	createKitchenPersistence,
	createKitchenSync,
	DEFAULT_SYNC_COALESCE_MS
} from '../src/lib/client-sync.ts';
import { sanitizeKitchenState } from '../src/lib/guest-storage.ts';

/**
 * Construct a ~317 KB validated AppState fixture (180 recipes, 40 pantry items, 30 shopping items, 12 meals).
 */
function buildLargeKitchenFixture() {
	const cuisines = ['Mediterranean', 'Italian', 'Japanese', 'Mexican', 'Indian'];
	const difficulties = ['Easy', 'Medium', 'Hard'];
	const allTags = ['Quick & easy', 'Plant-powered', 'High protein'];
	const slots = ['Breakfast', 'Lunch', 'Dinner'];

	const recipes = Array.from({ length: 180 }, (_, i) => ({
		id: `recipe-${String(i).padStart(3, '0')}`,
		title: `Roasted Seasonal Harvest Bowl #${i + 1}`,
		description:
			'Charred autumn vegetables, nutty farro, toasted pumpkin seeds, and bright herb tahini drizzle balanced for weeknight cooking.',
		image: '',
		cuisine: cuisines[i % cuisines.length],
		time: 25 + (i % 35),
		servings: 4,
		difficulty: difficulties[i % difficulties.length],
		tags: allTags.slice(0, 1 + (i % allTags.length)),
		saved: i % 3 === 0,
		ingredients: Array.from({ length: 10 }, (_, j) => ({
			name: `Ingredient ${j} for recipe ${i}`,
			quantity: 1 + (j % 4),
			unit: 'cup'
		})),
		steps: Array.from(
			{ length: 6 },
			(_, s) =>
				`Step ${s + 1}: Prepare aromatics and simmer gently until fragrant and tender (${i}-${s}).`
		),
		nutrition: {
			calories: 520,
			fat: 19,
			saturatedFat: 3,
			sodium: 410,
			carbs: 58,
			fiber: 9,
			sugar: 6,
			protein: 24
		}
	}));

	const pantry = Array.from({ length: 40 }, (_, i) => ({
		id: `pantry-${String(i).padStart(3, '0')}`,
		name: `Pantry staple ${i + 1}`,
		quantity: 2,
		unit: 'jar',
		category: 'Pantry',
		expires: '2027-02-15'
	}));

	const shopping = Array.from({ length: 30 }, (_, i) => ({
		id: `shop-${String(i).padStart(3, '0')}`,
		name: `Market item ${i + 1}`,
		quantity: 1,
		unit: 'bunch',
		checked: false
	}));

	const meals = Array.from({ length: 12 }, (_, i) => ({
		id: `meal-${String(i).padStart(3, '0')}`,
		date: '2026-11-22',
		slot: slots[i % slots.length],
		recipeId: `recipe-${String(i).padStart(3, '0')}`,
		servings: 4
	}));

	const sanitized = sanitizeKitchenState({
		pantry,
		recipes,
		meals,
		shopping,
		preferences: {
			diet: 'none',
			allergies: 'peanuts',
			cuisines: ['Mediterranean', 'Japanese'],
			maxTime: 30,
			complexity: 'Moderate',
			provider: 'openai',
			model: 'gpt-5.4-mini',
			theme: 'Saffron',
			dark: false,
			onboardingStatus: 'completed',
			ratings: {}
		}
	});
	const fixtureBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
	assert.ok(fixtureBytes >= 280_000 && fixtureBytes <= 420_000);
	return { fixture: sanitized, fixtureBytes };
}

function makeEnumerableStorage() {
	/** @type {Map<string, string>} */
	const values = new Map();
	let journalWrites = 0;
	let journalReads = 0;
	return {
		values,
		get journalWrites() {
			return journalWrites;
		},
		get journalReads() {
			return journalReads;
		},
		resetCounters() {
			journalWrites = 0;
			journalReads = 0;
		},
		storage: {
			get length() {
				return values.size;
			},
			/** @param {number} index */
			key: (index) => [...values.keys()][index] ?? null,
			/** @param {string} key */
			getItem: (key) => {
				if (key.startsWith('flavorithm-pending-journal:')) journalReads += 1;
				return values.get(key) ?? null;
			},
			/**
			 * @param {string} key
			 * @param {string} value
			 */
			setItem: (key, value) => {
				if (key.startsWith('flavorithm-pending-journal:')) journalWrites += 1;
				values.set(key, String(value));
			},
			/** @param {string} key */
			removeItem: (key) => {
				values.delete(key);
			}
		}
	};
}

/**
 * Deterministic in-process Node benchmark of ~317 KB synchronous per-edit journal staging + coalesced network sync.
 * @param {ReturnType<typeof buildLargeKitchenFixture>} input
 */
async function runNodeSyncBenchmark({ fixture, fixtureBytes }) {
	const user = {
		id: 'bench-user',
		name: 'Chef Ada',
		email: 'ada@example.test',
		householdId: 'bench-home'
	};
	const store = makeEnumerableStorage();
	let liveState = structuredClone(fixture);
	let serverState = structuredClone(fixture);
	let serverEtag = 'etag-1';
	let putCount = 0;
	let setStateCount = 0;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let syncTimer;

	const sync = createKitchenSync({
		storage: store.storage,
		getUser: () => user,
		getState: () => sanitizeKitchenState(liveState),
		setState: (next) => {
			setStateCount += 1;
			liveState = sanitizeKitchenState(next);
		},
		onStatus: () => {},
		transport: () => ({
			identity: { userId: user.id, householdId: user.householdId },
			get: async () => ({
				state: structuredClone(serverState),
				etag: serverEtag,
				userId: user.id,
				householdId: user.householdId
			}),
			put: async (next) => {
				putCount += 1;
				serverState = structuredClone(next);
				serverEtag = `etag-${putCount + 1}`;
				return { state: structuredClone(serverState), etag: serverEtag };
			}
		})
	});
	const persistence = createKitchenPersistence({
		storage: store.storage,
		getState: () => ({
			...liveState,
			preferences: sanitizeKitchenState({
				pantry: [],
				recipes: [],
				meals: [],
				shopping: [],
				preferences: liveState.preferences
			}).preferences
		}),
		getUser: () => user,
		sync,
		onAfterPersist: () => {
			clearTimeout(syncTimer);
			syncTimer = setTimeout(() => {
				void sync.sync();
			}, 40);
		}
	});

	sync.initialize(user, structuredClone(fixture), serverEtag);
	// Warm V8 JIT once before timing.
	liveState.preferences.allergies = 'warmup';
	persistence.persist();
	await sync.sync();
	clearTimeout(syncTimer);
	store.resetCounters();
	putCount = 0;
	setStateCount = 0;

	const typed = 'sesame seeds';
	/** @type {number[]} */
	const durations = [];
	for (let i = 1; i <= typed.length; i += 1) {
		const t0 = performance.now();
		liveState.preferences.allergies = typed.slice(0, i);
		persistence.persist();
		durations.push(performance.now() - t0);
	}
	const writesAfterBurst = store.journalWrites;
	const putsDuringBurst = putCount;

	await pause(90);
	assert.equal(writesAfterBurst, typed.length);
	assert.equal(putsDuringBurst, 0);
	assert.equal(putCount, 1);
	assert.equal(setStateCount, 0);

	return {
		fixtureBytes,
		coalesceMs: DEFAULT_SYNC_COALESCE_MS,
		livePreferenceBurst12: {
			meanMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)),
			maxMs: Number(Math.max(...durations).toFixed(2)),
			synchronousJournalWrites: writesAfterBurst,
			putsDuringBurst,
			putsAfterPause: putCount,
			postSyncSetStateCalls: setStateCount
		}
	};
}

/**
 * Minimal Chrome DevTools Protocol client over Node 24's built-in WebSocket.
 * @param {string} wsUrl
 */
async function connectCdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	let nextId = 1;
	/** @type {Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>} */
	const pending = new Map();
	ws.addEventListener('message', (event) => {
		const msg = JSON.parse(String(event.data));
		if (typeof msg.id === 'number') {
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
			else entry.resolve(msg.result);
		}
	});
	return {
		/**
		 * @param {string} method
		 * @param {Record<string, unknown>} [params]
		 */
		send(method, params = {}) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`CDP timeout calling ${method}`));
				}, 15_000);
				pending.set(id, {
					resolve(value) {
						clearTimeout(timer);
						resolve(value);
					},
					reject(err) {
						clearTimeout(timer);
						reject(err);
					}
				});
				ws.send(JSON.stringify({ id, method, params }));
			});
		},
		close() {
			ws.close();
		}
	};
}

/**
 * Optional headless Chrome E2E benchmark against built `server.mjs`.
 * @param {ReturnType<typeof buildLargeKitchenFixture>} input
 */
async function runChromeBenchmark({ fixture, fixtureBytes }) {
	const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
	if (!existsSync(chromeBin)) {
		throw new Error(`Chrome binary not found at ${chromeBin}. Set CHROME_BIN or omit --chrome.`);
	}
	if (!existsSync('build/handler.js')) {
		throw new Error('build/handler.js not found. Run `npm run build` before `--chrome`.');
	}

	const offset = Math.floor(Math.random() * 400);
	const serverPort = 4400 + offset;
	const cdpPort = 9400 + offset;
	const baseUrl = `http://127.0.0.1:${serverPort}`;
	const userDataDir = mkdtempSync(join(tmpdir(), 'flavorithm-bench-chrome-'));

	const server = spawn(process.execPath, ['server.mjs'], {
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(serverPort),
			ORIGIN: baseUrl,
			FLAVORITHM_DB_PATH: ':memory:',
			FLAVORITHM_AUTH_MODE: 'local',
			FLAVORITHM_CHATGPT_AUTH_FLOW: 'local',
			RESEND_API_KEY: '',
			BRAVE_SEARCH_API_KEY: ''
		},
		stdio: 'ignore'
	});
	const chrome = spawn(
		chromeBin,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			`--user-data-dir=${userDataDir}`,
			`--remote-debugging-port=${cdpPort}`,
			'about:blank'
		],
		{ stdio: 'ignore' }
	);

	try {
		for (let i = 0; i < 100; i += 1) {
			try {
				const res = await fetch(`${baseUrl}/api/auth`);
				if (res.ok) break;
			} catch {}
			if (i === 99) throw new Error('Benchmark server did not start in time');
			await pause(100);
		}

		let pageWsUrl = '';
		for (let i = 0; i < 100; i += 1) {
			try {
				const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
				if (res.ok) {
					/** @type {Array<{ type?: string; webSocketDebuggerUrl?: string }>} */
					const targets = await res.json();
					const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
					if (pageTarget?.webSocketDebuggerUrl) {
						pageWsUrl = pageTarget.webSocketDebuggerUrl;
						break;
					}
				}
			} catch {}
			if (i === 99) throw new Error('Chrome CDP endpoint did not start in time');
			await pause(100);
		}

		const cdp = await connectCdp(pageWsUrl);
		await cdp.send('Page.enable');
		await cdp.send('Runtime.enable');
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false
		});
		await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
			source: `(() => {
				const origSetItem = Storage.prototype.setItem;
				window.__perfMetrics = {
					setItems: [],
					puts: [],
					reset() {
						this.setItems = [];
						this.puts = [];
					}
				};
				Storage.prototype.setItem = function(key, value) {
					if (this === window.localStorage) {
						window.__perfMetrics.setItems.push({ key, bytes: String(value).length, t: performance.now() });
					}
					return origSetItem.call(this, key, value);
				};
				const origFetch = window.fetch;
				window.fetch = async function(input, init) {
					const rawUrl = typeof input === 'string' ? input : input?.url || '';
					const method = (init?.method || 'GET').toUpperCase();
					if (rawUrl.includes('/api/state') && method === 'PUT') {
						window.__perfMetrics.puts.push({ t: performance.now() });
					}
					return origFetch.apply(this, arguments);
				};
			})();`
		});

		/**
		 * @param {string} expression
		 */
		const evaluate = async (expression) => {
			const out = await cdp.send('Runtime.evaluate', {
				expression,
				awaitPromise: true,
				returnByValue: true
			});
			if (out.exceptionDetails) {
				throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
			}
			return out.result?.value;
		};

		await cdp.send('Page.navigate', { url: baseUrl });
		await pause(1200);

		const seedStatus = await evaluate(`(async () => {
			const fixture = ${JSON.stringify(fixture)};
			const reg = await fetch('/api/auth', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'register',
					name: 'Chef Ada',
					email: 'ada@example.com',
					password: 'correct-horse-battery'
				})
			});
			if (!reg.ok) throw new Error('register failed: ' + reg.status);
			const getRes = await fetch('/api/state');
			const etag = getRes.headers.get('etag');
			const putRes = await fetch('/api/state', {
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					...(etag ? { 'if-match': etag } : { 'if-none-match': '*' })
				},
				body: JSON.stringify({ state: fixture })
			});
			if (!putRes.ok) throw new Error('seed put failed: ' + putRes.status);
			localStorage.setItem('flavorithm-started', 'yes');
			return putRes.status;
		})()`);
		assert.equal(seedStatus, 200);

		await evaluate(`window.__beforeReload = true`);
		await cdp.send('Page.reload', { ignoreCache: false });
		for (let i = 0; i < 80; i += 1) {
			try {
				const ready = await evaluate(
					`!window.__beforeReload && Boolean(document.querySelector('[aria-label="Open household and account"]') && document.documentElement.dataset.theme)`
				);
				if (ready) break;
			} catch {}
			if (i === 79) throw new Error('Hydrated signed-in kitchen did not become ready after reload');
			await pause(100);
		}
		await pause(300);

		// 1. Theme / color mode immediate DOM update
		const themeToggle = await evaluate(`(async () => {
			window.__perfMetrics.reset();
			const btn = document.querySelector('button[aria-label="Switch color mode"]');
			const t0 = performance.now();
			btn.click();
			await Promise.resolve();
			const durationMs = Number((performance.now() - t0).toFixed(2));
			return {
				darkClassImmediate: document.documentElement.classList.contains('dark'),
				durationMs
			};
		})()`);
		assert.equal(themeToggle.darkClassImmediate, true);
		await pause(600);
		await evaluate(`document.querySelector('button[aria-label="Switch color mode"]').click()`);
		await pause(600);

		// 2. Shopping inline draft 12-keystroke burst + commit
		await evaluate(`(() => {
			const navBtn = Array.from(document.querySelectorAll('aside.sidebar nav button'))
				.find((b) => b.textContent?.includes('Shopping list'));
			navBtn.click();
		})()`);
		await pause(200);
		await evaluate(`document.querySelector('button[aria-label="Edit Market item 1"]').click()`);
		await pause(150);

		const shoppingDraftBurst = await evaluate(`(async () => {
			const input = document.querySelector('input[aria-label="Shopping item name"]');
			input.focus();
			window.__perfMetrics.reset();
			const chars = 'Organic Kale';
			const durations = [];
			input.value = '';
			for (const ch of chars) {
				const t0 = performance.now();
				input.value += ch;
				input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
				await Promise.resolve();
				durations.push(performance.now() - t0);
			}
			const journalWritesWhileTypingDraft = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			input.dispatchEvent(new FocusEvent('blur'));
			input.focus();
			await Promise.resolve();
			const journalWritesAfterCommit = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			const syncChipText = document.querySelector('[aria-label="Kitchen synchronization"]')?.textContent || '';
			return {
				meanMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)),
				maxMs: Number(Math.max(...durations).toFixed(2)),
				journalWritesWhileTypingDraft,
				journalWritesAfterCommit,
				syncChipImmediate: syncChipText.trim(),
				activeStillInput: document.activeElement === input
			};
		})()`);
		assert.equal(shoppingDraftBurst.journalWritesWhileTypingDraft, 0);
		assert.equal(shoppingDraftBurst.journalWritesAfterCommit, 1);
		assert.match(shoppingDraftBurst.syncChipImmediate, /Changes pending on this device/);
		await pause(650);
		const shoppingAfterSync = await evaluate(`(() => ({
			puts: window.__perfMetrics.puts.length,
			activeStillInput: document.activeElement === document.querySelector('input[aria-label="Shopping item name"]')
		}))()`);
		assert.equal(shoppingAfterSync.puts, 1);

		// 3. Pantry inline draft 12-keystroke burst + Done commit
		await evaluate(`(() => {
			const navBtn = Array.from(document.querySelectorAll('aside.sidebar nav button'))
				.find((b) => b.textContent?.includes('My pantry'));
			navBtn.click();
		})()`);
		await pause(200);
		await evaluate(`document.querySelector('button[aria-label="Edit Pantry staple 1"]').click()`);
		await pause(150);

		const pantryDraftBurst = await evaluate(`(async () => {
			const labels = Array.from(document.querySelectorAll('.pantry-row.editing label.pantry-field'));
			const unitLabel = labels.find((el) => el.textContent?.includes('Unit'));
			const input = unitLabel?.querySelector('input');
			input.focus();
			window.__perfMetrics.reset();
			const chars = 'tablespoons!';
			const durations = [];
			input.value = '';
			for (const ch of chars) {
				const t0 = performance.now();
				input.value += ch;
				input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
				await Promise.resolve();
				durations.push(performance.now() - t0);
			}
			const journalWritesWhileTypingDraft = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			const doneBtn = document.querySelector('.pantry-row.editing button.pantry-done-button');
			doneBtn.click();
			await Promise.resolve();
			const journalWritesAfterCommit = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			return {
				meanMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)),
				maxMs: Number(Math.max(...durations).toFixed(2)),
				journalWritesWhileTypingDraft,
				journalWritesAfterCommit
			};
		})()`);
		assert.equal(pantryDraftBurst.journalWritesWhileTypingDraft, 0);
		assert.equal(pantryDraftBurst.journalWritesAfterCommit, 1);
		await pause(650);
		const pantryAfterSync = await evaluate(`(() => ({
			puts: window.__perfMetrics.puts.length
		}))()`);
		assert.equal(pantryAfterSync.puts, 1);

		// 4. Live bound preference input 12-keystroke burst (synchronous per-edit journal + coalesced PUT)
		await evaluate(`(() => {
			const navBtn = Array.from(document.querySelectorAll('aside.sidebar nav button'))
				.find((b) => b.textContent?.includes('Discover'));
			navBtn.click();
		})()`);
		await pause(150);
		await evaluate(`(() => {
			const genBtn = Array.from(document.querySelectorAll('button'))
				.find((b) => b.textContent?.trim() === 'Generate');
			genBtn.click();
		})()`);
		await pause(200);

		const preferenceLiveBurst = await evaluate(`(async () => {
			const input = document.querySelector('input[placeholder*="peanuts"]');
			input.focus();
			window.__perfMetrics.reset();
			const chars = 'sesame seeds';
			const durations = [];
			input.value = '';
			for (const ch of chars) {
				const t0 = performance.now();
				input.value += ch;
				input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
				await Promise.resolve();
				durations.push(performance.now() - t0);
			}
			const journalWrites = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			const putsDuringBurst = window.__perfMetrics.puts.length;
			return {
				meanMs: Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)),
				maxMs: Number(Math.max(...durations).toFixed(2)),
				synchronousJournalWrites: journalWrites,
				putsDuringBurst
			};
		})()`);
		assert.equal(preferenceLiveBurst.synchronousJournalWrites, 12);
		assert.equal(preferenceLiveBurst.putsDuringBurst, 0);
		await pause(650);
		const preferenceAfterSync = await evaluate(`(() => ({
			putsAfterPause: window.__perfMetrics.puts.length
		}))()`);
		assert.equal(preferenceAfterSync.putsAfterPause, 1);

		// 5. Immediate journal durability before network PUT / without relying on pagehide
		const immediateDurability = await evaluate(`(async () => {
			const input = document.querySelector('input[placeholder*="peanuts"]');
			window.__perfMetrics.reset();
			input.value = 'tree nuts & lupin';
			input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'n', inputType: 'insertText' }));
			await Promise.resolve();
			const journalWritesImmediate = window.__perfMetrics.setItems
				.filter((w) => w.key.includes('flavorithm-pending-journal:')).length;
			const putsImmediate = window.__perfMetrics.puts.length;
			window.__beforeReload = true;
			return { journalWritesImmediate, putsImmediate };
		})()`);
		assert.equal(immediateDurability.journalWritesImmediate, 1);
		assert.equal(immediateDurability.putsImmediate, 0);

		await cdp.send('Page.reload', { ignoreCache: false });
		for (let i = 0; i < 80; i += 1) {
			try {
				const ready = await evaluate(
					`!window.__beforeReload && Boolean(document.querySelector('[aria-label="Open household and account"]') && document.documentElement.dataset.theme)`
				);
				if (ready) break;
			} catch {}
			if (i === 79)
				throw new Error('Hydrated signed-in kitchen did not become ready after durability reload');
			await pause(100);
		}
		await pause(300);
		await evaluate(`(() => {
			const genBtn = Array.from(document.querySelectorAll('button'))
				.find((b) => b.textContent?.trim() === 'Generate');
			genBtn.click();
		})()`);
		await pause(200);
		const restoredAllergy = await evaluate(
			`document.querySelector('input[placeholder*="peanuts"]')?.value || ''`
		);
		assert.equal(restoredAllergy, 'tree nuts & lupin');

		cdp.close();
		return {
			fixtureBytes,
			themeToggle,
			shoppingDraftBurst: { ...shoppingDraftBurst, ...shoppingAfterSync },
			pantryDraftBurst: { ...pantryDraftBurst, ...pantryAfterSync },
			preferenceLiveBurst: { ...preferenceLiveBurst, ...preferenceAfterSync },
			immediateDurability: { ...immediateDurability, restoredAllergy }
		};
	} finally {
		chrome.kill('SIGKILL');
		server.kill('SIGKILL');
		rmSync(userDataDir, { recursive: true, force: true });
	}
}

const fixtureData = buildLargeKitchenFixture();
const nodeResults = await runNodeSyncBenchmark(fixtureData);
const useChrome = process.argv.includes('--chrome');
const chromeResults = useChrome ? await runChromeBenchmark(fixtureData) : null;

console.log(
	JSON.stringify(
		{
			node: nodeResults,
			...(chromeResults ? { chrome: chromeResults } : {})
		},
		null,
		2
	)
);
process.exit(0);
