import { createHash, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from 'jose';
import { ApiError } from '#lib/server/db.ts';
import { getChatGPTAccount, isSessionBindingActive, saveChatGPTAccount } from './oauth-storage.ts';

// Codex's public device client, as used by the upstream Codex CLI and OSS clients.
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_SCOPE = 'codex.subscription';
const AUTH = 'https://auth.openai.com';
const TTL = 15 * 60_000;
type Attempt = {
	userId: string;
	session: string;
	origin: string;
	accountId?: string;
	deviceId: string;
	userCode: string;
	expiresAt: number;
	interval: number;
	nextPoll: number;
	busy: boolean;
	result?: { connected: true; accountId: string; planEnabled: true };
};
const attempts = new Map<string, Attempt>();
function fail(status: number, message: string): never {
	throw new ApiError(status, message);
}
async function providerJson(url: string, body: object | URLSearchParams, fetcher: typeof fetch) {
	let response: Response;
	try {
		response = await fetcher(url, {
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(12_000),
			headers: {
				'Content-Type':
					body instanceof URLSearchParams
						? 'application/x-www-form-urlencoded'
						: 'application/json',
				Accept: 'application/json',
				'User-Agent': 'Flavorithm/1.0'
			},
			body: body instanceof URLSearchParams ? body : JSON.stringify(body)
		});
	} catch {
		return fail(502, 'Could not reach ChatGPT authorization. Try again.');
	}
	// No provider error body or credentials enter errors/logs.
	let raw = '';
	if (!response.body) fail(502, 'ChatGPT returned an empty authorization response.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > 100_000) {
				await reader.cancel();
				fail(502, 'ChatGPT returned an oversized authorization response.');
			}
			raw += decoder.decode(part.value, { stream: true });
		}
		raw += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	if (raw.length > 100_000)
		return fail(502, 'ChatGPT returned an oversized authorization response.');
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		data = {};
	}
	return { response, data };
}
function live(userId: string, session: string) {
	if (!isSessionBindingActive(userId, session))
		fail(401, 'Your Flavorithm session expired. Sign in again.');
}
export function codexTokenExpiry(token: string, expiresIn?: unknown): number {
	let exp = 0;
	try {
		exp = Number(decodeJwt(token).exp) * 1000;
	} catch {
		/* Opaque tokens may supply expires_in. */
	}
	const seconds = Number(expiresIn);
	const fallback =
		Number.isFinite(seconds) && seconds > 0 ? Date.now() + Math.min(seconds, 31 * 86400) * 1000 : 0;
	const expires = exp > 0 && fallback > 0 ? Math.min(exp, fallback) : exp || fallback;
	if (!Number.isFinite(expires) || expires <= Date.now())
		fail(502, 'ChatGPT returned an invalid token expiry.');
	return Math.min(expires, Date.now() + 31 * 86400_000);
}
export async function startCodexDevice(
	input: { userId: string; sessionBinding: string; appUrl: URL; accountId?: string },
	fetcher: typeof fetch = fetch
) {
	live(input.userId, input.sessionBinding);
	if (
		input.appUrl.protocol !== 'https:' &&
		!['localhost', '127.0.0.1', '[::1]'].includes(input.appUrl.hostname)
	)
		fail(403, 'Use HTTPS to connect ChatGPT.');
	const selected = input.accountId ? getChatGPTAccount(input.userId, input.accountId) : null;
	if (input.accountId && !selected) fail(404, 'ChatGPT account not found.');
	const { response, data } = await providerJson(
		`${AUTH}/api/accounts/deviceauth/usercode`,
		{ client_id: CODEX_CLIENT_ID },
		fetcher
	);
	if (!response.ok)
		fail(
			response.status === 429 ? 429 : 502,
			'ChatGPT device login is unavailable. Enable device-code login in ChatGPT security settings and try again.'
		);
	const code = data.user_code ?? data.usercode;
	if (
		typeof data.device_auth_id !== 'string' ||
		!data.device_auth_id ||
		data.device_auth_id.length > 4096 ||
		typeof code !== 'string' ||
		!code ||
		code.length > 100
	)
		fail(502, 'ChatGPT returned an invalid device code.');
	// Replace earlier attempts only after successfully obtaining a new code.
	for (const [id, a] of attempts)
		if (a.userId === input.userId || a.expiresAt <= Date.now()) attempts.delete(id);
	const loginId = randomUUID();
	const interval = Math.max(5, Number(data.interval) || 5);
	if (!Number.isFinite(interval) || interval > 900)
		fail(502, 'ChatGPT returned an invalid polling interval.');
	const expiresAt = Date.now() + TTL;
	attempts.set(loginId, {
		userId: input.userId,
		session: input.sessionBinding,
		origin: input.appUrl.origin,
		...(selected?.clientId === CODEX_CLIENT_ID ? { accountId: selected.id } : {}),
		deviceId: data.device_auth_id,
		userCode: code,
		expiresAt,
		interval,
		nextPoll: Date.now() + interval * 1000,
		busy: false
	});
	return {
		kind: 'device' as const,
		loginId,
		userCode: code,
		verificationUrl: `${AUTH}/codex/device`,
		expiresAt,
		interval
	};
}
function owned(input: { userId: string; sessionBinding: string; appUrl: URL; loginId: string }) {
	live(input.userId, input.sessionBinding);
	const a = attempts.get(input.loginId);
	if (
		!a ||
		a.userId !== input.userId ||
		a.session !== input.sessionBinding ||
		a.origin !== input.appUrl.origin
	)
		fail(404, 'This ChatGPT connection attempt is unavailable. Start again.');
	if (a.expiresAt <= Date.now()) {
		attempts.delete(input.loginId);
		fail(410, 'ChatGPT authorization expired. Start again.');
	}
	return a;
}
export function cancelCodexDevice(input: {
	userId: string;
	sessionBinding: string;
	appUrl: URL;
	loginId: string;
}) {
	owned(input);
	attempts.delete(input.loginId);
	return { cancelled: true };
}
export async function pollCodexDevice(
	input: { userId: string; sessionBinding: string; appUrl: URL; loginId: string },
	fetcher: typeof fetch = fetch
) {
	const a = owned(input);
	if (a.result) return a.result;
	if (a.busy || Date.now() < a.nextPoll) return { pending: true };
	a.busy = true;
	a.nextPoll = Date.now() + a.interval * 1000;
	try {
		const { response, data } = await providerJson(
			`${AUTH}/api/accounts/deviceauth/token`,
			{ device_auth_id: a.deviceId, user_code: a.userCode },
			fetcher
		);
		if (response.status === 403 || response.status === 404) return { pending: true };
		if (response.status === 429) {
			a.nextPoll = Date.now() + Math.max(a.interval, 10) * 1000;
			return { pending: true };
		}
		if (!response.ok) {
			attempts.delete(input.loginId);
			fail(502, 'ChatGPT authorization failed. Start again.');
		}
		if (
			typeof data.authorization_code !== 'string' ||
			typeof data.code_verifier !== 'string' ||
			typeof data.code_challenge !== 'string' ||
			createHash('sha256').update(data.code_verifier).digest('base64url') !== data.code_challenge
		)
			fail(502, 'ChatGPT returned an invalid authorization exchange.');
		// Consume the provider code once. A failed exchange requires a fresh login.
		a.nextPoll = a.expiresAt;
		const token = await providerJson(
			CODEX_TOKEN_URL,
			new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: CODEX_CLIENT_ID,
				code: data.authorization_code,
				code_verifier: data.code_verifier,
				redirect_uri: `${AUTH}/deviceauth/callback`
			}),
			fetcher
		);
		if (!token.response.ok) fail(502, 'ChatGPT token exchange failed. Start again.');
		const t = token.data;
		if (
			typeof t.access_token !== 'string' ||
			!t.access_token ||
			typeof t.id_token !== 'string' ||
			!t.id_token ||
			typeof t.refresh_token !== 'string' ||
			!t.refresh_token
		)
			fail(502, 'ChatGPT returned incomplete credentials.');
		let identity;
		try {
			const keys = createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`), {
				[customFetch]: fetcher
			});
			identity = (
				await jwtVerify(t.id_token, keys, {
					issuer: AUTH,
					audience: CODEX_CLIENT_ID,
					algorithms: ['RS256', 'ES256'],
					requiredClaims: ['sub', 'exp', 'iat'],
					clockTolerance: 5
				})
			).payload;
		} catch {
			fail(502, 'ChatGPT identity could not be verified. Start again.');
		}
		const claims = identity['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
		const account = claims?.chatgpt_account_id;
		if (
			typeof identity.sub !== 'string' ||
			!identity.sub ||
			typeof account !== 'string' ||
			!account ||
			account.length > 512
		)
			fail(502, 'ChatGPT did not identify a Codex account.');
		const expiresAt = codexTokenExpiry(t.access_token, t.expires_in);
		// Recheck binding after every asynchronous provider operation and before saving.
		owned(input);
		if (a.accountId) {
			const selected = getChatGPTAccount(a.userId, a.accountId);
			if (!selected || selected.subject !== `${identity.sub}:${account}`)
				fail(
					409,
					'You authorized a different ChatGPT account. Use Add account to connect it separately.'
				);
		}
		const saved = saveChatGPTAccount({
			userId: a.userId,
			accountId: a.accountId,
			mode: 'local',
			clientId: CODEX_CLIENT_ID,
			subject: `${identity.sub}:${account}`,
			email: typeof identity.email === 'string' ? identity.email : null,
			scopes: [CODEX_SCOPE],
			credentials: {
				accessToken: t.access_token,
				refreshToken: t.refresh_token,
				idToken: t.id_token,
				codexAccountId: account
			},
			expiresAt,
			earliestRefreshAt: 0
		});
		a.result = { connected: true, accountId: saved.id, planEnabled: true };
		a.deviceId = '';
		a.userCode = '';
		return a.result;
	} catch (error) {
		// A consumed exchange or invalid identity must never be retried with the same code.
		attempts.delete(input.loginId);
		throw error;
	} finally {
		a.busy = false;
	}
}

/** Fixed Codex transport; only the two subscription API paths are remapped. */
export function codexSubscriptionFetch(
	accessToken: string,
	accountId: string,
	fetcher: typeof fetch
): typeof fetch {
	return (async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		let target: string;
		if (url === 'https://api.openai.com/v1/models')
			target = 'https://chatgpt.com/backend-api/codex/models?client_version=0.164.0';
		else if (url === 'https://api.openai.com/v1/responses')
			target = 'https://chatgpt.com/backend-api/codex/responses';
		else return fetcher(input, init);
		const headers = new Headers(init?.headers);
		headers.set('Authorization', `Bearer ${accessToken}`);
		headers.set('ChatGPT-Account-Id', accountId);
		headers.set('User-Agent', 'Flavorithm/1.0');
		headers.set('originator', 'flavorithm');
		return fetcher(target, { ...init, headers, redirect: 'error' });
	}) as typeof fetch;
}
