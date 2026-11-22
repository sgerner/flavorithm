import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CompanionConfig } from '../src/lib/server/chatgpt-companion.ts';

const tempDir = await mkdtemp(join(tmpdir(), 'flavorithm-oauth-test-'));
process.env.FLAVORITHM_DB_PATH = join(tempDir, 'test.sqlite');
process.env.ORIGIN = 'http://127.0.0.1:3000';

const backend = await import('../src/lib/server/db.ts');
const oauth = await import('../src/lib/server/chatgpt-oauth.ts');
const requestedScopes = oauth.REQUESTED_SCOPES;
const nativeFetch = globalThis.fetch;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
Object.assign(publicJwk, { kid: 'flavorithm-test-key', alg: 'RS256', use: 'sig' });

type CodeData = {
	nonce: string;
	clientId: string;
	subject: string;
	scopes: string[];
	challenge: string;
	wrongNonce?: boolean;
};

const codeData = new Map<string, CodeData>();
let nextClientNumber = 1;
let refreshCount = 0;
let revocationAttempts = 0;
let revocationFails = false;
const revokedTokens: string[] = [];
let refreshErrorCode: string | null = null;
let refreshHttpStatus = 400;
const refreshTokensSeen: string[] = [];
let refreshGate: Promise<void> | null = null;
let refreshStarted: (() => void) | null = null;

function responseJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

async function identityToken(data: CodeData): Promise<string> {
	return new SignJWT({
		nonce: data.wrongNonce ? `${data.nonce}-wrong` : data.nonce,
		email: 'same.chatgpt@example.com',
		email_verified: true
	})
		.setProtectedHeader({ alg: 'RS256', kid: 'flavorithm-test-key' })
		.setIssuer(oauth.OPENAI_ISSUER)
		.setAudience(data.clientId)
		.setSubject(data.subject)
		.setIssuedAt()
		.setExpirationTime('1h')
		.sign(privateKey);
}

globalThis.fetch = async (input, init) => {
	const url =
		typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
	if (url === oauth.OPENAI_DISCOVERY_URL) {
		return responseJson({
			issuer: oauth.OPENAI_ISSUER,
			jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
			revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke'
		});
	}
	if (url === 'https://auth.openai.com/.well-known/jwks.json') {
		return responseJson({ keys: [publicJwk] });
	}
	if (url === oauth.OPENAI_TOKEN_URL) {
		const form = new URLSearchParams(String(init?.body ?? ''));
		if (form.get('grant_type') === 'authorization_code') {
			const code = form.get('code') ?? '';
			const data = codeData.get(code);
			assert.ok(data, 'authorization code is tied to the expected transaction');
			assert.equal(
				form.get('client_id'),
				data.clientId,
				'the issued client ID is used at exchange'
			);
			assert.notEqual(form.get('client_id'), 'dynamic_agent_client');
			if (process.env.OPENAI_OAUTH_CLIENT_SECRET) {
				if (process.env.OPENAI_OAUTH_CLIENT_AUTH_METHOD === 'client_secret_basic') {
					const encoded = (value: string) => new URLSearchParams({ value }).toString().slice(6);
					assert.equal(
						new Headers(init?.headers).get('authorization'),
						'Basic ' +
							Buffer.from(
								`${encoded(data.clientId)}:${encoded(process.env.OPENAI_OAUTH_CLIENT_SECRET)}`
							).toString('base64')
					);
					assert.equal(form.has('client_secret'), false);
				} else assert.equal(form.get('client_secret'), process.env.OPENAI_OAUTH_CLIENT_SECRET);
			}
			const verifier = form.get('code_verifier') ?? '';
			const challenge = createHash('sha256').update(verifier).digest('base64url');
			assert.equal(challenge, data.challenge, 'the original PKCE verifier is used at exchange');
			return responseJson({
				access_token: `access-${data.clientId}`,
				refresh_token: `refresh-${data.clientId}`,
				id_token: await identityToken(data),
				token_type: 'Bearer',
				expires_in: 3600,
				scope: data.scopes.join(' '),
				earliest_refresh_at: 0
			});
		}
		if (form.get('grant_type') === 'refresh_token') {
			if (refreshErrorCode) return responseJson({ error: refreshErrorCode }, refreshHttpStatus);
			refreshCount += 1;
			refreshTokensSeen.push(form.get('refresh_token') ?? '');
			const refreshNumber = refreshCount;
			refreshStarted?.();
			if (refreshGate) await refreshGate;
			return responseJson({
				access_token: `access-refreshed-${refreshNumber}`,
				refresh_token: `refresh-rotated-${refreshNumber}`,
				expires_in: 3600,
				scope: requestedScopes.join(' '),
				earliest_refresh_at: 0
			});
		}
		return responseJson({ error: 'unsupported_grant_type' }, 400);
	}
	if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
		revocationAttempts += 1;
		revokedTokens.push(new URLSearchParams(String(init?.body ?? '')).get('token') ?? '');
		return new Response(null, { status: revocationFails ? 503 : 200 });
	}
	throw new Error(`Unexpected fetch in OAuth test: ${url}`);
};

after(async () => {
	globalThis.fetch = nativeFetch;
	backend.getDatabase().close();
	await rm(tempDir, { recursive: true, force: true });
});

async function createLocalUser(email: string) {
	return backend.registerUser('OAuth Test User', email, 'correct horse battery staple');
}

