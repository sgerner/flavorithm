import { getHostAIFor, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { mapSignedInAIRouteError, sessionExpiredResponse } from '#lib/server/ai-route-errors.ts';
import { ChatGPTOAuthError, withChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { getChatGPTAccount } from '#lib/server/oauth-storage.ts';
import type { RequestHandler } from './$types';
import { AIRequestError, parseAIRequest, runAIRequest, validateAIRequest } from '#lib/server/ai.ts';
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

		let parsed = parseAIRequest(body, event.request.signal);
		const record = body as Record<string, unknown>;
		const isSearch = parsed.action === 'search';
		const host = isSearch ? null : getHostAIFor(currentUser.id);

		if (!isSearch) {
			const explicitPersonal = parsed.usePersonalAI === true;
			const explicitHost =
				parsed.usePersonalAI === false || parsed.connectionId === HOST_CONNECTION_ID;
			const hasPersonalApiKey =
				typeof parsed.provider === 'string' &&
				parsed.provider !== 'chatgpt' &&
				typeof parsed.apiKey === 'string' &&
				parsed.apiKey.trim().length > 0;
			const hasPersonalChatGPT =
				parsed.provider === 'chatgpt' &&
				typeof parsed.connectionId === 'string' &&
				parsed.connectionId.trim().length > 0 &&
				parsed.connectionId !== HOST_CONNECTION_ID;
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
				parsed = parseAIRequest(body, event.request.signal);
				usingHostAI = true;
				hostTarget = { userId: host.userId, accountId: host.accountId };
			} else if (!host && explicitHost) {
				throw new ApiError(400, 'Host AI is not enabled. Connect a personal model in Settings.');
			}
		}

		let quotaConsumed = false;
		const consumeQuotaOnce = () => {
			if (quotaConsumed) return;
			quotaConsumed = true;
			consumeRateLimit(`ai-user:${currentUser.id}`, 30, 60 * 60 * 1000);
		};

		isChatGPTProvider = parsed.provider === 'chatgpt' && !isSearch;

		if (isChatGPTProvider) {
			const accountId = parsed.connectionId?.trim() ?? '';
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
			const targetUserId = usingHostAI && host ? host.userId : currentUser.id;
			const targetAccountId = usingHostAI && host ? host.accountId : accountId;
			if (!getChatGPTAccount(targetUserId, targetAccountId)) {
				throw new ChatGPTOAuthError(
					404,
					'ChatGPT account was not found.',
					'chatgpt_account_not_found'
				);
			}
			validateAIRequest(body, {
				signal: event.request.signal,
				requireRouteConnectionId: true
			});
			consumeQuotaOnce();
			const result = await withChatGPTConnection(
				targetUserId,
				targetAccountId,
				event.fetch,
				(resolved) =>
					runAIRequest(
						body,
						resolved.fetcher,
						undefined,
						{ accessToken: resolved.accessToken, codex: resolved.codex },
						event.request.signal,
						consumeQuotaOnce
					),
				{ sharedHost: usingHostAI }
			);
			return Response.json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}

		validateAIRequest(body, {
			signal: event.request.signal,
			requireRouteConnectionId: true
		});
		return Response.json(
			await runAIRequest(
				body,
				event.fetch,
				undefined,
				undefined,
				event.request.signal,
				consumeQuotaOnce
			),
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
