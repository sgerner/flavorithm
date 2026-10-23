import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { ApiError, consumeRateLimit } from '#lib/server/db.ts';
import {
	claimChatGPTRefreshLease,
	clearChatGPTCredentials,
	consumeHostedOAuthTransaction,
	decryptChatGPTCredentials,
	ensureChatGPTHostId,
	getChatGPTAccount,
	isSessionBindingActive,
	listStoredChatGPTAccounts,
	persistRefreshedChatGPTCredentials,
	releaseChatGPTRefreshLease,
	saveChatGPTAccount,
	storeHostedOAuthTransaction,
	type ChatGPTAccount,
	type ChatGPTCredentials,
	type OAuthMode
} from '#lib/server/oauth-storage.ts';

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_AUTHORIZE_URL = `${OPENAI_ISSUER}/api/accounts/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const OPENAI_DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const REQUESTED_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
	'resource.invoke',
	'chatgpt.tokens.use.direct'
];

const INITIAL_CLIENT_ID = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
const HOSTED_CALLBACK_PATH = '/api/connections/chatgpt/callback';
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 30_000;
const ACCESS_TOKEN_EARLY_REFRESH_MS = 90_000;

export class ChatGPTOAuthError extends ApiError {
	readonly code: string;

	constructor(status: number, message: string, code = 'chatgpt_oauth_error') {
		super(status, message);
		this.name = 'ChatGPTOAuthError';
		this.code = code;
	}
}

export type OAuthAvailability = {
	mode: 'local' | 'hosted' | 'unavailable';
	safeReason?: string;
};

export type PublicChatGPTAccount = {
	id: string;
	label: string;
	email?: string;
	subject?: string;
	planEnabled: boolean;
	connected: boolean;
	updatedAt: number;
};

type HostedClient = {
	clientId: string;
	clientSecret: string | null;
	clientAuthMethod: 'none' | 'client_secret_basic';
	redirectUri: string;
};

type PendingTransaction = {
	stateHash: string;
	verifier: string;
	nonce: string;
	userId: string;
	sessionBinding: string;
	accountId?: string;
	mode: OAuthMode;
	redirectUri: string;
	clientId: string;
	newRegistration: boolean;
	appOrigin: string;
	createdAt: number;
};

type LocalPendingTransaction = PendingTransaction & { cleanup: () => void };

// Native PKCE values are held only by the short-lived loopback listener. Hosted values are
// encrypted in SQLite so callbacks can land on another process or survive a restart.
const pendingTransactions = new Map<string, LocalPendingTransaction>();
const refreshPromises = new Map<string, Promise<string>>();
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function randomValue(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function sha256Base64Url(value: string): string {
	return sha256(value).toString('base64url');
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return normalized === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLoopbackAddress(address: string): boolean {
	const normalized = address
		.toLowerCase()
		.replace(/^::ffff:/, '')
		.replace(/^\[|\]$/g, '');
	return (
		normalized === '::1' || normalized === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

function isLoopbackOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
	} catch {
		return false;
	}
}

function decodeHostedEncryptionKey(): boolean {
	const raw = process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY?.trim();
	if (!raw) return false;
	const value = Buffer.from(raw, 'base64');
	return value.length === 32 && value.toString('base64') === raw;
}

function hostedClientConfig(): HostedClient | null {
	const clientId = process.env.OPENAI_OAUTH_CLIENT_ID?.trim();
	const redirectUri = process.env.OPENAI_OAUTH_REDIRECT_URI?.trim();
	const clientSecret = process.env.OPENAI_OAUTH_CLIENT_SECRET?.trim() || null;
	const configuredMethod = process.env.OPENAI_OAUTH_CLIENT_AUTH_METHOD?.trim();
	if (!clientId || !redirectUri || !decodeHostedEncryptionKey()) return null;

	let redirect: URL;
	try {
		redirect = new URL(redirectUri);
	} catch {
		return null;
	}
	if (
		redirect.pathname !== HOSTED_CALLBACK_PATH ||
		redirect.search ||
		redirect.hash ||
		redirect.username ||
		redirect.password ||
		redirect.protocol !== 'https:'
	) {
		return null;
	}

	let clientAuthMethod: HostedClient['clientAuthMethod'];
	if (!clientSecret) {
		if (configuredMethod && configuredMethod !== 'none') return null;
		clientAuthMethod = 'none';
	} else {
		if (configuredMethod && configuredMethod !== 'client_secret_basic') {
			return null;
		}
		clientAuthMethod =
			(configuredMethod as HostedClient['clientAuthMethod'] | undefined) ?? 'client_secret_basic';
	}
	return { clientId, clientSecret, clientAuthMethod, redirectUri: redirect.toString() };
}

export function getChatGPTOAuthAvailability(input: {
	url: URL;
	clientAddress: string | null;
}): OAuthAvailability {
	const configuredOrigin = process.env.ORIGIN?.trim();
	const localRequest =
		input.url.protocol === 'http:' &&
		isLoopbackHostname(input.url.hostname) &&
		!!input.clientAddress &&
		isLoopbackAddress(input.clientAddress) &&
		(!configuredOrigin || isLoopbackOrigin(configuredOrigin));
	if (localRequest) return { mode: 'local' };
	const hosted = hostedClientConfig();
	if (hosted && new URL(hosted.redirectUri).origin === input.url.origin) return { mode: 'hosted' };
	return {
		mode: 'unavailable',
		safeReason:
			'ChatGPT plan connections are available on localhost or when hosted OAuth is configured.'
	};
}

export function listChatGPTAccounts(userId: string): PublicChatGPTAccount[] {
	return listStoredChatGPTAccounts(userId).map((account) => ({
		id: account.id,
		label: account.label,
		...(account.email ? { email: account.email } : {}),
		subject: account.subject,
		planEnabled: account.scopes.includes('chatgpt.tokens.use.direct'),
		connected: Boolean(account.credentialEnvelope),
		updatedAt: account.updatedAt
	}));
}

function hostedAuthHeadersAndBody(
	mode: OAuthMode,
	clientId: string,
	body: URLSearchParams
): { headers: Headers; body: URLSearchParams } {
	const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
	if (mode === 'local') {
		body.set('client_id', clientId);
		return { headers, body };
	}
	const config = hostedClientConfig();
	if (!config || config.clientId !== clientId) {
		throw new ChatGPTOAuthError(
			503,
			'Hosted ChatGPT OAuth is not configured.',
			'chatgpt_oauth_unavailable'
		);
	}
	if (config.clientAuthMethod === 'client_secret_basic' && config.clientSecret) {
		const encodeFormComponent = (value: string) =>
			new URLSearchParams({ value }).toString().slice('value='.length);
		const encoded = Buffer.from(
			`${encodeFormComponent(config.clientId)}:${encodeFormComponent(config.clientSecret)}`
		).toString('base64');
		headers.set('Authorization', `Basic ${encoded}`);
		body.set('client_id', config.clientId);
	} else {
		body.set('client_id', config.clientId);
	}
	return { headers, body };
}

function validateAccountForReauthorization(
	userId: string,
	accountId: string | undefined,
	mode: OAuthMode
): { account?: ChatGPTAccount; clientId: string; newRegistration: boolean; idTokenHint?: string } {
	if (!accountId) {
		if (mode === 'local') return { clientId: INITIAL_CLIENT_ID, newRegistration: true };
		const hosted = hostedClientConfig();
		if (!hosted)
			throw new ChatGPTOAuthError(
				503,
				'Hosted ChatGPT OAuth is not configured.',
				'chatgpt_oauth_unavailable'
			);
		return { clientId: hosted.clientId, newRegistration: false };
	}
	const account = getChatGPTAccount(userId, accountId);
	if (!account)
		throw new ChatGPTOAuthError(404, 'ChatGPT account was not found.', 'chatgpt_account_not_found');
	if (account.mode !== mode) {
		throw new ChatGPTOAuthError(
			409,
			'This ChatGPT account was connected in another OAuth mode.',
			'chatgpt_account_mode_mismatch'
		);
	}
	let idTokenHint: string | undefined;
	if (account.credentialEnvelope) {
		try {
			idTokenHint = decryptChatGPTCredentials(
				userId,
				account.id,
				account.mode,
				account.credentialEnvelope
			).idToken;
		} catch {
			// Reauthorization can proceed without a retained ID-token hint.
		}
	}
	return { account, clientId: account.clientId, newRegistration: false, idTokenHint };
}

function installPendingTransaction(pending: PendingTransaction): {
	pending: LocalPendingTransaction;
	server?: ReturnType<typeof createServer>;
} {
	let listener: ReturnType<typeof createServer> | undefined;
	let timeout: NodeJS.Timeout | undefined;
	const entry: LocalPendingTransaction = {
		...pending,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			pendingTransactions.delete(entry.stateHash);
			if (listener?.listening) listener.close();
		}
	};
	pendingTransactions.set(entry.stateHash, entry);
	timeout = setTimeout(() => entry.cleanup(), TRANSACTION_TTL_MS);
	timeout.unref();
	if (entry.mode !== 'local') return { pending: entry };

	listener = createServer((request, response) => {
		const configuration = serverCallbackConfiguration(listener!);
		if (!configuration) {
			void sendNodeHtml(
				response,
				htmlResponse('This callback request could not be accepted.', undefined, false, 503)
			);
			return;
		}
		void onLoopbackCallback(request, response, entry, configuration.host, configuration.uri);
	});
	listener.requestTimeout = 15_000;
	listener.headersTimeout = 10_000;
	listener.maxHeadersCount = 32;
	listener.unref();
	return { pending: entry, server: listener };
}

function listenLoopback(server: ReturnType<typeof createServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			const address = server.address();
			if (!address || typeof address === 'string') {
				reject(new Error('Loopback listener did not receive a TCP port.'));
				return;
			}
			resolve(address.port);
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, '127.0.0.1');
	});
}

export async function startChatGPTOAuth(input: {
	userId: string;
	sessionBinding: string;
	appUrl: URL;
	mode: OAuthMode;
	accountId?: string;
	reconsent?: boolean;
}): Promise<{ authorizationUrl: string }> {
	if (!isSessionBindingActive(input.userId, input.sessionBinding)) {
		throw new ChatGPTOAuthError(
			401,
			'Your Flavorithm session has expired.',
			'chatgpt_session_expired'
		);
	}
	if (input.mode === 'hosted' && !hostedClientConfig()) {
		throw new ChatGPTOAuthError(
			503,
			'Hosted ChatGPT OAuth is not configured.',
			'chatgpt_oauth_unavailable'
		);
	}
	let clientData: ReturnType<typeof validateAccountForReauthorization>;
	try {
		clientData = validateAccountForReauthorization(input.userId, input.accountId, input.mode);
	} catch (error) {
		if (error instanceof ChatGPTOAuthError) throw error;
		throw new ChatGPTOAuthError(
			409,
			'The saved ChatGPT connection could not be opened.',
			'chatgpt_account_unavailable'
		);
	}
	const state = randomValue();
	const nonce = randomValue();
	const verifier = randomValue(48);
	const challenge = sha256Base64Url(verifier);
	let redirectUri: string;
	let appOrigin = input.appUrl.origin;
	if (input.mode === 'local') {
		if (!isLoopbackOrigin(appOrigin)) {
			throw new ChatGPTOAuthError(
				403,
				'ChatGPT connections require a local Flavorithm session.',
				'chatgpt_local_only'
			);
		}
		redirectUri = '';
	} else {
		redirectUri = hostedClientConfig()!.redirectUri;
		appOrigin = new URL(redirectUri).origin;
	}

	const pendingBase: PendingTransaction = {
		stateHash: sha256Base64Url(state),
		verifier,
		nonce,
		userId: input.userId,
		sessionBinding: input.sessionBinding,
		...(input.accountId ? { accountId: input.accountId } : {}),
		mode: input.mode,
		redirectUri,
		clientId: clientData.clientId,
		newRegistration: clientData.newRegistration,
		appOrigin,
		createdAt: Date.now()
	};
	let pending: PendingTransaction;
	let server: ReturnType<typeof createServer> | undefined;
	let localPending: LocalPendingTransaction | undefined;
	if (input.mode === 'local') {
		const installed = installPendingTransaction(pendingBase);
		localPending = installed.pending;
		pending = localPending;
		server = installed.server;
	} else {
		pending = pendingBase;
		try {
			storeHostedOAuthTransaction({
				stateHash: pending.stateHash,
				userId: pending.userId,
				createdAt: pending.createdAt,
				expiresAt: pending.createdAt + TRANSACTION_TTL_MS,
				payload: JSON.stringify(pending)
			});
		} catch {
			throw new ChatGPTOAuthError(
				503,
				'Hosted ChatGPT authorization could not be started securely.',
				'chatgpt_transaction_unavailable'
			);
		}
	}

	if (input.mode === 'local') {
		try {
			const port = await listenLoopback(server!);
			pending.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
			const nodeServer = server!;
			const expectedHost = `127.0.0.1:${port}`;
			setLoopbackCallbackConfiguration(nodeServer, expectedHost, pending.redirectUri);
		} catch {
			localPending?.cleanup();
			throw new ChatGPTOAuthError(
				503,
				'The local ChatGPT callback listener could not start.',
				'chatgpt_callback_unavailable'
			);
		}
	}

	const authorizationClientId = pending.clientId;
	const authorizationUrl = new URL(OPENAI_AUTHORIZE_URL);
	authorizationUrl.searchParams.set('client_id', authorizationClientId);
	authorizationUrl.searchParams.set('response_type', 'code');
	authorizationUrl.searchParams.set('redirect_uri', pending.redirectUri);
	authorizationUrl.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
	authorizationUrl.searchParams.set('resource', OPENAI_RESOURCE);
	authorizationUrl.searchParams.set('state', state);
	authorizationUrl.searchParams.set('nonce', nonce);
	authorizationUrl.searchParams.set('code_challenge_method', 'S256');
	authorizationUrl.searchParams.set('code_challenge', challenge);
	if (pending.mode === 'local') {
		authorizationUrl.searchParams.set('ext_agent_host_id', ensureChatGPTHostId());
	}
	if (pending.newRegistration && pending.mode === 'local') {
		authorizationUrl.searchParams.set('agent_name_hint', 'Flavorithm');
	} else if (input.accountId && clientData.idTokenHint && pending.mode === 'local') {
		authorizationUrl.searchParams.set('id_token_hint', clientData.idTokenHint);
		if (clientData.account?.email)
			authorizationUrl.searchParams.set('login_hint', clientData.account.email);
	} else if (input.accountId && clientData.account?.email && pending.mode === 'local') {
		authorizationUrl.searchParams.set('login_hint', clientData.account.email);
	}
	if (input.reconsent) authorizationUrl.searchParams.set('prompt', 'consent');
	return { authorizationUrl: authorizationUrl.toString() };
}

function setLoopbackCallbackConfiguration(
	server: ReturnType<typeof createServer>,
	expectedHost: string,
	callbackUri: string
): void {
	const marker = server as typeof server & {
		flavorithmOAuthHost?: string;
		flavorithmOAuthUri?: string;
	};
	marker.flavorithmOAuthHost = expectedHost;
	marker.flavorithmOAuthUri = callbackUri;
}

function htmlResponse(
	message: string,
	appOrigin?: string,
	success = false,
	status = 200
): Response {
	const target = appOrigin
		? new URL(success ? '/?chatgpt=connected' : '/?chatgpt=return', appOrigin).toString()
		: undefined;
	const safeMessage = escapeHtml(message);
	const link = target ? `<p><a href="${escapeHtml(target)}">Return to Flavorithm</a></p>` : '';
	const title = success ? 'ChatGPT connected' : 'ChatGPT connection';
	return new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><main><h1>${title}</h1><p>${safeMessage}</p>${link}</main></body></html>`,
		{
			status,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store, max-age=0',
				'Content-Security-Policy':
					"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
				'X-Content-Type-Options': 'nosniff',
				'Referrer-Policy': 'no-referrer'
			}
		}
	);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		const escapes: Record<string, string> = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#39;'
		};
		return escapes[char]!;
	});
}