async function beginFlow(
	user: Awaited<ReturnType<typeof createLocalUser>>,
	options: { accountId?: string; reconsent?: boolean } = {}
) {
	const binding = backend.getSessionBinding(user.token);
	assert.ok(binding);
	const result = await oauth.startChatGPTOAuth({
		userId: user.user.id,
		sessionBinding: binding,
		appUrl: new URL('http://127.0.0.1:3000/'),
		mode: 'local',
		...(options.accountId ? { accountId: options.accountId } : {}),
		reconsent: options.reconsent ?? false
	});
	const authorizationUrl = new URL(result.authorizationUrl);
	assert.equal(authorizationUrl.origin, new URL(oauth.OPENAI_AUTHORIZE_URL).origin);
	if (options.accountId) {
		assert.notEqual(authorizationUrl.searchParams.get('client_id'), 'dynamic_agent_client');
		assert.ok(authorizationUrl.searchParams.get('id_token_hint'));
		assert.equal(authorizationUrl.searchParams.has('agent_name_hint'), false);
	} else {
		assert.equal(authorizationUrl.searchParams.get('client_id'), 'dynamic_agent_client');
		assert.equal(authorizationUrl.searchParams.get('agent_name_hint'), 'Flavorithm');
	}
	assert.equal(
		authorizationUrl.searchParams.get('redirect_uri')?.startsWith('http://127.0.0.1:'),
		true
	);
	assert.equal(
		new URL(authorizationUrl.searchParams.get('redirect_uri')!).pathname,
		'/auth/callback'
	);
	assert.match(authorizationUrl.searchParams.get('ext_agent_host_id') ?? '', /^urn:uuid:/);
	assert.equal(authorizationUrl.searchParams.get('resource'), oauth.OPENAI_RESOURCE);
	assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
	assert.deepEqual(
		new Set(authorizationUrl.searchParams.get('scope')?.split(' ')),
		new Set(requestedScopes)
	);
	return authorizationUrl;
}

async function callbackFor(
	authorizationUrl: URL,
	options: {
		scopes?: string[];
		subject?: string;
		wrongNonce?: boolean;
		issuedClientId?: string;
		includeClientId?: boolean;
	} = {}
): Promise<{ response: Response; code: string; clientId: string }> {
	const clientId = options.issuedClientId ?? `oaiapp_test_${nextClientNumber++}`;
	const code = randomUUID();
	const nonce = authorizationUrl.searchParams.get('nonce');
	const challenge = authorizationUrl.searchParams.get('code_challenge');
	assert.ok(nonce && challenge);
	codeData.set(code, {
		nonce,
		challenge,
		clientId,
		subject: options.subject ?? 'openai-subject-shared',
		scopes: options.scopes ?? [...requestedScopes],
		wrongNonce: options.wrongNonce
	});
	const callback = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
	callback.searchParams.set('code', code);
	callback.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
	if (options.includeClientId !== false) callback.searchParams.set('client_id', clientId);
	return { response: await nativeFetch(callback), code, clientId };
}

test('callback validates state and nonce, consumes state once, and keeps a declined plan grant disabled', async () => {
	const user = await createLocalUser('oauth-state@example.com');
	const authorizationUrl = await beginFlow(user);
	const callback = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
	callback.searchParams.set('code', randomUUID());
	callback.searchParams.set('client_id', 'oaiapp_invalid_state');
	callback.searchParams.set('state', 'wrong-state-value');
	const badStateResponse = await nativeFetch(callback);
	assert.equal(badStateResponse.status, 400);

	const declined = await callbackFor(authorizationUrl, {
		scopes: requestedScopes.filter((scope) => scope !== 'chatgpt.tokens.use.direct')
	});
	assert.equal(declined.response.status, 200);
	const callbackHtml = await declined.response.text();
	assert.match(callbackHtml, /ChatGPT account is connected/);
	assert.doesNotMatch(callbackHtml, /access-oaiapp|refresh-oaiapp|authorization code/i);
	const account = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.ok(account);
	assert.equal(account.connected, true);
	assert.equal(account.planEnabled, false);
	await assert.rejects(oauth.getChatGPTAccessToken(user.user.id, account.id), (error: unknown) => {
		return error instanceof oauth.ChatGPTOAuthError && error.code === 'chatgpt_plan_scope_missing';
	});
	await assert.rejects(nativeFetch(new URL(authorizationUrl.searchParams.get('redirect_uri')!)));

	const reauthorization = await beginFlow(user, { accountId: account.id, reconsent: true });
	assert.equal(reauthorization.searchParams.get('client_id'), declined.clientId);
	assert.equal(
		reauthorization.searchParams.get('ext_agent_host_id'),
		authorizationUrl.searchParams.get('ext_agent_host_id')
	);
	assert.equal(reauthorization.searchParams.get('prompt'), 'consent');
	const reauthorized = await callbackFor(reauthorization, {
		issuedClientId: declined.clientId,
		includeClientId: false
	});
	assert.equal(reauthorized.response.status, 200);
	const afterReauthorization = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.equal(afterReauthorization?.id, account.id);
	assert.equal(afterReauthorization?.planEnabled, true);
	assert.ok((afterReauthorization?.updatedAt ?? 0) >= account.updatedAt);

	const wrongNonceUrl = await beginFlow(user);
	const invalidIdentity = await callbackFor(wrongNonceUrl, { wrongNonce: true });
	assert.equal(invalidIdentity.response.status, 401);
	assert.equal(oauth.listChatGPTAccounts(user.user.id).length, 1);
});

