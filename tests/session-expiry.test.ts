import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as svelte from 'svelte';
import * as svelteAnimate from 'svelte/animate';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import ts from 'typescript';
import * as aiConnectionsMod from '../src/lib/ai-connections.ts';
import * as aiContinuationMod from '../src/lib/ai-continuation.ts';
import * as butlerMod from '../src/lib/butler.ts';
import * as butlerChatMod from '../src/lib/butler-chat.ts';
import * as syncMod from '../src/lib/client-sync.ts';
import * as clientWorkflowsMod from '../src/lib/client-workflows.ts';
import * as coverUploadMod from '../src/lib/cover-upload.ts';
import * as dataMod from '../src/lib/data.ts';
import { createInitialState, createNewUserState } from '../src/lib/data.ts';
import * as discoveryMod from '../src/lib/discovery.ts';
import * as domainMod from '../src/lib/domain.ts';
import * as formValidationMod from '../src/lib/form-validation.ts';
import * as guestMod from '../src/lib/guest-storage.ts';
import * as importSessionMod from '../src/lib/import-session.ts';
import * as kitchenExportMod from '../src/lib/kitchen-export.ts';
import * as workflowsMod from '../src/lib/kitchen-workflows.ts';
import { readPendingJournal } from '../src/lib/offline-sync.ts';
import * as plannerMod from '../src/lib/planner.ts';
import * as recipeCollectionMod from '../src/lib/recipe-collection.ts';
import * as coverMod from '../src/lib/recipe-cover.ts';
import * as recipeDetailMod from '../src/lib/recipe-detail.ts';
import * as recipeDraftMod from '../src/lib/recipe-draft.ts';
import * as scraperMod from '../src/lib/recipe-scraper.ts';
import * as stateSchemaMod from '../src/lib/state-schema.ts';
import type { AppState, User } from '../src/lib/types.ts';
import * as voiceCaptureMod from '../src/lib/voice-capture.ts';
import * as voiceConfigMod from '../src/lib/voice-config.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.FLAVORITHM_AUTH_MODE = 'local';

registerHooks({
	load(url, context, nextLoad) {
		if (url.endsWith('.svelte')) {
			const filename = fileURLToPath(url);
			const source = readFileSync(filename, 'utf8');
			const { js } = compile(source, { filename, generate: 'server' });
			return { format: 'module', shortCircuit: true, source: js.code };
		}
		return nextLoad(url, context);
	}
});

const backend = await import('../src/lib/server/db.ts');
const oauthStorage = await import('../src/lib/server/oauth-storage.ts');
const { AIRequestError, runAIRequest } = await import('../src/lib/server/ai.ts');
const hooksServer = await import('../src/hooks.server.ts');
const authRoute = await import('../src/routes/api/auth/+server.ts');
const stateRoute = await import('../src/routes/api/state/+server.ts');
const aiRoute = await import('../src/routes/api/ai/+server.ts');
const modelsRoute = await import('../src/routes/api/models/+server.ts');
const connectionsRoute = await import('../src/routes/api/connections/chatgpt/+server.ts');
const exportRoute = await import('../src/routes/api/export/+server.ts');
const voiceRoute = await import('../src/routes/api/voice/+server.ts');
const syncStatusPath: string = '../src/lib/components/SyncStatus.svelte';
const { default: SyncStatus } = await import(syncStatusPath);

const nodeRequire = createRequire(import.meta.url);
const svelteClient = nodeRequire('svelte/internal/client') as {
	effect_root: (fn: () => void) => () => void;
	flush: (fn?: () => void) => void;
	tick: () => Promise<void>;
	untrack: <T>(fn: () => T) => T;
};
const svelteServer = nodeRequire('svelte/internal/server') as Record<string, unknown>;

// Compile and run the real src/routes/+page.svelte client script rather than copying page logic.
const rawPageSource = readFileSync('src/routes/+page.svelte', 'utf8');

function injectPageHook(svelteSource: string): string {
	const instanceStart = svelteSource.indexOf('<script lang="ts">');
	assert.notEqual(instanceStart, -1, 'expected instance <script lang="ts"> in +page.svelte');
	const instanceEnd = svelteSource.indexOf('</script>', instanceStart);
	assert.notEqual(instanceEnd, -1, 'expected closing </script> for instance script');
	const hook = `
	(globalThis as any).__onSessionPageInit?.({
		get user() { return user; },
		get kitchen() { return kitchen; },
		set kitchen(value: AppState) { kitchen = value; },
		get showStarter() { return showStarter; },
		get sessionExpired() { return sessionExpired; },
		get pendingSync() { return pendingSync; },
		get syncReady() { return syncReady; },
		get syncErrors() { return syncErrors; },
		get toast() { return toast; },
		get toastVersion() { return toastVersion; },
		get modal() { return modal; },
		set authMode(value: 'login' | 'register') { authMode = value; },
		set name(value: string) { name = value; },
		set email(value: string) { email = value; },
		set password(value: string) { password = value; },
		set deletePassword(value: string) { deletePassword = value; },
		request,
		ai,
		loadModelCatalog,
		retrySync,
		refreshAuth,
		reconnectKitchen,
		openSettings,
		authenticate,
		logout,
		deleteAccount,
		exportKitchen
	});
`;
	return svelteSource.slice(0, instanceEnd) + hook + svelteSource.slice(instanceEnd);
}

const hookedPageSource = injectPageHook(rawPageSource);
const scriptEnd =
	hookedPageSource.indexOf('</script>', hookedPageSource.indexOf('<script lang="ts">')) +
	'</script>'.length;
