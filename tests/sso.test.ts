import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generateKeyPair } from 'jose';
import { exportJWK, SignJWT } from 'jose';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.ORIGIN = 'https://kitchen.example.test';

const dbPath = '../src/lib/server/db.ts';
const ssoPath = '../src/lib/server/sso.ts';
const hooksPath = '../src/hooks.server.ts';
const authRoutePath = '../src/routes/api/auth/+server.ts';
const backend = await import(dbPath);
const sso = await import(ssoPath);
const { handle } = await import(hooksPath);
const authRoute = await import(authRoutePath);

const proxySecret = 'sso-test-shared-secret-long-enough-for-timing-safe-checks';
const oidcIssuer = 'https://idp.example.test/application/o/flavorithm/';
const oidcClientId = 'flavorithm-test-client';

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

async function runHook(input: {
	url: string;
	method?: string;
	headers?: HeadersInit;
	cookies?: CookieJar;
}): Promise<{
	response: Response;
	event: { locals: { user: unknown; authMode: string } };
	jar: CookieJar;
}> {
	const headers = new Headers(input.headers);
	const jar = input.cookies ?? cookieJar();
	if (!input.cookies) {
		for (const pair of (headers.get('cookie') ?? '').split(';')) {
			const separator = pair.indexOf('=');
			if (separator > 0) {
				jar.values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
			}
		}
	}
	const request = new Request(input.url, {
		method: input.method ?? 'GET',
		headers
	});
	const event = {
		request,
		url: new URL(request.url),
		cookies: jar.cookies,
		locals: { user: null as unknown, authMode: 'invalid' }
	};
	const response = await handle({
		event,
		resolve: async (resolvedEvent: typeof event) =>
			Response.json({
				user: resolvedEvent.locals.user,
				authMode: resolvedEvent.locals.authMode
			})
	} as never);
	return { response, event, jar };
}

function proxyHeaders(subject: string, email = `${subject}@example.test`): HeadersInit {
	return {
		'x-flavorithm-proxy-secret': proxySecret,
		'x-authentik-uid': subject,
		'x-authentik-email': email,
		'x-authentik-name': `User ${subject}`
	};
}