test('accounts stay separate by issued registration and rotating refreshes are serialized', async () => {
	const user = await createLocalUser('oauth-isolation@example.com');
	const firstAuthorization = await beginFlow(user);
	const first = await callbackFor(firstAuthorization, { issuedClientId: 'oaiapp_isolated_one' });
	assert.equal(first.response.status, 200);
	const secondAuthorization = await beginFlow(user);
	const second = await callbackFor(secondAuthorization, { issuedClientId: 'oaiapp_isolated_two' });
	assert.equal(second.response.status, 200);

	const accounts = oauth.listChatGPTAccounts(user.user.id);
	assert.equal(accounts.length, 2);
	assert.notEqual(accounts[0]?.id, accounts[1]?.id);
	assert.equal(accounts[0]?.subject, accounts[1]?.subject);
	assert.equal(accounts[0]?.email, accounts[1]?.email);

	const account = accounts.find((candidate) => candidate.id !== '')!;
	const database = backend.getDatabase();
	database
		.prepare(
			'UPDATE chatgpt_oauth_accounts SET expires_at = ?, earliest_refresh_at = 0 WHERE user_id = ? AND id = ?'
		)
		.run(Date.now() - 1, user.user.id, account.id);
	const before = refreshCount;
	const parallelResults = await Promise.all([
		oauth.getChatGPTAccessToken(user.user.id, account.id),
		oauth.getChatGPTAccessToken(user.user.id, account.id)
	]);
	assert.deepEqual(parallelResults, [
		`access-refreshed-${before + 1}`,
		`access-refreshed-${before + 1}`
	]);
	assert.equal(refreshCount, before + 1);
	assert.equal(
		refreshTokensSeen.at(-1),
		`refresh-${account.label === 'same.chatgpt@example.com' ? (account.id === accounts[0]?.id ? 'oaiapp_isolated_one' : 'oaiapp_isolated_two') : 'missing'}`
	);

	database
		.prepare(
			'UPDATE chatgpt_oauth_accounts SET expires_at = ?, earliest_refresh_at = 0 WHERE user_id = ? AND id = ?'
		)
		.run(Date.now() - 1, user.user.id, account.id);
	assert.equal(
		await oauth.getChatGPTAccessToken(user.user.id, account.id),
		`access-refreshed-${before + 2}`
	);
	assert.equal(refreshTokensSeen.at(-1), `refresh-rotated-${before + 1}`);
});

test('a failed remote revoke still clears local tokens and retains the account mapping', async () => {
	const user = await createLocalUser('oauth-revoke@example.com');
	const authorizationUrl = await beginFlow(user);
	const connected = await callbackFor(authorizationUrl, { issuedClientId: 'oaiapp_revoke' });
	assert.equal(connected.response.status, 200);
	const account = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.ok(account);
	revocationFails = true;
	const beforeAttempts = revocationAttempts;
	const result = await oauth.disconnectChatGPTAccount(user.user.id, account.id);
	revocationFails = false;
	assert.deepEqual(result, { remoteRevoked: false });
	assert.equal(revocationAttempts - beforeAttempts, 3);
	const afterDisconnect = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.equal(afterDisconnect?.id, account.id);
	assert.equal(afterDisconnect?.connected, false);
	assert.equal(afterDisconnect?.planEnabled, true);
	assert.ok((afterDisconnect?.updatedAt ?? 0) > account.updatedAt);
});

test('disconnect waits for rotation and revokes the latest token before clearing local credentials', async () => {
	const user = await createLocalUser('oauth-revoke-refresh-race@example.com');
	const authorizationUrl = await beginFlow(user);
	const connected = await callbackFor(authorizationUrl, { issuedClientId: 'oaiapp_revoke_race' });
	assert.equal(connected.response.status, 200);
	const account = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.ok(account);
	backend
		.getDatabase()
		.prepare(
			'UPDATE chatgpt_oauth_accounts SET expires_at = 0, earliest_refresh_at = 0 WHERE id = ?'
		)
		.run(account.id);

	let releaseRefresh!: () => void;
	refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
	const started = new Promise<void>((resolve) => (refreshStarted = resolve));
	const refreshBefore = refreshCount;
	const revokedBefore = revokedTokens.length;
	const refreshing = oauth.getChatGPTAccessToken(user.user.id, account.id);
	try {
		await started;
		const disconnecting = oauth.disconnectChatGPTAccount(user.user.id, account.id);
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseRefresh();
		assert.equal(await refreshing, `access-refreshed-${refreshBefore + 1}`);
		assert.deepEqual(await disconnecting, { remoteRevoked: true });
		assert.equal(revokedTokens.length, revokedBefore + 1);
		assert.equal(revokedTokens.at(-1), `refresh-rotated-${refreshBefore + 1}`);
		assert.equal(oauth.listChatGPTAccounts(user.user.id)[0]?.connected, false);
		await assert.rejects(() => oauth.getChatGPTAccessToken(user.user.id, account.id), {
			status: 401
		});
		assert.equal(refreshCount, refreshBefore + 1);
	} finally {
		releaseRefresh();
		refreshGate = null;
		refreshStarted = null;
	}
});

test('the callback refuses to save credentials after its initiating app session expires', async () => {
	const user = await createLocalUser('oauth-expired-session@example.com');
	const authorizationUrl = await beginFlow(user);
	backend.deleteSession(user.token);
	const attempted = await callbackFor(authorizationUrl, {
		issuedClientId: 'oaiapp_expired_session'
	});
	assert.equal(attempted.response.status, 401);
	assert.deepEqual(oauth.listChatGPTAccounts(user.user.id), []);
});