const clientScriptJs = ts.transpileModule(
	compile(hookedPageSource.slice(0, scriptEnd), {
		filename: 'src/routes/+page.svelte',
		generate: 'client'
	}).js.code,
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

type SessionPageApi = {
	readonly user: User | null;
	kitchen: AppState;
	readonly showStarter: boolean;
	readonly sessionExpired: boolean;
	readonly pendingSync: boolean;
	readonly syncReady: boolean;
	readonly syncErrors: string;
	readonly toast: string;
	readonly toastVersion: number;
	readonly modal: string;
	authMode: 'login' | 'register';
	name: string;
	email: string;
	password: string;
	deletePassword: string;
	request: (url: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<any>;
	ai: (action: string, extra?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
	loadModelCatalog: (connectionsTask?: Promise<void>) => Promise<void>;
	retrySync: (prefer?: 'local' | 'remote', expectedEtag?: string | null) => Promise<void>;
	refreshAuth: () => Promise<any>;
	reconnectKitchen: () => Promise<void>;
	openSettings: (focusModel?: boolean) => Promise<void>;
	authenticate: (event: SubmitEvent) => Promise<void>;
	logout: () => Promise<void>;
	deleteAccount: (event: SubmitEvent) => Promise<void>;
	exportKitchen: () => Promise<void>;
};

const noopComponent = () => {};
const iconProxy = new Proxy({}, { get: () => noopComponent });

function createStorage(initial: Iterable<[string, string]> = []) {
	const values = new Map<string, string>(initial);
	const base = {
		values,
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		clear: () => {
			values.clear();
		}
	};
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			if (typeof prop === 'string') return values.get(prop);
			return undefined;
		},
		ownKeys(target) {
			return [...Reflect.ownKeys(target), ...values.keys()];
		},
		getOwnPropertyDescriptor(target, prop) {
			if (typeof prop === 'string' && values.has(prop)) {
				return { enumerable: true, configurable: true, value: values.get(prop) };
			}
			return Reflect.getOwnPropertyDescriptor(target, prop);
		}
	});
}

function createServerClient() {
	let sessionToken: string | undefined;
	let clientIp = '127.0.0.1';
	let externalFetcher: typeof fetch = async (input) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (url === 'https://models.dev/api.json') {
			return Response.json({
				openai: {
					name: 'OpenAI',
					env: ['OPENAI_API_KEY'],
					models: {
						'gpt-4o-mini': {
							id: 'gpt-4o-mini',
							name: 'GPT-4o mini',
							attachment: true,
							tool_call: true
						}
					}
				}
			});
		}
		return Response.json({ localAvailable: false }, { status: 503 });
	};
	let customRouteInterceptor: ((url: URL, request: Request) => Response | null) | null = null;

	const cookies = {
		get: (name: string) => (name === 'flavorithm_session' ? sessionToken : undefined),
		set: (name: string, value: string) => {
			if (name === 'flavorithm_session') sessionToken = value;
		},
		delete: (name: string) => {
			if (name === 'flavorithm_session') sessionToken = undefined;
		}
	};

	async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const rawUrl =
			typeof input === 'string'
				? new URL(input, 'https://flavorithm.example')
				: input instanceof URL
					? input
					: new URL(input.url);
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		if (init?.headers) {
			for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
		}
		const method = (
			init?.method || (input instanceof Request ? input.method : 'GET')
		).toUpperCase();
		if (method !== 'GET' && method !== 'HEAD' && !headers.has('origin')) {
			headers.set('origin', 'https://flavorithm.example');
		}
		const request = new Request(rawUrl.href, {
			method,
			headers,
			body: init?.body ?? null,
			signal: init?.signal
		});

		if (customRouteInterceptor) {
			const intercepted = customRouteInterceptor(rawUrl, request);
			if (intercepted) return intercepted;
		}

		const event: any = {
			url: rawUrl,
			request,
			cookies,
			locals: {},
			fetch: externalFetcher,
			getClientAddress: () => clientIp
		};

		return hooksServer.handle({
			event,
			resolve: async (resolvedEvent: any) => {
				const path = resolvedEvent.url.pathname;
				if (path === '/api/auth') {
					return method === 'POST' ? authRoute.POST(resolvedEvent) : authRoute.GET(resolvedEvent);
				}
				if (path === '/api/state') {
					return method === 'PUT' ? stateRoute.PUT(resolvedEvent) : stateRoute.GET(resolvedEvent);
				}
				if (path === '/api/ai' && method === 'POST') {
					return aiRoute.POST(resolvedEvent);
				}
				if (path === '/api/models' && method === 'GET') {
					return modelsRoute.GET(resolvedEvent);
				}
				if (path === '/api/connections/chatgpt') {
					return method === 'POST'
						? connectionsRoute.POST(resolvedEvent)
						: connectionsRoute.GET(resolvedEvent);
				}
				if (path === '/api/voice' && method === 'GET') {
					return voiceRoute.GET(resolvedEvent);
				}
				if (path === '/api/export' && method === 'GET') {
					return exportRoute.GET(resolvedEvent);
				}
				return Response.json({ error: `Unhandled route ${method} ${path}` }, { status: 404 });
			}
		});
	}

	return {
		setIp(ip: string) {
			clientIp = ip;
		},
		setExternalFetcher(fetcher: typeof fetch) {
			externalFetcher = fetcher;
		},
		setInterceptor(interceptor: ((url: URL, request: Request) => Response | null) | null) {
			customRouteInterceptor = interceptor;
		},
		expireSession() {
			if (sessionToken) backend.deleteSession(sessionToken);
		},
		dispatch,
		async postAuth(body: Record<string, unknown>, ip = '127.0.0.1') {
			const previousIp = clientIp;
			clientIp = ip;
			try {
				const response = await dispatch('/api/auth', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				return { status: response.status, data: await response.json() };
			} finally {
				clientIp = previousIp;
			}
		},
		async getState() {
			const response = await dispatch('/api/state');
			return {
				status: response.status,
				etag: response.headers.get('etag') || '',
				data: await response.json()
			};
		}
	};
}