function loopbackAddress(request: IncomingMessage): boolean {
	return Boolean(request.socket.remoteAddress && isLoopbackAddress(request.socket.remoteAddress));
}

function sendNodeHtml(response: ServerResponse, result: Response): Promise<void> {
	return new Promise(async (resolve) => {
		response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
		response.end(await result.text(), resolve);
	});
}

async function onLoopbackCallback(
	request: IncomingMessage,
	response: ServerResponse,
	pending: PendingTransaction,
	expectedHost: string,
	callbackUri: string
): Promise<void> {
	if ((request.url?.length ?? 0) > 8_192) {
		await sendNodeHtml(
			response,
			htmlResponse('This callback request could not be accepted.', undefined, false, 413)
		);
		return;
	}
	if (
		request.method !== 'GET' ||
		!loopbackAddress(request) ||
		request.headers.host !== expectedHost ||
		(request.headers.origin &&
			request.headers.origin !== pending.appOrigin &&
			request.headers.origin !== OPENAI_ISSUER)
	) {
		await sendNodeHtml(
			response,
			htmlResponse('This callback request could not be accepted.', undefined, false, 403)
		);
		return;
	}
	let url: URL;
	try {
		url = new URL(request.url ?? '/', callbackUri);
	} catch {
		await sendNodeHtml(
			response,
			htmlResponse('This callback request could not be accepted.', undefined, false, 400)
		);
		return;
	}
	if (url.origin !== new URL(callbackUri).origin || url.pathname !== CALLBACK_PATH) {
		await sendNodeHtml(
			response,
			htmlResponse('This callback request could not be accepted.', undefined, false, 404)
		);
		return;
	}
	const callbackResponse = await finishCallback(url, pending.stateHash, pending);
	await sendNodeHtml(response, callbackResponse);
}