test('OIDC authorization code flow validates state, nonce, PKCE and signed ID token end to end', async () => {
	process.env.FLAVORITHM_AUTH_MODE = 'oidc';
	process.env.FLAVORITHM_OIDC_ISSUER = oidcIssuer;
	process.env.FLAVORITHM_OIDC_CLIENT_ID = oidcClientId;
	process.env.FLAVORITHM_OIDC_CLIENT_SECRET = '';
	process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'none';
	process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '3600';
	process.env.FLAVORITHM_OIDC_REDIRECT_URI = 'https://kitchen.example.test/auth/callback';

	const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
	const wrongSigningKey = await generateKeyPair('RS256', { modulusLength: 2048 });
	const jwk = await exportJWK(publicKey);
	jwk.kid = 'sso-test-key';
	jwk.alg = 'RS256';
	jwk.use = 'sig';
	let authorizationRequest: URL | null = null;
	let receivedVerifier = '';
	let tokenScenario: {
		nonce?: string;
		issuer?: string;
		audience?: string;
		expiration?: '10m' | 'expired';
		wrongSignature?: boolean;
		userinfoSubject?: string;
	} = {};
	const mockFetch: typeof fetch = async (input, init) => {
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
			const body = init?.body;
			const form = new URLSearchParams(
				typeof body === 'string'
					? body
					: body instanceof URLSearchParams
						? body.toString()
						: body
							? new TextDecoder().decode(body as ArrayBufferView<ArrayBuffer>)
							: ''
			);
			assert.equal(form.get('client_id'), oidcClientId);
			receivedVerifier = form.get('code_verifier') ?? '';
			const challenge = authorizationRequest?.searchParams.get('code_challenge');
			assert.ok(challenge);
			assert.equal(
				createHash('sha256').update(receivedVerifier).digest('base64url'),
				challenge,
				'the token request verifier must match the authorization challenge'
			);
			assert.equal(form.get('code'), 'mock-authorization-code');
			const nonce = authorizationRequest?.searchParams.get('nonce');
			assert.ok(nonce);
			const currentClaims = new SignJWT({ nonce: tokenScenario.nonce ?? nonce })
				.setProtectedHeader({ alg: 'RS256', kid: 'sso-test-key' })
				.setIssuer(tokenScenario.issuer ?? oidcIssuer)
				.setSubject('user-42')
				.setAudience(tokenScenario.audience ?? oidcClientId);
			if (tokenScenario.expiration === 'expired') {
				const now = Math.floor(Date.now() / 1000);
				currentClaims.setIssuedAt(now - 7200).setExpirationTime(now - 3600);
			} else {
				currentClaims.setIssuedAt().setExpirationTime('10m');
			}
			const idToken = await currentClaims.sign(
				tokenScenario.wrongSignature ? wrongSigningKey.privateKey : privateKey
			);
			return Response.json({
				access_token: 'mock-access-token',
				token_type: 'Bearer',
				expires_in: 600,
				id_token: idToken
			});
		}
		if (url.pathname === '/userinfo') {
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-access-token');
			return Response.json({
				sub: tokenScenario.userinfoSubject ?? 'user-42',
				email: 'oidc.person@example.test',
				name: 'OIDC Person',
				email_verified: true
			});
		}
		throw new Error(`Unexpected mocked OIDC request: ${url.origin}${url.pathname}`);
	};
	sso.setSsoFetchForTests(mockFetch);
	try {
		async function startLogin() {
			const cookies = cookieJar();
			const authorize = await sso.createOidcAuthorizationRedirect({
				requestUrl: new URL(
					'https://kitchen.example.test/auth/login?returnTo=%2Frecipes%3Fsort%3Dnew'
				),
				cookies: cookies.cookies as never,
				returnTo: '/recipes?sort=new'
			});
			authorizationRequest = authorize;
			const callbackUrl = new URL('https://kitchen.example.test/auth/callback');
			callbackUrl.searchParams.set('code', 'mock-authorization-code');
			callbackUrl.searchParams.set('state', authorize.searchParams.get('state')!);
			return { authorize, cookies, callbackUrl };
		}
		async function assertFailedWithoutCreatingIdentity(
			variant: typeof tokenScenario,
			options: { wrongState?: boolean; omitBrowserCookie?: boolean } = {}
		) {
			tokenScenario = variant;
			const before = (
				backend
					.getDatabase()
					.prepare('SELECT COUNT(*) AS count FROM external_identities')
					.get() as { count: number }
			).count;
			const oidcSessionsBefore = (
				backend
					.getDatabase()
					.prepare("SELECT COUNT(*) AS count FROM sessions WHERE auth_source = 'oidc'")
					.get() as { count: number }
			).count;
			const attempt = await startLogin();
			const callbackUrl = new URL(attempt.callbackUrl);
			if (options.wrongState) callbackUrl.searchParams.set('state', 'wrong-state-value');
			const cookies = options.omitBrowserCookie ? cookieJar() : attempt.cookies;
			await assert.rejects(() =>
				sso.completeOidcLogin({ callbackUrl, cookies: cookies.cookies as never })
			);
			const after = (
				backend
					.getDatabase()
					.prepare('SELECT COUNT(*) AS count FROM external_identities')
					.get() as { count: number }
			).count;
			const oidcSessionsAfter = (
				backend
					.getDatabase()
					.prepare("SELECT COUNT(*) AS count FROM sessions WHERE auth_source = 'oidc'")
					.get() as { count: number }
			).count;
			assert.equal(after, before, 'rejected OIDC responses must not create accounts or mappings');
			assert.equal(
				oidcSessionsAfter,
				oidcSessionsBefore,
				'rejected OIDC responses must not create sessions'
			);
		}

		await assertFailedWithoutCreatingIdentity({}, { wrongState: true });
		await assertFailedWithoutCreatingIdentity({}, { omitBrowserCookie: true });
		await assertFailedWithoutCreatingIdentity({ nonce: 'wrong-nonce' });
		await assertFailedWithoutCreatingIdentity({ issuer: 'https://attacker.example.test/' });
		await assertFailedWithoutCreatingIdentity({ audience: 'another-client' });
		await assertFailedWithoutCreatingIdentity({ wrongSignature: true });
		await assertFailedWithoutCreatingIdentity({ expiration: 'expired' });
		await assertFailedWithoutCreatingIdentity({ userinfoSubject: 'another-subject' });

		tokenScenario = {};
		const { cookies, authorize, callbackUrl } = await startLogin();
		assert.equal(authorize.origin, 'https://idp.example.test');
		assert.equal(
			authorize.searchParams.get('redirect_uri'),
			'https://kitchen.example.test/auth/callback'
		);
		assert.equal(authorize.searchParams.get('scope'), 'openid email profile');
		assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
		assert.ok(authorize.searchParams.get('code_challenge'));
		assert.equal(cookies.setCalls.length, 1);
		assert.equal(cookies.setCalls[0]?.options.httpOnly, true);
		assert.equal(cookies.setCalls[0]?.options.sameSite, 'lax');

		const result = await sso.completeOidcLogin({
			callbackUrl,
			cookies: cookies.cookies as never
		});
		assert.ok(receivedVerifier.length >= 43);
		assert.equal(result.user.email, 'oidc.person@example.test');
		assert.equal(result.user.name, 'OIDC Person');
		assert.equal(result.user.emailVerified, true);
		assert.equal(result.returnTo, '/recipes?sort=new');
		assert.equal(
			backend.getUserFromOidcSession(result.token, oidcIssuer, oidcClientId)?.id,
			result.user.id
		);
		assert.equal(backend.getUserFromSession(result.token), null);
		await assert.rejects(() =>
			sso.completeOidcLogin({ callbackUrl, cookies: cookies.cookies as never })
		);
		const logoutUrl = await sso.getOidcLogoutRedirectUrl();
		assert.equal(logoutUrl?.origin, 'https://idp.example.test');
		assert.equal(logoutUrl?.pathname, '/logout');
		assert.equal(
			logoutUrl?.searchParams.get('post_logout_redirect_uri'),
			'https://kitchen.example.test/'
		);
	} finally {
		sso.setSsoFetchForTests(undefined);
	}
});

