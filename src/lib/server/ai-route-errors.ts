import { AIRequestError } from '#lib/server/ai.ts';
import { ChatGPTInferenceError } from '#lib/server/chatgpt-inference.ts';
import {
	ChatGPTOAuthError,
	clearTerminalChatGPTCredentials,
	clearUnusableChatGPTCredentials,
	isTerminalChatGPTRefreshCode
} from '#lib/server/chatgpt-oauth.ts';
import { ApiError } from '#lib/server/db.ts';

export const HOST_UNAVAILABLE_MESSAGE =
	'Host AI is currently unavailable. Choose another connection in Settings or contact the host administrator.';

const HOST_UNRECOVERABLE_CODES = new Set([
	'chatgpt_account_reauth_required',
	'chatgpt_plan_scope_missing',
	'chatgpt_account_not_found',
	'chatgpt_account_mode_mismatch',
	'subscription_sharing_invalid_user',
	'chatpass_v2_scope_not_authorized',
	'chatpass_v2_invalid_authorization_context'
]);

export function sessionExpiredResponse(): Response {
	return Response.json(
		{ error: 'Authentication required', code: 'session_expired' },
		{ status: 401 }
	);
}

export function hostUnavailableResponse(): Response {
	return Response.json(
		{ error: HOST_UNAVAILABLE_MESSAGE, code: 'host_ai_unavailable' },
		{ status: 503, headers: { 'cache-control': 'no-store' } }
	);
}

/**
 * Unified signed-in provider-error contract (401 / 409 / 503) shared across `/api/ai` and `/api/models`:
 * - Reserves HTTP 401 (`code: 'session_expired'`) strictly for unauthenticated Flavorithm sessions.
 * - Maps shared Host AI credential/grant failures to HTTP 503 (`host_ai_unavailable`), clearing
 *   host credentials only on a terminal OAuth refresh code via a lease-taking helper.
 * - Maps personal ChatGPT OAuth/Codex credential rejections to HTTP 409 (`chatgpt_reauth_required`).
 * - Maps non-ChatGPT API-key 401 rejections to HTTP 409 (`provider_auth` or preserved `.code`)
 *   so signed-in requests never trigger client session-expiry handling.
 * - Preserves `.code` and `429` `Retry-After` headers across all other route errors.
 */
export function mapSignedInAIRouteError(
	error: unknown,
	context: {
		userId: string;
		usingHostAI?: boolean;
		hostTarget?: { userId: string; accountId: string } | null;
		personalAccountId?: string;
		isChatGPTProvider?: boolean;
		fallbackMessage: string;
	}
): Response {
	if (
		error instanceof ChatGPTOAuthError ||
		error instanceof ChatGPTInferenceError ||
		error instanceof AIRequestError ||
		error instanceof ApiError
	) {
		const code =
			'code' in error && typeof error.code === 'string' && error.code ? error.code : undefined;
		const retryAfter =
			'retryAfter' in error &&
			typeof error.retryAfter === 'number' &&
			Number.isFinite(error.retryAfter)
				? error.retryAfter
				: undefined;
		if (
			context.usingHostAI &&
			(error.status === 401 || (code !== undefined && HOST_UNRECOVERABLE_CODES.has(code)))
		) {
			const terminalRefreshCode =
				error instanceof ChatGPTOAuthError ? error.providerErrorCode : undefined;
			if (context.hostTarget && isTerminalChatGPTRefreshCode(terminalRefreshCode)) {
				clearTerminalChatGPTCredentials(
					context.hostTarget.userId,
					context.hostTarget.accountId,
					terminalRefreshCode,
					error instanceof ChatGPTOAuthError ? error.credentialEnvelope : undefined
				);
			}
			return hostUnavailableResponse();
		}
		if (error.status === 401 || code === 'subscription_sharing_invalid_user') {
			const isChatGPTError =
				Boolean(context.isChatGPTProvider) ||
				Boolean(context.personalAccountId) ||
				error instanceof ChatGPTOAuthError ||
				error instanceof ChatGPTInferenceError ||
				code === 'subscription_sharing_invalid_user';
			if (context.personalAccountId && code === 'subscription_sharing_invalid_user') {
				const rejectedAccessToken =
					'rejectedAccessToken' in error && typeof error.rejectedAccessToken === 'string'
						? error.rejectedAccessToken
						: undefined;
				clearUnusableChatGPTCredentials(
					context.userId,
					context.personalAccountId,
					rejectedAccessToken
				);
			}
			return Response.json(
				{
					error: error.message,
					code: isChatGPTError ? 'chatgpt_reauth_required' : (code ?? 'provider_auth')
				},
				{ status: 409, headers: { 'cache-control': 'no-store' } }
			);
		}
		const headers =
			error.status === 429 && retryAfter !== undefined
				? { 'Retry-After': String(Math.max(1, Math.ceil(retryAfter))) }
				: undefined;
		return Response.json(
			{ error: error.message, ...(code ? { code } : {}) },
			{ status: error.status, ...(headers ? { headers } : {}) }
		);
	}
	return Response.json({ error: context.fallbackMessage }, { status: 500 });
}
