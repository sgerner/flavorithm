import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAuthMetadata } from '#lib/server/sso.ts';

export const GET: RequestHandler = ({ locals }) => {
	return json(getAuthMetadata(locals.authMode));
};
