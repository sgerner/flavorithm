import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { exportJWK, SignJWT } from 'jose';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.ORIGIN = 'https://kitchen.example.test';

const dbPath = '../src/lib/server/db.ts';
const ssoPath = '../src/lib/server/sso.ts';
const hooksPath = '../src/hooks.server.ts';
const backend = await import(dbPath);
const sso = await import(ssoPath);
const { handle } = await import(hooksPath);

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

	process.env.FLAVORITHM_AUTH_MODE = '';
	assert.equal(sso.getAuthMode(), null, 'an explicitly empty auth mode is invalid');
	const invalid = await runHook({ url: 'https://kitchen.example.test/api/state' });
	assert.equal(invalid.response.status, 503);
	assert.equal(invalid.event.locals.authMode, 'invalid');
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