test('hosted OAuth uses the exact configured callback and encrypted server credentials', async () => {
	const storage = await import('../src/lib/server/oauth-storage.ts');
	const user = await createLocalUser('oauth-hosted@example.com');
	const validKeyBytes = Buffer.alloc(32, 9);
	const canonicalKey = validKeyBytes.toString('base64');
	process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = canonicalKey;
	process.env.OPENAI_OAUTH_CLIENT_ID = 'flavorithm-hosted-client';
	process.env.OPENAI_OAUTH_CLIENT_SECRET = 'hosted:secret with + chars';
	process.env.OPENAI_OAUTH_CLIENT_AUTH_METHOD = 'client_secret_basic';
	process.env.OPENAI_OAUTH_REDIRECT_URI =
		'https://flavorithm.example/api/connections/chatgpt/callback';
	try {
		assert.deepEqual(storage.decodeHostedEncryptionKey(), validKeyBytes);
		process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = `  ${canonicalKey} \n`;
		assert.deepEqual(storage.decodeHostedEncryptionKey(), validKeyBytes);
		const appUrl = new URL('https://flavorithm.example/settings');
		for (const invalidKey of [
			'',
			'   ',
			Buffer.alloc(31, 9).toString('base64'),
			Buffer.alloc(33, 9).toString('base64'),
			canonicalKey.replace(/=+$/, ''),
			Buffer.alloc(32, 0xfb).toString('base64url'),
			`${canonicalKey.slice(0, 10)} ${canonicalKey.slice(10)}`
		]) {
			process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = invalidKey;
			assert.equal(storage.decodeHostedEncryptionKey(), null);
			assert.equal(
				oauth.getChatGPTOAuthAvailability({ url: appUrl, clientAddress: '203.0.113.10' }).mode,
				'device'
			);
			assert.throws(
				() =>
					storage.encryptChatGPTCredentials(user.user.id, 'acct-invalid-key', 'hosted', {
						accessToken: 'a',
						refreshToken: 'r',
						idToken: 'i'
					}),
				/Hosted OAuth encryption is unavailable\./
			);
		}
		process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = canonicalKey;

		const roundTripEnvelope = storage.encryptChatGPTCredentials(
			user.user.id,
			'acct-roundtrip',
			'hosted',
			{
				accessToken: 'access-rt',
				refreshToken: null,
				idToken: 'id-rt',
				codexAccountId: 'codex-rt'
			}
		);
		assert.deepEqual(
			storage.decryptChatGPTCredentials(
				user.user.id,
				'acct-roundtrip',
				'hosted',
				roundTripEnvelope
			),
			{
				accessToken: 'access-rt',
				refreshToken: null,
				idToken: 'id-rt',
				codexAccountId: 'codex-rt'
			}
		);

		const availability = oauth.getChatGPTOAuthAvailability({
			url: appUrl,
			clientAddress: '203.0.113.10'
		});
		assert.equal(availability.mode, 'hosted');
		const binding = backend.getSessionBinding(user.token);
		assert.ok(binding);
		const start = await oauth.startChatGPTOAuth({
			userId: user.user.id,
			sessionBinding: binding,
			appUrl,
			mode: 'hosted'
		});
		const authorizationUrl = new URL(start.authorizationUrl);
		assert.equal(authorizationUrl.searchParams.get('client_id'), 'flavorithm-hosted-client');
		assert.equal(
			authorizationUrl.searchParams.get('redirect_uri'),
			process.env.OPENAI_OAUTH_REDIRECT_URI
		);
		assert.equal(authorizationUrl.searchParams.has('agent_name_hint'), false);
		assert.equal(authorizationUrl.searchParams.has('ext_agent_host_id'), false);
		const code = randomUUID();
		codeData.set(code, {
			nonce: authorizationUrl.searchParams.get('nonce')!,
			challenge: authorizationUrl.searchParams.get('code_challenge')!,
			clientId: 'flavorithm-hosted-client',
			subject: 'hosted-openai-subject',
			scopes: [...requestedScopes]
		});
		const callback = new URL(process.env.OPENAI_OAUTH_REDIRECT_URI);
		callback.searchParams.set('code', code);
		callback.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
		const context = { userId: user.user.id, sessionBinding: binding };
		const result = await oauth.handleHostedChatGPTCallback(callback, context);
		assert.equal(result.status, 200);
		assert.match(await result.text(), /Your ChatGPT account is connected/);
		const replay = await oauth.handleHostedChatGPTCallback(callback, context);
		assert.equal(replay.status, 400);
		const account = oauth.listChatGPTAccounts(user.user.id)[0];
		assert.ok(account);
		assert.equal(account.planEnabled, true);
		const storedCredential = backend
			.getDatabase()
			.prepare(
				'SELECT credential_envelope FROM chatgpt_oauth_accounts WHERE user_id = ? AND id = ?'
			)
			.get(user.user.id, account.id) as { credential_envelope: string };
		assert.doesNotMatch(
			storedCredential.credential_envelope,
			/access-flavorithm-hosted-client|refresh-flavorithm-hosted-client/
		);
		assert.equal(
			await oauth.getChatGPTAccessToken(user.user.id, account.id),
			'access-flavorithm-hosted-client'
		);

		// A still-active initiating session does not authorize a different browser account
		// or a replacement session to finish this connection (including an upstream SSO switch).
		for (const otherContext of [
			{ userId: 'another-user', sessionBinding: binding },
			{ userId: user.user.id, sessionBinding: 'another-session-binding' },
			{ userId: null, sessionBinding: null }
		]) {
			const attempt = await oauth.startChatGPTOAuth({
				userId: user.user.id,
				sessionBinding: binding,
				appUrl,
				mode: 'hosted'
			});
			const switchedCallback: URL = new URL(process.env.OPENAI_OAUTH_REDIRECT_URI!);
			switchedCallback.searchParams.set(
				'state',
				new URL(attempt.authorizationUrl).searchParams.get('state')!
			);
			switchedCallback.searchParams.set('code', 'must-not-be-exchanged');
			assert.equal(
				(await oauth.handleHostedChatGPTCallback(switchedCallback, otherContext)).status,
				401
			);
			assert.equal(oauth.listChatGPTAccounts(user.user.id).length, 1);
		}

		const expiredStart = await oauth.startChatGPTOAuth({
			userId: user.user.id,
			sessionBinding: binding,
			appUrl,
			mode: 'hosted'
		});
		const expiredAuthorization = new URL(expiredStart.authorizationUrl);
		const expiredState = expiredAuthorization.searchParams.get('state')!;
		const expiredHash = createHash('sha256').update(expiredState).digest('base64url');
		backend
			.getDatabase()
			.prepare('UPDATE chatgpt_oauth_pending SET expires_at = ? WHERE state_hash = ?')
			.run(Date.now() - 1, expiredHash);
		const expiredCallback = new URL(process.env.OPENAI_OAUTH_REDIRECT_URI);
		expiredCallback.searchParams.set('state', expiredState);
		const expired = await oauth.handleHostedChatGPTCallback(expiredCallback, context);
		assert.equal(expired.status, 400);
		assert.equal(
			backend
				.getDatabase()
				.prepare('SELECT 1 AS present FROM chatgpt_oauth_pending WHERE state_hash = ?')
				.get(expiredHash),
			undefined
		);

		// Malformed stored envelopes fail before keyFor(mode) runs or creates oauth.key on disk.
		const now = Date.now();
		backend
			.getDatabase()
			.prepare(
				'INSERT INTO chatgpt_oauth_pending(state_hash, user_id, created_at, expires_at, envelope) VALUES (?, ?, ?, ?, ?)'
			)
			.run('malformed-pending-fields', user.user.id, now, now + 60_000, '{"iv":"only-iv"}');
		backend
			.getDatabase()
			.prepare(
				'INSERT INTO chatgpt_oauth_pending(state_hash, user_id, created_at, expires_at, envelope) VALUES (?, ?, ?, ?, ?)'
			)
			.run('malformed-pending-json', user.user.id, now, now + 60_000, 'not-json');
		delete process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY;
		assert.equal(storage.decodeHostedEncryptionKey(), null);
		assert.throws(
			() => storage.consumeHostedOAuthTransaction('malformed-pending-fields', now + 1),
			/OAuth transaction is unavailable\./
		);
		assert.throws(
			() => storage.consumeHostedOAuthTransaction('malformed-pending-json', now + 1),
			SyntaxError
		);
		for (const malformed of [
			'{}',
			'{"iv":"a","tag":"b"}',
			'null',
			'{"iv":1,"tag":"b","data":"c"}'
		]) {
			assert.throws(
				() => storage.decryptChatGPTCredentials(user.user.id, account.id, 'hosted', malformed),
				/OAuth credentials are unavailable\./
			);
		}
		assert.throws(
			() => storage.decryptChatGPTCredentials(user.user.id, account.id, 'hosted', '{bad-json'),
			SyntaxError
		);
		const emptyKeyDir = await mkdtemp(join(tmpdir(), 'flavorithm-no-key-'));
		const previousDbPath = process.env.FLAVORITHM_DB_PATH;
		process.env.FLAVORITHM_DB_PATH = join(emptyKeyDir, 'test.sqlite');
		try {
			assert.throws(
				() => storage.decryptChatGPTCredentials(user.user.id, account.id, 'local', '{}'),
				/OAuth credentials are unavailable\./
			);
			await assert.rejects(stat(join(emptyKeyDir, 'oauth.key')), { code: 'ENOENT' });
		} finally {
			if (previousDbPath === undefined) delete process.env.FLAVORITHM_DB_PATH;
			else process.env.FLAVORITHM_DB_PATH = previousDbPath;
			await rm(emptyKeyDir, { recursive: true, force: true });
		}
	} finally {
		delete process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY;
		delete process.env.OPENAI_OAUTH_CLIENT_ID;
		delete process.env.OPENAI_OAUTH_CLIENT_SECRET;
		delete process.env.OPENAI_OAUTH_CLIENT_AUTH_METHOD;
		delete process.env.OPENAI_OAUTH_REDIRECT_URI;
	}
});

