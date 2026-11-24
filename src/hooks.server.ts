import type { Handle } from '@sveltejs/kit/hooks';
import { getUserFromSession } from '#lib/server/db.ts';
import {
	SESSION_COOKIE,
	authenticateProxyRequest,
	ensureProxyRequestBinding,
	getAuthMode,
	isAuthModeConfigured,
	requestOriginIsSecure,
	setOidcSessionCookie,
	getSsoUserFromSession,
	revokeProxyRequestBinding
} from '#lib/server/sso.ts';

function isApiPath(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith('/api/');
}

function isAuthPath(pathname: string): boolean {
	return pathname === '/auth' || pathname.startsWith('/auth/');
}

function isPublicAuthRequest(
	request: Request,
	pathname: string,
	mode: 'local' | 'oidc' | 'proxy' | 'invalid'
): boolean {
	if (pathname === '/api/auth' && (request.method === 'GET' || mode === 'local')) return true;
	if (pathname === '/api/recipe-import' && request.method === 'POST' && mode === 'local') {
		return true;
	}
	return false;
}

function isHostedChatGPTCallbackRequest(request: Request, pathname: string): boolean {
	return pathname === '/api/connections/chatgpt/callback' && request.method === 'GET';
}

function isFrameworkAsset(pathname: string): boolean {
	return (
		pathname.startsWith('/_app/') ||
		pathname.startsWith('/assets/') ||
		pathname === '/favicon.ico' ||
		pathname === '/robots.txt' ||
		pathname === '/manifest.webmanifest'
	);
}

function acceptsHtml(request: Request): boolean {
	return (request.headers.get('accept') ?? '').includes('text/html');
}

function unauthorizedApiResponse(): Response {
	return Response.json(
		{ error: 'Authentication required', code: 'session_expired' },
		{ status: 401 }
	);
}

function unavailableResponse(api: boolean): Response {
	return api
		? Response.json({ error: 'Authentication is unavailable' }, { status: 503 })
		: new Response('Authentication is unavailable', {
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
}

function proxyUnauthorizedResponse(api: boolean): Response {
	return api
		? unauthorizedApiResponse()
		: new Response('Authentication required', {
				status: 403,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
}

function ensureNoStore(response: Response): void {
	const cacheControl = response.headers.get('Cache-Control');
	const alreadyNoStore = cacheControl
		?.split(',')
		.some((directive) => directive.trim().toLowerCase() === 'no-store');
	if (!alreadyNoStore) response.headers.set('Cache-Control', 'no-store, max-age=0');
}

function hasExplicitPrivateMaxAge(pathname: string, response: Response): boolean {
	if (pathname !== '/api/models' || !response.ok) return false;
	const directives = (response.headers.get('Cache-Control') ?? '')
		.split(',')
		.map((directive) => directive.trim().toLowerCase());
	return (
		directives.includes('private') &&
		!directives.includes('no-store') &&
		directives.some((directive) => /^max-age=[1-9]\d*$/.test(directive))
	);
}

function withSecurityHeaders(
	response: Response,
	request: Request,
	pathname: string,
	authMode: 'local' | 'oidc' | 'proxy' | 'invalid'
): Response {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	response.headers.set('X-Flavorithm-Auth-Mode', authMode);
	const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	if (new URL(request.url).protocol === 'https:' || forwardedProto === 'https') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000');
	}
	const preservePrivateCache = hasExplicitPrivateMaxAge(pathname, response);
	if (isApiPath(pathname)) {
		if (preservePrivateCache) {
			response.headers.delete('Pragma');
			response.headers.delete('Expires');
		} else {
			ensureNoStore(response);
			response.headers.set('Pragma', 'no-cache');
			response.headers.set('Expires', '0');
		}
	}
	if (pathname.startsWith('/auth/')) response.headers.set('Cache-Control', 'no-store');
	if ((authMode === 'oidc' || authMode === 'proxy') && !preservePrivateCache) {
		ensureNoStore(response);
	}
	return response;
}

export const handle: Handle = async ({ event, resolve }) => {
	const mode = getAuthMode();
	event.locals.authMode = mode ?? 'invalid';
	const path = event.url.pathname;
	const api = isApiPath(path);
	const publicRequest =
		isPublicAuthRequest(event.request, path, event.locals.authMode) ||
		isHostedChatGPTCallbackRequest(event.request, path);
	let response: Response;

	if (!mode) {
		response = unavailableResponse(api);
	} else if (!isAuthModeConfigured(mode)) {
		response = unavailableResponse(api);
	} else {
		if (mode === 'local') {
			event.locals.user = getUserFromSession(event.cookies.get(SESSION_COOKIE));
		} else if (mode === 'oidc') {
			// The cookie name is shared for compatibility with the existing app, but
			// only a session created for this configured issuer and client is accepted.
			event.locals.user = getSsoUserFromSession(event.cookies.get(SESSION_COOKIE));
		} else if (isFrameworkAsset(path)) {
			event.locals.user = null;
		} else {
			const identity = authenticateProxyRequest(event.request);
			event.locals.user = identity?.user ?? null;
			if (identity && path !== '/auth/logout') {
				const binding = ensureProxyRequestBinding({
					currentToken: event.cookies.get(SESSION_COOKIE),
					user: identity.user,
					issuer: identity.issuer,
					subject: identity.subject
				});
				if (binding.setCookie) {
					setOidcSessionCookie(
						event.cookies,
						binding.token,
						binding.expiresAt,
						requestOriginIsSecure(event.url, event.request)
					);
				}
			} else {
				// A binding cookie is never an identity credential. Removing it when
				// the proxy assertion is absent makes that boundary explicit.
				revokeProxyRequestBinding(event.cookies.get(SESSION_COOKIE));
				event.cookies.delete(SESSION_COOKIE, { path: '/' });
			}
		}

		if (api && !publicRequest && !event.locals.user) {
			response = unauthorizedApiResponse();
		} else if (
			!event.locals.user &&
			!publicRequest &&
			mode === 'oidc' &&
			!isAuthPath(path) &&
			!isFrameworkAsset(path)
		) {
			if (
				(event.request.method === 'GET' || event.request.method === 'HEAD') &&
				acceptsHtml(event.request)
			) {
				const loginUrl = new URL('/auth/login', event.url.origin);
				loginUrl.searchParams.set('returnTo', `${event.url.pathname}${event.url.search}`);
				response = new Response(null, { status: 303, headers: { Location: loginUrl.href } });
			} else if (api) {
				response = unauthorizedApiResponse();
			} else {
				response = await resolve(event);
			}
		} else if (
			!event.locals.user &&
			!publicRequest &&
			mode === 'proxy' &&
			!isAuthPath(path) &&
			!isFrameworkAsset(path)
		) {
			response = proxyUnauthorizedResponse(api);
		} else {
			response = await resolve(event);
		}
	}

	return withSecurityHeaders(response, event.request, path, event.locals.authMode);
};