test('opaque provider subjects are preserved exactly rather than normalized into another account', () => {
	const base = { issuer: 'https://opaque.example.test/', emailVerified: false };
	const first = backend.resolveExternalIdentity({
		...base,
		subject: 'opaque-user',
		email: 'opaque-first@example.test'
	});
	const distinct = backend.resolveExternalIdentity({
		...base,
		subject: ' opaque-user',
		email: 'opaque-second@example.test'
	});
	assert.notEqual(first.id, distinct.id);
	assert.notEqual(first.householdId, distinct.householdId);
});

test('external identities map by issuer and subject and never link by email', () => {
	const local = backend.registerUser(
		'Local Account',
		'collision@example.test',
		'a sufficiently strong local password'
	);
	return local.then(({ user }: { user: any }) => {
		const identitiesBefore = backend
			.getDatabase()
			.prepare('SELECT COUNT(*) AS count FROM external_identities')
			.get()?.count;
		assert.throws(
			() =>
				backend.resolveExternalIdentity({
					issuer: oidcIssuer,
					subject: 'new-subject',
					email: 'collision@example.test',
					name: 'Different account',
					emailVerified: true
				}),
			{ status: 409 }
		);
		assert.equal(
			backend.getDatabase().prepare('SELECT COUNT(*) AS count FROM external_identities').get()
				?.count,
			identitiesBefore
		);
		const collisionIdentity = backend.resolveExternalIdentity({
			issuer: 'https://idp.example.test/another-application/',
			subject: 'new-subject',
			email: 'unique@example.test',
			name: 'External Account',
			emailVerified: true
		});
		assert.notEqual(collisionIdentity.id, user.id);
		assert.equal(
			backend.resolveExternalIdentity({
				issuer: 'https://idp.example.test/another-application/',
				subject: 'new-subject',
				email: 'unique@example.test',
				name: 'Updated Name',
				emailVerified: true
			}).id,
			collisionIdentity.id
		);
		assert.equal(
			backend
				.getDatabase()
				.prepare('SELECT sso_only FROM users WHERE id = ?')
				.get(collisionIdentity.id)?.sso_only,
			1
		);
		return assert.rejects(() => backend.loginUser('unique@example.test', 'some password'), {
			status: 401
		});
	});
});

test('proxy identity requires its secret on every request and ignores local session cookies', async () => {
	process.env.FLAVORITHM_AUTH_MODE = 'proxy';
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = proxySecret;
	process.env.FLAVORITHM_PROXY_SECRET_HEADER = 'x-flavorithm-proxy-secret';
	process.env.FLAVORITHM_PROXY_SUBJECT_HEADER = 'x-authentik-uid';
	process.env.FLAVORITHM_PROXY_EMAIL_HEADER = 'x-authentik-email';
	process.env.FLAVORITHM_PROXY_NAME_HEADER = 'x-authentik-name';
	process.env.FLAVORITHM_PROXY_ISSUER = 'https://authentik.example.test/';
	process.env.FLAVORITHM_PROXY_LOGOUT_URL =
		'https://authentik.example.test/outpost.goauthentik.io/sign_out';

	const local = await backend.registerUser(
		'Local Cookie User',
		'local-cookie@example.test',
		'a sufficiently strong local password'
	);
	const bypass = await runHook({
		url: 'https://kitchen.example.test/api/state',
		headers: { Cookie: `flavorithm_session=${local.token}` }
	});
	assert.equal(bypass.response.status, 401);
	assert.equal(bypass.event.locals.user, null);
	assert.ok(
		backend.getUserFromSession(local.token),
		'proxy mode must not consume or revoke a local session'
	);

	const unauthenticated = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: { Cookie: `flavorithm_session=${local.token}` }
	});
	assert.equal(
		unauthenticated.response.status,
		200,
		'auth metadata remains public without identity'
	);
	assert.equal((await unauthenticated.response.json()).user, null);

	const signedIn = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: proxyHeaders('proxy-user')
	});
	assert.equal(signedIn.response.status, 200);
	assert.equal(signedIn.event.locals.authMode, 'proxy');
	assert.equal(signedIn.response.headers.get('x-flavorithm-auth-mode'), 'proxy');
	assert.equal(
		(signedIn.event.locals.user as { emailVerified: boolean }).emailVerified,
		false,
		'default Authentik headers do not prove email ownership'
	);
	const firstUserId = (signedIn.event.locals.user as { id: string }).id;
	const bindingCookie = signedIn.jar.setCalls.find((entry) => entry.name === 'flavorithm_session');
	assert.ok(bindingCookie);
	assert.equal(bindingCookie.options.httpOnly, true);
	assert.equal(backend.getUserFromSession(bindingCookie.value), null);
	assert.ok(backend.getSessionBinding(bindingCookie.value));

	const switched = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: { ...proxyHeaders('other-user'), Cookie: `flavorithm_session=${bindingCookie.value}` }
	});
	assert.equal(switched.response.status, 200);
	assert.notEqual((switched.event.locals.user as { id: string }).id, firstUserId);
	assert.equal(
		backend.getSessionBinding(bindingCookie.value),
		null,
		'identity switching revokes old OAuth bindings'
	);

	const headerlessReuse = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: { Cookie: `flavorithm_session=${switched.jar.setCalls.at(-1)?.value}` }
	});
	assert.equal(headerlessReuse.response.status, 200);
	assert.equal((await headerlessReuse.response.json()).user, null);
	assert.equal(
		backend.getSessionBinding(switched.jar.setCalls.at(-1)?.value),
		null,
		'missing proxy assertions revoke binding cookies'
	);

	const collision = await runHook({
		url: 'https://kitchen.example.test/api/state',
		headers: proxyHeaders('third-user', 'local-cookie@example.test')
	});
	assert.equal(collision.response.status, 401, 'email collisions fail closed without auto-linking');

	const html = await runHook({
		url: 'https://kitchen.example.test/',
		headers: { Accept: 'text/html' }
	});
	assert.equal(html.response.status, 403);
	assert.equal(html.response.headers.get('x-flavorithm-auth-mode'), 'proxy');
	assert.equal(sso.getAuthMetadata('proxy').logoutUrl, '/auth/logout');
});