test('confirmed unusable refresh tokens require reconnection while keeping their registration', async () => {
	const user = await createLocalUser('oauth-terminal-refresh@example.com');
	for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused']) {
		const authorization = await beginFlow(user);
		await callbackFor(authorization, { issuedClientId: `oaiapp_terminal_${code}` });
		const account = oauth.listChatGPTAccounts(user.user.id).find((a) => a.connected && a.label)!;
		backend
			.getDatabase()
			.prepare(
				'UPDATE chatgpt_oauth_accounts SET expires_at = 0, earliest_refresh_at = 0 WHERE id = ?'
			)
			.run(account.id);
		refreshErrorCode = code;
		try {
			await assert.rejects(() => oauth.getChatGPTAccessToken(user.user.id, account.id), {
				status: 401
			});
		} finally {
			refreshErrorCode = null;
		}
		const retained = oauth.listChatGPTAccounts(user.user.id).find((a) => a.id === account.id);
		assert.ok(retained);
		assert.equal(retained.connected, false);
	}
});

test('an older refresh failure cannot clear a newly reauthorized credential set', async () => {
	const storage = await import('../src/lib/server/oauth-storage.ts');
	const user = await createLocalUser('oauth-lease-replace@example.com');
	const authorization = await beginFlow(user);
	await callbackFor(authorization, { issuedClientId: 'oaiapp_lease_replace' });
	const account = storage.listStoredChatGPTAccounts(user.user.id)[0];
	assert.ok(account);
	assert.equal(
		storage.claimChatGPTRefreshLease(user.user.id, account.id, 'old-lease', Date.now() + 30_000),
		true
	);
	storage.saveChatGPTAccount({
		accountId: account.id,
		userId: user.user.id,
		mode: 'local',
		clientId: account.clientId,
		subject: account.subject,
		email: account.email,
		scopes: account.scopes,
		credentials: {
			accessToken: 'newly-authorized',
			refreshToken: 'new-refresh',
			idToken: 'retained-id'
		},
		expiresAt: Date.now() + 3600_000,
		earliestRefreshAt: 0
	});
	storage.clearChatGPTCredentials(user.user.id, account.id, 'old-lease');
	assert.equal(await oauth.getChatGPTAccessToken(user.user.id, account.id), 'newly-authorized');
});

