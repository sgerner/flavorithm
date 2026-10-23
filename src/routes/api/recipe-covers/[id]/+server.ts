import type { RequestHandler } from './$types';
import { readCover } from '#lib/server/recipe-covers.ts';

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	const bytes = /^[a-f0-9]{64}$/.test(params.id)
		? readCover(locals.user.householdId, params.id)
		: undefined;
	if (!bytes) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(bytes), {
		headers: {
			'Content-Type': 'image/jpeg',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store'
		}
	});
};
