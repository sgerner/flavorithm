import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { getChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
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

		const isObjectBody = Boolean(body && typeof body === 'object' && !Array.isArray(body));
		const record = isObjectBody ? (body as Record<string, unknown>) : null;
		const isSearch = record?.action === 'search';
		const host = isSearch ? null : getHostAI();
		let usingHost = false;

		if (record && !isSearch) {
			const explicitPersonal = record.usePersonalAI === true;
			const explicitHost =
				record.usePersonalAI === false || record.connectionId === HOST_CONNECTION_ID;
			const hasPersonalApiKey =
				typeof record.provider === 'string' &&
				record.provider !== 'chatgpt' &&
				typeof record.apiKey === 'string' &&
				record.apiKey.trim().length > 0;
			const hasPersonalChatGPT =
				record.provider === 'chatgpt' &&
				typeof record.connectionId === 'string' &&
				record.connectionId.trim().length > 0 &&
				record.connectionId !== HOST_CONNECTION_ID;
			const usePersonal =
				explicitPersonal || (!explicitHost && (hasPersonalApiKey || hasPersonalChatGPT));

			if (host && !usePersonal) {
				const {
					reasoning: _reasoning,
					apiKey: _apiKey,
					usePersonalAI: _usePersonalAI,
					...rest
				} = record;
				body = {
					...rest,
					provider: 'chatgpt',
					model: host.model,
					connectionId: host.accountId
				};
				usingHost = true;
			} else if (!host && explicitHost) {
				throw new ApiError(400, 'Host AI is not enabled. Connect a personal model in Settings.');
			}
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
			if (!usingHost && accountId === HOST_CONNECTION_ID) {
				throw new ApiError(
					400,
					host
						? 'Select a personal ChatGPT account or another provider.'
						: 'Host AI is not enabled. Connect a personal model in Settings.'
				);
			}
			const resolved = await getChatGPTConnection(
				usingHost && host ? host.userId : user.id,
				usingHost && host ? host.accountId : accountId,
				event.fetch
			);
			connection = { accessToken: resolved.accessToken, codex: resolved.codex };
			providerFetch = resolved.fetcher;
		}
		return Response.json(
			await runAIRequest(body, providerFetch, undefined, connection, event.request.signal),
			{
				headers: { 'cache-control': 'no-store' }
			}
		);
	} catch (error) {
		if (error instanceof ChatGPTInferenceError)
			return Response.json({ error: error.message, code: error.code }, { status: error.status });
		if (error instanceof ApiError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		if (error instanceof AIRequestError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		return Response.json({ error: 'The AI request could not be completed.' }, { status: 500 });
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