async function companionBundle(
	user: Awaited<ReturnType<typeof createLocalUser>>,
	options: { wrongNonce?: boolean; scopes?: string[] } = {}
) {
	const sessionBinding = backend.getSessionBinding(user.token)!;
	const appUrl = new URL('https://flavorithm.example/');
	const keyPath = join(tempDir, 'oauth.key');
	try {
		await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const localKey = await readFile(keyPath);
	const setup: CompanionConfig = {
		pairingId: randomBytes(32).toString('base64url'),
		pairingKey: randomBytes(32).toString('base64url'),
		nonce: randomBytes(32).toString('base64url'),
		origin: appUrl.origin,
		expiresAt: Date.now() + 10 * 60 * 1000,
		clientId: 'dynamic_agent_client',
		newRegistration: true,
		reconsent: false
	};
	const pairingIv = randomBytes(12);
	const pairingCipher = createCipheriv('aes-256-gcm', localKey, pairingIv);
	pairingCipher.setAAD(
		Buffer.from(`flavorithm:chatgpt:local-pending:${user.user.id}:${setup.pairingId}`)
	);
	const pairingData = Buffer.concat([
		pairingCipher.update(JSON.stringify({ ...setup, sessionBinding }), 'utf8'),
		pairingCipher.final()
	]);
	const envelope = JSON.stringify({
		iv: pairingIv.toString('base64url'),
		tag: pairingCipher.getAuthTag().toString('base64url'),
		data: pairingData.toString('base64url')
	});
	backend
		.getDatabase()
		.prepare(
			'INSERT INTO chatgpt_oauth_pairings(id, user_id, expires_at, envelope) VALUES (?, ?, ?, ?)'
		)
		.run(setup.pairingId, user.user.id, setup.expiresAt, envelope);
	const token = {
		access_token: 'sensitive-access',
		refresh_token: 'sensitive-refresh',
		expires_in: 3600,
		id_token: await identityToken({
			clientId: 'oaiapp_companion',
			subject: 'companion-user',
			nonce: setup.nonce,
			challenge: 'unused',
			scopes: requestedScopes,
			wrongNonce: options.wrongNonce
		}),
		scope: (options.scopes ?? requestedScopes).join(' ')
	};
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(setup.pairingKey, 'base64url'), iv);
	cipher.setAAD(Buffer.from(`flavorithm:companion:${setup.origin}:${setup.pairingId}`));
	const data = Buffer.concat([
		cipher.update(JSON.stringify({ clientId: 'oaiapp_companion', token, receivedAt: Date.now() })),
		cipher.final()
	]);
	return {
		userId: user.user.id,
		sessionBinding,
		appUrl,
		bundle: {
			version: 1 as const,
			pairingId: setup.pairingId,
			iv: iv.toString('base64url'),
			tag: cipher.getAuthTag().toString('base64url'),
			data: data.toString('base64url')
		}
	};
}

test('companion import rejects forged identity, session swaps, cross-user bundles, tampering, replays, and expired attempts', async () => {
	const user = await createLocalUser('companion-validation@example.com');
	await assert.rejects(
		oauth.finishChatGPTCompanion(await companionBundle(user, { wrongNonce: true })),
		{ code: 'chatgpt_identity_invalid' }
	);
	assert.equal(oauth.listChatGPTAccounts(user.user.id).length, 0);
	const wrongSession = await companionBundle(user);
	await assert.rejects(
		oauth.finishChatGPTCompanion({ ...wrongSession, sessionBinding: 'another-session' }),
		{ code: 'chatgpt_pairing_session_mismatch' }
	);
	const tampered = await companionBundle(user);
	tampered.bundle.tag = randomBytes(16).toString('base64url');
	await assert.rejects(oauth.finishChatGPTCompanion(tampered), (error: unknown) => {
		return (
			error instanceof oauth.ChatGPTOAuthError &&
			error.status === 400 &&
			error.code === 'chatgpt_pairing_invalid'
		);
	});
	const missingField = await companionBundle(user);
	missingField.bundle.data = '';
	await assert.rejects(oauth.finishChatGPTCompanion(missingField), (error: unknown) => {
		return (
			error instanceof oauth.ChatGPTOAuthError &&
			error.status === 400 &&
			error.code === 'chatgpt_pairing_invalid'
		);
	});
	const storage = await import('../src/lib/server/oauth-storage.ts');
	const rawKey = randomBytes(32);
	const rawIv = randomBytes(12);
	const rawAad = Buffer.from('flavorithm:companion:https://flavorithm.example:pairing-check');
	const rawCipher = createCipheriv('aes-256-gcm', rawKey, rawIv);
	rawCipher.setAAD(rawAad);
	const rawData = Buffer.concat([rawCipher.update('{"ok":true}', 'utf8'), rawCipher.final()]);
	const rawEnvelope = {
		iv: rawIv.toString('base64url'),
		tag: rawCipher.getAuthTag().toString('base64url'),
		data: rawData.toString('base64url')
	};
	assert.equal(storage.decipherOAuthEnvelope(rawEnvelope, rawKey, rawAad), '{"ok":true}');
	assert.throws(() => storage.decipherOAuthEnvelope(rawEnvelope, rawKey, Buffer.from('wrong-aad')));
	assert.throws(
		() => storage.decipherOAuthEnvelope({ ...rawEnvelope, iv: '' }, rawKey, rawAad),
		/OAuth envelope is invalid\./
	);
	const expired = await companionBundle(user);
	backend
		.getDatabase()
		.prepare('UPDATE chatgpt_oauth_pairings SET expires_at = ? WHERE id = ?')
		.run(Date.now() - 1, expired.bundle.pairingId);
	await assert.rejects(oauth.finishChatGPTCompanion(expired), { code: 'chatgpt_pairing_expired' });
	assert.equal(oauth.listChatGPTAccounts(user.user.id).length, 0);

	const valid = await companionBundle(user);
	const stranger = await createLocalUser('companion-stranger@example.com');
	await assert.rejects(
		oauth.finishChatGPTCompanion({
			...valid,
			userId: stranger.user.id,
			sessionBinding: backend.getSessionBinding(stranger.token)!
		}),
		{ code: 'chatgpt_pairing_expired' }
	);
	assert.equal(oauth.listChatGPTAccounts(stranger.user.id).length, 0);
	const connected = await oauth.finishChatGPTCompanion(valid);
	assert.equal(connected.connected, true);
	assert.equal(connected.planEnabled, true);
	assert.equal(
		await oauth.getChatGPTAccessToken(user.user.id, connected.accountId),
		'sensitive-access'
	);
	await assert.rejects(oauth.finishChatGPTCompanion(valid), { code: 'chatgpt_pairing_expired' });
});

