import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { hostUnavailableResponse, mapSignedInAIRouteError } from '#lib/server/ai-route-errors.ts';
import { withChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import type { RequestHandler } from './$types';
import { AIRequestError, runAIRequest } from '#lib/server/ai.ts';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';

const MAX_REQUEST_BYTES = 9_000_000;

export const POST: RequestHandler = async (event) => {
	let user: NonNullable<typeof event.locals.user> | null = null;
	let usingHostAI = false;
	let hostTarget: { userId: string; accountId: string } | null = null;
	let personalAccountId = '';
	let isChatGPTProvider = false;
	try {
		assertSameOrigin(event.request);
		user = event.locals.user;
		if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
		const currentUser = user;
		consumeRateLimit(`ai-user:${currentUser.id}`, 30, 60 * 60 * 1000);

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

		const isSearch = Boolean(
			body && typeof body === 'object' && 'action' in body && body.action === 'search'
		);
		const host = getHostAI();
		if (host && body && typeof body === 'object' && !isSearch) {
			usingHostAI = true;
			hostTarget = { userId: host.userId, accountId: host.accountId };
			body = { ...body, provider: 'chatgpt', model: host.model, connectionId: host.accountId };
		}

		isChatGPTProvider = Boolean(
			body &&
			typeof body === 'object' &&
			'provider' in body &&
			body.provider === 'chatgpt' &&
			!isSearch
		);

		if (isChatGPTProvider && body && typeof body === 'object') {
			const accountId =
				'connectionId' in body && typeof body.connectionId === 'string' ? body.connectionId : '';
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			if (!usingHostAI && accountId === HOST_CONNECTION_ID) {
				usingHostAI = true;
				return hostUnavailableResponse();
			}
			if (!usingHostAI) personalAccountId = accountId;
			const result = await withChatGPTConnection(
				host?.userId ?? currentUser.id,
				accountId,
				event.fetch,
				(resolved) =>
					runAIRequest(
						body,
						resolved.fetcher,
						undefined,
						{ accessToken: resolved.accessToken, codex: resolved.codex },
						event.request.signal
					)
			);
			return Response.json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return Response.json(
			await runAIRequest(body, event.fetch, undefined, undefined, event.request.signal),
			{
				headers: { 'cache-control': 'no-store' }
			}
		);
	} catch (error) {
		return mapSignedInAIRouteError(error, {
			userId: user?.id ?? '',
			usingHostAI,
			hostTarget,
			personalAccountId,
			isChatGPTProvider,
			fallbackMessage: 'The AI request could not be completed.'
		});
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
