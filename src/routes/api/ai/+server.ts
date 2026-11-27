import { getHostAIFor, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { mapSignedInAIRouteError, sessionExpiredResponse } from '#lib/server/ai-route-errors.ts';
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
		if (!user) return sessionExpiredResponse();
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

		const isObjectBody = Boolean(body && typeof body === 'object' && !Array.isArray(body));
		const record = isObjectBody ? (body as Record<string, unknown>) : null;
		const isSearch = record?.action === 'search';
		const host = isSearch ? null : getHostAIFor(currentUser.id);

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
				usingHostAI = true;
				hostTarget = { userId: host.userId, accountId: host.accountId };
			} else if (!host && explicitHost) {
				throw new ApiError(400, 'Host AI is not enabled. Connect a personal model in Settings.');
			}
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
				throw new ApiError(
					400,
					host
						? 'Select a personal ChatGPT account or another provider.'
						: 'Host AI is not enabled. Connect a personal model in Settings.'
				);
			}
			if (!usingHostAI) personalAccountId = accountId;
			const result = await withChatGPTConnection(
				usingHostAI && host ? host.userId : currentUser.id,
				usingHostAI && host ? host.accountId : accountId,
				event.fetch,
				(resolved) =>
					runAIRequest(
						body,
						resolved.fetcher,
						undefined,
						{ accessToken: resolved.accessToken, codex: resolved.codex },
						event.request.signal
					),
				{ sharedHost: usingHostAI }
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