async function exchangeAuthorizationCode(input: {
	mode: OAuthMode;
	clientId: string;
	code: string;
	verifier: string;
	redirectUri: string;
}): Promise<Record<string, unknown>> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		code_verifier: input.verifier,
		redirect_uri: input.redirectUri,
		resource: OPENAI_RESOURCE
	});
	const { headers, body: authenticatedBody } = hostedAuthHeadersAndBody(
		input.mode,
		input.clientId,
		body
	);
	let response: Response;
	try {
		response = await fetch(OPENAI_TOKEN_URL, {
			method: 'POST',
			headers,
			body: authenticatedBody,
			redirect: 'error',
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		throw new ChatGPTOAuthError(
			502,
			'ChatGPT authorization could not be completed. Please try again.',
			'chatgpt_token_exchange_failed'
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new ChatGPTOAuthError(
			502,
			'ChatGPT authorization could not be completed. Please try again.',
			'chatgpt_token_exchange_failed'
		);
	}
	return payload as Record<string, unknown>;
}

async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
	if (remoteJwks) return remoteJwks;
	let discovery: unknown;
	try {
		const response = await fetch(OPENAI_DISCOVERY_URL, {
			redirect: 'error',
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) throw new Error('discovery unavailable');
		discovery = await response.json();
	} catch {
		throw new ChatGPTOAuthError(
			503,
			'ChatGPT identity verification is temporarily unavailable.',
			'chatgpt_identity_unavailable'
		);
	}
	const jwksUri =
		discovery && typeof discovery === 'object' && 'jwks_uri' in discovery
			? (discovery as { jwks_uri?: unknown }).jwks_uri
			: null;
	if (typeof jwksUri !== 'string') {
		throw new ChatGPTOAuthError(
			503,
			'ChatGPT identity verification is temporarily unavailable.',
			'chatgpt_identity_unavailable'
		);
	}
	const issuer =
		discovery && typeof discovery === 'object' && 'issuer' in discovery
			? (discovery as { issuer?: unknown }).issuer
			: null;
	if (issuer !== OPENAI_ISSUER) {
		throw new ChatGPTOAuthError(
			503,
			'ChatGPT identity verification is temporarily unavailable.',
			'chatgpt_identity_unavailable'
		);
	}
	try {
		const url = new URL(jwksUri);
		if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com')
			throw new Error('invalid JWKS host');
		remoteJwks = createRemoteJWKSet(url, {
			[customFetch]: (jwksUrl, options) => fetch(jwksUrl, { ...options, redirect: 'error' })
		});
		return remoteJwks;
	} catch {
		throw new ChatGPTOAuthError(
			503,
			'ChatGPT identity verification is temporarily unavailable.',
			'chatgpt_identity_unavailable'
		);
	}
}

async function verifyIdentityToken(
	idToken: string,
	clientId: string,
	expectedNonce: string
): Promise<JWTPayload> {
	try {
		const { payload } = await jwtVerify(idToken, await getJwks(), {
			issuer: OPENAI_ISSUER,
			audience: clientId,
			requiredClaims: ['sub', 'exp', 'iat'],
			clockTolerance: 5
		});
		if (payload.nonce !== expectedNonce || typeof payload.sub !== 'string' || !payload.sub) {
			throw new Error('Identity token did not match the authorization transaction.');
		}
		return payload;
	} catch {
		throw new ChatGPTOAuthError(
			401,
			'ChatGPT identity could not be verified. Please start again.',
			'chatgpt_identity_invalid'
		);
	}
}

function scopesFrom(value: unknown): string[] {
	return typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}

function parseEarliestRefreshAt(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === 'string' && value) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function validateTokenResponse(value: Record<string, unknown>): {
	credentials: ChatGPTCredentials;
	expiresAt: number;
	earliestRefreshAt: number;
	scopes: string[];
} {
	if (
		typeof value.access_token !== 'string' ||
		typeof value.id_token !== 'string' ||
		!(typeof value.refresh_token === 'string' || value.refresh_token === undefined)
	) {
		throw new ChatGPTOAuthError(
			502,
			'ChatGPT did not return a usable connection.',
			'chatgpt_token_response_invalid'
		);
	}
	const expiresIn = Number(value.expires_in);
	if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
		throw new ChatGPTOAuthError(
			502,
			'ChatGPT did not return a usable connection.',
			'chatgpt_token_response_invalid'
		);
	}
	return {
		credentials: {
			accessToken: value.access_token,
			refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : null,
			idToken: value.id_token
		},
		expiresAt: Date.now() + expiresIn * 1000,
		earliestRefreshAt: parseEarliestRefreshAt(value.earliest_refresh_at),
		scopes: scopesFrom(value.scope)
	};
}

function takePending(
	stateHash: string,
	transaction: LocalPendingTransaction
): LocalPendingTransaction | null {
	const current = pendingTransactions.get(stateHash);
	if (!current || current !== transaction) return null;
	if (current.createdAt + TRANSACTION_TTL_MS <= Date.now()) {
		current.cleanup();
		return null;
	}
	pendingTransactions.delete(stateHash);
	current.cleanup();
	return current;
}

async function finishCallback(
	url: URL,
	stateHash: string,
	transaction?: PendingTransaction
): Promise<Response> {
	const state = url.searchParams.get('state');
	if (
		!state ||
		url.searchParams.getAll('state').length !== 1 ||
		sha256Base64Url(state) !== stateHash
	) {
		return htmlResponse('This ChatGPT connection could not be verified.', undefined, false, 400);
	}
	const pending = transaction
		? transaction.mode === 'local'
			? takePending(stateHash, transaction as LocalPendingTransaction)
			: transaction
		: null;
	if (!pending)
		return htmlResponse(
			'This ChatGPT connection has expired or was already used.',
			undefined,
			false,
			400
		);
	if (!isSessionBindingActive(pending.userId, pending.sessionBinding)) {
		return htmlResponse(
			'Your Flavorithm session expired. Return to the app and sign in again.',
			pending.appOrigin,
			false,
			401
		);
	}
	if (pending.mode === 'hosted') {
		const configured = hostedClientConfig();
		if (!configured || url.origin + url.pathname !== configured.redirectUri) {
			return htmlResponse(
				'This callback could not be matched to the hosted OAuth configuration.',
				pending.appOrigin,
				false,
				400
			);
		}
	}
	if (
		url.searchParams.getAll('code').length > 1 ||
		url.searchParams.getAll('client_id').length > 1
	) {
		return htmlResponse(
			'ChatGPT returned an invalid callback. Return to Flavorithm and start again.',
			pending.appOrigin,
			false,
			400
		);
	}
	const oauthError = url.searchParams.get('error');
	if (oauthError) {
		const message =
			oauthError === 'access_denied'
				? 'ChatGPT plan access was not approved. You can return to Flavorithm and try again.'
				: 'ChatGPT could not complete the connection. Return to Flavorithm and try again.';
		return htmlResponse(message, pending.appOrigin, false, 200);
	}
	const code = url.searchParams.get('code');
	if (!code || code.length > 4_096) {
		return htmlResponse(
			'ChatGPT did not return an authorization code. Return to Flavorithm and try again.',
			pending.appOrigin,
			false,
			400
		);
	}
	const returnedClientId = url.searchParams.get('client_id');
	let clientId = pending.clientId;
	if (pending.newRegistration) {
		if (
			!returnedClientId ||
			returnedClientId === INITIAL_CLIENT_ID ||
			returnedClientId.length > 512
		) {
			return htmlResponse(
				'The new ChatGPT registration did not include its issued client ID.',
				pending.appOrigin,
				false,
				400
			);
		}
		clientId = returnedClientId;
	} else if (returnedClientId && returnedClientId !== pending.clientId) {
		return htmlResponse(
			'ChatGPT returned a different client registration than the one selected.',
			pending.appOrigin,
			false,
			400
		);
	}
	if (pending.mode === 'hosted' && clientId !== pending.clientId) {
		return htmlResponse(
			'ChatGPT returned a different client registration than the one configured.',
			pending.appOrigin,
			false,
			400
		);
	}

	try {
		const response = await exchangeAuthorizationCode({
			mode: pending.mode,
			clientId,
			code,
			verifier: pending.verifier,
			redirectUri: pending.redirectUri
		});
		const parsed = validateTokenResponse(response);
		const identity = await verifyIdentityToken(parsed.credentials.idToken, clientId, pending.nonce);
		if (pending.accountId) {
			const selected = getChatGPTAccount(pending.userId, pending.accountId);
			if (!selected || selected.clientId !== clientId || selected.subject !== identity.sub) {
				return htmlResponse(
					'The signed-in ChatGPT account does not match the selected connection.',
					pending.appOrigin,
					false,
					401
				);
			}
		}
		const email =
			identity.email_verified === true && typeof identity.email === 'string'
				? identity.email
				: null;
		if (!isSessionBindingActive(pending.userId, pending.sessionBinding)) {
			return htmlResponse(
				'Your Flavorithm session expired. Return to the app and sign in again.',
				pending.appOrigin,
				false,
				401
			);
		}
		saveChatGPTAccount({
			userId: pending.userId,
			...(pending.accountId ? { accountId: pending.accountId } : {}),
			mode: pending.mode,
			clientId,
			subject: identity.sub!,
			email,
			scopes: parsed.scopes,
			credentials: parsed.credentials,
			expiresAt: parsed.expiresAt,
			earliestRefreshAt: parsed.earliestRefreshAt
		});
		return htmlResponse(
			'Your ChatGPT account is connected. Return to Flavorithm to choose it for AI requests.',
			pending.appOrigin,
			true
		);
	} catch (error) {
		if (error instanceof ChatGPTOAuthError) {
			const status = error.status >= 500 ? 502 : error.status;
			const message =
				error.status === 401
					? 'ChatGPT identity could not be verified. Return to Flavorithm and start again.'
					: 'ChatGPT could not complete the connection. Return to Flavorithm and try again.';
			return htmlResponse(message, pending.appOrigin, false, status);
		}
		return htmlResponse(
			'ChatGPT could not complete the connection. Return to Flavorithm and try again.',
			pending.appOrigin,
			false,
			502
		);
	}
}

function serverCallbackConfiguration(server: ReturnType<typeof createServer>): {
	host: string;
	uri: string;
} | null {
	const marker = server as typeof server & {
		flavorithmOAuthHost?: string;
		flavorithmOAuthUri?: string;
	};
	return marker.flavorithmOAuthHost && marker.flavorithmOAuthUri
		? { host: marker.flavorithmOAuthHost, uri: marker.flavorithmOAuthUri }
		: null;
}

export async function handleHostedChatGPTCallback(
	url: URL,
	context: { userId: string | null; sessionBinding: string | null }
): Promise<Response> {
	if (!context.userId || !context.sessionBinding) {
		return htmlResponse('Your Flavorithm session could not be verified.', undefined, false, 401);
	}
	if (url.href.length > 8_192) {
		return htmlResponse('This callback request could not be accepted.', undefined, false, 413);
	}
	const state = url.searchParams.get('state');
	if (!state || state.length > 256 || url.searchParams.getAll('state').length !== 1) {
		return htmlResponse('This ChatGPT connection could not be verified.', undefined, false, 400);
	}
	const expected = hostedClientConfig();
	if (!expected || url.origin + url.pathname !== expected.redirectUri) {
		return htmlResponse(
			'This callback could not be matched to the hosted OAuth configuration.',
			undefined,
			false,
			400
		);
	}
	const stateHash = sha256Base64Url(state);
	let consumed: ReturnType<typeof consumeHostedOAuthTransaction>;
	try {
		consumed = consumeHostedOAuthTransaction(stateHash);
	} catch {
		return htmlResponse(
			'This ChatGPT connection has expired or was already used.',
			undefined,
			false,
			400
		);
	}
	if (!consumed) {
		return htmlResponse(
			'This ChatGPT connection has expired or was already used.',
			undefined,
			false,
			400
		);
	}
	let pending: PendingTransaction;
	try {
		const value: unknown = JSON.parse(consumed.payload);
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Invalid payload');
		const candidate = value as Record<string, unknown>;
		if (
			candidate.stateHash !== stateHash ||
			candidate.userId !== consumed.userId ||
			candidate.createdAt !== consumed.createdAt ||
			candidate.mode !== 'hosted' ||
			candidate.redirectUri !== expected.redirectUri ||
			candidate.appOrigin !== new URL(expected.redirectUri).origin ||
			candidate.clientId !== expected.clientId ||
			candidate.newRegistration !== false ||
			typeof candidate.verifier !== 'string' ||
			typeof candidate.nonce !== 'string' ||
			typeof candidate.sessionBinding !== 'string' ||
			(candidate.accountId !== undefined && typeof candidate.accountId !== 'string')
		) {
			throw new Error('Invalid transaction');
		}
		pending = candidate as unknown as PendingTransaction;
	} catch {
		return htmlResponse(
			'This ChatGPT connection has expired or was already used.',
			undefined,
			false,
			400
		);
	}
	if (pending.userId !== context.userId || pending.sessionBinding !== context.sessionBinding) {
		return htmlResponse('Your Flavorithm session could not be verified.', undefined, false, 401);
	}
	return finishCallback(url, stateHash, pending);
}

function endpointFromDiscovery(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	if ((value as { issuer?: unknown }).issuer !== OPENAI_ISSUER) return null;
	const endpoint = (value as { revocation_endpoint?: unknown }).revocation_endpoint;
	if (typeof endpoint !== 'string') return null;
	try {
		const url = new URL(endpoint);
		return url.protocol === 'https:' && url.hostname === 'auth.openai.com' ? url.toString() : null;
	} catch {
		return null;
	}
}

export async function disconnectChatGPTAccount(
	userId: string,
	accountId: string
): Promise<{ remoteRevoked: boolean }> {
	if (!getChatGPTAccount(userId, accountId))
		throw new ChatGPTOAuthError(404, 'ChatGPT account was not found.', 'chatgpt_account_not_found');
	const leaseToken = randomUUID();
	const coordinationDeadline = Date.now() + 20_000;
	let coordinated = claimChatGPTRefreshLease(userId, accountId, leaseToken, Date.now() + 90_000);
	while (!coordinated && Date.now() < coordinationDeadline) {
		if (!getChatGPTAccount(userId, accountId)) return { remoteRevoked: false };
		await delay(100);
		coordinated = claimChatGPTRefreshLease(userId, accountId, leaseToken, Date.now() + 90_000);
	}
	if (!coordinated) {
		// A stale refresh lease must not keep local credentials usable after disconnect.
		clearChatGPTCredentials(userId, accountId);
		return { remoteRevoked: false };
	}

	let remoteRevoked = false;
	try {
		// Read only after owning the refresh lease so rotation cannot make this token stale.
		const account = getChatGPTAccount(userId, accountId);
		if (!account) return { remoteRevoked: false };
		let credentials: ChatGPTCredentials | null = null;
		if (account.credentialEnvelope) {
			try {
				credentials = decryptChatGPTCredentials(
					userId,
					account.id,
					account.mode,
					account.credentialEnvelope
				);
			} catch {
				credentials = null;
			}
		}
		if (!credentials?.refreshToken) return { remoteRevoked: false };
		try {
			const discoveryResponse = await fetch(OPENAI_DISCOVERY_URL, {
				redirect: 'error',
				signal: AbortSignal.timeout(8_000)
			});
			const discovery = discoveryResponse.ok ? await discoveryResponse.json() : null;
			const endpoint = endpointFromDiscovery(discovery);
			if (endpoint) {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const body = new URLSearchParams({
						token: credentials.refreshToken,
						token_type_hint: 'refresh_token'
					});
					const { headers, body: authenticatedBody } = hostedAuthHeadersAndBody(
						account.mode,
						account.clientId,
						body
					);
					try {
						const response = await fetch(endpoint, {
							method: 'POST',
							headers,
							body: authenticatedBody,
							redirect: 'error',
							signal: AbortSignal.timeout(8_000)
						});
						if (response.status === 200) {
							remoteRevoked = true;
							break;
						}
						if (response.status < 500 || attempt === 2) break;
					} catch {
						if (attempt === 2) break;
					}
					await delay(150 * (attempt + 1));
				}
			}
		} catch {
			remoteRevoked = false;
		}
	} finally {
		if (!clearChatGPTCredentials(userId, accountId, leaseToken)) {
			// Reauthorization or an expired lease changed the row while revocation was in flight.
			// Prefer the explicit local disconnect and never claim remote revocation in that case.
			clearChatGPTCredentials(userId, accountId);
			remoteRevoked = false;
		}
	}
	return { remoteRevoked };
}

