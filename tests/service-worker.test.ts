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

test('service worker semantic typecheck rejects invalid route helpers', () => {
	assert.equal(workerDiagnostics.length, 0);
	const broken = readFileSync('src/service-worker.ts', 'utf8').replace(
		"resolve('/')",
		"resolve('/api')"
	);
	const diagnostics = typecheckServiceWorker(broken);
	assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 2345));
});
