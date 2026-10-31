import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Cookies } from '@sveltejs/kit';
import * as oidc from 'openid-client';
import {
	ApiError,
	consumeOidcLoginTransaction,
	createOidcLoginTransaction,
	createOidcSession,
	deleteSession,
	ensureProxyBindingSession,
	getUserFromOidcSession,
	revokeProxyBindingSession,
	revokeOidcSession as revokeOidcSessionRecord,
	resolveExternalIdentity
} from '#lib/server/db.ts';
import type { User } from '#lib/types.ts';

export type AuthMode = 'local' | 'oidc' | 'proxy';
export type RuntimeAuthMode = AuthMode | 'invalid';

export const SESSION_COOKIE = 'flavorithm_session';
const OIDC_TRANSACTION_COOKIE_PREFIX = 'flavorithm_oidc_txn_';
const OIDC_TRANSACTION_TTL_SECONDS = 10 * 60;
const PROXY_BINDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PROXY_ISSUER = 'flavorithm:proxy';
const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function getAuthMode(): AuthMode | null {
	const raw = process.env.FLAVORITHM_AUTH_MODE;
	const configured = raw === undefined ? 'local' : raw.trim().toLowerCase();
	return configured === 'local' || configured === 'oidc' || configured === 'proxy'
		? configured
		: null;
}

type OidcSettings = {
	issuer: string;
	clientId: string;
	clientSecret?: string;
	clientAuthMethod: 'basic' | 'post' | 'none';
	origin: string;
	callbackUri: string;
	sessionTtlMs: number;
};

function isLoopbackOrigin(url: URL): boolean {
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function configuredOrigin(): URL | null {
	const raw = process.env.ORIGIN?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(url))) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		)
			return null;
		return url;
	} catch {
		return null;
	}
}

function oidcSettings(): OidcSettings | null {
	const issuer = process.env.FLAVORITHM_OIDC_ISSUER?.trim();
	const clientId = process.env.FLAVORITHM_OIDC_CLIENT_ID?.trim();
	const origin = configuredOrigin();
	if (!issuer || !clientId || !origin) return null;
	try {
		const issuerUrl = new URL(issuer);
		if (
			issuerUrl.protocol !== 'https:' ||
			issuerUrl.username ||
			issuerUrl.password ||
			issuerUrl.search ||
			issuerUrl.hash
		)
			return null;
		const callback = new URL('/auth/callback', origin);
		const configuredCallback = process.env.FLAVORITHM_OIDC_REDIRECT_URI?.trim();
		if (configuredCallback && new URL(configuredCallback).href !== callback.href) return null;
		const ttlSeconds = Number(process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS ?? 3600);
		if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 86_400) return null;
		const clientSecret = process.env.FLAVORITHM_OIDC_CLIENT_SECRET?.trim() || undefined;
		const configuredAuthMethod =
			process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD?.trim().toLowerCase();
		const clientAuthMethod = configuredAuthMethod || (clientSecret ? 'post' : 'none');
		if (
			(clientAuthMethod !== 'basic' &&
				clientAuthMethod !== 'post' &&
				clientAuthMethod !== 'none') ||
			(!clientSecret && clientAuthMethod !== 'none')
		)
			return null;
		return {
			issuer: issuerUrl.href,
			clientId,
			clientSecret,
			clientAuthMethod,
			origin: origin.origin,
			callbackUri: callback.href,
			sessionTtlMs: ttlSeconds * 1000
		};
	} catch {
		return null;
	}
}

function configuredHeaderName(envName: string, fallback: string): string | null {
	const name = (process.env[envName]?.trim() || fallback).toLowerCase();
	return HTTP_TOKEN_RE.test(name) ? name : null;
}

type ProxySettings = {
	secret: string;
	secretHeader: string;
	subjectHeader: string;
	emailHeader: string;
	nameHeader: string;
	issuer: string;
};

