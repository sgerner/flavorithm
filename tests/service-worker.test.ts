import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real worker against Fetch/Cache doubles to test the auth boundary, not a copy of it.
const source = ts.transpileModule(readFileSync('src/service-worker.ts', 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

interface HarnessOptions {
	version?: string;
	buckets?: Map<string, Map<string, Response>>;
	customFetch?: (
		request: Request,
		path: string,
		defaultFetch: () => Promise<Response>
	) => Promise<Response> | Response;
}

function redirectedResponse(
	body: BodyInit | null,
	init: ResponseInit & { url: string; redirected?: boolean }
): Response {
	const response = new Response(body, init);
	Object.defineProperty(response, 'url', { value: init.url });
	Object.defineProperty(response, 'redirected', { value: init.redirected ?? true });
	return response;
}

function workerHarness(initialMode: string, options: HarnessOptions = {}) {
	const origin = 'https://kitchen.example.test';
	const version = options.version ?? 'test';
	const cacheName = `flavorithm-${version}`;
	const buckets = options.buckets ?? new Map<string, Map<string, Response>>();
	let mode = initialMode;
	let offline = false;
	let loginHtml = false;
	let skipWaitingCount = 0;
	const stored = buckets.get(cacheName) ?? new Map<string, Response>();
	const credentials: Array<{ path: string; credentials: string }> = [];
	const handlers = new Map<string, (event: any) => void>();
	function makeCache(bucket: Map<string, Response>) {
		return {
			put: async (request: Request, response: Response) => {
				assert.equal(request.credentials, 'omit');
				bucket.set(request.url, response.clone());
			},
			match: async (request: Request) => bucket.get(request.url)?.clone(),
			delete: async (request: Request) => bucket.delete(request.url)
		};
	}
	runInNewContext(source, {
		exports: {},
		URL,
		Request,
		Response,
		require: (name: string) => {
			if (name === '$app/env') return { version };
			if (name === '$app/manifest')
				return {
					assets: [{ path: 'manifest.webmanifest' }],
					immutable: [{ path: '_app/test.js' }],
					prerendered: []
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
			skipWaiting: async () => {
				skipWaitingCount += 1;
			},
			clients: { claim: async () => {} }
		},
		caches: {
			open: async (name: string) => {
				let bucket = buckets.get(name);
				if (!bucket) {
					bucket = name === cacheName ? stored : new Map<string, Response>();
					buckets.set(name, bucket);
				}
				return makeCache(bucket);
			},
			keys: async () => [...buckets.keys()],
			delete: async (name: string) => {
				const bucket = buckets.get(name);
				bucket?.clear();
				return buckets.delete(name);
			}
		},
		fetch: async (request: Request) => {
			if (offline) throw new TypeError('Offline test fixture');
			const path = new URL(request.url).pathname;
			credentials.push({ path, credentials: request.credentials });
			const defaultFetch = async () => {
				if (path === '/api/auth') return Response.json({ user: null, authMode: mode });
				if (path === '/_app/test.js' && !loginHtml)
					return new Response('/* static */', { headers: { 'content-type': 'text/javascript' } });
				if (path === '/manifest.webmanifest' && !loginHtml)
					return new Response('{"name":"Flavorithm"}', {
						headers: { 'content-type': 'application/manifest+json; charset=utf-8' }
					});
				return new Response(loginHtml ? '<h1>Gateway login</h1>' : '<h1>Kitchen shell</h1>', {
					headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': mode }
				});
			};
			if (options.customFetch) {
				return options.customFetch(request, path, defaultFetch);
			}
			return defaultFetch();
		}
	});
	function dispatchRequest(
		path: string,
		navigate = false
	): { response: Promise<Response>; settled: Promise<void> } {
		let pending: Promise<Response> | undefined;
		const background: Array<Promise<unknown>> = [];
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
				background.push(value);
			}
		});
		assert.ok(pending, 'worker handles the tested request');
		const response = pending;
		const settled = (async () => {
			await response;
			await Promise.all(background);
		})();
		return { response, settled };
	}
	return {
		buckets,
		stored,
		credentials,
		get skipWaitingCalls() {
			return skipWaitingCount;
		},
		setMode: (value: string) => {
			mode = value;
		},
		setOffline: (value: boolean) => {
			offline = value;
		},
		goOffline: () => {
			offline = true;
		},
		serveLoginHtml: () => {
			loginHtml = true;
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
		dispatchRequest,
		request: async (path: string, navigate = false): Promise<Response> => {
			const { response, settled } = dispatchRequest(path, navigate);
			await settled;
			return response;
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

test('manifest.webmanifest validates with application/manifest+json and serves offline', async () => {
	const worker = workerHarness('local');
	await worker.install();
	assert.ok(worker.stored.has('https://kitchen.example.test/manifest.webmanifest'));
	worker.goOffline();
	const manifest = await worker.request('/manifest.webmanifest');
	assert.equal(manifest.status, 200);
	assert.deepEqual(await manifest.json(), { name: 'Flavorithm' });
});

test('upgrading from v1 to v2 during HTTP 503 rejects v2 install, deletes partial v2 cache, and retains flavorithm-v1', async () => {
	for (const failingPath of ['/api/auth', '/_app/test.js', '/manifest.webmanifest', '/']) {
		const buckets = new Map<string, Map<string, Response>>();
		const v1 = workerHarness('local', { version: 'v1', buckets });
		await v1.install();
		await v1.activate();
		assert.deepEqual([...buckets.keys()], ['flavorithm-v1']);
		assert.equal(v1.skipWaitingCalls, 1);

		let return503 = true;
		const v2 = workerHarness('local', {
			version: 'v2',
			buckets,
			customFetch: async (_request, path, defaultFetch) => {
				if (return503 && path === failingPath) {
					return new Response('Service Unavailable', {
						status: 503,
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					});
				}
				return defaultFetch();
			}
		});

		await assert.rejects(
			() => v2.install(),
			`v2 install must reject when ${failingPath} returns HTTP 503`
		);
		assert.equal(v2.skipWaitingCalls, 0);
		assert.equal(buckets.has('flavorithm-v2'), false);
		assert.deepEqual([...buckets.keys()], ['flavorithm-v1']);

		v1.goOffline();
		const shell = await v1.request('/', true);
		assert.equal(shell.status, 200);
		assert.match(await shell.text(), /Kitchen shell/);
		assert.equal((await v1.request('/_app/test.js')).status, 200);
		assert.equal((await v1.request('/manifest.webmanifest')).status, 200);

		return503 = false;
		await v2.install();
		await v2.activate();
		assert.equal(v2.skipWaitingCalls, 1);
		assert.deepEqual([...buckets.keys()], ['flavorithm-v2']);
	}
});

test('network errors during install abort before skipWaiting and clean up partial caches', async () => {
	const buckets = new Map<string, Map<string, Response>>();
	const v1 = workerHarness('local', { version: 'v1', buckets });
	await v1.install();
	await v1.activate();

	const v2 = workerHarness('local', {
		version: 'v2',
		buckets,
		customFetch: async (_request, path, defaultFetch) => {
			if (path === '/') throw new TypeError('Connection reset during shell precache');
			return defaultFetch();
		}
	});
	await assert.rejects(() => v2.install(), TypeError);
	assert.equal(v2.skipWaitingCalls, 0);
	assert.deepEqual([...buckets.keys()], ['flavorithm-v1']);
});

test('online local navigations with credentials include restore offlineUrl via a deduplicated credentials omit sub-fetch', async () => {
	let releaseShellFetch: (() => void) | undefined;
	const shellGate = new Promise<void>((resolve) => {
		releaseShellFetch = resolve;
	});
	let installed = false;
	const worker = workerHarness('local', {
		customFetch: async (request, path, defaultFetch) => {
			if (path === '/' && request.credentials === 'include') {
				return new Response('<h1>Authenticated navigation view</h1>', {
					headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
				});
			}
			if (path === '/pantry' && request.credentials === 'include') {
				return new Response('<h1>Authenticated pantry view</h1>', {
					headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
				});
			}
			if (installed && path === '/' && request.credentials === 'omit') {
				await shellGate;
				return new Response('<h1>Refreshed credential-free shell</h1>', {
					headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
				});
			}
			return defaultFetch();
		}
	});
	await worker.install();
	installed = true;

	worker.stored.delete('https://kitchen.example.test/');
	worker.credentials.length = 0;

	const first = worker.dispatchRequest('/pantry?filter=expiring', true);
	const second = worker.dispatchRequest('/', true);
	assert.match(await (await first.response).text(), /Authenticated pantry view/);
	assert.match(await (await second.response).text(), /Authenticated navigation view/);

	releaseShellFetch!();
	await Promise.all([first.settled, second.settled]);

	const omitSubFetches = worker.credentials.filter(
		(entry) => entry.path === '/' && entry.credentials === 'omit'
	);
	assert.equal(omitSubFetches.length, 1, 'concurrent local navigations share one omit sub-fetch');
	assert.equal(worker.stored.has('https://kitchen.example.test/pantry?filter=expiring'), false);
	assert.ok(worker.stored.has('https://kitchen.example.test/'));

	worker.goOffline();
	const offlineReload = await worker.request('/', true);
	assert.equal(offlineReload.status, 200);
	assert.match(await offlineReload.text(), /Refreshed credential-free shell/);
});

test('same-origin local redirects preserve offlineUrl while cross-origin, non-local, and gateway navigations evict it', async () => {
	let nextNavigationResponse: (() => Response) | null = null;
	const worker = workerHarness('local', {
		customFetch: async (request, path, defaultFetch) => {
			if (nextNavigationResponse && request.credentials === 'include') {
				const reply = nextNavigationResponse;
				nextNavigationResponse = null;
				return reply();
			}
			return defaultFetch();
		}
	});
	await worker.install();
	assert.ok(worker.stored.has('https://kitchen.example.test/'));

	// 1. Same-origin local logout redirect keeps offlineUrl intact without extra sub-fetches.
	worker.credentials.length = 0;
	nextNavigationResponse = () =>
		redirectedResponse('<h1>Signed-out kitchen shell</h1>', {
			status: 200,
			url: 'https://kitchen.example.test/',
			headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
		});
	const localLogout = await worker.request('/auth/logout', true);
	assert.equal(localLogout.status, 200);
	assert.ok(worker.stored.has('https://kitchen.example.test/'));
	assert.equal(
		worker.credentials.filter((entry) => entry.credentials === 'omit').length,
		0,
		'preserved offlineUrl needs no redundant sub-fetch'
	);

	// 2. Transient 503 proxy error without auth-mode header preserves offlineUrl.
	nextNavigationResponse = () =>
		new Response('<h1>503 Bad Gateway</h1>', {
			status: 503,
			headers: { 'content-type': 'text/html' }
		});
	assert.equal((await worker.request('/', true)).status, 503);
	assert.ok(worker.stored.has('https://kitchen.example.test/'));

	// 3. Cross-origin redirect evicts offlineUrl even if header claimed local.
	nextNavigationResponse = () =>
		redirectedResponse('<h1>External login</h1>', {
			status: 200,
			url: 'https://idp.example.test/login',
			headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
		});
	await worker.request('/auth/logout', true);
	assert.equal(worker.stored.has('https://kitchen.example.test/'), false);

	// Restore shell via online local navigation, then verify non-local and gateway evictions.
	await worker.request('/', true);
	assert.ok(worker.stored.has('https://kitchen.example.test/'));

	for (const nonLocalMode of ['oidc', 'proxy', 'invalid']) {
		nextNavigationResponse = () =>
			redirectedResponse('<h1>Managed auth</h1>', {
				status: nonLocalMode === 'invalid' ? 503 : 200,
				url: 'https://kitchen.example.test/',
				headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': nonLocalMode }
			});
		await worker.request('/', true);
		assert.equal(
			worker.stored.has('https://kitchen.example.test/'),
			false,
			`${nonLocalMode} navigation must evict offlineUrl`
		);
		await worker.request('/', true);
		assert.ok(worker.stored.has('https://kitchen.example.test/'));
	}

	// 4. Gateway login page without X-Flavorithm-Auth-Mode header evicts offlineUrl.
	nextNavigationResponse = () =>
		new Response('<h1>Gateway login</h1>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
	await worker.request('/', true);
	assert.equal(worker.stored.has('https://kitchen.example.test/'), false);
	worker.goOffline();
	assert.equal((await worker.request('/', true)).status, 503);
});

test('in-flight local shell refresh does not repopulate offlineUrl after concurrent SSO eviction', async () => {
	let releaseRefresh: (() => void) | undefined;
	const refreshGate = new Promise<void>((resolve) => {
		releaseRefresh = resolve;
	});
	let installed = false;
	const worker = workerHarness('local', {
		customFetch: async (request, path, defaultFetch) => {
			if (installed && path === '/' && request.credentials === 'omit') {
				await refreshGate;
				return new Response('<h1>Stale local shell</h1>', {
					headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': 'local' }
				});
			}
			return defaultFetch();
		}
	});
	await worker.install();
	installed = true;
	worker.stored.delete('https://kitchen.example.test/');

	const nav = worker.dispatchRequest('/', true);
	await nav.response;

	worker.setMode('oidc');
	await worker.request('/api/auth');

	releaseRefresh!();
	await nav.settled;
	assert.equal(worker.stored.has('https://kitchen.example.test/'), false);
});