async function settleAsyncWork() {
	for (let i = 0; i < 6; i += 1) {
		svelteClient.flush();
		await new Promise((resolve) => setImmediate(resolve));
	}
	svelteClient.flush();
}

function createPageInstance(
	server: ReturnType<typeof createServerClient>,
	storage = createStorage(),
	initialOnline = true
) {
	const mountCallbacks: Array<() => void> = [];
	let onlineFlag = initialOnline;
	let autoSyncCount = 0;
	let nextTimerId = 1;
	const activeTimers = new Set<number>();
	const activeAutoSyncTimers = new Set<number>();
	const downloads: Array<{ filename: string; content: string; type: string }> = [];
	const blobUrls = new Map<string, { content: string; type: string }>();
	class RecordedBlob {
		readonly textContent: string;
		readonly type: string;
		constructor(parts: Array<string>, init?: { type?: string }) {
			this.textContent = parts.join('');
			this.type = init?.type ?? '';
		}
		async text() {
			return this.textContent;
		}
	}
	const customUrl = Object.assign(
		function URLProxy(input: string | URL, base?: string | URL) {
			return new URL(input, base);
		},
		{
			createObjectURL: (blob: unknown) => {
				const token = `blob:test-${blobUrls.size + 1}`;
				const recorded = blob as RecordedBlob;
				blobUrls.set(token, {
					content: typeof recorded?.textContent === 'string' ? recorded.textContent : '',
					type: typeof recorded?.type === 'string' ? recorded.type : ''
				});
				return token;
			},
			revokeObjectURL: () => {}
		}
	);
	let api!: SessionPageApi;

	const modMap: Record<string, unknown> = {
		svelte: {
			...svelte,
			onMount: (fn: () => void) => {
				mountCallbacks.push(fn);
			},
			tick: svelteClient.tick,
			untrack: svelteClient.untrack
		},
		'svelte/animate': svelteAnimate,
		'svelte/internal/client': svelteClient,
		'svelte/internal/disclose-version': {},
		'svelte/internal/server': svelteServer,
		'@lucide/svelte': iconProxy,
		'#lib/cover-upload.ts': coverUploadMod,
		'#lib/recipe-cover.ts': coverMod,
		'#lib/focus.ts': { focusTrap: () => ({}) },
		'#lib/form-validation.ts': formValidationMod,
		'#lib/motion.ts': {
			backdropMotion: () => ({}),
			dialogMotion: () => ({}),
			revealMotion: () => ({}),
			fadeMotion: () => ({}),
			motionDuration: () => 0,
			prefersReducedMotion: () => true
		},
		'#lib/planner.ts': plannerMod,
		'#lib/data.ts': dataMod,
		'#lib/domain.ts': domainMod,
		'#lib/import-session.ts': importSessionMod,
		'#lib/kitchen-workflows.ts': workflowsMod,
		'#lib/discovery.ts': discoveryMod,
		'#lib/recipe-collection.ts': recipeCollectionMod,
		'#lib/recipe-detail.ts': recipeDetailMod,
		'#lib/recipe-draft.ts': recipeDraftMod,
		'#lib/butler.ts': butlerMod,
		'#lib/butler-chat.ts': butlerChatMod,
		'#lib/voice-capture.ts': { ...voiceCaptureMod, VoiceCapture: class {} },
		'#lib/voice-config.ts': voiceConfigMod,
		'#lib/ai-connections.ts': aiConnectionsMod,
		'#lib/ai-continuation.ts': aiContinuationMod,
		'#lib/client-workflows.ts': clientWorkflowsMod,
		'#lib/guest-storage.ts': guestMod,
		'#lib/kitchen-export.ts': kitchenExportMod,
		'#lib/client-sync.ts': syncMod,
		'#lib/recipe-scraper.ts': scraperMod,
		'#lib/state-schema.ts': stateSchemaMod,
		'#lib/components/RecipeDetail.svelte': { default: noopComponent },
		'#lib/components/ButlerChat.svelte': { default: noopComponent },
		'#lib/components/RecipeEditor.svelte': { default: noopComponent },
		'#lib/components/SyncStatus.svelte': { default: noopComponent },
		'#lib/components/AIConnection.svelte': { default: noopComponent },
		'#lib/components/VoiceSettings.svelte': { default: noopComponent },
		'#lib/components/RecipeImport.svelte': {
			default: noopComponent,
			emptyImportSession: importSessionMod.emptyImportSession
		}
	};

	const exports: { default?: any } = {};
	const sandbox: Record<string, unknown> = {
		exports,
		require: (id: string) => {
			if (id in modMap) return modMap[id];
			if (id.startsWith('#lib/components/') && id.endsWith('.svelte')) {
				return { __esModule: true, default: noopComponent };
			}
			throw new Error(`Unexpected +page.svelte dependency ${id}`);
		},
		Date,
		Intl,
		Map,
		Set,
		Number,
		String,
		Boolean,
		Array,
		Object,
		Math,
		JSON,
		RegExp,
		Error,
		RangeError,
		TypeError,
		DOMException,
		Blob: RecordedBlob,
		CSS: { escape: (value: string) => value },
		Promise,
		URL: customUrl,
		URLSearchParams,
		Headers,
		Response,
		Request,
		AbortController,
		AbortSignal,
		structuredClone,
		encodeURIComponent,
		decodeURIComponent,
		crypto,
		console,
		setTimeout: (_fn: () => void, ms?: number) => {
			const id = nextTimerId++;
			activeTimers.add(id);
			if (ms === 500) {
				autoSyncCount += 1;
				activeAutoSyncTimers.add(id);
			}
			return id;
		},
		clearTimeout: (id: number) => {
			activeTimers.delete(id);
			activeAutoSyncTimers.delete(id);
		},
		setInterval: () => nextTimerId++,
		clearInterval: () => {},
		localStorage: storage,
		sessionStorage: createStorage(),
		document: {
			documentElement: {
				dataset: {} as Record<string, string>,
				classList: { toggle: () => {} }
			},
			createElement: (tag: string) => ({
				tag,
				href: '',
				download: '',
				click() {
					const payload = blobUrls.get(this.href);
					downloads.push({
						filename: this.download,
						content: payload?.content ?? '',
						type: payload?.type ?? ''
					});
				}
			})
		},
		navigator: {
			get onLine() {
				return onlineFlag;
			}
		},
		window: {
			location: {
				href: 'https://flavorithm.example/',
				assign: () => {},
				reload: () => {}
			},
			history: {
				replaceState: () => {}
			},
			addEventListener: () => {},
			removeEventListener: () => {},
			scrollTo: () => {}
		},
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			if (!onlineFlag) throw new TypeError('Failed to fetch');
			return server.dispatch(input, init);
		}
	};
	sandbox.globalThis = sandbox;
	sandbox.__onSessionPageInit = (instance: SessionPageApi) => {
		api = instance;
	};

	runInNewContext(clientScriptJs, sandbox);
	const dispose = svelteClient.effect_root(() => {
		exports.default(null, { data: { authMode: 'local', loginUrl: null, logoutUrl: null } });
	});
	svelteClient.flush();

	return {
		storage,
		dispose,
		get user() {
			return api.user;
		},
		get kitchen() {
			return api.kitchen;
		},
		get showStarter() {
			return api.showStarter;
		},
		get sessionExpired() {
			return api.sessionExpired;
		},
		get pendingSync() {
			return api.pendingSync;
		},
		get syncErrors() {
			return api.syncErrors;
		},
		get toast() {
			return api.toast;
		},
		get toastVersion() {
			return api.toastVersion;
		},
		get autoSyncCount() {
			return autoSyncCount;
		},
		get activeAutoSyncTimers() {
			return activeAutoSyncTimers.size;
		},
		set online(value: boolean) {
			onlineFlag = value;
		},
		async mount() {
			for (const fn of mountCallbacks) fn();
			await settleAsyncWork();
		},
		mutateKitchen(mutator: (draft: AppState) => void) {
			const next = structuredClone(JSON.parse(JSON.stringify(api.kitchen)) as AppState);
			mutator(next);
			api.kitchen = next;
			svelteClient.flush();
		},
		async authenticate(args: {
			action: 'login' | 'register';
			name?: string;
			email: string;
			password: string;
			ip?: string;
		}) {
			if (args.ip) server.setIp(args.ip);
			api.authMode = args.action;
			if (args.name !== undefined) api.name = args.name;
			api.email = args.email;
			api.password = args.password;
			await api.authenticate({ preventDefault: () => {} } as SubmitEvent);
			await settleAsyncWork();
		},
		async logout() {
			await api.logout();
			await settleAsyncWork();
		},
		async deleteAccount(password: string) {
			api.deletePassword = password;
			await api.deleteAccount({ preventDefault: () => {} } as SubmitEvent);
			await settleAsyncWork();
		},
		async refreshAuth() {
			const result = await api.refreshAuth();
			await settleAsyncWork();
			return result;
		},
		async reconnectKitchen() {
			await api.reconnectKitchen();
			await settleAsyncWork();
		},
		async openSettings() {
			await api.openSettings();
			await settleAsyncWork();
		},
		async retrySync() {
			await api.retrySync();
			await settleAsyncWork();
		},
		async callAI(body: Record<string, unknown>, fetcher?: typeof fetch) {
			if (fetcher) server.setExternalFetcher(fetcher);
			try {
				return await api.request('/api/ai', body, 'POST');
			} finally {
				await settleAsyncWork();
			}
		},
		async callModels(search = '', fetcher?: typeof fetch) {
			if (fetcher) server.setExternalFetcher(fetcher);
			try {
				return await api.request(`/api/models${search}`);
			} finally {
				await settleAsyncWork();
			}
		},
		get downloads() {
			return downloads;
		},
		async exportKitchen() {
			await api.exportKitchen();
			await settleAsyncWork();
		}
	};
}