test('OIDC ignores local cookies, redirects HTML to login, and returns JSON 401 for APIs', async () => {
	process.env.FLAVORITHM_AUTH_MODE = 'oidc';
	process.env.FLAVORITHM_OIDC_ISSUER = oidcIssuer;
	process.env.FLAVORITHM_OIDC_CLIENT_ID = oidcClientId;
	process.env.FLAVORITHM_OIDC_CLIENT_SECRET = '';
	process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'none';
	process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '3600';
	process.env.FLAVORITHM_OIDC_REDIRECT_URI = 'https://kitchen.example.test/auth/callback';

	const local = await backend.registerUser(
		'OIDC Local Cookie',
		'oidc-local-cookie@example.test',
		'a sufficiently strong local password'
	);
	const html = await runHook({
		url: 'https://kitchen.example.test/pantry?filter=staples',
		headers: { Accept: 'text/html', Cookie: `flavorithm_session=${local.token}` }
	});
	assert.equal(html.response.status, 303);
	assert.match(
		html.response.headers.get('location') ?? '',
		/^https:\/\/kitchen\.example\.test\/auth\/login\?/
	);
	assert.equal(html.response.headers.get('x-flavorithm-auth-mode'), 'oidc');
	assert.match(html.response.headers.get('cache-control') ?? '', /no-store/);
	assert.ok(backend.getUserFromSession(local.token), 'ignored local sessions remain locally valid');

	const api = await runHook({
		url: 'https://kitchen.example.test/api/state',
		headers: { Cookie: `flavorithm_session=${local.token}` }
	});
	assert.equal(api.response.status, 401);
	assert.match(api.response.headers.get('content-type') ?? '', /application\/json/);

	const oidcProbe = await runHook({ url: 'https://kitchen.example.test/api/auth' });
	assert.equal(oidcProbe.response.status, 200);
	assert.deepEqual(await oidcProbe.response.json(), {
		user: null,
		authMode: 'oidc'
	});

	process.env.FLAVORITHM_AUTH_MODE = '';
	assert.equal(sso.getAuthMode(), null, 'an explicitly empty auth mode is invalid');
	const invalid = await runHook({ url: 'https://kitchen.example.test/api/state' });
	assert.equal(invalid.response.status, 503);
	assert.equal(invalid.event.locals.authMode, 'invalid');
	const invalidProbe = await runHook({ url: 'https://kitchen.example.test/api/auth' });
	assert.equal(invalidProbe.response.status, 503);
	assert.equal(invalidProbe.event.locals.authMode, 'invalid');
});

