import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the real worker against Fetch/Cache doubles to test the auth boundary, not a copy of it.
const source = ts.transpileModule(readFileSync('src/service-worker.ts', 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function workerHarness(initialMode: string) {
	const origin = 'https://kitchen.example.test';
	let mode = initialMode;
	let offline = false;
	let loginHtml = false;
	const stored = new Map<string, Response>();
	const credentials: Array<{ path: string; credentials: string }> = [];
	const handlers = new Map<string, (event: any) => void>();
	const cache = {
		put: async (request: Request, response: Response) => {
			assert.equal(request.credentials, 'omit');
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
				return { assets: [], immutable: [{ path: '_app/test.js' }], prerendered: [] };
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
		caches: { open: async () => cache, keys: async () => [], delete: async () => true },
		fetch: async (request: Request) => {
			if (offline) throw new TypeError('Offline test fixture');
			const path = new URL(request.url).pathname;
			credentials.push({ path, credentials: request.credentials });
			if (path === '/api/auth') return Response.json({ user: null, authMode: mode });
			if (path === '/_app/test.js' && !loginHtml)
				return new Response('/* static */', { headers: { 'content-type': 'text/javascript' } });
			return new Response(loginHtml ? '<h1>Gateway login</h1>' : '<h1>Kitchen shell</h1>', {
				headers: { 'content-type': 'text/html', 'x-flavorithm-auth-mode': mode }
			});
		}
	});
	return {
		stored,
		credentials,
		setMode: (value: string) => {
			mode = value;
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
		request: async (path: string, navigate = false): Promise<Response> => {
			let pending: Promise<Response> | undefined;
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
				}
			});
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