test('real +page.svelte logout and deleteAccount preserve custom flavorithm-guest-kitchen entries and match showStarter', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-pantry-1', name: 'tahini', quantity: 1, unit: 'jar', category: 'Condiments' }
	];
	customGuest.meals = [
		{
			id: 'guest-meal-1',
			date: '2026-11-24',
			slot: 'Lunch',
			recipeId: 'lemon-chickpea-orzo',
			servings: 3
		}
	];
	customGuest.shopping = [
		{ id: 'guest-shop-1', name: 'pita bread', quantity: 6, unit: 'pieces', checked: false }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createPageInstance(server, storage);
	try {
		await app.mount();
		assert.equal(app.showStarter, false);
		assert.equal(app.kitchen.pantry[0].name, 'tahini');

		const password = 'A very strong test password 123!';
		await server.postAuth(
			{ action: 'register', name: 'Household Chef', email: 'chef1@example.test', password },
			'10.0.0.1'
		);
		await server.postAuth({ action: 'logout' }, '10.0.0.1');

		await app.authenticate({
			action: 'login',
			email: 'chef1@example.test',
			password,
			ip: '10.0.0.1'
		});
		app.mutateKitchen((draft) => {
			draft.pantry = [
				{ id: 'home-saffron', name: 'saffron', quantity: 2, unit: 'grams', category: 'Spices' }
			];
		});
		await app.retrySync();
		assert.equal(JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry[0].name, 'tahini');

		await app.logout();
		assert.equal(app.user, null);
		assert.equal(app.showStarter, false);
		assert.equal(storage.values.has('flavorithm-last-account'), false);
		assert.equal(app.kitchen.pantry[0].id, 'guest-pantry-1');
		assert.equal(app.kitchen.meals[0].id, 'guest-meal-1');
		assert.equal(app.kitchen.shopping[0].id, 'guest-shop-1');

		await app.authenticate({
			action: 'login',
			email: 'chef1@example.test',
			password,
			ip: '10.0.0.1'
		});
		await app.deleteAccount(password);
		assert.equal(app.user, null);
		assert.equal(app.showStarter, false);
		assert.equal(app.kitchen.pantry[0].id, 'guest-pantry-1');
		assert.equal(app.kitchen.meals[0].id, 'guest-meal-1');
		assert.equal(app.kitchen.shopping[0].id, 'guest-shop-1');
		assert.equal(
			JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry[0].id,
			'guest-pantry-1'
		);

		// Registering a new account from that saved guest kitchen moves the data into the account
		// and clears guest storage so logging out does not resurrect a stale copy.
		await app.authenticate({
			action: 'register',
			name: 'Registered Guest',
			email: 'registered-guest@example.test',
			password,
			ip: '10.0.0.1'
		});
		assert.equal(app.kitchen.pantry[0].id, 'guest-pantry-1');
		assert.equal(storage.values.has('flavorithm-guest-kitchen'), false);
		assert.equal(storage.values.has('flavorithm-started'), false);

		await app.logout();
		assert.equal(app.user, null);
		assert.equal(app.showStarter, true);
		assert.equal(app.kitchen.pantry.length, createInitialState().pantry.length);
		assert.equal(
			app.kitchen.pantry.some((item) => item.id === 'guest-pantry-1'),
			false
		);
	} finally {
		app.dispose();
	}
});