test('SSO configuration fails closed for missing secrets, insecure origins, and invalid bounds', () => {
	process.env.FLAVORITHM_AUTH_MODE = 'proxy';
	delete process.env.FLAVORITHM_PROXY_SHARED_SECRET;
	assert.equal(sso.isAuthModeConfigured('proxy'), false);
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = 'short';
	assert.equal(sso.isAuthModeConfigured('proxy'), false);
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = proxySecret;
	process.env.FLAVORITHM_PROXY_SECRET_HEADER = 'not a valid header';
	assert.equal(sso.isAuthModeConfigured('proxy'), false);
	delete process.env.FLAVORITHM_PROXY_SECRET_HEADER;
	assert.equal(sso.isAuthModeConfigured('proxy'), true);

	process.env.FLAVORITHM_AUTH_MODE = 'oidc';
	process.env.FLAVORITHM_OIDC_ISSUER = oidcIssuer;
	process.env.FLAVORITHM_OIDC_CLIENT_ID = oidcClientId;
	process.env.FLAVORITHM_OIDC_CLIENT_SECRET = '';
	process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'basic';
	process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '3600';
	process.env.ORIGIN = 'http://kitchen.example.test';
	assert.equal(sso.isAuthModeConfigured('oidc'), false);
	process.env.ORIGIN = 'https://kitchen.example.test';
	assert.equal(sso.isAuthModeConfigured('oidc'), false, 'client authentication needs a secret');
	process.env.FLAVORITHM_OIDC_CLIENT_SECRET = 'client-secret';
	process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '60';
	assert.equal(
		sso.isAuthModeConfigured('oidc'),
		false,
		'session bounds must stay between 5 minutes and 24 hours'
	);
});

test('container healthcheck targets GET /api/auth, returns 200 in valid modes, and returns 503 when auth is broken', async () => {
	const composeYaml = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8');
	const probeMatch = composeYaml.match(/fetch\('([^']+)'\)/);
	assert.ok(probeMatch, 'compose.yml must define a fetch-based healthcheck probe');
	const probeUrl = new URL(probeMatch[1]);
	assert.equal(probeUrl.href, 'http://127.0.0.1:3000/api/auth');
	assert.ok(!composeYaml.includes('/manifest.webmanifest'));

	async function runHealthcheckProbe(): Promise<Response> {
		const jar = cookieJar();
		const request = new Request(`https://kitchen.example.test${probeUrl.pathname}`, {
			method: 'GET'
		});
		const event = {
			request,
			url: new URL(request.url),
			cookies: jar.cookies,
			locals: { user: null as unknown, authMode: 'invalid' }
		};
		return handle({
			event,
			resolve: (resolvedEvent: typeof event) => authRoute.GET(resolvedEvent as never)
		} as never);
	}

	process.env.ORIGIN = 'https://kitchen.example.test';
	process.env.FLAVORITHM_AUTH_MODE = 'local';
	const localProbe = await runHealthcheckProbe();
	assert.equal(localProbe.status, 200);
	assert.equal((await localProbe.json()).authMode, 'local');

	process.env.FLAVORITHM_AUTH_MODE = 'oidc';
	process.env.FLAVORITHM_OIDC_ISSUER = oidcIssuer;
	process.env.FLAVORITHM_OIDC_CLIENT_ID = oidcClientId;
	process.env.FLAVORITHM_OIDC_CLIENT_SECRET = '';
	process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'none';
	process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS = '3600';
	process.env.FLAVORITHM_OIDC_REDIRECT_URI = 'https://kitchen.example.test/auth/callback';
	const oidcProbe = await runHealthcheckProbe();
	assert.equal(oidcProbe.status, 200);
	assert.equal((await oidcProbe.json()).authMode, 'oidc');

	process.env.FLAVORITHM_AUTH_MODE = 'proxy';
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = proxySecret;
	delete process.env.FLAVORITHM_PROXY_SECRET_HEADER;
	const proxyProbe = await runHealthcheckProbe();
	assert.equal(proxyProbe.status, 200);
	const proxyData = await proxyProbe.json();
	assert.equal(proxyData.authMode, 'proxy');
	assert.equal(proxyData.user, null);

	process.env.FLAVORITHM_AUTH_MODE = 'invalid-mode';
	assert.equal((await runHealthcheckProbe()).status, 503);

	process.env.FLAVORITHM_AUTH_MODE = 'proxy';
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = 'short';
	assert.equal((await runHealthcheckProbe()).status, 503);

	process.env.FLAVORITHM_AUTH_MODE = 'oidc';
	process.env.FLAVORITHM_OIDC_CLIENT_ID = '';
	assert.equal((await runHealthcheckProbe()).status, 503);
});

const stateRoute = await import('../src/routes/api/state/+server.ts');
const logoutRoute = await import('../src/routes/auth/logout/+server.ts');
const coverRoute = await import('../src/routes/api/recipe-covers/[id]/+server.ts');

async function captureSql<T>(fn: () => Promise<T> | T): Promise<{
	result: T;
	statements: string[];
	writes: string[];
	selects: string[];
}> {
	const db = backend.getDatabase();
	const originalExec = db.exec.bind(db);
	const originalPrepare = db.prepare.bind(db);
	const statements: string[] = [];
	const record = (sql: string) => {
		statements.push(sql.replace(/\s+/g, ' ').trim());
	};
	db.exec = ((sql: string) => {
		record(sql);
		return originalExec(sql);
	}) as typeof db.exec;
	db.prepare = ((sql: string) => {
		const stmt = originalPrepare(sql);
		return new Proxy(stmt, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== 'function') return value;
				if (prop === 'get' || prop === 'all' || prop === 'run' || prop === 'iterate') {
					return (...args: unknown[]) => {
						record(sql);
						return (value as (...params: unknown[]) => unknown).apply(target, args);
					};
				}
				return value.bind(target);
			}
		});
	}) as typeof db.prepare;
	try {
		const result = await fn();
		const writes = statements.filter((sql) =>
			/^(BEGIN\b|COMMIT\b|ROLLBACK\b|INSERT\b|UPDATE\b|DELETE\b|REPLACE\b|ALTER\b|CREATE\b|DROP\b)/i.test(
				sql
			)
		);
		const selects = statements.filter((sql) => /^SELECT\b/i.test(sql));
		return { result, statements, writes, selects };
	} finally {
		db.exec = originalExec;
		db.prepare = originalPrepare;
	}
}

