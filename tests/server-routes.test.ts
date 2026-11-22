import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.ORIGIN = 'https://kitchen.example.test';
process.env.FLAVORITHM_AUTH_MODE = 'local';

const backend = await import('../src/lib/server/db.ts');
const sso = await import('../src/lib/server/sso.ts');
const ai = await import('../src/lib/server/ai.ts');
const oauthStorage = await import('../src/lib/server/oauth-storage.ts');
const { handle } = await import('../src/hooks.server.ts');

const modelsRoute = await import('../src/routes/api/models/+server.ts');
const authApiRoute = await import('../src/routes/api/auth/+server.ts');
const chatgptRoute = await import('../src/routes/api/connections/chatgpt/+server.ts');
const chatgptCallbackRoute =
	await import('../src/routes/api/connections/chatgpt/callback/+server.ts');
const authLoginRoute = await import('../src/routes/auth/login/+server.ts');
const authCallbackRoute = await import('../src/routes/auth/callback/+server.ts');
const authLogoutRoute = await import('../src/routes/auth/logout/+server.ts');
const authMetaRoute = await import('../src/routes/auth/meta/+server.ts');

const appOrigin = 'https://kitchen.example.test';
const proxySecret = 'route-test-proxy-shared-secret-long-enough-for-checks';
const oidcIssuer = 'https://idp.example.test/application/o/flavorithm/';
const oidcClientId = 'flavorithm-route-test-client';

type CookieJar = {
	values: Map<string, string>;
	setCalls: Array<{ name: string; value: string; options: Record<string, unknown> }>;
	deleteCalls: string[];
	cookies: {
		get(name: string): string | undefined;
		set(name: string, value: string, options: Record<string, unknown>): void;
		delete(name: string, options?: Record<string, unknown>): void;
	};
};

function cookieJar(initial: Record<string, string> = {}): CookieJar {
	const values = new Map(Object.entries(initial));
	const setCalls: CookieJar['setCalls'] = [];
	const deleteCalls: string[] = [];
	return {
		values,
		setCalls,
		deleteCalls,
		cookies: {
			get: (name) => values.get(name),
			set: (name, value, options) => {
				values.set(name, value);
				setCalls.push({ name, value, options });
			},
			delete: (name) => {
				values.delete(name);
				deleteCalls.push(name);
			}
		}
	};
}

function configureMode(mode: 'local' | 'oidc' | 'proxy', proxyLogoutUrl = '') {
	process.env.ORIGIN = appOrigin;
	process.env.FLAVORITHM_AUTH_MODE = mode;
	if (mode === 'oidc') {
		process.env.FLAVORITHM_OIDC_ISSUER = oidcIssuer;
		process.env.FLAVORITHM_OIDC_CLIENT_ID = oidcClientId;
		process.env.FLAVORITHM_OIDC_CLIENT_SECRET = '';
		process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'none';
		process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '3600';
		process.env.FLAVORITHM_OIDC_REDIRECT_URI = `${appOrigin}/auth/callback`;
	} else if (mode === 'proxy') {
		process.env.FLAVORITHM_PROXY_SHARED_SECRET = proxySecret;
		process.env.FLAVORITHM_PROXY_SECRET_HEADER = 'x-flavorithm-proxy-secret';
		process.env.FLAVORITHM_PROXY_SUBJECT_HEADER = 'x-authentik-uid';
		process.env.FLAVORITHM_PROXY_EMAIL_HEADER = 'x-authentik-email';
		process.env.FLAVORITHM_PROXY_NAME_HEADER = 'x-authentik-name';
		process.env.FLAVORITHM_PROXY_ISSUER = 'https://authentik.example.test/';
		process.env.FLAVORITHM_PROXY_LOGOUT_URL = proxyLogoutUrl;
	}
}

function proxyHeaders(subject: string, email = `${subject}@example.test`): Record<string, string> {
	return {
		'x-flavorithm-proxy-secret': proxySecret,
		'x-authentik-uid': subject,
		'x-authentik-email': email,
		'x-authentik-name': `User ${subject}`
	};
}