test('companion import retains sign-in without claiming plan access when the provider declines plan scope', async () => {
	const user = await createLocalUser('companion-scope@example.com');
	await oauth.finishChatGPTCompanion(
		await companionBundle(user, { scopes: ['openid', 'profile', 'email'] })
	);
	const account = oauth.listChatGPTAccounts(user.user.id)[0];
	assert.equal(account.connected, true);
	assert.equal(account.planEnabled, false);
	await assert.rejects(oauth.getChatGPTAccessToken(user.user.id, account.id), {
		code: 'chatgpt_plan_scope_missing'
	});
});

test('connection API offers device auth, supports configured hosted OAuth, and finishes legacy imports', async () => {
	const route = await import('../src/routes/api/connections/chatgpt/+server.ts');
	const user = await createLocalUser('companion-route@example.com');
	const url = new URL('https://flavorithm.example/api/connections/chatgpt');
	const event = (body?: unknown, origin = url.origin) =>
		({
			url,
			locals: { user: user.user },
			cookies: { get: () => user.token },
			getClientAddress: () => '203.0.113.8',
			request: new Request(
				url,
				body === undefined
					? {}
					: {
							method: 'POST',
							headers: {
								origin,
								'content-type': 'application/json',
								'sec-fetch-site': 'same-origin'
							},
							body: JSON.stringify(body)
						}
			)
		}) as unknown as Parameters<typeof route.GET>[0];
	const status = await route.GET(event());
	const availability = await status.json();
	assert.equal(availability.configured, true);
	assert.equal(availability.mode, 'device');
	assert.deepEqual(availability.accounts, []);
	assert.match(status.headers.get('cache-control')!, /no-store/);
	const config = {
		OPENAI_OAUTH_CLIENT_ID: 'oaiapp_hosted_browser',
		OPENAI_OAUTH_REDIRECT_URI: `${url.origin}/api/connections/chatgpt/callback`,
		FLAVORITHM_OAUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64')
	};
	const previous = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
	Object.assign(process.env, config);
	try {
		const configured = await route.GET(event());
		assert.equal((await configured.json()).mode, 'hosted');
		const started = await route.POST(event({ action: 'start' }));
		assert.equal(started.status, 200);
		assert.match(started.headers.get('cache-control')!, /no-store/);
		const result = await started.json();
		const authorization = new URL(result.authorizationUrl);
		assert.equal(authorization.origin, 'https://auth.openai.com');
		assert.equal(authorization.searchParams.get('client_id'), config.OPENAI_OAUTH_CLIENT_ID);
		assert.equal(authorization.searchParams.get('redirect_uri'), config.OPENAI_OAUTH_REDIRECT_URI);
		assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
		assert.equal('script' in result, false);
		assert.equal(authorization.searchParams.has('client_secret'), false);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(
		(await route.POST(event({ action: 'start' }, 'https://attacker.example'))).status,
		403
	);
	assert.equal(
		(await route.POST(event({ action: 'start', oversized: 'x'.repeat(100_001) }))).status,
		413
	);
	assert.equal((await route.POST(event({ action: 'import', bundle: { version: 1 } }))).status, 400);
	const input = await companionBundle(user);
	const imported = await route.POST(event({ action: 'import', bundle: input.bundle }));
	assert.equal(imported.status, 200);
	assert.equal((await route.POST(event({ action: 'import', bundle: input.bundle }))).status, 400);
	assert.equal(oauth.listChatGPTAccounts(user.user.id)[0].connected, true);
	const anonymous = { ...event(), locals: { user: null } };
	assert.equal((await route.GET(anonymous as never)).status, 401);
});

test('mid-TTL upstream 401 refreshes once across concurrent callers, retries routes, preserves transient credentials, and remaps personal reauth to 422', async () => {
	const modelsRoute = await import('../src/routes/api/models/+server.ts');
	const aiRoute = await import('../src/routes/api/ai/+server.ts');
	const storage = await import('../src/lib/server/oauth-storage.ts');
	const { defaultPreferences, seedRecipes } = await import('../src/lib/data.ts');
	const user = await createLocalUser('oauth-mid-ttl-recovery@example.com');

	// Unauthenticated callers still receive HTTP 401.
	const unauthModels = await modelsRoute.GET({
		locals: { user: null },
		fetch: async () => Response.json({}),
		url: new URL('http://127.0.0.1:3000/api/models')
	} as never);
	assert.equal(unauthModels.status, 401);
	const unauthAI = await aiRoute.POST({
		locals: { user: null },
		fetch: async () => Response.json({}),
		request: new Request('http://127.0.0.1:3000/api/ai', {
			method: 'POST',
			headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'generate' })
		})
	} as never);
	assert.equal(unauthAI.status, 401);

	const authUrl = await beginFlow(user);
	const connected = await callbackFor(authUrl, { issuedClientId: 'oaiapp_mid_ttl' });
	assert.equal(connected.response.status, 200);
	const account = oauth.listChatGPTAccounts(user.user.id)[0]!;
	const initialToken = `access-${connected.clientId}`;

	// Token is still mid-TTL (expires 1 hour from now), yet OpenAI revokes it early.
	const seenTokens: string[] = [];
	const beforeRefreshes = refreshCount;
	const providerFetch: typeof fetch = async (input, init) => {
		const target = String(input);
		if (target === 'https://models.dev/api.json') return Response.json({});
		const auth = new Headers(init?.headers).get('authorization') ?? '';
		seenTokens.push(auth);
		if (auth === `Bearer ${initialToken}`) {
			return Response.json({ error: { message: 'Token revoked' } }, { status: 401 });
		}
		if (target === 'https://api.openai.com/v1/models') {
			return Response.json({
				models: [{ slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list' }]
			});
		}
		return new Response(
			`data: ${JSON.stringify({
				type: 'response.completed',
				response: {
					status: 'completed',
					output: [
						{
							content: [
								{
									type: 'output_text',
									text: JSON.stringify({
										recipes: [seedRecipes[0], seedRecipes[1], seedRecipes[2]]
									})
								}
							]
						}
					]
				}
			})}\n\n`,
			{ headers: { 'content-type': 'text/event-stream' } }
		);
	};

	const [modelsRes, aiRes] = await Promise.all([
		modelsRoute.GET({
			locals: { user: user.user },
			fetch: providerFetch,
			url: new URL(
				`http://127.0.0.1:3000/api/models?connection=chatgpt&accountId=${encodeURIComponent(account.id)}`
			)
		} as never),
		aiRoute.POST({
			locals: { user: user.user },
			fetch: providerFetch,
			request: new Request('http://127.0.0.1:3000/api/ai', {
				method: 'POST',
				headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'generate',
					provider: 'chatgpt',
					model: 'gpt-5',
					connectionId: account.id,
					preferences: defaultPreferences
				})
			})
		} as never)
	]);
	assert.equal(modelsRes.status, 200);
	assert.equal(aiRes.status, 200);
	assert.equal(refreshCount - beforeRefreshes, 1, 'concurrent 401s rotate the refresh token once');
	assert.equal(oauth.listChatGPTAccounts(user.user.id)[0]?.connected, true);

	// Transient 5xx refresh failure returns 502 without clearing encrypted credentials.
	refreshErrorCode = 'server_error';
	refreshHttpStatus = 503;
	try {
		const transient = await modelsRoute.GET({
			locals: { user: user.user },
			fetch: async (input: RequestInfo | URL) =>
				String(input) === 'https://models.dev/api.json'
					? Response.json({})
					: Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }),
			url: new URL(
				`http://127.0.0.1:3000/api/models?connection=chatgpt&accountId=${encodeURIComponent(account.id)}`
			)
		} as never);
		assert.equal(transient.status, 502);
		assert.equal((await transient.json()).code, 'chatgpt_refresh_failed');
		assert.ok(storage.getChatGPTAccount(user.user.id, account.id)?.credentialEnvelope);
		assert.equal(oauth.listChatGPTAccounts(user.user.id)[0]?.connected, true);
	} finally {
		refreshErrorCode = null;
		refreshHttpStatus = 400;
	}

	// Retry also returning 401 clears credentials and remaps signed-in response to 422 chatgpt_reauth_required.
	const retryRejected = await aiRoute.POST({
		locals: { user: user.user },
		fetch: async () => Response.json({ error: { message: 'Still invalid' } }, { status: 401 }),
		request: new Request('http://127.0.0.1:3000/api/ai', {
			method: 'POST',
			headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
			body: JSON.stringify({
				action: 'generate',
				provider: 'chatgpt',
				model: 'gpt-5',
				connectionId: account.id,
				preferences: defaultPreferences
			})
		})
	} as never);
	assert.equal(retryRejected.status, 422);
	assert.equal((await retryRejected.json()).code, 'chatgpt_reauth_required');
	assert.equal(storage.getChatGPTAccount(user.user.id, account.id)?.credentialEnvelope, null);
	assert.equal(oauth.listChatGPTAccounts(user.user.id)[0]?.connected, false);

	// Subsequent signed-in model catalog calls while disconnected also return 422 chatgpt_reauth_required.
	const disconnectedModels = await modelsRoute.GET({
		locals: { user: user.user },
		fetch: async () => Response.json({}),
		url: new URL(
			`http://127.0.0.1:3000/api/models?connection=chatgpt&accountId=${encodeURIComponent(account.id)}`
		)
	} as never);
	assert.equal(disconnectedModels.status, 422);
	assert.equal((await disconnectedModels.json()).code, 'chatgpt_reauth_required');
});

