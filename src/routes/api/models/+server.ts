import { getChatGPTAccessToken } from '#lib/server/chatgpt-oauth.ts';
import { listChatGPTModels, ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { ApiError } from '#lib/server/db.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AIRequestError, getSupportedModels } from '#lib/server/ai.ts';

let catalog: Promise<Awaited<ReturnType<typeof getSupportedModels>>> | undefined;
let catalogExpiresAt = 0;
function publicCatalog(fetcher: typeof fetch) {
	if (!catalog || Date.now() >= catalogExpiresAt) {
		catalogExpiresAt = Date.now() + 60 * 60 * 1000;
		const pending = getSupportedModels(fetcher).catch((error) => {
			if (catalog === pending) catalog = undefined;
			throw error;
		});
		catalog = pending;
	}
	return catalog;
}

export const GET: RequestHandler = async ({ locals, fetch, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized.' }, { status: 401 });

	try {
		if (url.searchParams.get('connection') === 'chatgpt') {
			const accountId = url.searchParams.get('accountId');
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			const accessToken = await getChatGPTAccessToken(locals.user.id, accountId);
			const result = await listChatGPTModels(accessToken, fetch);
			try {
				const catalog = await publicCatalog(fetch);
				const openai = catalog.providers.find((provider) => provider.id === 'openai');
				for (const model of result.providers[0].models) {
					const metadata = openai?.models.find((candidate) => candidate.id === model.id);
					if (metadata?.reasoning) Object.assign(model, { reasoning: metadata.reasoning });
				}
			} catch {
				/* An unavailable public catalog must not hide entitled account models. */
			}
			return json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return json(await publicCatalog(fetch), {
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
