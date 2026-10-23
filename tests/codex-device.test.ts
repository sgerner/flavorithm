import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.ORIGIN = 'https://flavorithm.example';
const db = await import('../src/lib/server/db.ts');
const storage = await import('../src/lib/server/oauth-storage.ts');
const device = await import('../src/lib/server/codex-device.ts');
const oauth = await import('../src/lib/server/chatgpt-oauth.ts');
const inference = await import('../src/lib/server/chatgpt-inference.ts');
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
let sequence = 0;
async function user() {
	const account = await db.registerUser(
		'Device Tester',
		`device-${++sequence}@example.com`,
		'correct horse battery'
	);
	return {
		...account,
		userId: account.user.id,
		sessionBinding: db.getSessionBinding(account.token)!,
		appUrl: new URL('https://flavorithm.example')
	};
}
function fixture() {
	const state = {
		pending: false,
		badPkce: false,
		badAudience: false,
		subject: 'subject-1',
		account: 'account-1',
		refreshes: 0,
		calls: [] as string[]
	};
	const verifier = 'original-device-pkce-verifier';
	const fetcher = (async (input: any, init: any) => {
		const url = String(input);
		state.calls.push(url);
		if (url.endsWith('/deviceauth/usercode')) {
			assert.deepEqual(JSON.parse(init.body), { client_id: device.CODEX_CLIENT_ID });
			return Response.json({
				device_auth_id: 'server-only-device-id',
				user_code: 'ABCD-1234',
				interval: '5'
			});
		}
		if (url.endsWith('/deviceauth/token')) {
			assert.deepEqual(JSON.parse(init.body), {
				device_auth_id: 'server-only-device-id',
				user_code: 'ABCD-1234'
			});
			return state.pending
				? new Response('{}', { status: 404 })
				: Response.json({
						authorization_code: 'single-use-code',
						code_verifier: verifier,
						code_challenge: state.badPkce
							? 'bad'
							: createHash('sha256').update(verifier).digest('base64url')
					});
		}
		if (url === device.CODEX_TOKEN_URL) {
			const body = new URLSearchParams(init.body);
			assert.equal(body.get('client_id'), device.CODEX_CLIENT_ID);
			assert.equal(body.has('resource'), false);
			if (body.get('grant_type') === 'refresh_token') {
				state.refreshes++;
				return Response.json({
					access_token: 'rotated-access',
					refresh_token: 'rotated-refresh',
					expires_in: 3600
				});
			}
			assert.equal(body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
			assert.equal(body.get('code_verifier'), verifier);
			const id_token = await new SignJWT({
				email: 'owner@example.com',
				'https://api.openai.com/auth': { chatgpt_account_id: state.account }
			})
				.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
				.setIssuer('https://auth.openai.com')
				.setAudience(state.badAudience ? 'wrong' : device.CODEX_CLIENT_ID)
				.setSubject(state.subject)
				.setIssuedAt()
				.setExpirationTime('1h')
				.sign(privateKey);
			return Response.json({
				access_token: 'test-access',
				refresh_token: 'test-refresh',
				id_token,
				expires_in: 3600
			});
		}
		if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
		throw new Error('Unexpected provider destination');
	}) as typeof fetch;
	return { state, fetcher };
}

test('device login honors polling, verifies PKCE and identity, and stores isolated encrypted accounts', async (t) => {
	const owner = await user();
	const stranger = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	const start = await device.startCodexDevice(owner, f.fetcher);
	assert.equal(start.verificationUrl, 'https://auth.openai.com/codex/device');
	assert.equal(JSON.stringify(start).includes('server-only-device-id'), false);
	const input = { ...owner, loginId: start.loginId };
	assert.deepEqual(await device.pollCodexDevice(input, f.fetcher), { pending: true });
	assert.equal(f.state.calls.length, 1);
	await assert.rejects(
		device.pollCodexDevice(
			{ ...input, userId: stranger.userId, sessionBinding: stranger.sessionBinding },
			f.fetcher
		),
		{ status: 404 }
	);
	await assert.rejects(
		device.pollCodexDevice({ ...input, appUrl: new URL('https://attacker.example') }, f.fetcher),
		{ status: 404 }
	);
	f.state.pending = true;
	now += 6000;
	assert.deepEqual(await device.pollCodexDevice(input, f.fetcher), { pending: true });
	f.state.pending = false;
	now += 6000;
	const result = await device.pollCodexDevice(input, f.fetcher);
	assert.equal('connected' in result, true);
	if (!('accountId' in result)) throw new Error('Expected saved account');
	assert.deepEqual(await device.pollCodexDevice(input, f.fetcher), result);
	const saved = storage.getChatGPTAccount(owner.userId, result.accountId)!;
	assert.equal(saved.credentialEnvelope!.includes('test-access'), false);
	assert.equal(oauth.listChatGPTAccounts(owner.userId)[0].planEnabled, true);
	assert.deepEqual(oauth.listChatGPTAccounts(stranger.userId), []);
	const credentials = storage.decryptChatGPTCredentials(
		owner.userId,
		saved.id,
		saved.mode,
		saved.credentialEnvelope!
	);
	assert.equal(credentials.codexAccountId, 'account-1');
	assert.equal(await oauth.getChatGPTAccessToken(owner.userId, saved.id), 'test-access');
	// The fixed public Codex client can register a separate account/workspace for the same app user.
	f.state.subject = 'subject-2';
	f.state.account = 'account-2';
	const next = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	await device.pollCodexDevice({ ...owner, loginId: next.loginId }, f.fetcher);
	assert.equal(oauth.listChatGPTAccounts(owner.userId).length, 2);
	// Wrong account reauthorization never replaces the selected credential set.
	const reconnect = await device.startCodexDevice({ ...owner, accountId: saved.id }, f.fetcher);
	now += 6000;
	await assert.rejects(device.pollCodexDevice({ ...owner, loginId: reconnect.loginId }, f.fetcher));
	assert.equal(storage.getChatGPTAccount(owner.userId, saved.id)!.subject, 'subject-1:account-1');
});

test('device login rejects expired, cancelled, switched-session, bad PKCE, and unverified identity attempts', async (t) => {
	const owner = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	const first = await device.startCodexDevice(owner, f.fetcher);
	await assert.rejects(
		device.pollCodexDevice(
			{ ...owner, sessionBinding: 'forged', loginId: first.loginId },
			f.fetcher
		),
		{ status: 401 }
	);
	device.cancelCodexDevice({ ...owner, loginId: first.loginId });
	await assert.rejects(device.pollCodexDevice({ ...owner, loginId: first.loginId }, f.fetcher), {
		status: 404
	});
	const expired = await device.startCodexDevice(owner, f.fetcher);
	now = expired.expiresAt + 1;
	await assert.rejects(device.pollCodexDevice({ ...owner, loginId: expired.loginId }, f.fetcher), {
		status: 410
	});
	f.state.badPkce = true;
	const bad = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	await assert.rejects(device.pollCodexDevice({ ...owner, loginId: bad.loginId }, f.fetcher), {
		status: 502
	});
	f.state.badPkce = false;
	f.state.badAudience = true;
	const forged = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	await assert.rejects(device.pollCodexDevice({ ...owner, loginId: forged.loginId }, f.fetcher), {
		status: 502
	});
	assert.equal(oauth.listChatGPTAccounts(owner.userId).length, 0);
	await assert.rejects(
		device.startCodexDevice({ ...owner, appUrl: new URL('http://remote.example') }, f.fetcher),
		{ status: 403 }
	);
});

test('Codex refresh uses its own token endpoint and existing serialized rotation storage', async (t) => {
	const owner = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	const start = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	const result = await device.pollCodexDevice({ ...owner, loginId: start.loginId }, f.fetcher);
	if (!('accountId' in result)) throw new Error('Expected saved account');
	const saved = storage.getChatGPTAccount(owner.userId, result.accountId)!;
	const credentials = storage.decryptChatGPTCredentials(
		owner.userId,
		saved.id,
		saved.mode,
		saved.credentialEnvelope!
	);
	storage.saveChatGPTAccount({ ...saved, accountId: saved.id, credentials, expiresAt: now - 1000 });
	t.mock.method(globalThis, 'fetch', f.fetcher);
	const tokens = await Promise.all([
		oauth.getChatGPTAccessToken(owner.userId, saved.id),
		oauth.getChatGPTAccessToken(owner.userId, saved.id)
	]);
	assert.deepEqual(tokens, ['rotated-access', 'rotated-access']);
	assert.equal(f.state.refreshes, 1);
	const updated = storage.getChatGPTAccount(owner.userId, saved.id)!;
	const rotated = storage.decryptChatGPTCredentials(
		owner.userId,
		saved.id,
		saved.mode,
		updated.credentialEnvelope!
	);
	assert.equal(rotated.refreshToken, 'rotated-refresh');
	assert.equal(rotated.codexAccountId, 'account-1');
});

test('Codex model discovery and inference use fixed subscription endpoints with account headers', async () => {
	const calls: string[] = [];
	const fetcher = (async (input: any, init: any) => {
		const url = String(input);
		calls.push(url);
		if (url === 'https://models.dev/api.json') {
			assert.equal(new Headers(init?.headers).has('Authorization'), false);
			return Response.json({});
		}
		assert.equal(new URL(url).origin, 'https://chatgpt.com');
		assert.equal(new Headers(init.headers).get('chatgpt-account-id'), 'account-1');
		assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-access');
		assert.equal(init.redirect, 'error');
		if (new URL(url).pathname.endsWith('/models'))
			return Response.json({
				models: [
					{
						slug: 'native-test',
						display_name: 'Native test',
						visibility: 'list',
						input_modalities: ['text', 'image'],
						supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
					}
				]
			});
		const body = JSON.parse(init.body);
		assert.equal(body.stream, true);
		assert.equal(body.store, false);
		assert.equal(body.reasoning.effort, 'high');
		return new Response(
			'data: ' +
				JSON.stringify({
					type: 'response.completed',
					response: {
						status: 'completed',
						output: [{ content: [{ type: 'output_text', text: '{"recipe":"test"}' }] }]
					}
				}) +
				'\n\n',
			{ headers: { 'content-type': 'text/event-stream' } }
		);
	}) as typeof fetch;
	const wrapped = device.codexSubscriptionFetch('test-access', 'account-1', fetcher);
	const catalog = await inference.listChatGPTModels('test-access', wrapped);
	assert.equal(catalog.providers[0].models[0].vision, true);
	assert.deepEqual(catalog.providers[0].models[0].reasoning?.efforts, ['low', 'high']);
	assert.equal(
		await inference.chatGPTResponse(
			{
				accessToken: 'test-access',
				model: 'native-test',
				instructions: 'Recipe JSON',
				prompt: 'Rice',
				reasoning: { effort: 'high' }
			},
			wrapped
		),
		'{"recipe":"test"}'
	);
	await wrapped('https://models.dev/api.json');
	assert.equal(
		calls.some((url) => url.startsWith('https://api.openai.com/')),
		false
	);
});

test('connection API exposes device code only to the initiating authenticated same-origin session', async (t) => {
	const owner = await user();
	const f = fixture();
	t.mock.method(globalThis, 'fetch', f.fetcher);
	const route = await import('../src/routes/api/connections/chatgpt/+server.ts');
	const url = new URL('https://flavorithm.example/api/connections/chatgpt');
	const event = (body?: unknown, origin = url.origin) =>
		({
			url,
			locals: { user: owner.user },
			cookies: { get: () => owner.token },
			getClientAddress: () => '203.0.113.23',
			request: new Request(
				url,
				body
					? {
							method: 'POST',
							headers: { origin, 'content-type': 'application/json' },
							body: JSON.stringify(body)
						}
					: {}
			)
		}) as any;
	assert.equal((await (await route.GET(event())).json()).mode, 'device');
	assert.equal(
		(await route.POST(event({ action: 'start' }, 'https://attacker.example'))).status,
		403
	);
	const started = await route.POST(event({ action: 'start' }));
	assert.equal(started.status, 200);
	assert.match(started.headers.get('cache-control')!, /no-store/);
	const data = await started.json();
	assert.equal(data.kind, 'device');
	assert.equal('deviceId' in data, false);
	assert.equal('access_token' in data, false);
	assert.equal((await route.POST(event({ action: 'cancel', loginId: data.loginId }))).status, 200);
	assert.equal((await route.POST(event({ action: 'poll', loginId: data.loginId }))).status, 404);
	assert.equal((await route.GET({ ...event(), locals: { user: null } })).status, 401);
});

test('cancelling while token exchange is in flight prevents late credentials from being saved', async (t) => {
	const owner = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const fetcher = (async (input: any, init: any) => {
		if (String(input) === device.CODEX_TOKEN_URL) {
			entered();
			await gate;
		}
		return f.fetcher(input, init);
	}) as typeof fetch;
	const attempt = await device.startCodexDevice(owner, fetcher);
	now += 6000;
	const input = { ...owner, loginId: attempt.loginId };
	const pending = device.pollCodexDevice(input, fetcher);
	await started;
	device.cancelCodexDevice(input);
	release();
	await assert.rejects(pending, { status: 404 });
	assert.equal(oauth.listChatGPTAccounts(owner.userId).length, 0);
});

test('AI API resolves the owned Codex connection and validates native reasoning before recipe inference', async (t) => {
	const owner = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	const start = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	const result = await device.pollCodexDevice({ ...owner, loginId: start.loginId }, f.fetcher);
	if (!('accountId' in result)) throw new Error('Expected saved account');
	const { defaultPreferences } = await import('../src/lib/data.ts');
	const route = await import('../src/routes/api/ai/+server.ts');
	const nutrition = {
		calories: 400,
		fat: 10,
		saturatedFat: 2,
		sodium: 300,
		carbs: 60,
		fiber: 5,
		sugar: 2,
		protein: 15
	};
	const recipe = {
		title: 'Rice bowl',
		description: 'A simple rice bowl.',
		image: '',
		time: 20,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Any',
		tags: [],
		ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }],
		steps: ['Cook rice.'],
		nutrition
	};
	let responses = 0;
	const fetcher = (async (input: any, init: any) => {
		const url = new URL(String(input));
		assert.equal(url.origin, 'https://chatgpt.com');
		assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-access');
		assert.equal(new Headers(init.headers).get('chatgpt-account-id'), 'account-1');
		if (url.pathname.endsWith('/models'))
			return Response.json({
				models: [
					{
						slug: 'native-test',
						display_name: 'Native',
						visibility: 'list',
						supported_reasoning_levels: [{ effort: 'high' }]
					}
				]
			});
		assert.equal(url.pathname, '/backend-api/codex/responses');
		responses++;
		const body = JSON.parse(init.body);
		assert.equal(body.reasoning.effort, 'high');
		return new Response(
			'data: ' +
				JSON.stringify({
					type: 'response.completed',
					response: {
						status: 'completed',
						output: [
							{
								content: [
									{
										type: 'output_text',
										text: JSON.stringify({ recipes: [recipe, recipe, recipe] })
									}
								]
							}
						]
					}
				}) +
				'\n\n'
		);
	}) as typeof fetch;
	const url = new URL('https://flavorithm.example/api/ai');
	const event = (effort = 'high') =>
		({
			url,
			locals: { user: owner.user },
			fetch: fetcher,
			request: new Request(url, {
				method: 'POST',
				headers: { origin: url.origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'generate',
					provider: 'chatgpt',
					model: 'native-test',
					apiKey: 'forged-browser-key',
					connectionId: result.accountId,
					reasoning: { effort },
					preferences: defaultPreferences
				})
			})
		}) as any;
	const response = await route.POST(event());
	assert.equal(response.status, 200);
	assert.equal((await response.json()).recipes.length, 3);
	assert.equal((await route.POST(event('unsupported'))).status, 400);
	assert.equal(responses, 1);
	const stranger = await user();
	assert.equal((await route.POST({ ...event(), locals: { user: stranger.user } })).status, 404);
});

