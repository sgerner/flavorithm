import { getHostAI } from '#lib/server/host-ai.ts';
import { getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AIRequestError, runAIRequest } from '#lib/server/ai.ts';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';

const MAX_REQUEST_BYTES = 9_000_000;

export const POST: RequestHandler = async (event) => {
	try {
		assertSameOrigin(event.request);
		const user = event.locals.user;
		if (!user) throw new ApiError(401, 'Unauthorized.');
		consumeRateLimit(`ai-user:${user.id}`, 30, 60 * 60 * 1000);

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

		let connection: { accessToken: string; codex?: boolean } | undefined;
		let providerFetch = event.fetch;
		if (
			body &&
			typeof body === 'object' &&
			'provider' in body &&
			body.provider === 'chatgpt' &&
			(!('action' in body) || body.action !== 'search')
		) {
			const accountId =
				'connectionId' in body && typeof body.connectionId === 'string' ? body.connectionId : '';
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			const resolved = await getChatGPTConnection(host?.userId ?? user.id, accountId, event.fetch);
			connection = { accessToken: resolved.accessToken, codex: resolved.codex };
			providerFetch = resolved.fetcher;
		}
		return json(
			await runAIRequest(body, providerFetch, undefined, connection, event.request.signal),
			{
				headers: { 'cache-control': 'no-store' }
			}
		);
	} catch (error) {
		if (error instanceof ChatGPTInferenceError)
			return json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof ApiError) {
			return json({ error: error.message }, { status: error.status });
		}
		if (error instanceof AIRequestError) {
			return json({ error: error.message }, { status: error.status });
		}
		return json({ error: 'The AI request could not be completed.' }, { status: 500 });
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
			if (size > MAX_REQUEST_BYTES) {
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