function configureProxyTestEnv(): void {
	process.env.ORIGIN = 'https://kitchen.example.test';
	process.env.FLAVORITHM_AUTH_MODE = 'proxy';
	process.env.FLAVORITHM_PROXY_SHARED_SECRET = proxySecret;
	process.env.FLAVORITHM_PROXY_SECRET_HEADER = 'x-flavorithm-proxy-secret';
	process.env.FLAVORITHM_PROXY_SUBJECT_HEADER = 'x-authentik-uid';
	process.env.FLAVORITHM_PROXY_EMAIL_HEADER = 'x-authentik-email';
	process.env.FLAVORITHM_PROXY_NAME_HEADER = 'x-authentik-name';
	process.env.FLAVORITHM_PROXY_ISSUER = 'https://authentik.example.test/';
	process.env.FLAVORITHM_PROXY_LOGOUT_URL =
		'https://authentik.example.test/outpost.goauthentik.io/sign_out';
}

async function runProxyRoute(input: {
	url: string;
	headers?: HeadersInit;
	cookies?: CookieJar;
	handler: (event: never) => Promise<Response> | Response;
	params?: Record<string, string>;
}): Promise<{
	response: Response;
	event: { locals: { user: unknown; authMode: string } };
	jar: CookieJar;
}> {
	const headers = new Headers(input.headers);
	const jar = input.cookies ?? cookieJar();
	if (!input.cookies) {
		for (const pair of (headers.get('cookie') ?? '').split(';')) {
			const separator = pair.indexOf('=');
			if (separator > 0) {
				jar.values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
			}
		}
	}
	const request = new Request(input.url, { method: 'GET', headers });
	const event = {
		request,
		url: new URL(request.url),
		cookies: jar.cookies,
		params: input.params ?? {},
		locals: { user: null as unknown, authMode: 'invalid' }
	};
	const response = await handle({
		event,
		resolve: async (resolvedEvent: typeof event) => input.handler(resolvedEvent as never)
	} as never);
	return { response, event, jar };
}

test('steady-state proxy requests execute zero SQLite writes and consolidate session lookup', async () => {
	configureProxyTestEnv();

	const initial = await captureSql(() =>
		runProxyRoute({
			url: 'https://kitchen.example.test/api/auth',
			headers: proxyHeaders('steady-proxy-user'),
			handler: authRoute.GET as never
		})
	);
	assert.equal(initial.result.response.status, 200);
	const initialSetCookie = initial.result.jar.setCalls.find(
		(entry) => entry.name === 'flavorithm_session'
	);
	assert.ok(initialSetCookie, 'new proxy bindings emit Set-Cookie');
	const bindingToken = initialSetCookie.value;
	assert.ok(backend.getSessionBinding(bindingToken));

	const steadyHeaders = {
		...proxyHeaders('steady-proxy-user'),
		Cookie: `flavorithm_session=${bindingToken}`
	};

	const repeatedAuth = await captureSql(() =>
		runProxyRoute({
			url: 'https://kitchen.example.test/api/auth',
			headers: steadyHeaders,
			handler: authRoute.GET as never
		})
	);
	assert.equal(repeatedAuth.result.response.status, 200);
	assert.equal(
		(await repeatedAuth.result.response.json()).user.email,
		'steady-proxy-user@example.test'
	);
	assert.deepEqual(
		repeatedAuth.writes,
		[],
		'repeated /api/auth with unchanged headers and fresh cookie must run zero SQLite writes'
	);
	assert.equal(
		repeatedAuth.selects.length,
		2,
		'steady-state proxy auth must run exactly one identity SELECT and one session token_hash SELECT'
	);
	assert.equal(
		repeatedAuth.result.jar.setCalls.length,
		0,
		'fresh proxy bindings do not re-emit Set-Cookie on every request'
	);

	const repeatedState = await captureSql(() =>
		runProxyRoute({
			url: 'https://kitchen.example.test/api/state',
			headers: steadyHeaders,
			handler: stateRoute.GET as never
		})
	);
	assert.equal(repeatedState.result.response.status, 200);
	assert.equal((await repeatedState.result.response.json()).state.recipes.length, 8);
	assert.deepEqual(
		repeatedState.writes,
		[],
		'repeated /api/state with unchanged headers and fresh cookie must run zero SQLite writes'
	);
	assert.equal(repeatedState.result.jar.setCalls.length, 0);
	assert.ok(backend.getSessionBinding(bindingToken));
});

