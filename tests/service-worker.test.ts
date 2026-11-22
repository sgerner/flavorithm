import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const formatHost: ts.FormatDiagnosticsHost = {
	getCanonicalFileName: (fileName) => fileName,
	getCurrentDirectory: () => process.cwd(),
	getNewLine: () => '\n'
};

function typecheckServiceWorker(overrideWorkerSource?: string): readonly ts.Diagnostic[] {
	if (!existsSync('node_modules/$app/tsconfig/service-worker.json')) {
		execFileSync(process.execPath, ['node_modules/@sveltejs/kit/svelte-kit.js', 'sync'], {
			stdio: 'inherit'
		});
	}
	const configPath = resolve('tsconfig.service-worker.json');
	const workerPath = resolve('src/service-worker.ts');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	assert.equal(
		configFile.error,
		undefined,
		configFile.error ? ts.formatDiagnostics([configFile.error], formatHost) : undefined
	);
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
	assert.equal(parsed.errors.length, 0, ts.formatDiagnostics(parsed.errors, formatHost));
	const baseHost = ts.createCompilerHost(parsed.options);
	if (overrideWorkerSource !== undefined) {
		const originalGetSourceFile = baseHost.getSourceFile.bind(baseHost);
		baseHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
			if (resolve(fileName) === workerPath) {
				return ts.createSourceFile(fileName, overrideWorkerSource, languageVersion);
			}
			return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
		};
	}
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: parsed.options,
		host: baseHost
	});
	return ts.getPreEmitDiagnostics(program);
}

