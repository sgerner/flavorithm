import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import { createInitialState } from '../src/lib/data.ts';

function rawHttp(path, { method = 'GET', headers = {}, body } = {}) {
	const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: '127.0.0.1',
				port: 5187,
				path,
				method,
				agent: false,
				headers: {
					Origin: origin,
					...(payload === undefined ? {} : { 'Content-Length': String(payload.byteLength) }),
					...headers
				}
			},
			(res) => {
				const chunks = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode,
						headers: res.headers,
						body: Buffer.concat(chunks)
					})
				);
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

// Exercise the built server against a disposable, in-memory database.
const origin = 'http://127.0.0.1:5187';
const server = spawn(process.execPath, ['server.mjs'], {
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: '5187',
		ORIGIN: origin,
		FLAVORITHM_DB_PATH: ':memory:',
		FLAVORITHM_AUTH_MODE: 'local',
		// Keep this smoke entirely offline; device endpoints are exercised with signed mocks.
		FLAVORITHM_CHATGPT_AUTH_FLOW: 'local',
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
	const homeHtml = await home.text();
	assert.match(homeHtml, /Flavorithm/);
	assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
	assert.match(home.headers.get('permissions-policy'), /microphone=\(self\)/);

	// Verify wire-level br/gzip/identity compression, HEAD /, and precompressed immutable assets.
	const rawHomeIdentity = await rawHttp('/', { headers: { 'Accept-Encoding': 'identity' } });
	const rawHomeBr = await rawHttp('/', { headers: { 'Accept-Encoding': 'br, gzip, deflate' } });
	const rawHomeGzip = await rawHttp('/', { headers: { 'Accept-Encoding': 'gzip' } });
	assert.equal(rawHomeIdentity.headers['content-encoding'], undefined);
	assert.match(String(rawHomeIdentity.headers['vary']), /Accept-Encoding/i);
	assert.equal(rawHomeBr.headers['content-encoding'], 'br');
	assert.match(String(rawHomeBr.headers['vary']), /Accept-Encoding/i);
	assert.ok(rawHomeBr.body.byteLength < rawHomeIdentity.body.byteLength);
	const normalizeHtmlNonce = (buffer) =>
		buffer.toString('utf8').replace(/nonce="[^"]+"/g, 'nonce="csp"');
	assert.equal(
		normalizeHtmlNonce(brotliDecompressSync(rawHomeBr.body)),
		normalizeHtmlNonce(rawHomeIdentity.body)
	);
	assert.equal(rawHomeGzip.headers['content-encoding'], 'gzip');
	assert.equal(
		normalizeHtmlNonce(gunzipSync(rawHomeGzip.body)),
		normalizeHtmlNonce(rawHomeIdentity.body)
	);

	const headHome = await rawHttp('/', {
		method: 'HEAD',
		headers: { 'Accept-Encoding': 'br, gzip' }
	});
	assert.equal(headHome.status, 200);
	assert.equal(headHome.body.byteLength, 0);

	const immutableMatch = homeHtml.match(/\/_app\/immutable\/[^"'\s>]+\.(?:js|css)/);
	assert.ok(immutableMatch, 'HTML shell references an immutable asset');
	const immutableBr = await rawHttp(immutableMatch[0], {
		headers: { 'Accept-Encoding': 'br, gzip' }
	});
	const immutableGz = await rawHttp(immutableMatch[0], {
		headers: { 'Accept-Encoding': 'gzip' }
	});
	const immutableRaw = await rawHttp(immutableMatch[0], {
		headers: { 'Accept-Encoding': 'identity' }
	});
	assert.equal(immutableBr.headers['content-encoding'], 'br');
	assert.deepEqual(brotliDecompressSync(immutableBr.body), immutableRaw.body);
	assert.equal(immutableGz.headers['content-encoding'], 'gzip');
	assert.deepEqual(gunzipSync(immutableGz.body), immutableRaw.body);

	const rawAuthSmall = await rawHttp('/api/auth', {
		headers: { 'Accept-Encoding': 'br, gzip' }
	});
	assert.equal(rawAuthSmall.status, 200);
	assert.equal(rawAuthSmall.headers['content-encoding'], undefined);
	assert.ok(rawAuthSmall.body.byteLength < 1024);

	assert.equal((await fetch(`${origin}/manifest.webmanifest`)).status, 200);
	assert.equal((await fetch(`${origin}/service-worker.js`)).status, 200);
	let anonymous = await fetch(`${origin}/api/state`);
	assert.equal(anonymous.status, 401);
	assert.match(anonymous.headers.get('cache-control'), /no-store/);
	function client() {
		let cookie = '';
		const call = async function (
			path,
			body,
			method = body === undefined ? 'GET' : 'POST',
			extra = {}
		) {
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
		call.cookie = () => cookie;
		return call;
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

	// Verify GET/PUT /api/state and GET /api/export compression + ETag formats (br, gzip, identity, W/).
	const ownerCookie = owner.cookie();
	const stateBr = await rawHttp('/api/state', {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'br, gzip' }
	});
	assert.equal(stateBr.headers['content-encoding'], 'br');
	assert.match(String(stateBr.headers['vary']), /Accept-Encoding/i);
	assert.match(String(stateBr.headers['etag']), /-br"$/);
	const parsedStateBr = JSON.parse(brotliDecompressSync(stateBr.body).toString('utf8'));

	const putStateBr = await rawHttp('/api/state', {
		method: 'PUT',
		headers: {
			Cookie: ownerCookie,
			'Content-Type': 'application/json',
			'Accept-Encoding': 'br, gzip',
			'If-Match': String(stateBr.headers['etag'])
		},
		body: JSON.stringify({ state: parsedStateBr.state })
	});
	assert.equal(putStateBr.status, 200);
	assert.equal(putStateBr.headers['content-encoding'], 'br');

	const stateGzip = await rawHttp('/api/state', {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'gzip' }
	});
	assert.equal(stateGzip.headers['content-encoding'], 'gzip');
	assert.match(String(stateGzip.headers['etag']), /-gzip"$/);
	const putStateGzip = await rawHttp('/api/state', {
		method: 'PUT',
		headers: {
			Cookie: ownerCookie,
			'Content-Type': 'application/json',
			'Accept-Encoding': 'gzip',
			'If-Match': String(stateGzip.headers['etag'])
		},
		body: JSON.stringify({ state: parsedStateBr.state })
	});
	assert.equal(putStateGzip.status, 200);
	assert.equal(putStateGzip.headers['content-encoding'], 'gzip');

	const stateIdentity = await rawHttp('/api/state', {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'identity' }
	});
	assert.equal(stateIdentity.headers['content-encoding'], undefined);
	const identityEtag = String(stateIdentity.headers['etag']);
	assert.doesNotMatch(identityEtag, /-(?:br|gzip|deflate)"$/);
	assert.deepEqual(gunzipSync(stateGzip.body), stateIdentity.body);

	const putStateIdentity = await rawHttp('/api/state', {
		method: 'PUT',
		headers: {
			Cookie: ownerCookie,
			'Content-Type': 'application/json',
			'Accept-Encoding': 'identity',
			'If-Match': identityEtag
		},
		body: JSON.stringify({ state: parsedStateBr.state })
	});
	assert.equal(putStateIdentity.status, 200);

	const weakTag = `W/${String(putStateIdentity.headers['etag'])}`;
	const putStateWeak = await rawHttp('/api/state', {
		method: 'PUT',
		headers: {
			Cookie: ownerCookie,
			'Content-Type': 'application/json',
			'Accept-Encoding': 'br',
			'If-Match': weakTag
		},
		body: JSON.stringify({ state: parsedStateBr.state })
	});
	assert.equal(putStateWeak.status, 200);

	const exportBr = await rawHttp('/api/export', {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'br, gzip' }
	});
	const exportIdentity = await rawHttp('/api/export', {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'identity' }
	});
	assert.equal(exportBr.headers['content-encoding'], 'br');
	assert.match(String(exportBr.headers['vary']), /Accept-Encoding/i);
	assert.equal(
		JSON.parse(brotliDecompressSync(exportBr.body).toString('utf8')).user.email,
		JSON.parse(exportIdentity.body.toString('utf8')).user.email
	);

	// Binary JPEG recipe covers (>1,024 B) omit Content-Encoding and retain private, no-store.
	const rawPixels = Buffer.alloc(400 * 200 * 3);
	for (let i = 0; i < rawPixels.length; i += 3) {
		rawPixels[i] = (i * 17) & 0xff;
		rawPixels[i + 1] = (i * 31) & 0xff;
		rawPixels[i + 2] = (i * 47) & 0xff;
	}
	const jpegInput = await sharp(rawPixels, { raw: { width: 400, height: 200, channels: 3 } })
		.jpeg({ quality: 85 })
		.toBuffer();
	const uploadedCover = await rawHttp('/api/recipe-covers', {
		method: 'POST',
		headers: { Cookie: ownerCookie, 'Content-Type': 'image/jpeg' },
		body: jpegInput
	});
	assert.equal(uploadedCover.status, 200);
	const { image: coverPath } = JSON.parse(uploadedCover.body.toString('utf8'));
	const fetchedCover = await rawHttp(coverPath, {
		headers: { Cookie: ownerCookie, 'Accept-Encoding': 'br, gzip' }
	});
	assert.equal(fetchedCover.status, 200);
	assert.equal(fetchedCover.headers['content-type'], 'image/jpeg');
	assert.equal(fetchedCover.headers['content-encoding'], undefined);
	assert.equal(fetchedCover.headers['cache-control'], 'private, no-store');
	assert.ok(fetchedCover.body.byteLength > 1024);
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
