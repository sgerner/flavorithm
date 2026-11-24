import type { RequestHandler } from './$types';
import { getState } from '#lib/server/db.ts';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user)
		return Response.json(
			{ error: 'Authentication required', code: 'session_expired' },
			{ status: 401 }
		);
	return Response.json(
		{
			exportedAt: new Date().toISOString(),
			user: locals.user,
			state: getState(locals.user)
		},
		{
			headers: { 'Content-Disposition': 'attachment; filename="flavorithm-data.json"' }
		}
	);
};