test('nested Codex terminal refresh errors require reconnection and JWT expiry works without expires_in', async (t) => {
	const owner = await user();
	const f = fixture();
	let now = Date.now();
	t.mock.method(Date, 'now', () => now);
	const start = await device.startCodexDevice(owner, f.fetcher);
	now += 6000;
	const result = await device.pollCodexDevice({ ...owner, loginId: start.loginId }, f.fetcher);
	if (!('accountId' in result)) throw new Error('Expected saved account');
	const saved = storage.getChatGPTAccount(owner.userId, result.accountId)!;
	const credentials = storage.decryptChatGPTCredentials(
		owner.userId,
		saved.id,
		saved.mode,
		saved.credentialEnvelope!
	);
	storage.saveChatGPTAccount({ ...saved, accountId: saved.id, credentials, expiresAt: now - 1000 });
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json({ error: { code: 'refresh_token_reused' } }, { status: 400 })
	);
	await assert.rejects(oauth.getChatGPTAccessToken(owner.userId, saved.id), { status: 401 });
	assert.equal(storage.getChatGPTAccount(owner.userId, saved.id)!.credentialEnvelope, null);
	const expires = Math.floor(now / 1000) + 3600;
	const token = await new SignJWT({})
		.setProtectedHeader({ alg: 'RS256' })
		.setExpirationTime(expires)
		.sign(privateKey);
	assert.equal(device.codexTokenExpiry(token), expires * 1000);
	assert.throws(() => device.codexTokenExpiry('opaque-token'), { status: 502 });
});
