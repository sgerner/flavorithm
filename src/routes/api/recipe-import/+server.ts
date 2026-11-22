import { z } from 'zod';
import type { RequestHandler } from './$types';
import {
	AIRequestError,
	importRecipeFromUrl,
	type RecipeUrlImportFallback
} from '#lib/server/ai.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';
import { getHostAI } from '#lib/server/host-ai.ts';
import { getAuthMode } from '#lib/server/sso.ts';

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
	connectionId: z.string().max(100).optional()
});

export const POST: RequestHandler = async (event) => {
	try {
		assertSameOrigin(event.request);
		if (event.request.headers.get('sec-fetch-site') === 'cross-site') {
			throw new ApiError(403, 'Cross-origin request rejected');
		}

		const user = event.locals.user;
		const authMode = event.locals.authMode ?? getAuthMode() ?? 'invalid';
		if (!user && authMode !== 'local') {
			throw new ApiError(401, 'Authentication required');
		}

		const ip = event.getClientAddress();
		consumeRateLimit(`recipe-import-ip:${ip}`, 20, 15 * 60 * 1000);
		if (user) {
			consumeRateLimit(`recipe-import-user:${user.id}`, 30, 60 * 60 * 1000);
		}

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
				authenticated: Boolean(user),
				resolveFallback: async (): Promise<RecipeUrlImportFallback | null> => {
					if (!user) return null;

					const host = getHostAI();
					if (host) {
						consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 60 * 1000);
						const resolved = await getChatGPTConnection(host.userId, host.accountId, event.fetch);
						return {
							provider: 'chatgpt',
							model: host.model,
							reasoning: payload.reasoning,
							connection: { accessToken: resolved.accessToken, codex: resolved.codex },
							fetcher: resolved.fetcher
						};
					}

					const provider = payload.provider?.trim();
					const model = payload.model?.trim();
					if (!provider || !model) return null;

					if (provider === 'chatgpt') {
						const accountId = payload.connectionId?.trim() ?? '';
						if (!accountId) return null;
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
			undefined,
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
				{ error: error.message },
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
