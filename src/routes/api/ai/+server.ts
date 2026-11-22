import { getHostAI } from '#lib/server/host-ai.ts';
import { ChatGPTOAuthError, getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AIRequestError, parseAIRequest, runAIRequest, validateAIRequest } from '#lib/server/ai.ts';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';

const MAX_REQUEST_BYTES = 9_000_000;

function aiErrorHeaders(retryAfter?: number, status?: number): Record<string, string> {
	return {
		'cache-control': 'no-store',
		...(status === 429 ? { 'Retry-After': String(Math.max(1, Math.ceil(retryAfter ?? 60))) } : {})
	};
}

export const POST: RequestHandler = async (event) => {
	try {
		assertSameOrigin(event.request);
		const user = event.locals.user;
		if (!user) throw new ApiError(401, 'Unauthorized.');

		if (event.request.signal.aborted) {
			throw new AIRequestError('The AI request was cancelled.', 499, { code: 'request_cancelled' });
		}

		const contentLength = Number(event.request.headers.get('content-length') ?? 0);
		if (contentLength > MAX_REQUEST_BYTES) {
			throw new AIRequestError('Request is too large.', 413);
		}

		let body: unknown;
		try {
			const raw = await readLimitedBody(event.request);
			body = JSON.parse(raw);
		} catch (error) {
			if (error instanceof AIRequestError) throw error;
			if (event.request.signal.aborted) {
				throw new AIRequestError('The AI request was cancelled.', 499, {
					code: 'request_cancelled'
				});
			}
			throw new AIRequestError('Request body must contain valid JSON.');
		}

		const host = getHostAI();
		if (
			host &&
			body &&
			typeof body === 'object' &&
			(!('action' in body) || body.action !== 'search')
		) {
			body = { ...body, provider: 'chatgpt', model: host.model, connectionId: host.accountId };
		}

		const parsed = parseAIRequest(body, event.request.signal);

		let connection: { accessToken: string; codex?: boolean } | undefined;
		let providerFetch = event.fetch;
		if (parsed.provider === 'chatgpt' && parsed.action !== 'search') {
			const accountId = parsed.connectionId?.trim() ?? '';
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			const resolved = await getChatGPTConnection(host?.userId ?? user.id, accountId, event.fetch);
			connection = { accessToken: resolved.accessToken, codex: resolved.codex };
			providerFetch = resolved.fetcher;
		}
		validateAIRequest(body, {
			signal: event.request.signal,
			requireRouteConnectionId: true
		});
		return json(
			await runAIRequest(body, providerFetch, undefined, connection, event.request.signal, () => {
				consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 60 * 1000);
			}),
			{
				headers: { 'cache-control': 'no-store' }
			}
		);
	} catch (error) {
		if (error instanceof ChatGPTInferenceError) {
			return json(
				{ error: error.message, ...(error.code ? { code: error.code } : {}) },
				{
					status: error.status,
					headers: aiErrorHeaders(error.retryAfter, error.status)
				}
			);
		}
		if (error instanceof ChatGPTOAuthError) {
			return json(
				{ error: error.message, code: error.code },
				{
					status: error.status,
					headers: aiErrorHeaders(error.retryAfter, error.status)
				}
			);
		}
		if (error instanceof ApiError) {
			return json(
				{ error: error.message },
				{
					status: error.status,
					headers: aiErrorHeaders(error.retryAfter, error.status)
				}
			);
		}
		if (error instanceof AIRequestError) {
			return json(
				{ error: error.message, ...(error.code ? { code: error.code } : {}) },
				{
					status: error.status,
					headers: aiErrorHeaders(error.retryAfter, error.status)
				}
			);
		}
		return json(
			{ error: 'The AI request could not be completed.' },
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
			if (request.signal.aborted) {
				void reader.cancel().catch(() => undefined);
				throw new AIRequestError('The AI request was cancelled.', 499, {
					code: 'request_cancelled'
				});
			}
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_REQUEST_BYTES) {
				void reader.cancel().catch(() => undefined);
				throw new AIRequestError('Request is too large.', 413);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof AIRequestError) throw error;
		if (request.signal.aborted) {
			throw new AIRequestError('The AI request was cancelled.', 499, { code: 'request_cancelled' });
		}
		throw error;
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