// Execute the real worker against Fetch/Cache doubles to test the auth boundary, not a copy of it.
const workerDiagnostics = typecheckServiceWorker();
assert.equal(workerDiagnostics.length, 0, ts.formatDiagnostics(workerDiagnostics, formatHost));
const source = ts.transpileModule(readFileSync('src/service-worker.ts', 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function workerHarness(initialMode: string) {
	const origin = 'https://kitchen.example.test';
	let mode = initialMode;
	let offline = false;
	let loginHtml = false;
	let immutableBody = '/* static */';
	let iconBody = '<svg id="v1"></svg>';
	let putGate: Promise<void> | null = null;
	const stored = new Map<string, Response>();
	const cacheBuckets = new Set<string>(['flavorithm-old', 'flavorithm-test', 'unrelated-cache']);
	const credentials: Array<{ path: string; credentials: string; cache: RequestCache }> = [];
	const waitUntilTasks: Array<Promise<unknown>> = [];
	const handlers = new Map<string, (event: any) => void>();
	const cache = {
		put: async (request: Request, response: Response) => {
			assert.equal(request.credentials, 'omit');
			if (putGate) await putGate;
			stored.set(request.url, response.clone());
		},
		match: async (request: Request) => stored.get(request.url)?.clone(),
		delete: async (request: Request) => stored.delete(request.url)
	};
	runInNewContext(source, {
		exports: {},
		URL,
		Request,
		Response,
		require: (name: string) => {
			if (name === '$app/env') return { version: 'test' };
			if (name === '$app/manifest')
				return {
					assets: [
						{ path: 'favicon.svg' },
						{ path: 'manifest.webmanifest' },
						{ path: 'api/asset-bypass.js' }
					],
					immutable: [{ path: '_app/test.js' }, { path: 'api/immutable-bypass.js' }],
					prerendered: [{ path: '/api/prerendered-bypass' }]
				};
			if (name === '$app/paths')
				return {
					resolve: (path: string) => (path.startsWith('/') ? path : '/' + path),
					asset: (path: string) => '/' + path
				};
			throw new Error(`Unexpected worker dependency ${name}`);
		},
		self: {
			location: { origin },
			addEventListener: (name: string, callback: (event: any) => void) =>
				handlers.set(name, callback),
			skipWaiting: async () => {},
			clients: { claim: async () => {} }
		},
		caches: {
			open: async (name: string) => {
				cacheBuckets.add(name);
				return cache;
			},
			keys: async () => [...cacheBuckets],
			delete: async (name: string) => cacheBuckets.delete(name)
		},
		fetch: async (request: Request) => {
			if (offline) throw new TypeError('Offline test fixture');
			const path = new URL(request.url).pathname;
			credentials.push({ path, credentials: request.credentials, cache: request.cache });
			if (path === '/api/auth') return Response.json({ user: null, authMode: mode });
			if (path === '/_app/test.js' && !loginHtml)
				return new Response(immutableBody, { headers: { 'content-type': 'text/javascript' } });
			if (path === '/favicon.svg' && !loginHtml)
				return new Response(iconBody, { headers: { 'content-type': 'image/svg+xml' } });
			if (path === '/manifest.webmanifest' && !loginHtml)
				return new Response('{"name":"Flavorithm"}', {
					headers: { 'content-type': 'application/manifest+json' }
				});
			return new Response(loginHtml ? '<h1>Gateway login</h1>' : '<h1>Kitchen shell</h1>', {
				headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': mode }
			});
		}
	});
	function dispatch(path: string, navigate = false) {
		let pending: Promise<Response> | undefined;
		const eventWaitUntil: Array<Promise<unknown>> = [];
		const request = new Request(origin + path);
		handlers.get('fetch')!({
			request: navigate
				? {
						url: request.url,
						method: 'GET',
						mode: 'navigate',
						credentials: 'include',
						headers: request.headers
					}
				: request,
			respondWith: (value: Promise<Response>) => {
				pending = value;
			},
			waitUntil: (value: Promise<unknown>) => {
				eventWaitUntil.push(value);
				waitUntilTasks.push(value);
			}
		});
		return { pending, waitUntil: eventWaitUntil };
	}
	return {
		stored,
		cacheBuckets,
		credentials,
		waitUntilTasks,
		setMode: (value: string) => {
			mode = value;
		},
		goOffline: (value = true) => {
			offline = value;
		},
		serveLoginHtml: (value = true) => {
			loginHtml = value;
		},
		setImmutableBody: (value: string) => {
			immutableBody = value;
		},
		setIconBody: (value: string) => {
			iconBody = value;
		},
		gateCachePut: () => {
			let release!: () => void;
			putGate = new Promise<void>((resolve) => {
				release = () => {
					putGate = null;
					resolve();
				};
			});
			return release;
		},
		flushWaitUntil: async () => {
			while (waitUntilTasks.length > 0) {
				const batch = waitUntilTasks.splice(0);
				await Promise.all(batch);
			}
		},
		install: async () => {
			let pending: Promise<unknown> | undefined;
			handlers.get('install')!({
				waitUntil: (value: Promise<unknown>) => {
					pending = value;
				}
			});
			await pending;
		},
		activate: async () => {
			let pending: Promise<unknown> | undefined;
			handlers.get('activate')!({
				waitUntil: (value: Promise<unknown>) => {
					pending = value;
				}
			});
			await pending;
		},
		dispatch,
		request: async (path: string, navigate = false): Promise<Response> => {
			const { pending } = dispatch(path, navigate);
			assert.ok(pending, 'worker handles the tested request');
			return pending;
		}
	};
}

test('local mode retains a credential-free offline shell', async () => {
	const worker = workerHarness('local');
	await worker.install();
	assert.ok(worker.stored.has('https://kitchen.example.test/'));
	assert.ok(
		worker.credentials.some((request) => request.path === '/' && request.credentials === 'omit')
	);
	worker.goOffline();
	const response = await worker.request('/', true);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Kitchen shell/);
});

test('SSO modes never cache or restore navigation HTML', async () => {
	for (const mode of ['oidc', 'proxy']) {
		const worker = workerHarness(mode);
		await worker.install();
		await worker.request('/', true);
		assert.equal(worker.stored.has('https://kitchen.example.test/'), false);
		worker.goOffline();
		const response = await worker.request('/', true);
		assert.equal(response.status, 503);
		assert.match(await response.text(), /Reconnect to verify your session/);
	}
});

test('switching to SSO removes a previously cached local shell', async () => {
	const worker = workerHarness('local');
	await worker.install();
	worker.setMode('proxy');
	await worker.request('/api/auth');
	assert.equal(worker.stored.has('https://kitchen.example.test/'), false);
	worker.goOffline();
	assert.equal((await worker.request('/', true)).status, 503);
});

test('protected static fetches carry proxy credentials but never cache a login page as JavaScript', async () => {
	const worker = workerHarness('proxy');
	worker.serveLoginHtml();
	await worker.install();
	assert.equal(worker.stored.size, 0);
	assert.ok(
		worker.credentials.some(
			(request) => request.path === '/_app/test.js' && request.credentials === 'same-origin'
		)
	);
});

test('service worker semantic typecheck rejects invalid route helpers', () => {
	assert.equal(workerDiagnostics.length, 0);
	const broken = readFileSync('src/service-worker.ts', 'utf8').replace(
		"resolve('/')",
		"resolve('/api')"
	);
	const diagnostics = typecheckServiceWorker(broken);
	assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 2345));
});

test('precached immutable bundles serve from CacheStorage with zero online origin fetches', async () => {
	const worker = workerHarness('local');
	await worker.install();
	const installImmutableFetch = worker.credentials.find(
		(request) => request.path === '/_app/test.js'
	);
	assert.ok(installImmutableFetch);
	assert.equal(installImmutableFetch.credentials, 'same-origin');
	assert.notEqual(installImmutableFetch.cache, 'no-store');

	worker.credentials.length = 0;
	worker.waitUntilTasks.length = 0;
	worker.setImmutableBody('/* unexpected refetch */');

	const response = await worker.request('/_app/test.js');
	assert.equal(response.status, 200);
	assert.equal(await response.text(), '/* static */');
	assert.equal(worker.credentials.length, 0);
	assert.equal(worker.waitUntilTasks.length, 0);

	await worker.activate();
	assert.equal(worker.cacheBuckets.has('flavorithm-old'), false);
	assert.equal(worker.cacheBuckets.has('flavorithm-test'), true);
	assert.equal(worker.cacheBuckets.has('unrelated-cache'), true);
});

