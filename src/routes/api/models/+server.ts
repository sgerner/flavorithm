import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { ChatGPTOAuthError, withChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { listChatGPTModels, ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { clearChatGPTCredentials } from '#lib/server/oauth-storage.ts';
import { ApiError } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';
import { AIRequestError, getPublicModelCatalog } from '#lib/server/ai.ts';

const HOST_UNRECOVERABLE_CODES = new Set([
	'chatgpt_account_reauth_required',
	'chatgpt_plan_scope_missing',
	'chatgpt_account_not_found',
	'chatgpt_account_mode_mismatch',
	'subscription_sharing_invalid_user',
	'chatpass_v2_scope_not_authorized',
	'chatpass_v2_invalid_authorization_context'
]);
const HOST_UNAVAILABLE_MESSAGE =
	'Host AI is currently unavailable. Choose another connection in Settings or contact the host administrator.';

export const GET: RequestHandler = async ({ locals, fetch, url }) => {
	if (!locals.user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
	const currentUser = locals.user;
	let usingHostAI = false;
	let hostTarget: { userId: string; accountId: string } | null = null;
	let personalAccountId = '';

	try {
		if (url.searchParams.get('connection') === 'chatgpt') {
			const accountId = url.searchParams.get('accountId');
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			if (accountId === HOST_CONNECTION_ID) {
				usingHostAI = true;
				const host = getHostAI();
				if (!host) {
					return Response.json(
						{ error: HOST_UNAVAILABLE_MESSAGE, code: 'host_ai_unavailable' },
						{ status: 503, headers: { 'cache-control': 'no-store' } }
					);
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
		if (
			error instanceof ChatGPTOAuthError ||
			error instanceof ChatGPTInferenceError ||
			error instanceof AIRequestError ||
			error instanceof ApiError
		) {
			const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
			if (
				usingHostAI &&
				(error.status === 401 || (code !== undefined && HOST_UNRECOVERABLE_CODES.has(code)))
			) {
				if (hostTarget) clearChatGPTCredentials(hostTarget.userId, hostTarget.accountId);
				return Response.json(
					{ error: HOST_UNAVAILABLE_MESSAGE, code: 'host_ai_unavailable' },
					{ status: 503, headers: { 'cache-control': 'no-store' } }
				);
			}
			if (error.status === 401 || code === 'subscription_sharing_invalid_user') {
				if (personalAccountId && code === 'subscription_sharing_invalid_user') {
					clearChatGPTCredentials(currentUser.id, personalAccountId);
				}
				return Response.json(
					{ error: error.message, code: 'chatgpt_reauth_required' },
					{ status: 422, headers: { 'cache-control': 'no-store' } }
				);
			}
			return Response.json(
				{ error: error.message, ...(code ? { code } : {}) },
				{ status: error.status }
			);
		}
		return Response.json({ error: 'The model catalog could not be loaded.' }, { status: 500 });
	}
};
