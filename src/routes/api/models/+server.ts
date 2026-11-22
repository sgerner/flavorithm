import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { listChatGPTModels, ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { ApiError } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';
import { AIRequestError, getPublicModelCatalog, resolvePublicFetcher } from '#lib/server/ai.ts';

export const GET: RequestHandler = async (event) => {
	const { locals, url } = event;
	const catalogFetcher = resolvePublicFetcher(event);
	if (!locals.user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });

	try {
		if (url.searchParams.get('connection') === 'chatgpt') {
			const accountId = url.searchParams.get('accountId');
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			const host = accountId === HOST_CONNECTION_ID ? getHostAI() : null;
			const connection = await getChatGPTConnection(
				host?.userId ?? locals.user.id,
				host?.accountId ?? accountId,
				catalogFetcher
			);
			const result = await listChatGPTModels(connection.accessToken, connection.fetcher);
			try {
				const catalog = await getPublicModelCatalog(catalogFetcher);
				const openai = catalog.providers.find((provider) => provider.id === 'openai');
				for (const model of result.providers[0].models) {
					const metadata = openai?.models.find((candidate) => candidate.id === model.id);
					if (metadata?.reasoning && !model.reasoning)
						Object.assign(model, { reasoning: metadata.reasoning });
				}
			} catch {
				/* An unavailable public catalog must not hide entitled account models. */
			}
			return Response.json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return Response.json(await getPublicModelCatalog(catalogFetcher), {
			headers: { 'cache-control': 'private, max-age=3600' }
		});
	} catch (error) {
		if (error instanceof ApiError || error instanceof ChatGPTInferenceError)
			return Response.json({ error: error.message }, { status: error.status });
		if (error instanceof AIRequestError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		return Response.json({ error: 'The model catalog could not be loaded.' }, { status: 500 });
	}
};