test('real +page.svelte tearing down without a valid guest snapshot restores createInitialState with showStarter = true', async () => {
	const server = createServerClient();
	const storage = createStorage([['flavorithm-started', 'yes']]);
	const app = createPageInstance(server, storage);
	try {
		await app.mount();
		const password = 'A very strong test password 123!';
		await server.postAuth(
			{ action: 'register', name: 'No Guest User', email: 'noguest@example.test', password },
			'10.0.0.2'
		);
		await app.authenticate({
			action: 'login',
			email: 'noguest@example.test',
			password,
			ip: '10.0.0.2'
		});
		assert.equal(app.showStarter, false);

		storage.removeItem('flavorithm-guest-kitchen');
		storage.setItem('flavorithm-started', 'yes');
		await app.logout();
		assert.equal(app.showStarter, true);
		assert.equal(storage.values.has('flavorithm-started'), false);
		assert.equal(app.kitchen.pantry.length, createInitialState().pantry.length);
	} finally {
		app.dispose();
	}
});

test('real +page.svelte local session expiry pauses auto-sync, keeps last-account, notifies once, restores offline/online without guest replacement, and merges edits after re-login', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-only', name: 'maple syrup', quantity: 1, unit: 'bottle', category: 'Pantry' }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createPageInstance(server, storage);
	let offlineReload: ReturnType<typeof createPageInstance> | undefined;
	let offlineNoBaselineReload: ReturnType<typeof createPageInstance> | undefined;
	let onlineExpiredReload: ReturnType<typeof createPageInstance> | undefined;
	try {
		await app.mount();

		const password = 'A very strong test password 123!';
		await server.postAuth(
			{ action: 'register', name: 'Ada Lovelace', email: 'ada@example.test', password },
			'10.0.0.3'
		);
		await app.authenticate({
			action: 'login',
			email: 'ada@example.test',
			password,
			ip: '10.0.0.3'
		});
		app.mutateKitchen((draft) => {
			draft.pantry = [
				{ id: 'p-flour', name: 'bread flour', quantity: 4, unit: 'cups', category: 'Baking' }
			];
		});
		await app.retrySync();
		const accountUser = structuredClone(JSON.parse(JSON.stringify(app.user)) as User);

		const toastVersionBeforeExpiry = app.toastVersion;
		server.expireSession();
		await app.openSettings();
		assert.equal(app.sessionExpired, true);
		assert.deepEqual(JSON.parse(JSON.stringify(app.user)), accountUser);
		assert.equal(app.kitchen.pantry[0].quantity, 4);
		assert.ok(storage.getItem('flavorithm-last-account'));
		assert.equal(app.toastVersion, toastVersionBeforeExpiry + 1);
		assert.equal(app.toast, guestMod.SESSION_EXPIRED_MESSAGE);

		await app.reconnectKitchen();
		assert.equal(app.toastVersion, toastVersionBeforeExpiry + 1);
		assert.equal(app.sessionExpired, true);

		const syncCountBefore = app.autoSyncCount;
		app.mutateKitchen((draft) => {
			draft.pantry[0].quantity = 9;
			draft.meals.push({
				id: 'expired-meal-1',
				date: '2026-11-25',
				slot: 'Dinner',
				recipeId: 'lemon-herb-chicken',
				servings: 2
			});
			draft.shopping.push({
				id: 'expired-shop-1',
				name: 'lemons',
				quantity: 4,
				unit: 'whole',
				checked: false
			});
		});
		assert.equal(app.autoSyncCount, syncCountBefore);
		assert.equal(app.pendingSync, true);
		const journalRecords = readPendingJournal(storage, accountUser).records;
		assert.equal(journalRecords.length, 1);
		assert.equal(
			JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry[0].id,
			'guest-only'
		);

		const rendered = render(SyncStatus, {
			props: {
				kitchen: app.kitchen,
				online: true,
				pending: app.pendingSync,
				syncing: false,
				conflicts: [],
				sessionExpired: app.sessionExpired,
				signIn: () => {},
				retry: () => {},
				resolve: () => {},
				exportPending: () => {}
			}
		});
		assert.match(rendered.body, /Session expired/);
		assert.match(rendered.body, /<button class="primary">Sign in<\/button>/);

		// Offline reload restores journal even when confirmed baseline key is evicted.
		const journalOnlyStorage = createStorage(
			[...storage.values.entries()].filter(([key]) => !key.startsWith('flavorithm-confirmed:v1:'))
		);
		offlineReload = createPageInstance(server, journalOnlyStorage, false);
		await offlineReload.mount();
		assert.deepEqual(JSON.parse(JSON.stringify(offlineReload.user)), accountUser);
		assert.equal(offlineReload.kitchen.pantry[0].quantity, 9);
		assert.equal(offlineReload.kitchen.meals.length, 1);
		assert.equal(offlineReload.kitchen.shopping.length, 1);

		// Even when restore() returns false (cached account with no baseline and no journal), +page.svelte keeps cached user and never loads guest snapshot.
		const noBaselineNoJournalStorage = createStorage([
			['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
			['flavorithm-started', 'yes'],
			['flavorithm-last-account', JSON.stringify(accountUser)]
		]);
		offlineNoBaselineReload = createPageInstance(server, noBaselineNoJournalStorage, false);
		await offlineNoBaselineReload.mount();
		assert.deepEqual(JSON.parse(JSON.stringify(offlineNoBaselineReload.user)), accountUser);
		assert.equal(
			offlineNoBaselineReload.kitchen.pantry.some((item) => item.id === 'guest-only'),
			false
		);
		assert.deepEqual(offlineNoBaselineReload.kitchen.pantry, createNewUserState().pantry);

		// Online reload while still expired restores flavorithm-last-account in sessionExpired = true mode.
		onlineExpiredReload = createPageInstance(server, storage);
		await onlineExpiredReload.mount();
		assert.equal(onlineExpiredReload.sessionExpired, true);
		assert.deepEqual(JSON.parse(JSON.stringify(onlineExpiredReload.user)), accountUser);
		assert.equal(onlineExpiredReload.kitchen.pantry[0].quantity, 9);
		assert.equal(
			JSON.parse(storage.getItem('flavorithm-guest-kitchen')!).pantry[0].id,
			'guest-only'
		);

		// Re-login clears sessionExpired, merges offline edits, and syncs them to /api/state.
		await onlineExpiredReload.authenticate({
			action: 'login',
			email: 'ada@example.test',
			password,
			ip: '10.0.0.3'
		});
		assert.equal(onlineExpiredReload.sessionExpired, false);
		assert.equal(onlineExpiredReload.pendingSync, false);
		assert.equal(readPendingJournal(storage, accountUser).records.length, 0);
		const serverState = await server.getState();
		assert.equal(serverState.status, 200);
		assert.equal(serverState.data.state.pantry[0].quantity, 9);
		assert.equal(serverState.data.state.meals[0].id, 'expired-meal-1');
		assert.equal(serverState.data.state.shopping[0].id, 'expired-shop-1');
	} finally {
		offlineReload?.dispose();
		offlineNoBaselineReload?.dispose();
		onlineExpiredReload?.dispose();
		app.dispose();
	}
});