function proxySettings(): ProxySettings | null {
	const secret = process.env.FLAVORITHM_PROXY_SHARED_SECRET ?? '';
	const secretHeader = configuredHeaderName(
		'FLAVORITHM_PROXY_SECRET_HEADER',
		'x-flavorithm-proxy-secret'
	);
	const subjectHeader = configuredHeaderName('FLAVORITHM_PROXY_SUBJECT_HEADER', 'x-authentik-uid');
	const emailHeader = configuredHeaderName('FLAVORITHM_PROXY_EMAIL_HEADER', 'x-authentik-email');
	const nameHeader = configuredHeaderName('FLAVORITHM_PROXY_NAME_HEADER', 'x-authentik-name');
	const issuer = process.env.FLAVORITHM_PROXY_ISSUER?.trim() || DEFAULT_PROXY_ISSUER;
	if (
		Buffer.byteLength(secret, 'utf8') < 32 ||
		!secretHeader ||
		!subjectHeader ||
		!emailHeader ||
		!nameHeader ||
		!issuer ||
		issuer.length > 2_000
	)
		return null;
	return { secret, secretHeader, subjectHeader, emailHeader, nameHeader, issuer };
}

export function isAuthModeConfigured(mode: AuthMode): boolean {
	if (mode === 'local') return true;
	if (mode === 'oidc') return oidcSettings() !== null;
	return proxySettings() !== null;
}

let testFetch: typeof fetch | undefined;
export function setSsoFetchForTests(fetcher: typeof fetch | undefined): void {
	testFetch = fetcher;
	oidcConfigurations.clear();
}

function customFetchAdapter(fetcher: typeof fetch): oidc.CustomFetch {
	return (url, options) => fetcher(url, options as unknown as RequestInit);
}

const oidcConfigurations = new Map<string, Promise<oidc.Configuration>>();
async function getOidcConfiguration(settings = oidcSettings()): Promise<oidc.Configuration> {
	if (!settings) throw new ApiError(503, 'Organization sign-in is not configured correctly');
	const cacheKey = `${settings.issuer}\u0000${settings.clientId}\u0000${settings.clientAuthMethod}\u0000${settings.clientSecret ?? ''}`;
	let pending = oidcConfigurations.get(cacheKey);
	if (!pending) {
		pending = (async () => {
			const authentication =
				settings.clientAuthMethod === 'basic'
					? oidc.ClientSecretBasic(settings.clientSecret)
					: settings.clientAuthMethod === 'post'
						? oidc.ClientSecretPost(settings.clientSecret)
						: oidc.None();
			const discoveryOptions: oidc.DiscoveryRequestOptions = {
				execute: [oidc.enableNonRepudiationChecks]
			};
			if (testFetch) discoveryOptions[oidc.customFetch] = customFetchAdapter(testFetch);
			const configuration = await oidc.discovery(
				new URL(settings.issuer),
				settings.clientId,
				undefined,
				authentication,
				discoveryOptions
			);
			if (testFetch) configuration[oidc.customFetch] = customFetchAdapter(testFetch);
			return configuration;
		})();
		oidcConfigurations.set(cacheKey, pending);
	}
	try {
		return await pending;
	} catch {
		oidcConfigurations.delete(cacheKey);
		throw new ApiError(503, 'Organization sign-in is temporarily unavailable');
	}
}

function oidcTransactionCookieName(state: string): string {
	const suffix = createHash('sha256').update(state).digest('base64url').slice(0, 24);
	return `${OIDC_TRANSACTION_COOKIE_PREFIX}${suffix}`;
}

function safeReturnTo(value: string | null, origin: string): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
		return '/';
	try {
		const target = new URL(value, origin);
		if (target.origin !== origin || target.username || target.password) return '/';
		if (target.pathname === '/auth/callback' || target.pathname === '/auth/login') return '/';
		return `${target.pathname}${target.search}`;
	} catch {
		return '/';
	}
}

