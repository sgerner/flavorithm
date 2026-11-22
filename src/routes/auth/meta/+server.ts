import type { RequestHandler } from './$types';
import { getAuthMetadata } from '#lib/server/sso.ts';

export const GET: RequestHandler = ({ locals }) => {
	return Response.json(getAuthMetadata(locals.authMode));
};