test('proxy framework asset requests execute zero SQLite queries while preserving security headers and active bindings', async () => {
	configureProxyTestEnv();

	const seeded = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: proxyHeaders('asset-proxy-user')
	});
	const token =
		seeded.jar.setCalls.find((entry) => entry.name === 'flavorithm_session')?.value ?? '';
	assert.notEqual(token, '');

	for (const assetPath of ['/_app/immutable/entry/start.js', '/favicon.ico']) {
		const withCookieAndHeaders = await captureSql(() =>
			runHook({
				url: `https://kitchen.example.test${assetPath}`,
				headers: {
					...proxyHeaders('asset-proxy-user'),
					Cookie: `flavorithm_session=${token}`
				}
			})
		);
		assert.equal(withCookieAndHeaders.result.response.status, 200);
		assert.deepEqual(
			withCookieAndHeaders.statements,
			[],
			`${assetPath} must execute zero SQLite queries in proxy mode`
		);
		assert.equal(withCookieAndHeaders.result.jar.setCalls.length, 0);
		assert.equal(withCookieAndHeaders.result.jar.deleteCalls.length, 0);
		assert.ok(
			backend.getSessionBinding(token),
			`${assetPath} must not revoke an active proxy binding cookie`
		);
		const headers = withCookieAndHeaders.result.response.headers;
		assert.equal(headers.get('x-content-type-options'), 'nosniff');
		assert.equal(headers.get('x-frame-options'), 'DENY');
		assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
		assert.equal(
			headers.get('permissions-policy'),
			'camera=(self), microphone=(self), geolocation=()'
		);
		assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin');
		assert.equal(headers.get('x-flavorithm-auth-mode'), 'proxy');
		assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
		assert.match(headers.get('cache-control') ?? '', /no-store/);

		const withoutHeaders = await captureSql(() =>
			runHook({
				url: `https://kitchen.example.test${assetPath}`,
				headers: { Cookie: `flavorithm_session=${token}` }
			})
		);
		assert.equal(withoutHeaders.result.response.status, 200);
		assert.deepEqual(withoutHeaders.statements, []);
		assert.ok(backend.getSessionBinding(token));
	}

	const unauthCover = await runProxyRoute({
		url: `https://kitchen.example.test/api/recipe-covers/${'a'.repeat(64)}`,
		handler: coverRoute.GET as never,
		params: { id: 'a'.repeat(64) }
	});
	assert.equal(unauthCover.response.status, 401, 'recipe cover routes still enforce proxy auth');

	const authCover = await runProxyRoute({
		url: `https://kitchen.example.test/api/recipe-covers/${'a'.repeat(64)}`,
		headers: {
			...proxyHeaders('asset-proxy-user'),
			Cookie: `flavorithm_session=${token}`
		},
		handler: coverRoute.GET as never,
		params: { id: 'a'.repeat(64) }
	});
	assert.equal(
		authCover.response.status,
		404,
		'authenticated recipe cover route resolves user and checks household cover storage'
	);
	assert.ok(authCover.event.locals.user);
});

test('changing proxy profile headers updates users and external_identities inside BEGIN IMMEDIATE and preserves collision checks', async () => {
	configureProxyTestEnv();

	const first = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: proxyHeaders('mutable-proxy-user', 'mutable-initial@example.test')
	});
	const token = first.jar.setCalls.find((entry) => entry.name === 'flavorithm_session')?.value!;
	const userId = (first.event.locals.user as { id: string }).id;

	const renamed = await captureSql(() =>
		runHook({
			url: 'https://kitchen.example.test/api/auth',
			headers: {
				'x-flavorithm-proxy-secret': proxySecret,
				'x-authentik-uid': 'mutable-proxy-user',
				'x-authentik-email': 'mutable-initial@example.test',
				'x-authentik-name': 'Renamed Proxy Chef',
				Cookie: `flavorithm_session=${token}`
			}
		})
	);
	assert.equal(renamed.result.response.status, 200);
	assert.equal((renamed.result.event.locals.user as { name: string }).name, 'Renamed Proxy Chef');
	assert.ok(renamed.writes.some((sql) => /^BEGIN IMMEDIATE$/i.test(sql)));
	assert.ok(renamed.writes.some((sql) => /^UPDATE users\b/i.test(sql)));
	assert.ok(renamed.writes.some((sql) => /^UPDATE external_identities\b/i.test(sql)));
	assert.ok(renamed.writes.some((sql) => /^COMMIT$/i.test(sql)));

	const afterRenameSteady = await captureSql(() =>
		runHook({
			url: 'https://kitchen.example.test/api/auth',
			headers: {
				'x-flavorithm-proxy-secret': proxySecret,
				'x-authentik-uid': 'mutable-proxy-user',
				'x-authentik-email': 'mutable-initial@example.test',
				'x-authentik-name': 'Renamed Proxy Chef',
				Cookie: `flavorithm_session=${token}`
			}
		})
	);
	assert.deepEqual(afterRenameSteady.writes, []);

	const reemailed = await captureSql(() =>
		runHook({
			url: 'https://kitchen.example.test/api/auth',
			headers: {
				'x-flavorithm-proxy-secret': proxySecret,
				'x-authentik-uid': 'mutable-proxy-user',
				'x-authentik-email': 'mutable-updated@example.test',
				'x-authentik-name': 'Renamed Proxy Chef',
				Cookie: `flavorithm_session=${token}`
			}
		})
	);
	assert.equal(reemailed.result.response.status, 200);
	assert.equal(
		(reemailed.result.event.locals.user as { email: string }).email,
		'mutable-updated@example.test'
	);
	assert.ok(reemailed.writes.some((sql) => /^BEGIN IMMEDIATE$/i.test(sql)));
	assert.ok(reemailed.writes.some((sql) => /^UPDATE users\b/i.test(sql)));
	assert.ok(reemailed.writes.some((sql) => /^UPDATE external_identities\b/i.test(sql)));
	assert.equal(
		backend
			.getDatabase()
			.prepare('SELECT email FROM external_identities WHERE user_id = ?')
			.get(userId)?.email,
		'mutable-updated@example.test'
	);

	await backend.registerUser(
		'Existing Local Target',
		'taken-target@example.test',
		'a sufficiently strong local password'
	);
	assert.throws(
		() =>
			backend.resolveExternalIdentity({
				issuer: 'https://authentik.example.test/',
				subject: 'mutable-proxy-user',
				email: 'taken-target@example.test',
				name: 'Renamed Proxy Chef',
				emailVerified: false
			}),
		{ status: 409 }
	);
});