export function createOidcAuthorizationRedirect(input: {
	requestUrl: URL;
	cookies: Cookies;
	returnTo?: string | null;
}): Promise<URL> {
	return (async () => {
		const settings = oidcSettings();
		if (!settings) throw new ApiError(503, 'Organization sign-in is not configured correctly');
		const configuration = await getOidcConfiguration(settings);
		const state = oidc.randomState();
		const nonce = oidc.randomNonce();
		const codeVerifier = oidc.randomPKCECodeVerifier();
		const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
		const browserToken = randomBytes(32).toString('base64url');
		createOidcLoginTransaction({
			state,
			browserToken,
			codeVerifier,
			nonce,
			returnTo: safeReturnTo(input.returnTo ?? null, settings.origin),
			ttlMs: OIDC_TRANSACTION_TTL_SECONDS * 1000
		});
		input.cookies.set(oidcTransactionCookieName(state), browserToken, {
			path: '/auth/callback',
			httpOnly: true,
			secure: new URL(settings.origin).protocol === 'https:',
			sameSite: 'lax',
			maxAge: OIDC_TRANSACTION_TTL_SECONDS
		});
		return oidc.buildAuthorizationUrl(configuration, {
			redirect_uri: settings.callbackUri,
			response_type: 'code',
			scope: 'openid email profile',
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			state,
			nonce
		});
	})();
}

export async function completeOidcLogin(input: { callbackUrl: URL; cookies: Cookies }): Promise<{
	user: User;
	token: string;
	expiresAt: number;
	returnTo: string;
}> {
	const settings = oidcSettings();
	if (!settings) throw new ApiError(503, 'Organization sign-in is not configured correctly');
	const state = input.callbackUrl.searchParams.get('state') ?? '';
	const cookieName = oidcTransactionCookieName(state);
	const browserToken = input.cookies.get(cookieName);
	input.cookies.delete(cookieName, { path: '/auth/callback' });
	const transaction = browserToken ? consumeOidcLoginTransaction(state, browserToken) : null;
	if (!transaction) throw new ApiError(400, 'Sign-in could not be completed. Please try again.');
	if (input.callbackUrl.searchParams.has('error')) {
		throw new ApiError(401, 'Sign-in could not be completed. Please try again.');
	}
	const configuration = await getOidcConfiguration(settings);
	const grantUrl = new URL(settings.callbackUri);
	grantUrl.search = input.callbackUrl.search;
	const tokens = await oidc.authorizationCodeGrant(configuration, grantUrl, {
		expectedState: state,
		expectedNonce: transaction.nonce,
		pkceCodeVerifier: transaction.codeVerifier
	});
	const claims = tokens.claims();
	const subject = typeof claims?.sub === 'string' ? claims.sub : '';
	let email = typeof claims?.email === 'string' ? claims.email : '';
	let emailVerified = claims?.email_verified === true;
	let name =
		typeof claims?.name === 'string'
			? claims.name
			: typeof claims?.preferred_username === 'string'
				? claims.preferred_username
				: email;
	if (!claims || !subject) {
		throw new ApiError(401, 'The identity provider did not return a usable identity');
	}
	if (
		(!email || !name) &&
		tokens.access_token &&
		configuration.serverMetadata().userinfo_endpoint
	) {
		const userInfo = await oidc.fetchUserInfo(configuration, tokens.access_token, subject);
		if (!email && typeof userInfo.email === 'string') email = userInfo.email;
		if (!name && typeof userInfo.name === 'string') name = userInfo.name;
		if (userInfo.email_verified === true) emailVerified = true;
	}
	if (!email) throw new ApiError(401, 'The identity provider did not return a usable identity');
	const user = resolveExternalIdentity({
		issuer: settings.issuer,
		subject,
		email,
		name,
		emailVerified
	});
	const tokenExpiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
	const ttlMs = Math.min(settings.sessionTtlMs, tokenExpiresAt - Date.now());
	if (ttlMs <= 0) throw new ApiError(401, 'The identity provider returned an expired identity');
	const session = createOidcSession(user, settings.issuer, subject, settings.clientId, ttlMs);
	return { user, ...session, returnTo: safeReturnTo(transaction.returnTo, settings.origin) };
}