test('real +page.svelte signing out or registering during sessionExpired isolates prior journals and never leaks household data into guest storage', async () => {
	const customGuest = createInitialState();
	customGuest.pantry = [
		{ id: 'guest-tea', name: 'earl grey tea', quantity: 1, unit: 'tin', category: 'Beverages' }
	];
	const server = createServerClient();
	const storage = createStorage([
		['flavorithm-guest-kitchen', JSON.stringify(customGuest)],
		['flavorithm-started', 'yes']
	]);
	const app = createPageInstance(server, storage);
	try {
		await app.mount();

		const password = 'A very strong test password 123!';
		await server.postAuth(
			{ action: 'register', name: 'Old Owner', email: 'old-owner@example.test', password },
			'10.0.0.4'
		);
		await app.authenticate({
			action: 'login',
			email: 'old-owner@example.test',
			password,
			ip: '10.0.0.4'
		});
		const oldOwner = structuredClone(JSON.parse(JSON.stringify(app.user)) as User);

		server.expireSession();
		await app.refreshAuth();
		assert.equal(app.sessionExpired, true);
		app.mutateKitchen((draft) => {
			draft.pantry = [
				{ id: 'private-caviar', name: 'caviar', quantity: 2, unit: 'tins', category: 'Seafood' }
			];
		});

		await app.authenticate({
			action: 'register',
			name: 'New Owner',
			email: 'new-owner@example.test',
			password,
			ip: '10.0.0.4'
		});
		assert.equal(app.sessionExpired, false);
		assert.equal(app.user?.email, 'new-owner@example.test');
		assert.equal(app.kitchen.pantry[0].id, 'guest-tea');
		assert.equal(
			app.kitchen.pantry.some((item) => item.id === 'private-caviar'),
			false
		);
		assert.equal(readPendingJournal(storage, oldOwner).records.length, 1);
		assert.equal(storage.values.has('flavorithm-guest-kitchen'), false);
		assert.equal(storage.values.has('flavorithm-started'), false);

		const newOwner = structuredClone(JSON.parse(JSON.stringify(app.user)) as User);
		server.expireSession();
		await app.reconnectKitchen();
		assert.equal(app.sessionExpired, true);
		app.mutateKitchen((draft) => {
			draft.shopping = [
				{ id: 'new-owner-shop', name: 'coffee beans', quantity: 1, unit: 'bag', checked: false }
			];
		});
		await app.logout();
		assert.equal(app.user, null);
		assert.equal(app.sessionExpired, false);
		assert.equal(app.showStarter, true);
		assert.equal(app.kitchen.pantry.length, createInitialState().pantry.length);
		assert.equal(
			app.kitchen.pantry.some((item) => item.id === 'guest-tea' || item.id === 'private-caviar'),
			false
		);
		assert.deepEqual(app.kitchen.shopping, []);
		assert.equal(readPendingJournal(storage, oldOwner).records.length, 1);
		assert.equal(readPendingJournal(storage, newOwner).records.length, 1);
	} finally {
		app.dispose();
	}
});

