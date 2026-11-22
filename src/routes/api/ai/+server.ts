import { getHostAI, HOST_CONNECTION_ID } from '#lib/server/host-ai.ts';
import { ChatGPTOAuthError, withChatGPTConnection } from '#lib/server/chatgpt-oauth.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import { clearChatGPTCredentials } from '#lib/server/oauth-storage.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AIRequestError, runAIRequest } from '#lib/server/ai.ts';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';

const MAX_REQUEST_BYTES = 9_000_000;
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

export const POST: RequestHandler = async (event) => {
	let user: NonNullable<typeof event.locals.user> | null = null;
	let usingHostAI = false;
	let hostTarget: { userId: string; accountId: string } | null = null;
	let personalAccountId = '';
	try {
		assertSameOrigin(event.request);
		user = event.locals.user;
		if (!user) return json({ error: 'Unauthorized.' }, { status: 401 });
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

		if (
			body &&
			typeof body === 'object' &&
			'provider' in body &&
			body.provider === 'chatgpt' &&
			!isSearch
		) {
			const accountId =
				'connectionId' in body && typeof body.connectionId === 'string' ? body.connectionId : '';
			if (!accountId) throw new ApiError(400, 'Select a connected ChatGPT account.');
			if (!usingHostAI && accountId === HOST_CONNECTION_ID) {
				usingHostAI = true;
				return json(
					{ error: HOST_UNAVAILABLE_MESSAGE, code: 'host_ai_unavailable' },
					{ status: 503, headers: { 'cache-control': 'no-store' } }
				);
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
			return json(result, {
				headers: { 'cache-control': 'no-store' }
			});
		}
		return json(await runAIRequest(body, event.fetch, undefined, undefined, event.request.signal), {
			headers: { 'cache-control': 'no-store' }
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
				return json(
					{ error: HOST_UNAVAILABLE_MESSAGE, code: 'host_ai_unavailable' },
					{ status: 503, headers: { 'cache-control': 'no-store' } }
				);
			}
			if (error.status === 401 || code === 'subscription_sharing_invalid_user') {
				if (user && personalAccountId && code === 'subscription_sharing_invalid_user') {
					clearChatGPTCredentials(user.id, personalAccountId);
				}
				return json(
					{ error: error.message, code: 'chatgpt_reauth_required' },
					{ status: 422, headers: { 'cache-control': 'no-store' } }
				);
			}
			return json({ error: error.message, ...(code ? { code } : {}) }, { status: error.status });
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