async function refreshAccountAccessToken(userId: string, accountId: string): Promise<string> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const account = getChatGPTAccount(userId, accountId);
		if (!account)
			throw new ChatGPTOAuthError(
				404,
				'ChatGPT account was not found.',
				'chatgpt_account_not_found'
			);
		if (!account.scopes.includes('chatgpt.tokens.use.direct')) {
			throw new ChatGPTOAuthError(
				403,
				'ChatGPT plan access was not approved for this account.',
				'chatgpt_plan_scope_missing'
			);
		}
		if (!account.credentialEnvelope) {
			throw new ChatGPTOAuthError(
				401,
				'Reconnect this ChatGPT account to continue.',
				'chatgpt_account_reauth_required'
			);
		}
		let credentials: ChatGPTCredentials;
		try {
			credentials = decryptChatGPTCredentials(
				userId,
				account.id,
				account.mode,
				account.credentialEnvelope
			);
		} catch {
			throw new ChatGPTOAuthError(
				503,
				'ChatGPT credentials could not be read securely.',
				'chatgpt_credentials_unavailable'
			);
		}
		const now = Date.now();
		if (account.expiresAt > now + ACCESS_TOKEN_EARLY_REFRESH_MS) return credentials.accessToken;
		if (account.expiresAt > now && account.earliestRefreshAt > now) return credentials.accessToken;
		if (!credentials.refreshToken) {
			clearChatGPTCredentials(userId, account.id);
			throw new ChatGPTOAuthError(
				401,
				'Reconnect this ChatGPT account to continue.',
				'chatgpt_account_reauth_required'
			);
		}
		if (account.earliestRefreshAt > now) {
			throw new ChatGPTOAuthError(
				503,
				'ChatGPT access is temporarily waiting to refresh. Please retry shortly.',
				'chatgpt_refresh_not_ready'
			);
		}

		const leaseToken = randomUUID();
		if (!claimChatGPTRefreshLease(userId, account.id, leaseToken, now + REFRESH_LEASE_MS, now)) {
			await delay(200);
			continue;
		}
		try {
			const body = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: credentials.refreshToken,
				resource: OPENAI_RESOURCE
			});
			const { headers, body: authenticatedBody } = hostedAuthHeadersAndBody(
				account.mode,
				account.clientId,
				body
			);
			let response: Response;
			try {
				response = await fetch(OPENAI_TOKEN_URL, {
					method: 'POST',
					headers,
					body: authenticatedBody,
					redirect: 'error',
					signal: AbortSignal.timeout(12_000)
				});
			} catch {
				throw new ChatGPTOAuthError(
					502,
					'ChatGPT access could not be refreshed. Please retry.',
					'chatgpt_refresh_failed'
				);
			}
			let responseBody: unknown;
			try {
				responseBody = await response.json();
			} catch {
				responseBody = null;
			}
			if (!response.ok) {
				const errorCode =
					responseBody && typeof responseBody === 'object' && 'error' in responseBody
						? (responseBody as { error?: unknown }).error
						: null;
				if (
					typeof errorCode === 'string' &&
					new Set([
						'invalid_grant',
						'invalid_refresh_token',
						'token_expired',
						'refresh_token_expired',
						'refresh_token_invalidated',
						'refresh_token_reused'
					]).has(errorCode)
				) {
					clearChatGPTCredentials(userId, account.id, leaseToken);
					throw new ChatGPTOAuthError(
						401,
						'Reconnect this ChatGPT account to continue.',
						'chatgpt_account_reauth_required'
					);
				}
				throw new ChatGPTOAuthError(
					502,
					'ChatGPT access could not be refreshed. Please retry.',
					'chatgpt_refresh_failed'
				);
			}
			if (!responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) {
				throw new ChatGPTOAuthError(
					502,
					'ChatGPT access could not be refreshed. Please retry.',
					'chatgpt_refresh_failed'
				);
			}
			const refreshResult = responseBody as Record<string, unknown>;
			if (typeof refreshResult.access_token !== 'string') {
				throw new ChatGPTOAuthError(
					502,
					'ChatGPT access could not be refreshed. Please retry.',
					'chatgpt_refresh_failed'
				);
			}
			const expiresIn = Number(refreshResult.expires_in);
			if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
				throw new ChatGPTOAuthError(
					502,
					'ChatGPT access could not be refreshed. Please retry.',
					'chatgpt_refresh_failed'
				);
			}
			const nextCredentials: ChatGPTCredentials = {
				accessToken: refreshResult.access_token,
				refreshToken:
					typeof refreshResult.refresh_token === 'string'
						? refreshResult.refresh_token
						: credentials.refreshToken,
				idToken:
					typeof refreshResult.id_token === 'string' ? refreshResult.id_token : credentials.idToken
			};
			const scopes =
				typeof refreshResult.scope === 'string' ? scopesFrom(refreshResult.scope) : account.scopes;
			const saved = persistRefreshedChatGPTCredentials({
				userId,
				accountId: account.id,
				leaseToken,
				credentials: nextCredentials,
				expiresAt: Date.now() + expiresIn * 1000,
				earliestRefreshAt: parseEarliestRefreshAt(refreshResult.earliest_refresh_at),
				scopes
			});
			if (!saved)
				throw new ChatGPTOAuthError(
					503,
					'ChatGPT access could not be saved securely.',
					'chatgpt_credentials_unavailable'
				);
			if (!scopes.includes('chatgpt.tokens.use.direct')) {
				throw new ChatGPTOAuthError(
					403,
					'ChatGPT plan access is no longer authorized.',
					'chatgpt_plan_scope_missing'
				);
			}
			return nextCredentials.accessToken;
		} finally {
			releaseChatGPTRefreshLease(userId, account.id, leaseToken);
		}
	}
	throw new ChatGPTOAuthError(
		503,
		'ChatGPT access is being refreshed. Please retry shortly.',
		'chatgpt_refresh_in_progress'
	);
}

export async function getChatGPTAccessToken(userId: string, accountId: string): Promise<string> {
	const key = `${userId}:${accountId}`;
	const existing = refreshPromises.get(key);
	if (existing) return existing;
	const promise = refreshAccountAccessToken(userId, accountId);
	refreshPromises.set(key, promise);
	try {
		return await promise;
	} finally {
		if (refreshPromises.get(key) === promise) refreshPromises.delete(key);
	}
}

export function enforceChatGPTStartRateLimit(userId: string, clientAddress: string): void {
	consumeRateLimit(`chatgpt-oauth:${userId}`, 10, 15 * 60 * 1000);
	consumeRateLimit(`chatgpt-oauth-ip:${clientAddress}`, 30, 15 * 60 * 1000);
}

export function validateHostedOAuthConfiguration(): boolean {
	return Boolean(hostedClientConfig());
}
