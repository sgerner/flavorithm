import type { RequestHandler } from './$types';
import { ApiError } from '#lib/server/db.ts';
import {
	completeOidcLogin,
	getAuthMode,
	getConfiguredPublicOrigin,
	requestOriginIsSecure,
	setOidcSessionCookie
} from '#lib/server/sso.ts';

function failure(error: unknown): Response {
	const status = error instanceof ApiError ? error.status : 401;
	return new Response('Sign-in could not be completed. Please return to the app and try again.', {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
	});
}

export const GET: RequestHandler = async ({ url, cookies, request, locals }) => {
	if (locals.authMode !== 'oidc' || getAuthMode() !== 'oidc') {
		return new Response('Organization sign-in is not enabled.', {
			status: 404,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
		});
	}
	try {
		const result = await completeOidcLogin({ callbackUrl: url, cookies });
		setOidcSessionCookie(
			cookies,
			result.token,
			result.expiresAt,
			requestOriginIsSecure(url, request)
		);
		const origin = getConfiguredPublicOrigin();
		if (!origin) throw new ApiError(503, 'Organization sign-in is not configured correctly');
		return new Response(null, {
			status: 303,
			headers: {
				Location: new URL(result.returnTo, origin).href,
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer'
			}
		});
	} catch (error) {
		return failure(error);
	}
};
