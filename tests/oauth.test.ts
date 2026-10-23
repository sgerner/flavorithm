import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

process.env.FLAVORITHM_DB_PATH = ':memory:';
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
			if (refreshErrorCode) return responseJson({ error: refreshErrorCode }, 400);
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

after(() => {
	globalThis.fetch = nativeFetch;
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
	const user = await createLocalUser('oauth-hosted@example.com');
	process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
	process.env.OPENAI_OAUTH_CLIENT_ID = 'flavorithm-hosted-client';
	process.env.OPENAI_OAUTH_CLIENT_SECRET = 'hosted:secret with + chars';
	process.env.OPENAI_OAUTH_CLIENT_AUTH_METHOD = 'client_secret_basic';
	process.env.OPENAI_OAUTH_REDIRECT_URI =
		'https://flavorithm.example/api/connections/chatgpt/callback';
	try {
		const appUrl = new URL('https://flavorithm.example/settings');
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
