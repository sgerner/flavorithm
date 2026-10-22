import { getChatGPTAccessToken } from '#lib/server/chatgpt-oauth.ts';
import { listChatGPTModels, ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { ApiError } from '#lib/server/db.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AIRequestError, getSupportedModels } from '#lib/server/ai.ts';

export const GET: RequestHandler = async ({ locals, fetch, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized.' }, { status: 401 });

	try {
		if (url.searchParams.get('connection') === 'chatgpt') {
			const accountId = url.searchParams.get('accountId');
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			const accessToken = await getChatGPTAccessToken(locals.user.id, accountId);
			return json(await listChatGPTModels(accessToken, fetch), {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return json(await getSupportedModels(fetch), {
			headers: { 'cache-control': 'private, max-age=3600' }
		});
	} catch (error) {
		if (error instanceof ApiError || error instanceof ChatGPTInferenceError)
			return json({ error: error.message }, { status: error.status });
		if (error instanceof AIRequestError) {
			return json({ error: error.message }, { status: error.status });
		}
		return json({ error: 'The model catalog could not be loaded.' }, { status: 500 });
	}
};
