import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { hostUnavailableResponse, mapSignedInAIRouteError } from '#lib/server/ai-route-errors.ts';
import { withChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { listChatGPTModels } from '#lib/server/chatgpt-inference.ts';
import { ApiError } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';
import { getPublicModelCatalog } from '#lib/server/ai.ts';

export const GET: RequestHandler = async ({ locals, fetch, url }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
	const currentUser = locals.user;
	let usingHostAI = false;
	let hostTarget: { userId: string; accountId: string } | null = null;
	let personalAccountId = '';
	const isChatGPTProvider = url.searchParams.get('connection') === 'chatgpt';

	try {
		if (isChatGPTProvider) {
			const accountId = url.searchParams.get('accountId');
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			if (accountId === HOST_CONNECTION_ID) {
				usingHostAI = true;
				const host = getHostAI();
				if (!host) {
					return hostUnavailableResponse();
				}
				hostTarget = { userId: host.userId, accountId: host.accountId };
			} else {
				personalAccountId = accountId;
			}
			const catalogPromise = getPublicModelCatalog(fetch).catch(() => null);
			const [result, catalogData] = await Promise.all([
				withChatGPTConnection(
					hostTarget?.userId ?? currentUser.id,
					hostTarget?.accountId ?? accountId,
					fetch,
					(connection) => listChatGPTModels(connection.accessToken, connection.fetcher)
				),
				catalogPromise
			]);
			const openai = catalogData?.providers.find((provider) => provider.id === 'openai');
			for (const model of result.providers[0].models) {
				const metadata = openai?.models.find((candidate) => candidate.id === model.id);
				if (metadata?.reasoning && !model.reasoning)
					Object.assign(model, { reasoning: metadata.reasoning });
			}
			return Response.json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return Response.json(await getPublicModelCatalog(fetch), {
			headers: { 'cache-control': 'private, max-age=3600' }
		});
	} catch (error) {
		return mapSignedInAIRouteError(error, {
			userId: currentUser.id,
			usingHostAI,
			hostTarget,
			personalAccountId,
			isChatGPTProvider,
			fallbackMessage: 'The model catalog could not be loaded.'
		});
	}
};
