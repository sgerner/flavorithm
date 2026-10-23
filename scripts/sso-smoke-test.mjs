import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

// A disposable built-server test. This is a fixture secret, never a deployment credential.
const secret = 'test-only-proxy-boundary-secret-do-not-use-in-production';
const origin = 'https://kitchen.example.test';
const address = 'http://127.0.0.1:5188';
const server = spawn(process.execPath, ['server.mjs'], {
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: '5188',
		ORIGIN: origin,
		FLAVORITHM_DB_PATH: ':memory:',
		FLAVORITHM_AUTH_MODE: 'proxy',
		FLAVORITHM_PROXY_SHARED_SECRET: secret,
		FLAVORITHM_PROXY_SECRET_HEADER: 'x-flavorithm-proxy-secret',
		FLAVORITHM_PROXY_SUBJECT_HEADER: 'x-authentik-uid',
		FLAVORITHM_PROXY_EMAIL_HEADER: 'x-authentik-email',
		FLAVORITHM_PROXY_NAME_HEADER: 'x-authentik-name',
		FLAVORITHM_PROXY_ISSUER: 'smoke:authentik',
		FLAVORITHM_PROXY_LOGOUT_URL: '',
		RESEND_API_KEY: '',
		BRAVE_SEARCH_API_KEY: ''
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));
const identity = (subject, email = `${subject}@example.test`) => ({
	'x-flavorithm-proxy-secret': secret,
	'x-authentik-uid': subject,
	'x-authentik-email': email,
	'x-authentik-name': 'SSO Test User'
});
async function request(path, headers = {}, body, method = body ? 'POST' : 'GET') {
	return fetch(address + path, {
		method,
		redirect: 'manual',
		headers: {
			Origin: origin,
			...(body ? { 'Content-Type': 'application/json' } : {}),
			...headers
		},
		body: body ? JSON.stringify(body) : undefined
	});
}

try {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.exitCode !== null)
			throw new Error(`SSO server stopped: ${output.replaceAll(secret, '[redacted]')}`);
		try {
			await request('/api/auth');
			break;
		} catch {
			if (attempt === 99) throw new Error('SSO smoke server did not start');
			await pause(100);
		}
	}
	assert.equal((await request('/api/state')).status, 401);
	assert.equal((await (await request('/api/auth')).json()).user, null);
	assert.equal((await request('/')).status, 403);
	const spoof = identity('first');
	delete spoof['x-flavorithm-proxy-secret'];
	assert.equal((await request('/api/state', spoof)).status, 401);
	assert.equal(
		(await request('/api/state', { ...identity('first'), 'x-flavorithm-proxy-secret': 'wrong' }))
			.status,
		401
	);
	assert.equal((await request('/api/state', { 'x-flavorithm-proxy-secret': secret })).status, 401);

	const firstResponse = await request('/api/auth', identity('first'));
	assert.equal(firstResponse.status, 200);
	assert.match(firstResponse.headers.get('cache-control'), /no-store/);
	const first = (await firstResponse.json()).user;
	const cookie = firstResponse.headers.get('set-cookie')?.split(';')[0];
	assert.ok(cookie, 'SSO creates a session binding for model connections');
	assert.equal(first.email, 'first@example.test');
	const same = await request('/api/auth', identity('first'));
	assert.equal((await same.json()).user.id, first.id);
	const seeded = await request('/api/state', identity('first'));
	assert.equal((await seeded.json()).state.recipes.length, 8);
	const home = await request('/', identity('first'));
	assert.equal(home.status, 200);
	assert.match(home.headers.get('cache-control'), /no-store/);
	assert.equal(
		(await request('/api/state', { Cookie: cookie })).status,
		401,
		'cookie cannot replace proxy verification'
	);
	assert.equal(
		(await request('/api/state', identity('other', first.email))).status,
		401,
		'email alone cannot link an identity'
	);
	const secondResponse = await request('/api/auth', { ...identity('second'), Cookie: cookie });
	assert.equal(secondResponse.status, 200);
	const second = (await secondResponse.json()).user;
	assert.notEqual(second.id, first.id);
	assert.notEqual(second.householdId, first.householdId);
	for (const action of [
		'login',
		'register',
		'requestPasswordReset',
		'resetPassword',
		'requestEmailVerification',
		'verifyEmail',
		'deleteAccount'
	]) {
		assert.equal(
			(await request('/api/auth', identity('first'), { action })).status,
			403,
			`local ${action} disabled`
		);
	}
	const currentState = await request('/api/state', identity('second'));
	const { state } = await currentState.json();
	const staleWrite = await request(
		'/api/state',
		{ ...identity('second'), 'If-Match': currentState.headers.get('etag') },
		{
			state,
			expectedUserId: first.id,
			expectedHouseholdId: first.householdId
		},
		'PUT'
	);
	assert.equal(staleWrite.status, 409);
	assert.equal((await request('/api/connections/chatgpt', identity('first'))).status, 200);
	console.log(
		'SSO smoke passed: automatic provisioning, trusted proxy boundary, cookie bypass rejection, account isolation, local-auth blocking, and seeded state.'
	);
} finally {
	if (server.exitCode === null && server.signalCode === null) {
		server.kill('SIGTERM');
		await new Promise((resolve) => server.once('exit', resolve));
	}
}
