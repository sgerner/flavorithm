import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	ApiError,
	assertSameOrigin,
	errorResponse,
	getState,
	getStateEtag,
	readJson,
	saveState,
	validateAppState
} from '#lib/server/db.ts';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	const state = getState(locals.user);
	return json({ state }, { headers: state ? { ETag: getStateEtag(locals.user) } : {} });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
	try {
		assertSameOrigin(request);
		if (!locals.user) throw new ApiError(401, 'Authentication required');
		const body = await readJson(request);
		if (typeof body !== 'object' || body === null || !('state' in body))
			throw new ApiError(400, 'A state object is required');
		const state = validateAppState(body.state);
		if (!state) throw new ApiError(400, 'State data is invalid or too large');
		const saved = saveState(locals.user, state, {
			ifMatch: request.headers.get('if-match'),
			ifNoneMatch: request.headers.get('if-none-match')
		});
		return json({ state: saved }, { headers: { ETag: getStateEtag(locals.user) } });
	} catch (error) {
		return errorResponse(error);
	}
};