test('immutable cache misses populate CacheStorage asynchronously via waitUntil without blocking respondWith', async () => {
	const worker = workerHarness('proxy');
	worker.serveLoginHtml(true);
	await worker.install();
	assert.equal(worker.stored.size, 0);

	worker.serveLoginHtml(false);
	worker.credentials.length = 0;
	const releasePut = worker.gateCachePut();

	const firstResponse = await worker.request('/_app/test.js');
	assert.equal(firstResponse.status, 200);
	assert.equal(await firstResponse.text(), '/* static */');
	assert.equal(worker.stored.has('https://kitchen.example.test/_app/test.js'), false);
	assert.equal(worker.waitUntilTasks.length, 1);

	releasePut();
	await worker.flushWaitUntil();
	assert.equal(worker.stored.has('https://kitchen.example.test/_app/test.js'), true);

	worker.credentials.length = 0;
	const secondResponse = await worker.request('/_app/test.js');
	assert.equal(await secondResponse.text(), '/* static */');
	assert.equal(worker.credentials.length, 0);
});

test('mutable static assets return cached responses immediately and revalidate in waitUntil', async () => {
	const worker = workerHarness('local');
	await worker.install();
	worker.credentials.length = 0;
	worker.setIconBody('<svg id="v2"></svg>');

	const staleResponse = await worker.request('/favicon.svg');
	assert.equal(staleResponse.status, 200);
	assert.equal(await staleResponse.text(), '<svg id="v1"></svg>');
	assert.equal(worker.waitUntilTasks.length, 1);
	await worker.flushWaitUntil();

	assert.equal(worker.credentials.length, 1);
	assert.equal(worker.credentials[0].path, '/favicon.svg');
	assert.equal(worker.credentials[0].credentials, 'same-origin');
	assert.equal(worker.credentials[0].cache, 'no-cache');

	const freshResponse = await worker.request('/favicon.svg');
	assert.equal(await freshResponse.text(), '<svg id="v2"></svg>');
	await worker.flushWaitUntil();

	worker.goOffline(true);
	const offlineHit = await worker.request('/favicon.svg');
	assert.equal(offlineHit.status, 200);
	assert.equal(await offlineHit.text(), '<svg id="v2"></svg>');
	await assert.doesNotReject(() => worker.flushWaitUntil());
});

test('uncacheable and uncached static asset misses return 504 when offline', async () => {
	const worker = workerHarness('local');
	await worker.install();
	assert.equal(worker.stored.has('https://kitchen.example.test/manifest.webmanifest'), false);

	const onlineManifest = await worker.request('/manifest.webmanifest');
	assert.equal(onlineManifest.status, 200);
	assert.equal(await onlineManifest.text(), '{"name":"Flavorithm"}');
	await worker.flushWaitUntil();
	assert.equal(worker.stored.has('https://kitchen.example.test/manifest.webmanifest'), false);

	worker.goOffline(true);
	const offlineManifest = await worker.request('/manifest.webmanifest');
	assert.equal(offlineManifest.status, 504);

	const blockedWorker = workerHarness('proxy');
	blockedWorker.serveLoginHtml(true);
	await blockedWorker.install();
	blockedWorker.goOffline(true);
	const offlineImmutableMiss = await blockedWorker.request('/_app/test.js');
	assert.equal(offlineImmutableMiss.status, 504);
});

test('API URLs stay excluded from static precaching and fetch interception while SSO clearOfflineShell preserves static assets', async () => {
	const worker = workerHarness('local');
	await worker.install();
	assert.equal(
		worker.credentials.some(
			(request) => request.path.startsWith('/api/') && request.path !== '/api/auth'
		),
		false
	);
	for (const apiPath of [
		'/api',
		'/api/state',
		'/api/recipe-covers/cover-1',
		'/api/asset-bypass.js',
		'/api/immutable-bypass.js',
		'/api/prerendered-bypass'
	]) {
		assert.equal(worker.dispatch(apiPath).pending, undefined, `${apiPath} must bypass worker`);
		assert.equal(worker.stored.has(`https://kitchen.example.test${apiPath}`), false);
	}

	assert.equal(worker.stored.has('https://kitchen.example.test/'), true);
	assert.equal(worker.stored.has('https://kitchen.example.test/_app/test.js'), true);
	assert.equal(worker.stored.has('https://kitchen.example.test/favicon.svg'), true);

	worker.setMode('oidc');
	await worker.request('/api/auth');
	assert.equal(worker.stored.has('https://kitchen.example.test/'), false);
	assert.equal(worker.stored.has('https://kitchen.example.test/_app/test.js'), true);
	assert.equal(worker.stored.has('https://kitchen.example.test/favicon.svg'), true);
});