async function invokeHookedRoute(input: {
	path: string;
	handler: (event: never) => Response | Promise<Response>;
	method?: string;
	headers?: HeadersInit;
	body?: unknown;
	jar?: CookieJar;
	clientIp?: string | null;
	fetcher?: typeof fetch;
}) {
	const url = new URL(input.path, appOrigin);
	const headers = new Headers(input.headers);
	if (input.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	if (input.body !== undefined && !headers.has('origin')) {
		headers.set('origin', appOrigin);
	}
	const jar = input.jar ?? cookieJar();
	const request = new Request(url, {
		method: input.method ?? (input.body !== undefined ? 'POST' : 'GET'),
		headers,
		body: input.body !== undefined ? JSON.stringify(input.body) : undefined
	});
	const clientIp = input.clientIp === undefined ? '203.0.113.42' : input.clientIp;
	const event = {
		request,
		url,
		cookies: jar.cookies,
		fetch: input.fetcher ?? fetch,
		getClientAddress: () => {
			if (clientIp === null) throw new Error('ClientAddress cannot be determined');
			return clientIp;
		},
		locals: { user: null as unknown, authMode: 'invalid' as const }
	};
	const response = await handle({
		event,
		resolve: async (resolvedEvent: typeof event) => input.handler(resolvedEvent as never)
	} as never);
	return { response, event, jar };
}

test('/api/models preserves private max-age caching, enforces no-store on errors and ChatGPT queries, and shares cache with runAIRequest', async (t) => {
	configureMode('local');
	const { user, token } = await backend.registerUser(
		'Models Tester',
		'models-route@example.test',
		'secure password for models route'
	);

	const unauthenticated = await invokeHookedRoute({
		path: '/api/models',
		handler: modelsRoute.GET
	});
	assert.equal(unauthenticated.response.status, 401);
	assert.equal(unauthenticated.response.headers.get('cache-control'), 'no-store, max-age=0');
	assert.equal(unauthenticated.response.headers.get('pragma'), 'no-cache');
	assert.equal(unauthenticated.response.headers.get('expires'), '0');

	let catalogFetchCount = 0;
	let failCatalog = true;
	const rawCatalog = {
		openai: {
			name: 'OpenAI',
			env: ['OPENAI_API_KEY'],
			models: {
				'gpt-test': {
					name: 'GPT Test',
					reasoning: true,
					reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
					modalities: { input: ['text', 'image'], output: ['text'] }
				}
			}
		}
	};
	const mockFetcher: typeof fetch = async (input, init) => {
		const target = String(input);
		if (target === 'https://models.dev/api.json') {
			catalogFetchCount += 1;
			if (failCatalog) {
				return Response.json({ error: 'upstream outage' }, { status: 503 });
			}
			return Response.json(rawCatalog);
		}
		if (target === 'https://api.openai.com/v1/chat/completions') {
			const payload = JSON.parse(String(init?.body));
			assert.equal(payload.reasoning_effort, 'high');
			return Response.json({
				choices: [
					{
						message: {
							content: JSON.stringify({
								ingredients: [{ name: 'Milk', quantity: 1, unit: 'cup', category: 'Dairy & eggs' }]
							})
						}
					}
				]
			});
		}
		if (new URL(target).origin === 'https://chatgpt.com') {
			return Response.json({
				models: [
					{
						slug: 'gpt-test',
						display_name: 'GPT Test Plan',
						visibility: 'list',
						input_modalities: ['text']
					}
				]
			});
		}
		throw new Error(`Unexpected fetch URL: ${target}`);
	};

	const failedCatalog = await invokeHookedRoute({
		path: '/api/models',
		handler: modelsRoute.GET,
		jar: cookieJar({ flavorithm_session: token }),
		fetcher: mockFetcher
	});
	assert.equal(failedCatalog.response.status, 502);
	assert.equal(failedCatalog.response.headers.get('cache-control'), 'no-store, max-age=0');
	assert.equal(failedCatalog.response.headers.get('pragma'), 'no-cache');
	assert.equal(failedCatalog.response.headers.get('expires'), '0');
	assert.equal(catalogFetchCount, 1);

	failCatalog = false;
	const cachedLocal = await invokeHookedRoute({
		path: '/api/models',
		handler: modelsRoute.GET,
		jar: cookieJar({ flavorithm_session: token }),
		fetcher: mockFetcher
	});
	assert.equal(cachedLocal.response.status, 200);
	assert.equal(cachedLocal.response.headers.get('cache-control'), 'private, max-age=3600');
	assert.equal(cachedLocal.response.headers.get('pragma'), null);
	assert.equal(cachedLocal.response.headers.get('expires'), null);
	assert.equal(catalogFetchCount, 2);
	const parsedCatalog = (await cachedLocal.response.json()) as {
		providers: Array<{ id: string; models: Array<{ id: string }> }>;
	};
	assert.equal(parsedCatalog.providers[0]?.id, 'openai');

	// Subsequent /api/models requests in proxy and oidc modes also preserve private max-age without refetching.
	configureMode('proxy');
	const cachedProxy = await invokeHookedRoute({
		path: '/api/models',
		handler: modelsRoute.GET,
		headers: proxyHeaders('models-proxy-user'),
		fetcher: mockFetcher
	});
	assert.equal(cachedProxy.response.status, 200);
	assert.equal(cachedProxy.response.headers.get('cache-control'), 'private, max-age=3600');
	assert.equal(cachedProxy.response.headers.get('pragma'), null);
	assert.equal(cachedProxy.response.headers.get('expires'), null);
	assert.equal(catalogFetchCount, 2);

	configureMode('oidc');
	const oidcUser = backend.resolveExternalIdentity({
		issuer: oidcIssuer,
		subject: 'models-oidc-subject',
		email: 'models-oidc@example.test',
		name: 'Models OIDC User',
		emailVerified: true
	});
	const oidcSession = backend.createOidcSession(
		oidcUser,
		oidcIssuer,
		'models-oidc-subject',
		oidcClientId,
		60_000
	);
	const cachedOidc = await invokeHookedRoute({
		path: '/api/models',
		handler: modelsRoute.GET,
		jar: cookieJar({ flavorithm_session: oidcSession.token }),
		fetcher: mockFetcher
	});
	assert.equal(cachedOidc.response.status, 200);
	assert.equal(cachedOidc.response.headers.get('cache-control'), 'private, max-age=3600');
	assert.equal(cachedOidc.response.headers.get('pragma'), null);
	assert.equal(cachedOidc.response.headers.get('expires'), null);
	assert.equal(catalogFetchCount, 2);

	configureMode('local');
	// runAIRequest with reasoning reuses the same cached public catalog without fetching models.dev again.
	await ai.runAIRequest(
		{
			action: 'vision',
			provider: 'openai',
			model: 'gpt-test',
			apiKey: 'sk-test-key',
			image: 'data:image/png;base64,aGVsbG8=',
			reasoning: { effort: 'high' }
		},
		mockFetcher
	);
	assert.equal(catalogFetchCount, 2);

	// Missing accountId on ?connection=chatgpt returns 400 with no-store headers.
	const missingAccount = await invokeHookedRoute({
		path: '/api/models?connection=chatgpt',
		handler: modelsRoute.GET,
		jar: cookieJar({ flavorithm_session: token }),
		fetcher: mockFetcher
	});
	assert.equal(missingAccount.response.status, 400);
	assert.equal(missingAccount.response.headers.get('cache-control'), 'no-store, max-age=0');
	assert.equal(missingAccount.response.headers.get('pragma'), 'no-cache');
	assert.equal(missingAccount.response.headers.get('expires'), '0');

	// Connected ChatGPT catalog query keeps no-store and enriches reasoning from the cached public catalog.
	process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString('base64');
	const savedAccount = oauthStorage.saveChatGPTAccount({
		userId: user.id,
		mode: 'hosted',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		subject: 'codex-subject-1',
		email: user.email,
		scopes: ['openid', 'profile', 'email', 'offline_access', 'codex.subscription'],
		credentials: {
			accessToken: 'codex-access-token',
			refreshToken: 'codex-refresh-token',
			idToken: 'codex-id-token',
			codexAccountId: 'acct-models-1'
		},
		expiresAt: Date.now() + 3_600_000,
		earliestRefreshAt: 0
	});
	t.mock.method(globalThis, 'fetch', mockFetcher);
	const chatgptCatalog = await invokeHookedRoute({
		path: `/api/models?connection=chatgpt&accountId=${savedAccount.id}`,
		handler: modelsRoute.GET,
		jar: cookieJar({ flavorithm_session: token }),
		fetcher: mockFetcher
	});
	assert.equal(chatgptCatalog.response.status, 200);
	assert.equal(chatgptCatalog.response.headers.get('cache-control'), 'no-store');
	assert.equal(chatgptCatalog.response.headers.get('pragma'), 'no-cache');
	assert.equal(chatgptCatalog.response.headers.get('expires'), '0');
	const chatgptData = (await chatgptCatalog.response.json()) as {
		providers: Array<{ models: Array<{ id: string; reasoning?: { efforts: string[] } }> }>;
	};
	assert.deepEqual(chatgptData.providers[0]?.models[0]?.reasoning?.efforts, ['low', 'high']);
	assert.equal(catalogFetchCount, 2);

	// After the 60-minute TTL expires, getPublicModelCatalog refetches models.dev.
	const realNow = Date.now;
	const futureNow = realNow() + 60 * 60 * 1000 + 1_000;
	Date.now = () => futureNow;
	try {
		const refreshed = await invokeHookedRoute({
			path: '/api/models',
			handler: modelsRoute.GET,
			jar: cookieJar({ flavorithm_session: token }),
			fetcher: mockFetcher
		});
		assert.equal(refreshed.response.status, 200);
		assert.equal(refreshed.response.headers.get('cache-control'), 'private, max-age=3600');
		assert.equal(catalogFetchCount, 3);
	} finally {
		Date.now = realNow;
	}
});

test('/api/connections/chatgpt/callback renders HTML 401 across auth modes and guards missing clientAddress', async () => {
	assert.equal(backend.clientAddress({ getClientAddress: () => ' 198.51.100.7 ' }), '198.51.100.7');
	assert.equal(backend.clientAddress({ getClientAddress: () => '   ' }), null);
	assert.equal(
		backend.clientAddress({
			getClientAddress: () => {
				throw new Error('missing ADDRESS_HEADER');
			}
		}),
		null
	);
	assert.equal(backend.clientAddress({}), null);

	for (const mode of ['local', 'oidc', 'proxy'] as const) {
		configureMode(mode);
		const expiredCallback = await invokeHookedRoute({
			path: '/api/connections/chatgpt/callback?code=test-code&state=test-state',
			handler: chatgptCallbackRoute.GET,
			headers: { Accept: 'text/html,application/xhtml+xml' }
		});
		assert.equal(
			expiredCallback.response.status,
			401,
			`expected HTML 401 in ${mode} mode instead of redirect or JSON`
		);
		assert.match(expiredCallback.response.headers.get('content-type') ?? '', /text\/html/);
		assert.match(expiredCallback.response.headers.get('cache-control') ?? '', /no-store/);
		assert.match(
			await expiredCallback.response.text(),
			/Your Flavorithm session could not be verified\./
		);

		const nonGetBlocked = await invokeHookedRoute({
			path: '/api/connections/chatgpt/callback',
			method: 'POST',
			handler: chatgptCallbackRoute.GET
		});
		assert.equal(nonGetBlocked.response.status, 401);
		assert.match(nonGetBlocked.response.headers.get('content-type') ?? '', /application\/json/);
	}

	configureMode('local');
	const missingIpCallback = await invokeHookedRoute({
		path: '/api/connections/chatgpt/callback?code=test-code&state=test-state',
		handler: chatgptCallbackRoute.GET,
		clientIp: null
	});
	assert.equal(missingIpCallback.response.status, 403);
	assert.match(missingIpCallback.response.headers.get('cache-control') ?? '', /no-store/);
	assert.match(await missingIpCallback.response.text(), /ChatGPT callback could not be accepted\./);

	const { token } = await backend.registerUser(
		'ChatGPT IP Guard User',
		'chatgpt-ip@example.test',
		'secure password for chatgpt ip'
	);
	const statusWithoutIp = await invokeHookedRoute({
		path: '/api/connections/chatgpt',
		handler: chatgptRoute.GET,
		jar: cookieJar({ flavorithm_session: token }),
		clientIp: null
	});
	assert.equal(statusWithoutIp.response.status, 200);
	assert.match(statusWithoutIp.response.headers.get('cache-control') ?? '', /no-store/);

	const postWithoutIp = await invokeHookedRoute({
		path: '/api/connections/chatgpt',
		handler: chatgptRoute.POST,
		jar: cookieJar({ flavorithm_session: token }),
		headers: { 'sec-fetch-site': 'same-origin' },
		body: { action: 'start' },
		clientIp: null
	});
	assert.equal(postWithoutIp.response.status, 403);
	assert.equal(
		((await postWithoutIp.response.json()) as { error: string }).error,
		'The request source could not be verified'
	);
});

test('/api/auth completes logout without clientAddress and returns 403 for other actions when clientAddress is missing', async () => {
	configureMode('local');
	const password = 'secure password for auth ip guard';
	const registered = await backend.registerUser(
		'Auth IP User',
		'auth-ip-guard@example.test',
		password
	);
	assert.ok(backend.getUserFromSession(registered.token));

	const blockedActions: Array<Record<string, unknown>> = [
		{
			action: 'register',
			name: 'Blocked User',
			email: 'blocked@example.test',
			password
		},
		{
			action: 'login',
			email: registered.user.email,
			password
		},
		{
			action: 'requestPasswordReset',
			email: registered.user.email
		},
		{
			action: 'resetPassword',
			token: 't'.repeat(32),
			password
		},
		{
			action: 'requestEmailVerification'
		},
		{
			action: 'verifyEmail',
			token: 'v'.repeat(32)
		},
		{
			action: 'deleteAccount',
			password
		}
	];

	for (const payload of blockedActions) {
		const jar = cookieJar({ flavorithm_session: registered.token });
		const result = await invokeHookedRoute({
			path: '/api/auth',
			handler: authApiRoute.POST,
			jar,
			body: payload,
			clientIp: null
		});
		assert.equal(
			result.response.status,
			403,
			`expected 403 for action ${String(payload.action)} without clientAddress`
		);
		assert.equal(
			((await result.response.json()) as { error: string }).error,
			'The request source could not be verified'
		);
		assert.match(result.response.headers.get('cache-control') ?? '', /no-store/);
	}

	assert.ok(
		backend.getUserFromSession(registered.token),
		'session remains active before explicit logout'
	);

	const logoutJar = cookieJar({ flavorithm_session: registered.token });
	const loggedOut = await invokeHookedRoute({
		path: '/api/auth',
		handler: authApiRoute.POST,
		jar: logoutJar,
		body: { action: 'logout' },
		clientIp: null
	});
	assert.equal(loggedOut.response.status, 200);
	assert.deepEqual(await loggedOut.response.json(), { user: null });
	assert.equal(backend.getUserFromSession(registered.token), null);
	assert.ok(logoutJar.deleteCalls.includes('flavorithm_session'));
	assert.match(loggedOut.response.headers.get('cache-control') ?? '', /no-store/);
});

test('/auth/meta, /auth/login, /auth/callback, and /auth/logout work across local, oidc, and proxy modes', async () => {
	// 1. Local mode
	configureMode('local');
	const localMeta = await invokeHookedRoute({
		path: '/auth/meta',
		handler: authMetaRoute.GET
	});
	assert.equal(localMeta.response.status, 200);
	assert.equal(localMeta.response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await localMeta.response.json(), {
		authMode: 'local',
		loginUrl: null,
		logoutUrl: null
	});

	const localLogin = await invokeHookedRoute({
		path: '/auth/login',
		handler: authLoginRoute.GET
	});
	assert.equal(localLogin.response.status, 404);
	assert.equal(localLogin.response.headers.get('cache-control'), 'no-store');

	const localCallback = await invokeHookedRoute({
		path: '/auth/callback?code=abc&state=xyz',
		handler: authCallbackRoute.GET
	});
	assert.equal(localCallback.response.status, 404);
	assert.equal(localCallback.response.headers.get('cache-control'), 'no-store');

	const localAccount = await backend.registerUser(
		'Local Logout User',
		'local-logout@example.test',
		'secure local logout password'
	);
	const localLogoutJar = cookieJar({ flavorithm_session: localAccount.token });
	const localLogout = await invokeHookedRoute({
		path: '/auth/logout',
		handler: authLogoutRoute.GET,
		jar: localLogoutJar
	});
	assert.equal(localLogout.response.status, 303);
	assert.equal(localLogout.response.headers.get('location'), `${appOrigin}/`);
	assert.equal(localLogout.response.headers.get('cache-control'), 'no-store');
	assert.equal(backend.getUserFromSession(localAccount.token), null);
	assert.ok(localLogoutJar.deleteCalls.includes('flavorithm_session'));

	// 2. OIDC mode
	configureMode('oidc');
	const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
	const jwk = await exportJWK(publicKey);
	Object.assign(jwk, { kid: 'route-oidc-key', alg: 'RS256', use: 'sig' });
	let lastAuthorizeUrl: URL | null = null;
	sso.setSsoFetchForTests(async (input, init) => {
		const url = new URL(input.toString());
		if (url.pathname.endsWith('/.well-known/openid-configuration')) {
			return Response.json({
				issuer: oidcIssuer,
				authorization_endpoint: 'https://idp.example.test/authorize',
				token_endpoint: 'https://idp.example.test/token',
				userinfo_endpoint: 'https://idp.example.test/userinfo',
				jwks_uri: 'https://idp.example.test/jwks',
				end_session_endpoint: 'https://idp.example.test/logout',
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
				token_endpoint_auth_methods_supported: ['none']
			});
		}
		if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
		if (url.pathname === '/token') {
			const form = new URLSearchParams(String(init?.body ?? ''));
			const verifier = form.get('code_verifier') ?? '';
			assert.equal(
				createHash('sha256').update(verifier).digest('base64url'),
				lastAuthorizeUrl?.searchParams.get('code_challenge')
			);
			const idToken = await new SignJWT({
				nonce: lastAuthorizeUrl?.searchParams.get('nonce'),
				email: 'oidc-route@example.test',
				name: 'OIDC Route User',
				email_verified: true
			})
				.setProtectedHeader({ alg: 'RS256', kid: 'route-oidc-key' })
				.setIssuer(oidcIssuer)
				.setSubject('oidc-route-subject')
				.setAudience(oidcClientId)
				.setIssuedAt()
				.setExpirationTime('10m')
				.sign(privateKey);
			return Response.json({
				access_token: 'oidc-route-access',
				token_type: 'Bearer',
				expires_in: 600,
				id_token: idToken
			});
		}
		throw new Error(`Unexpected OIDC request: ${url.href}`);
	});

	try {
		const oidcMeta = await invokeHookedRoute({
			path: '/auth/meta',
			handler: authMetaRoute.GET
		});
		assert.equal(oidcMeta.response.status, 200);
		assert.equal(oidcMeta.response.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await oidcMeta.response.json(), {
			authMode: 'oidc',
			loginUrl: '/auth/login',
			logoutUrl: '/auth/logout'
		});

		const oidcLoginNoIp = await invokeHookedRoute({
			path: '/auth/login?returnTo=%2Fpantry',
			handler: authLoginRoute.GET,
			clientIp: null
		});
		assert.equal(oidcLoginNoIp.response.status, 403);
		assert.equal(oidcLoginNoIp.response.headers.get('cache-control'), 'no-store');
		assert.match(await oidcLoginNoIp.response.text(), /The request source could not be verified\./);

		const oidcJar = cookieJar();
		const oidcLogin = await invokeHookedRoute({
			path: '/auth/login?returnTo=%2Fpantry',
			handler: authLoginRoute.GET,
			jar: oidcJar
		});
		assert.equal(oidcLogin.response.status, 302);
		assert.equal(oidcLogin.response.headers.get('cache-control'), 'no-store');
		lastAuthorizeUrl = new URL(oidcLogin.response.headers.get('location')!);
		assert.equal(lastAuthorizeUrl.origin, 'https://idp.example.test');
		const state = lastAuthorizeUrl.searchParams.get('state')!;
		assert.ok(state);

		const badStateCallback = await invokeHookedRoute({
			path: '/auth/callback?code=oidc-code&state=wrong-state',
			handler: authCallbackRoute.GET,
			jar: oidcJar
		});
		assert.equal(badStateCallback.response.status, 400);
		assert.equal(badStateCallback.response.headers.get('cache-control'), 'no-store');

		const completeCallback = await invokeHookedRoute({
			path: `/auth/callback?code=oidc-code&state=${encodeURIComponent(state)}`,
			handler: authCallbackRoute.GET,
			jar: oidcJar
		});
		assert.equal(completeCallback.response.status, 303);
		assert.equal(completeCallback.response.headers.get('location'), `${appOrigin}/pantry`);
		assert.equal(completeCallback.response.headers.get('cache-control'), 'no-store');
		const oidcSessionToken = oidcJar.values.get('flavorithm_session');
		assert.ok(oidcSessionToken);
		assert.ok(backend.getUserFromOidcSession(oidcSessionToken, oidcIssuer, oidcClientId));

		// Provider error callback returns 401
		const errorJar = cookieJar();
		const secondLogin = await invokeHookedRoute({
			path: '/auth/login',
			handler: authLoginRoute.GET,
			jar: errorJar
		});
		const secondState = new URL(secondLogin.response.headers.get('location')!).searchParams.get(
			'state'
		)!;
		const errorCallback = await invokeHookedRoute({
			path: `/auth/callback?error=access_denied&state=${encodeURIComponent(secondState)}`,
			handler: authCallbackRoute.GET,
			jar: errorJar
		});
		assert.equal(errorCallback.response.status, 401);
		assert.equal(errorCallback.response.headers.get('cache-control'), 'no-store');

		const oidcLogout = await invokeHookedRoute({
			path: '/auth/logout',
			handler: authLogoutRoute.GET,
			jar: oidcJar
		});
		assert.equal(oidcLogout.response.status, 303);
		assert.equal(oidcLogout.response.headers.get('cache-control'), 'no-store');
		const logoutLocation = new URL(oidcLogout.response.headers.get('location')!);
		assert.equal(logoutLocation.origin, 'https://idp.example.test');
		assert.equal(logoutLocation.pathname, '/logout');
		assert.equal(logoutLocation.searchParams.get('post_logout_redirect_uri'), `${appOrigin}/`);
		assert.equal(backend.getUserFromOidcSession(oidcSessionToken, oidcIssuer, oidcClientId), null);
	} finally {
		sso.setSsoFetchForTests(undefined);
	}

	// 3. Proxy mode
	configureMode('proxy', '');
	const proxyMetaWithoutLogout = await invokeHookedRoute({
		path: '/auth/meta',
		handler: authMetaRoute.GET
	});
	assert.equal(proxyMetaWithoutLogout.response.status, 200);
	assert.equal(proxyMetaWithoutLogout.response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await proxyMetaWithoutLogout.response.json(), {
		authMode: 'proxy',
		loginUrl: null,
		logoutUrl: null
	});

	const gatewayLogoutUrl = 'https://authentik.example.test/outpost.goauthentik.io/sign_out';
	configureMode('proxy', gatewayLogoutUrl);
	const proxyMetaWithLogout = await invokeHookedRoute({
		path: '/auth/meta',
		handler: authMetaRoute.GET
	});
	assert.equal(proxyMetaWithLogout.response.status, 200);
	assert.deepEqual(await proxyMetaWithLogout.response.json(), {
		authMode: 'proxy',
		loginUrl: null,
		logoutUrl: '/auth/logout'
	});

	const proxyLogin = await invokeHookedRoute({
		path: '/auth/login',
		handler: authLoginRoute.GET,
		headers: proxyHeaders('proxy-route-user')
	});
	assert.equal(proxyLogin.response.status, 404);
	assert.equal(proxyLogin.response.headers.get('cache-control'), 'no-store');

	const proxyCallback = await invokeHookedRoute({
		path: '/auth/callback',
		handler: authCallbackRoute.GET,
		headers: proxyHeaders('proxy-route-user')
	});
	assert.equal(proxyCallback.response.status, 404);
	assert.equal(proxyCallback.response.headers.get('cache-control'), 'no-store');

	// Establish a proxy binding cookie via an authenticated request, then verify /auth/logout revokes it.
	const proxySessionJar = cookieJar();
	const proxySignedIn = await invokeHookedRoute({
		path: '/api/auth',
		handler: authApiRoute.GET,
		headers: proxyHeaders('proxy-route-user'),
		jar: proxySessionJar
	});
	assert.equal(proxySignedIn.response.status, 200);
	const bindingToken = proxySessionJar.values.get('flavorithm_session');
	assert.ok(bindingToken);
	assert.ok(backend.getSessionBinding(bindingToken));

	const proxyLogout = await invokeHookedRoute({
		path: '/auth/logout',
		handler: authLogoutRoute.GET,
		headers: proxyHeaders('proxy-route-user'),
		jar: proxySessionJar
	});
	assert.equal(proxyLogout.response.status, 303);
	assert.equal(proxyLogout.response.headers.get('location'), gatewayLogoutUrl);
	assert.equal(proxyLogout.response.headers.get('cache-control'), 'no-store');
	assert.equal(backend.getSessionBinding(bindingToken), null);
	assert.ok(proxySessionJar.deleteCalls.includes('flavorithm_session'));
});