test('OAuth tables index foreign-key and expiry columns and avoid table scans on cleanups and cascades', async () => {
	await import('../src/lib/server/oauth-storage.ts');
	const database = backend.getDatabase();

	for (const [table, expectedIndexedColumns] of [
		['chatgpt_oauth_accounts', ['user_id']],
		['chatgpt_oauth_pending', ['user_id', 'expires_at']],
		['chatgpt_oauth_pairings', ['user_id', 'expires_at']],
		['codex_device_attempts', ['user_id', 'expires_at']]
	] as const) {
		const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{
			name: string;
			partial: number;
		}>;
		for (const columnName of expectedIndexedColumns) {
			const hasUnconditionalLeadingIndex = indexes.some((index) => {
				if (index.partial !== 0) return false;
				const columns = database.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{
					seqno: number;
					name: string | null;
				}>;
				return columns.some((column) => column.seqno === 0 && column.name === columnName);
			});
			assert.equal(
				hasUnconditionalLeadingIndex,
				true,
				`Expected unconditional leading index on ${table}.${columnName}`
			);
		}
	}

	const queries = [
		'DELETE FROM users WHERE id = ?',
		'DELETE FROM chatgpt_oauth_pending WHERE expires_at <= ?',
		'DELETE FROM chatgpt_oauth_pairings WHERE expires_at <= ?',
		'DELETE FROM codex_device_attempts WHERE user_id = ? OR expires_at <= ?'
	];

	for (const sql of queries) {
		const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
			parent: number;
			detail: string;
		}>;
		assert.ok(plan.length > 0, `Expected query plan for: ${sql}`);
		assert.equal(
			plan.some((step) => step.detail.startsWith('SEARCH ')),
			true,
			`Expected SEARCH step in plan for ${sql}: ${JSON.stringify(plan)}`
		);
		for (const step of plan) {
			assert.doesNotMatch(step.detail, /\bSCAN\b/, `Unexpected SCAN in plan for: ${sql}`);
			if (step.parent === 0) {
				assert.match(
					step.detail,
					/^(SEARCH |MULTI-INDEX OR$)/,
					`Expected SEARCH or MULTI-INDEX OR root step for: ${sql}`
				);
			}
		}
	}

	const deviceCleanupPlan = database
		.prepare(
			'EXPLAIN QUERY PLAN DELETE FROM codex_device_attempts WHERE user_id = ? OR expires_at <= ?'
		)
		.all() as Array<{ detail: string }>;
	assert.equal(
		deviceCleanupPlan.some((step) => step.detail === 'MULTI-INDEX OR'),
		true,
		'Expected MULTI-INDEX OR plan for codex_device_attempts cleanup'
	);
});
