import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createInitialState } from '../src/lib/data.ts';

// Exercise the built server against a disposable, in-memory database.
const origin = 'http://127.0.0.1:5187';
const server = spawn(process.execPath, ['server.mjs'], {
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: '5187',
		ORIGIN: origin,
		FLAVORITHM_DB_PATH: ':memory:',
		RESEND_API_KEY: '',
		BRAVE_SEARCH_API_KEY: ''
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
server.stdout.on('data', (chunk) => (serverOutput += chunk));
server.stderr.on('data', (chunk) => (serverOutput += chunk));
const password = 'Only a disposable test password 123!';
try {
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(`Test server stopped: ${serverOutput}`);
		try {
			const response = await fetch(origin);
			if (response.ok) break;
		} catch {}
		if (i === 99) throw new Error('Test server did not start');
		await pause(100);
	}
	const home = await fetch(origin);
	assert.match(await home.text(), /Flavorithm/);
	assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
	assert.match(home.headers.get('permissions-policy'), /microphone=\(self\)/);
	assert.equal((await fetch(`${origin}/manifest.webmanifest`)).status, 200);
	assert.equal((await fetch(`${origin}/service-worker.js`)).status, 200);
	let anonymous = await fetch(`${origin}/api/state`);
	assert.equal(anonymous.status, 401);
	assert.match(anonymous.headers.get('cache-control'), /no-store/);
	function client() {
		let cookie = '';
		return async function (path, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
			const response = await fetch(origin + path, {
				method,
				headers: {
					Origin: origin,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
					...(cookie ? { Cookie: cookie } : {}),
					...extra
				},
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const setCookie = response.headers.get('set-cookie');
			if (setCookie) cookie = setCookie.split(';')[0];
			return { response, data: await response.json() };
		};
	}
	const owner = client(),
		member = client();
	let result = await owner('/api/auth', {
		action: 'register',
		name: 'Smoke Owner',
		email: 'smoke-owner@example.test',
		password
	});
	assert.equal(result.response.status, 201);
	let initial = await owner('/api/state');
	assert.equal(initial.response.status, 200);
	assert.equal(initial.data.state.recipes.length, 8);
	assert.deepEqual(initial.data.state.pantry, []);
	assert.deepEqual(initial.data.state.meals, []);
	const connections = await owner('/api/connections/chatgpt');
	assert.equal(connections.response.status, 200);
	assert.equal(connections.data.mode, 'local');
	assert.deepEqual(connections.data.accounts, []);
	const started = await owner('/api/connections/chatgpt', { action: 'start' });
	assert.equal(started.response.status, 200);
	const authorization = new URL(started.data.authorizationUrl);
	assert.equal(authorization.origin, 'https://auth.openai.com');
	assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
	assert.ok(authorization.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));
	assert.match(authorization.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
	const callback = new URL(authorization.searchParams.get('redirect_uri'));
	assert.equal(callback.hostname, '127.0.0.1');
	assert.equal(callback.pathname, '/auth/callback');
	callback.searchParams.set('state', authorization.searchParams.get('state'));
	callback.searchParams.set('error', 'access_denied');
	assert.equal((await fetch(callback)).status, 200);
	assert.equal(
		(await owner('/api/models?connection=chatgpt&accountId=not-owned')).response.status,
		404
	);
	assert.equal(
		(
			await owner('/api/ai', {
				action: 'generate',
				provider: 'chatgpt',
				model: 'test',
				connectionId: 'not-owned',
				apiKey: 'forged-client-token'
			})
		).response.status,
		404
	);

	const state = createInitialState();
	state.recipes[0].rating = 5;
	result = await owner('/api/state', { state }, 'PUT', {
		'If-Match': initial.response.headers.get('etag')
	});
	assert.equal(result.response.status, 200);
	const staleTag = result.response.headers.get('etag');
	assert.ok(staleTag);
	assert.equal((await owner('/api/state', { state }, 'PUT')).response.status, 428);
	const invite = (await owner('/api/household', { action: 'createInvite' })).data.inviteCode;
	assert.ok(invite);
	assert.equal(
		(
			await member('/api/auth', {
				action: 'register',
				name: 'Smoke Member',
				email: 'smoke-member@example.test',
				password
			})
		).response.status,
		201
	);
	assert.equal(
		(await member('/api/household', { action: 'join', code: invite })).response.status,
		200
	);
	result = await member('/api/state');
	assert.equal(result.data.state.recipes[0].rating, undefined);
	result.data.state.pantry[0].quantity = 99;
	assert.equal(
		(
			await member('/api/state', { state: result.data.state }, 'PUT', {
				'If-Match': result.response.headers.get('etag')
			})
		).response.status,
		200
	);
	assert.equal(
		(await owner('/api/state', { state }, 'PUT', { 'If-Match': staleTag })).response.status,
		412
	);
	result = await owner('/api/state');
	assert.equal(result.data.state.pantry[0].quantity, 99);
	assert.equal(result.data.state.recipes[0].rating, 5);
	assert.equal((await owner('/api/export')).data.user.email, 'smoke-owner@example.test');
	assert.equal(
		(await owner('/api/state', { state }, 'PUT', { Origin: 'https://hostile.example' })).response
			.status,
		403
	);
	assert.equal(
		(await owner('/api/ai', { action: 'generate', provider: 'openai', model: 'test', apiKey: '' }))
			.response.status,
		400
	);
	assert.equal(
		(
			await owner('/api/auth', {
				action: 'requestPasswordReset',
				email: 'smoke-owner@example.test'
			})
		).response.status,
		503
	);
	assert.equal((await owner('/api/auth', { action: 'logout' })).response.status, 200);
	assert.equal((await owner('/api/auth')).data.user, null);
	assert.equal(
		(await owner('/api/auth', { action: 'login', email: 'smoke-owner@example.test', password }))
			.response.status,
		200
	);
	assert.equal(
		(await owner('/api/auth', { action: 'deleteAccount', password })).response.status,
		200
	);
	assert.equal((await owner('/api/state')).response.status, 401);
	assert.equal((await member('/api/household')).data.members.length, 1);
	console.log(
		'Production HTTP smoke test passed: auth, sessions, shared state, private ratings, ETags, CSRF, export, deletion, PWA assets, OAuth start/denial, account isolation, and security headers.'
	);
} finally {
	server.kill('SIGTERM');
}