test('real +page.svelte keeps sessionExpired false and sync active on /api/ai and /api/models provider errors or unmarked 401s while pausing sync on session_expired 401s', async () => {
	const server = createServerClient();
	const storage = createStorage();
	const app = createPageInstance(server, storage);
	try {
		await app.mount();

		const password = 'A very strong test password 123!';
		await server.postAuth(
			{
				action: 'register',
				name: 'Provider Tester',
				email: 'provider-auth@example.test',
				password
			},
			'10.0.0.5'
		);
		await app.authenticate({
			action: 'login',
			email: 'provider-auth@example.test',
			password,
			ip: '10.0.0.5'
		});
		assert.equal(app.sessionExpired, false);

		// 1. Missing ChatGPT connection context throws 401 in runAIRequest, which /api/ai remaps via ai-route-errors.ts — and even an unmarked 401 from /api/ai never expires the Flavorithm session.
		await assert.rejects(
			() =>
				runAIRequest({
					action: 'vision',
					provider: 'chatgpt',
					model: 'gpt-4o-mini',
					image: 'data:image/png;base64,aGVsbG8='
				}),
			(err: unknown) =>
				err instanceof AIRequestError &&
				err.status === 401 &&
				/Connect a ChatGPT account/i.test(err.message)
		);

		// 2. Hard rule: a provider 401 or main's provider_auth / host_ai_unavailable codes from /api/ai never expire the Flavorithm session.
		for (const simulated of [
			{ status: 401, body: { error: 'Connect a ChatGPT account before using your plan.' } },
			{
				status: 409,
				body: { error: 'Connect a ChatGPT account before using your plan.', code: 'provider_auth' }
			},
			{
				status: 503,
				body: { error: 'Host AI is temporarily unavailable.', code: 'host_ai_unavailable' }
			}
		]) {
			server.setInterceptor((url) =>
				url.pathname === '/api/ai'
					? Response.json(simulated.body, { status: simulated.status })
					: null
			);
			await assert.rejects(
				() =>
					app.callAI({
						action: 'vision',
						usePersonalAI: true,
						provider: 'chatgpt',
						model: 'gpt-4o-mini',
						image: 'data:image/png;base64,aGVsbG8='
					}),
				{
					status: simulated.status,
					message: simulated.body.error
				}
			);
			assert.equal(app.sessionExpired, false);
		}
		server.setInterceptor(null);

		// 3. Non-ChatGPT API-key upstream 401 on /api/ai surfaces as 502 upstream provider error on main without expiring the session.
		await assert.rejects(
			() =>
				app.callAI(
					{
						action: 'vision',
						usePersonalAI: true,
						provider: 'openai',
						model: 'gpt-4o-mini',
						apiKey: 'sk-invalid-key',
						image: 'data:image/png;base64,aGVsbG8='
					},
					async (input) => {
						const url =
							typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
						if (url === 'https://models.dev/api.json') {
							return Response.json({
								openai: {
									name: 'OpenAI',
									env: ['OPENAI_API_KEY'],
									models: {
										'gpt-4o-mini': {
											id: 'gpt-4o-mini',
											name: 'GPT-4o mini',
											attachment: true,
											tool_call: true
										}
									}
								}
							});
						}
						return Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 });
					}
				),
			{
				status: 502,
				message: 'AI provider request failed with status 401.'
			}
		);
		assert.equal(app.sessionExpired, false);

		// 4. Expired ChatGPT OAuth token returns 409 chatgpt_reauth_required on /api/ai and /api/models without expiring the Flavorithm session.
		const expiredAccount = oauthStorage.saveChatGPTAccount({
			userId: app.user!.id,
			mode: 'local',
			clientId: 'dynamic_agent_client',
			subject: 'expired-oauth-subject',
			email: 'provider-auth@example.test',
			scopes: ['openid', 'chatgpt.tokens.use.direct'],
			credentials: {
				accessToken: 'expired-access-token',
				refreshToken: '',
				idToken: 'expired-id-token'
			},
			expiresAt: Date.now() - 60_000,
			earliestRefreshAt: 0
		});

		await assert.rejects(
			() =>
				app.callAI({
					action: 'vision',
					usePersonalAI: true,
					provider: 'chatgpt',
					connectionId: expiredAccount.id,
					model: 'gpt-4o-mini',
					image: 'data:image/png;base64,aGVsbG8='
				}),
			{
				status: 409,
				code: 'chatgpt_reauth_required',
				message: 'Reconnect this ChatGPT account to continue.'
			}
		);
		assert.equal(app.sessionExpired, false);

		await assert.rejects(
			() =>
				app.callModels(`?connection=chatgpt&accountId=${encodeURIComponent(expiredAccount.id)}`),
			{
				status: 409,
				code: 'chatgpt_reauth_required',
				message: 'Reconnect this ChatGPT account to continue.'
			}
		);
		assert.equal(app.sessionExpired, false);

		// 5. Upstream OpenAI 401 with an active local token (and unrefreshable grant) maps to 409 chatgpt_reauth_required on /api/ai without expiring the Flavorithm session.
		const liveAccount = oauthStorage.saveChatGPTAccount({
			userId: app.user!.id,
			mode: 'local',
			clientId: 'dynamic_agent_client_live',
			subject: 'live-oauth-subject',
			email: 'provider-auth@example.test',
			scopes: ['openid', 'chatgpt.tokens.use.direct'],
			credentials: {
				accessToken: 'live-access-token',
				refreshToken: '',
				idToken: 'live-id-token'
			},
			expiresAt: Date.now() + 3_600_000,
			earliestRefreshAt: 0
		});
		await assert.rejects(
			() =>
				app.callAI(
					{
						action: 'vision',
						usePersonalAI: true,
						provider: 'chatgpt',
						connectionId: liveAccount.id,
						model: 'gpt-4o-mini',
						image: 'data:image/png;base64,aGVsbG8='
					},
					async () => Response.json({ error: { message: 'upstream 401' } }, { status: 401 })
				),
			{
				status: 409,
				code: 'chatgpt_reauth_required'
			}
		);
		assert.equal(app.sessionExpired, false);

		// Kitchen sync continues scheduling and syncing edits after provider errors.
		const syncCountBeforeEdit = app.autoSyncCount;
		app.mutateKitchen((draft) => {
			draft.pantry = [
				{
					id: 'synced-olive-oil',
					name: 'olive oil',
					quantity: 1,
					unit: 'bottle',
					category: 'Pantry'
				}
			];
		});
		assert.ok(app.autoSyncCount > syncCountBeforeEdit);
		assert.equal(app.activeAutoSyncTimers, 1);
		await app.retrySync();
		assert.equal(app.pendingSync, false);
		const persisted = await server.getState();
		assert.equal(persisted.status, 200);
		assert.equal(persisted.data.state.pantry[0].id, 'synced-olive-oil');

		// 5. Genuine Flavorithm session expiry returns 401 with code: 'session_expired' via hooks.server.ts, setting sessionExpired = true and pausing auto-sync.
		const toastsBeforeExpiry = app.toastVersion;
		server.expireSession();
		await assert.rejects(
			() =>
				app.callAI({
					action: 'vision',
					usePersonalAI: true,
					provider: 'chatgpt',
					connectionId: liveAccount.id,
					model: 'gpt-4o-mini',
					image: 'data:image/png;base64,aGVsbG8='
				}),
			{
				status: 401,
				code: 'session_expired',
				message: 'Authentication required'
			}
		);
		assert.equal(app.sessionExpired, true);
		assert.equal(app.activeAutoSyncTimers, 0);
		assert.equal(app.toastVersion, toastsBeforeExpiry + 1);
		assert.equal(app.toast, guestMod.SESSION_EXPIRED_MESSAGE);

		const syncCountDuringExpired = app.autoSyncCount;
		app.mutateKitchen((draft) => {
			draft.pantry[0].quantity = 3;
		});
		assert.equal(app.autoSyncCount, syncCountDuringExpired);
		assert.equal(app.activeAutoSyncTimers, 0);
		assert.equal(app.pendingSync, true);

		// Exporting while sessionExpired downloads a local backup with pending edits and the session-expired notice.
		await app.exportKitchen();
		assert.equal(app.downloads.length, 1);
		const exported = JSON.parse(app.downloads[0].content);
		assert.equal(exported.source, 'offline');
		assert.equal(exported.hasPendingChanges, true);
		assert.equal(exported.state.pantry[0].quantity, 3);
		assert.match(app.toast, /session expired/i);
	} finally {
		app.dispose();
	}
});
