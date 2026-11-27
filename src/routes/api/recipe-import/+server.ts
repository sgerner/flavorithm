import { z } from 'zod';
import type { RequestEvent } from './$types';
import {
	AIRequestError,
	importRecipeFromUrl,
	type RecipeUrlImportFallback,
	type SecureRecipePageFetcher
} from '#lib/server/ai.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ApiError, assertSameOrigin, clientAddress, consumeRateLimit } from '#lib/server/db.ts';
import { getHostAIFor, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';

const MAX_IMPORT_REQUEST_BYTES = 64_000;

const recipeImportRequestSchema = z.object({
	url: z.string().trim().min(1).max(2_048),
	provider: z
		.string()
		.regex(/^[a-z0-9-]{1,100}$/)
		.optional(),
	model: z.string().trim().max(200).optional(),
	reasoning: z
		.object({
			effort: z
				.string()
				.regex(/^[a-z_]{1,24}$/)
				.optional(),
			enabled: z.boolean().optional(),
			budgetTokens: z.number().int().min(0).max(32_768).optional()
		})
		.optional(),
	apiKey: z.string().max(1_000).optional(),
	connectionId: z.string().max(100).optional(),
	usePersonalAI: z.boolean().optional()
});

export type RecipeImportRouteOptions = {
	pageFetcher?: SecureRecipePageFetcher;
};

export const POST = async (event: RequestEvent, options: RecipeImportRouteOptions = {}) => {
	try {
		assertSameOrigin(event.request);
		if (event.request.headers.get('sec-fetch-site') === 'cross-site') {
			throw new ApiError(403, 'Cross-origin request rejected');
		}

		const user = event.locals.user;
		if (!user) {
			throw new ApiError(401, 'Authentication required', 'session_expired');
		}

		const ip = clientAddress(event);
		if (!ip) throw new ApiError(403, 'The request source could not be verified');
		consumeRateLimit(`recipe-import-ip:${ip}`, 20, 15 * 60 * 1000);
		consumeRateLimit(`recipe-import-user:${user.id}`, 30, 60 * 60 * 1000);

		const contentLength = Number(event.request.headers.get('content-length') ?? 0);
		if (contentLength > MAX_IMPORT_REQUEST_BYTES) {
			throw new AIRequestError('Request is too large.', 413);
		}

		let rawBody: unknown;
		try {
			const raw = await readLimitedBody(event.request);
			rawBody = JSON.parse(raw);
		} catch (error) {
			if (error instanceof AIRequestError) throw error;
			throw new AIRequestError('Request body must contain valid JSON.');
		}

		const parsed = recipeImportRequestSchema.safeParse(rawBody);
		if (!parsed.success) {
			throw new AIRequestError('Provide a valid recipe URL to import.', 400);
		}
		const payload = parsed.data;

		const result = await importRecipeFromUrl(
			{
				url: payload.url,
				authenticated: true,
				resolveFallback: async (): Promise<RecipeUrlImportFallback | null> => {
					const host = getHostAIFor(user.id);
					const provider = payload.provider?.trim();
					const model = payload.model?.trim();
					const explicitPersonal = payload.usePersonalAI === true;
					const explicitHost =
						payload.usePersonalAI === false || payload.connectionId === HOST_CONNECTION_ID;
					const hasPersonalApiKey = Boolean(
						provider && provider !== 'chatgpt' && payload.apiKey?.trim()
					);
					const hasPersonalChatGPT = Boolean(
						provider === 'chatgpt' &&
						payload.connectionId?.trim() &&
						payload.connectionId.trim() !== HOST_CONNECTION_ID
					);
					const usePersonal =
						explicitPersonal || (!explicitHost && (hasPersonalApiKey || hasPersonalChatGPT));

					if (host && !usePersonal) {
						consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 60 * 1000);
						const resolved = await getChatGPTConnection(host.userId, host.accountId, event.fetch);
						return {
							provider: 'chatgpt',
							model: host.model,
							connection: { accessToken: resolved.accessToken, codex: resolved.codex },
							fetcher: resolved.fetcher
						};
					}

					if (!provider || !model) return null;

					if (provider === 'chatgpt') {
						const accountId = payload.connectionId?.trim() ?? '';
						if (!accountId || accountId === HOST_CONNECTION_ID) return null;
						consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 60 * 1000);
						const resolved = await getChatGPTConnection(user.id, accountId, event.fetch);
						return {
							provider: 'chatgpt',
							model,
							reasoning: payload.reasoning,
							connection: { accessToken: resolved.accessToken, codex: resolved.codex },
							fetcher: resolved.fetcher
						};
					}

					const apiKey = payload.apiKey?.trim() ?? '';
					if (!apiKey) return null;
					consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 1000 * 60);
					return {
						provider,
						model,
						apiKey,
						reasoning: payload.reasoning,
						fetcher: event.fetch
					};
				}
			},
			options.pageFetcher,
			event.request.signal
		);

		return Response.json(result, {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		if (error instanceof ChatGPTInferenceError) {
			return Response.json(
				{ error: error.message, code: error.code },
				{ status: error.status, headers: { 'cache-control': 'no-store' } }
			);
		}
		if (error instanceof ApiError) {
			return Response.json(
				error.code ? { error: error.message, code: error.code } : { error: error.message },
				{ status: error.status, headers: { 'cache-control': 'no-store' } }
			);
		}
		if (error instanceof AIRequestError) {
			return Response.json(
				{ error: error.message },
				{ status: error.status, headers: { 'cache-control': 'no-store' } }
			);
		}
		return Response.json(
			{ error: 'The recipe URL could not be imported.' },
			{ status: 500, headers: { 'cache-control': 'no-store' } }
		);
	}
};

async function readLimitedBody(request: Request) {
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_IMPORT_REQUEST_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new AIRequestError('Request is too large.', 413);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(combined);
	} catch {
		throw new AIRequestError('Request body must contain valid UTF-8 JSON.');
	}
}
