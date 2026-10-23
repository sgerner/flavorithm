import type { RequestHandler } from './$types';
import {
	getAuthMode,
	getConfiguredPublicOrigin,
	getOidcLogoutRedirectUrl,
	getProxyLogoutUrl,
	revokeOidcSession,
	revokeProxyRequestBinding,
	revokeSession,
	SESSION_COOKIE
} from '#lib/server/sso.ts';

export const GET: RequestHandler = async ({ cookies, locals }) => {
	if (locals.authMode === 'local') revokeSession(cookies.get(SESSION_COOKIE));
	if (locals.authMode === 'oidc') revokeOidcSession(cookies.get(SESSION_COOKIE));
	if (locals.authMode === 'proxy') revokeProxyRequestBinding(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
	if (locals.authMode === 'oidc' && getAuthMode() === 'oidc') {
		const providerLogout = await getOidcLogoutRedirectUrl();
		if (providerLogout) {
			return new Response(null, {
				status: 303,
				headers: {
					Location: providerLogout.href,
					'Cache-Control': 'no-store',
					'Referrer-Policy': 'no-referrer'
				}
			});
		}
	}
	if (locals.authMode === 'proxy') {
		const proxyLogout = getProxyLogoutUrl();
		if (proxyLogout) {
			return new Response(null, {
				status: 303,
				headers: {
					Location: proxyLogout,
					'Cache-Control': 'no-store',
					'Referrer-Policy': 'no-referrer'
				}
			});
		}
	}
	return new Response(null, {
		status: 303,
		headers: {
			Location: `${getConfiguredPublicOrigin() ?? '/'}${getConfiguredPublicOrigin() ? '/' : ''}`,
			'Cache-Control': 'no-store'
		}
	});
};