export function setOidcSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: number,
	secure: boolean
): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		expires: new Date(expiresAt),
		maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
	});
}

export function getOidcLogoutRedirectUrl(): Promise<URL | null> {
	return (async () => {
		const settings = oidcSettings();
		if (!settings) return null;
		try {
			const configuration = await getOidcConfiguration(settings);
			if (!configuration.serverMetadata().end_session_endpoint) return null;
			return oidc.buildEndSessionUrl(configuration, {
				post_logout_redirect_uri: `${settings.origin}/`
			});
		} catch {
			return null;
		}
	})();
}

function fixedTimeSecretMatch(expected: string, supplied: string): boolean {
	const expectedHash = createHash('sha256').update(expected).digest();
	const suppliedHash = createHash('sha256').update(supplied).digest();
	return timingSafeEqual(expectedHash, suppliedHash);
}

export function authenticateProxyRequest(request: Request): {
	user: User;
	issuer: string;
	subject: string;
} | null {
	const settings = proxySettings();
	if (!settings) return null;
	const suppliedSecret = request.headers.get(settings.secretHeader) ?? '';
	if (!fixedTimeSecretMatch(settings.secret, suppliedSecret)) return null;
	const subject = request.headers.get(settings.subjectHeader)?.trim() ?? '';
	const email = request.headers.get(settings.emailHeader)?.trim() ?? '';
	const name = request.headers.get(settings.nameHeader)?.trim() ?? '';
	if (
		!subject ||
		subject.length > 500 ||
		!email ||
		email.length > 254 ||
		name.length > 80 ||
		/[\r\n\u0000]/.test(subject + email + name)
	)
		return null;
	try {
		const user = resolveExternalIdentity({
			issuer: settings.issuer,
			subject,
			email,
			name: name || email,
			// Authentik's default proxy headers do not prove mailbox ownership.
			emailVerified: false
		});
		return { user, issuer: settings.issuer, subject };
	} catch {
		return null;
	}
}

export function ensureProxyRequestBinding(input: {
	currentToken: string | undefined;
	user: User;
	issuer: string;
	subject: string;
}): { token: string; expiresAt: number } {
	return ensureProxyBindingSession(
		input.currentToken,
		input.user,
		input.issuer,
		input.subject,
		PROXY_BINDING_TTL_MS
	);
}

export function revokeProxyRequestBinding(token: string | undefined): void {
	revokeProxyBindingSession(token);
}

export function requestOriginIsSecure(requestUrl: URL, request: Request): boolean {
	const publicOrigin = configuredOrigin();
	const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	return (
		publicOrigin?.protocol === 'https:' ||
		requestUrl.protocol === 'https:' ||
		forwardedProto === 'https'
	);
}

export function getAuthMetadata(mode: RuntimeAuthMode): {
	authMode: RuntimeAuthMode;
	loginUrl: string | null;
	logoutUrl: string | null;
} {
	return {
		authMode: mode,
		loginUrl: mode === 'oidc' ? '/auth/login' : null,
		logoutUrl:
			mode === 'oidc' || (mode === 'proxy' && getProxyLogoutUrl() !== null) ? '/auth/logout' : null
	};
}

export function getConfiguredPublicOrigin(): string | null {
	return configuredOrigin()?.origin ?? null;
}

export function getProxyLogoutUrl(): string | null {
	const raw = process.env.FLAVORITHM_PROXY_LOGOUT_URL?.trim();
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackOrigin(url))) ||
			url.username ||
			url.password ||
			url.hash
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

export function revokeSession(token: string | undefined): void {
	deleteSession(token);
}

export function revokeOidcSession(token: string | undefined): void {
	revokeOidcSessionRecord(token);
}

export function getSsoUserFromSession(token: string | undefined): User | null {
	const settings = oidcSettings();
	return settings ? getUserFromOidcSession(token, settings.issuer, settings.clientId) : null;
}