test('proxy binding renews only below half TTL and revokes immediately on logout, missing headers, or identity switch', async () => {
	configureProxyTestEnv();

	const created = await runHook({
		url: 'https://kitchen.example.test/api/auth',
		headers: proxyHeaders('ttl-proxy-user')
	});
	const token = created.jar.setCalls.find((entry) => entry.name === 'flavorithm_session')?.value!;
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const initialBindingHash = backend.getSessionBinding(token);
	assert.equal(initialBindingHash, tokenHash);

	const aboveHalfExpiry = Date.now() + Math.floor(sso.PROXY_BINDING_TTL_MS / 2) + 60_000;
	backend
		.getDatabase()
		.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND auth_source = 'proxy'")
		.run(aboveHalfExpiry, tokenHash);

	const notYetHalfExpired = await captureSql(() =>
		runHook({
			url: 'https://kitchen.example.test/api/auth',
			headers: { ...proxyHeaders('ttl-proxy-user'), Cookie: `flavorithm_session=${token}` }
		})
	);
	assert.deepEqual(notYetHalfExpired.writes, []);
	assert.equal(notYetHalfExpired.result.jar.setCalls.length, 0);
	assert.equal(
		backend
			.getDatabase()
			.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
			.get(tokenHash)?.expires_at,
		aboveHalfExpiry
	);

	const belowHalfExpiry = Date.now() + Math.floor(sso.PROXY_BINDING_TTL_MS / 2) - 5_000;
	backend
		.getDatabase()
		.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND auth_source = 'proxy'")
		.run(belowHalfExpiry, tokenHash);

	const renewed = await captureSql(() =>
		runHook({
			url: 'https://kitchen.example.test/api/auth',
			headers: { ...proxyHeaders('ttl-proxy-user'), Cookie: `flavorithm_session=${token}` }
		})
	);
	assert.equal(renewed.writes.length, 1);
	assert.match(renewed.writes[0] ?? '', /^UPDATE sessions SET expires_at = \?/i);
	assert.equal(renewed.result.jar.setCalls.length, 1);
	assert.equal(renewed.result.jar.setCalls[0]?.value, token);
	assert.equal(
		backend.getSessionBinding(token),
		initialBindingHash,
		'renewing a half-expired binding keeps the session hash stable for OAuth callbacks'
	);
	const renewedExpiresAt = backend
		.getDatabase()
		.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
		.get(tokenHash)?.expires_at as number;
	assert.ok(renewedExpiresAt > aboveHalfExpiry);

	const loggedOut = await runProxyRoute({
		url: 'https://kitchen.example.test/auth/logout',
		headers: { ...proxyHeaders('ttl-proxy-user'), Cookie: `flavorithm_session=${token}` },
		handler: logoutRoute.GET as never
	});
	assert.equal(loggedOut.response.status, 303);
	assert.equal(
		loggedOut.response.headers.get('location'),
		'https://authentik.example.test/outpost.goauthentik.io/sign_out'
	);
	assert.equal(
		backend.getSessionBinding(token),
		null,
		'/auth/logout immediately revokes the proxy binding'
	);
	assert.equal(
		backend
			.getDatabase()
			.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?')
			.get(tokenHash)?.count,
		0
	);
});
