import type { Handle } from '@sveltejs/kit/hooks';
import { getUserFromSession } from '#lib/server/db.ts';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = getUserFromSession(event.cookies.get('flavorithm_session'));
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

	const forwardedProto = event.request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	if (event.url.protocol === 'https:' || forwardedProto === 'https') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000');
	}

	if (event.url.pathname === '/api' || event.url.pathname.startsWith('/api/')) {
		response.headers.set('Cache-Control', 'no-store, max-age=0');
		response.headers.set('Pragma', 'no-cache');
		response.headers.set('Expires', '0');
	}

	return response;
};
