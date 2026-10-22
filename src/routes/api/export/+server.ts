import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getState } from '#lib/server/db.ts';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	return json(
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
