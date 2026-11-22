import type { RequestHandler } from './$types';
import { ApiError, clientAddress, consumeRateLimit } from '#lib/server/db.ts';
import { createOidcAuthorizationRedirect, getAuthMode } from '#lib/server/sso.ts';

export const GET: RequestHandler = async (event) => {
	const { url, cookies, locals } = event;
	if (locals.authMode !== 'oidc' || getAuthMode() !== 'oidc') {
		return new Response('Organization sign-in is not enabled.', {
			status: 404,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
		});
	}
	const address = clientAddress(event);
	if (!address) {
		return new Response('The request source could not be verified.', {
			status: 403,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
		});
	}
	try {
		consumeRateLimit(`oidc-login:${address}`, 100, 10 * 60 * 1000);
		const authorizationUrl = await createOidcAuthorizationRedirect({
			requestUrl: url,
			cookies,
			returnTo: url.searchParams.get('returnTo')
		});
		return new Response(null, {
			status: 302,
			headers: {
				Location: authorizationUrl.href,
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer'
			}
		});
	} catch (error) {
		const limited = error instanceof ApiError && error.status === 429;
		return new Response(
			limited
				? 'Too many sign-in attempts. Please wait before trying again.'
				: 'Organization sign-in is temporarily unavailable.',
			{
				status: error instanceof ApiError ? error.status : 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
			}
		);
	}
};
