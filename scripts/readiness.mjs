// Deployment checks print configuration status, never secret values.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {Record<string, string | undefined>} ReadinessEnv
 */

/**
 * @typedef {'port' | 'authMode' | 'oidc' | 'proxy' | 'origin' | 'sqlite' | 'mail' | 'search' | 'chatgptOAuth' | 'whisper' | 'hostAdmin'} ReadinessCheckId
 */

/**
 * @typedef {object} ReadinessCheck
 * @property {ReadinessCheckId} id
 * @property {string} label
 * @property {boolean} ready
 * @property {string} hint
 */

/**
 * @typedef {object} ReadinessEvaluation
 * @property {ReadinessCheck[]} checks
 * @property {boolean} ok
 */

const HOSTED_CALLBACK_PATH = '/api/connections/chatgpt/callback';
const DEFAULT_PROXY_ISSUER = 'flavorithm:proxy';
const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isSsoLoopbackHost(hostname) {
	const normalized = hostname.toLowerCase();
	return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isChatgptLoopbackHost(hostname) {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return normalized === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * @param {string | undefined} rawOrigin
 * @returns {URL | null}
 */
function parseHttpOrigin(rawOrigin) {
	const trimmed = rawOrigin?.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		if (
			(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash ||
			parsed.username ||
			parsed.password
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * @param {string | undefined} rawKey
 * @returns {boolean}
 */
function validHostedEncryptionKey(rawKey) {
	const raw = rawKey?.trim();
	if (!raw) return false;
	const decoded = Buffer.from(raw, 'base64');
	return decoded.length === 32 && decoded.toString('base64') === raw;
}

/**
 * @param {ReadinessEnv} env
 * @returns {{ redirectOrigin: string } | null}
 */
function parseHostedChatgptClient(env) {
	const clientId = env.OPENAI_OAUTH_CLIENT_ID?.trim();
	const redirectUri = env.OPENAI_OAUTH_REDIRECT_URI?.trim();
	const clientSecret = env.OPENAI_OAUTH_CLIENT_SECRET?.trim() || null;
	const configuredMethod = env.OPENAI_OAUTH_CLIENT_AUTH_METHOD?.trim();
	if (!clientId || !redirectUri || !validHostedEncryptionKey(env.FLAVORITHM_OAUTH_ENCRYPTION_KEY)) {
		return null;
	}

	/** @type {URL} */
	let redirect;
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

	if (!clientSecret) {
		if (configuredMethod && configuredMethod !== 'none') return null;
	} else if (configuredMethod && configuredMethod !== 'client_secret_basic') {
		return null;
	}

	return { redirectOrigin: redirect.origin };
}

/**
 * @param {string | undefined} rawUrl
 * @returns {boolean}
 */
function validWhisperUrl(rawUrl) {
	try {
		const url = new URL(rawUrl || '');
		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			!url.username &&
			!url.password &&
			!url.hash
		);
	} catch {
		return false;
	}
}

/**
 * Evaluates deployment readiness purely from the supplied environment map.
 *
 * @param {ReadinessEnv} [env]
 * @returns {ReadinessEvaluation}
 */
export function evaluateReadiness(env = {}) {
	/** @param {string} name */
	const configured = (name) => Boolean(env[name]?.trim());

	const port = Number(env.PORT || 3000);
	const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;

	const parsedOrigin = env.ORIGIN ? parseHttpOrigin(env.ORIGIN) : null;
	const secureOrigin = parsedOrigin !== null && parsedOrigin.protocol === 'https:';
	const effectiveOrigin = env.ORIGIN
		? parsedOrigin
		: validPort
			? new URL(`http://localhost:${port}`)
			: null;

	const emailFrom = env.EMAIL_FROM?.trim() ?? '';
	const mail =
		configured('RESEND_API_KEY') &&
		Boolean(emailFrom) &&
		!/@example\.(?:com|test|org)>?$/i.test(emailFrom);

	const rawAuthMode = env.FLAVORITHM_AUTH_MODE;
	const authMode = rawAuthMode === undefined ? 'local' : rawAuthMode.trim().toLowerCase();
	const validAuthMode = authMode === 'local' || authMode === 'oidc' || authMode === 'proxy';

	const authOrigin =
		parsedOrigin &&
		(parsedOrigin.protocol === 'https:' ||
			(parsedOrigin.protocol === 'http:' && isSsoLoopbackHost(parsedOrigin.hostname)))
			? parsedOrigin
			: null;
	const validAuthOrigin = authOrigin !== null;

	let validOidcIssuer = false;
	const rawOidcIssuer = env.FLAVORITHM_OIDC_ISSUER?.trim();
	if (rawOidcIssuer) {
		try {
			const issuer = new URL(rawOidcIssuer);
			validOidcIssuer =
				issuer.protocol === 'https:' &&
				!issuer.username &&
				!issuer.password &&
				!issuer.search &&
				!issuer.hash;
		} catch {
			validOidcIssuer = false;
		}
	}

	const expectedOidcRedirect = authOrigin ? `${authOrigin.origin}/auth/callback` : '';
	const configuredOidcRedirect = env.FLAVORITHM_OIDC_REDIRECT_URI?.trim();
	let validOidcRedirect = !configuredOidcRedirect;
	if (configuredOidcRedirect) {
		try {
			validOidcRedirect = new URL(configuredOidcRedirect).href === expectedOidcRedirect;
		} catch {
			validOidcRedirect = false;
		}
	}

	const oidcClientSecret = env.FLAVORITHM_OIDC_CLIENT_SECRET?.trim() || undefined;
	const oidcClientAuthMethod =
		env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD?.trim().toLowerCase() ||
		(oidcClientSecret ? 'post' : 'none');
	const validOidcClientAuth =
		(oidcClientAuthMethod === 'basic' ||
			oidcClientAuthMethod === 'post' ||
			oidcClientAuthMethod === 'none') &&
		(oidcClientAuthMethod === 'none' || Boolean(oidcClientSecret));

	const oidcSessionTtl = Number(env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS ?? 3600);
	const validOidcSessionTtl =
		Number.isInteger(oidcSessionTtl) && oidcSessionTtl >= 300 && oidcSessionTtl <= 86_400;

	const oidcReady =
		validAuthOrigin &&
		validOidcIssuer &&
		configured('FLAVORITHM_OIDC_CLIENT_ID') &&
		validOidcRedirect &&
		validOidcClientAuth &&
		validOidcSessionTtl;

	/**
	 * @param {string} name
	 * @param {string} fallback
	 * @returns {boolean}
	 */
	const validHeaderName = (name, fallback) => HTTP_TOKEN_RE.test(env[name]?.trim() || fallback);
	const proxySecret = env.FLAVORITHM_PROXY_SHARED_SECRET ?? '';
	const proxyIssuer = env.FLAVORITHM_PROXY_ISSUER?.trim() || DEFAULT_PROXY_ISSUER;
	const validProxyIssuer = proxyIssuer.length > 0 && proxyIssuer.length <= 2_000;

	let validProxyLogout = true;
	const proxyLogout = env.FLAVORITHM_PROXY_LOGOUT_URL?.trim();
	if (proxyLogout) {
		try {
			const url = new URL(proxyLogout);
			validProxyLogout =
				(url.protocol === 'https:' ||
					(url.protocol === 'http:' && isSsoLoopbackHost(url.hostname))) &&
				!url.username &&
				!url.password &&
				!url.hash;
		} catch {
			validProxyLogout = false;
		}
	}

	const proxyReady =
		Buffer.byteLength(proxySecret, 'utf8') >= 32 &&
		validHeaderName('FLAVORITHM_PROXY_SECRET_HEADER', 'x-flavorithm-proxy-secret') &&
		validHeaderName('FLAVORITHM_PROXY_SUBJECT_HEADER', 'x-authentik-uid') &&
		validHeaderName('FLAVORITHM_PROXY_EMAIL_HEADER', 'x-authentik-email') &&
		validHeaderName('FLAVORITHM_PROXY_NAME_HEADER', 'x-authentik-name') &&
		validProxyIssuer &&
		validProxyLogout;

	const hostedClient = parseHostedChatgptClient(env);
	const hostedClientMatchesOrigin = Boolean(
		secureOrigin &&
		parsedOrigin &&
		hostedClient &&
		hostedClient.redirectOrigin === parsedOrigin.origin
	);
	const hostedOAuth =
		env.FLAVORITHM_CHATGPT_AUTH_FLOW === 'device' ? secureOrigin : hostedClientMatchesOrigin;

	const localChatgptRequest = Boolean(
		effectiveOrigin &&
		effectiveOrigin.protocol === 'http:' &&
		isChatgptLoopbackHost(effectiveOrigin.hostname)
	);
	const chatgptMode = !effectiveOrigin
		? 'unavailable'
		: localChatgptRequest && env.FLAVORITHM_CHATGPT_AUTH_FLOW === 'local'
			? 'local'
			: env.FLAVORITHM_CHATGPT_AUTH_FLOW !== 'device' &&
				  hostedClient &&
				  hostedClient.redirectOrigin === effectiveOrigin.origin
				? 'hosted'
				: localChatgptRequest || effectiveOrigin.protocol === 'https:'
					? 'device'
					: 'unavailable';
	const codexDeviceAvailable = chatgptMode === 'device';

	const dbPath = env.FLAVORITHM_DB_PATH?.trim();
	const persistentDb = Boolean(dbPath) && dbPath !== ':memory:';

	/** @type {ReadinessCheck[]} */
	const checks = [
		{
			id: 'port',
			label: 'HTTP listen port',
			ready: validPort,
			hint: 'Set PORT to an integer between 1 and 65535.'
		},
		{
			id: 'authMode',
			label: 'Authentication mode',
			ready: validAuthMode,
			hint: 'Set FLAVORITHM_AUTH_MODE to local, oidc, or proxy.'
		},
		...(authMode === 'oidc'
			? [
					/** @type {ReadinessCheck} */ ({
						id: 'oidc',
						label: 'OIDC sign-in',
						ready: oidcReady,
						hint: 'Set ORIGIN, FLAVORITHM_OIDC_ISSUER, and FLAVORITHM_OIDC_CLIENT_ID; register the exact /auth/callback URL. Match the optional client-auth method to the provider, provide a secret for basic/post, and keep the session TTL between 300 and 86400 seconds.'
					})
				]
			: []),
		...(authMode === 'proxy'
			? [
					/** @type {ReadinessCheck} */ ({
						id: 'proxy',
						label: 'Trusted proxy sign-in',
						ready: proxyReady,
						hint: 'Set FLAVORITHM_PROXY_SHARED_SECRET to at least 32 bytes and configure the trusted proxy to overwrite identity headers and inject the matching secret header. Header names, proxy issuer (up to 2000 characters), and an optional logout URL must also be valid.'
					})
				]
			: []),
		{
			id: 'origin',
			label: 'Public HTTPS origin',
			ready: secureOrigin,
			hint: 'Set ORIGIN to the public HTTPS origin. Local HTTP is suitable for development.'
		},
		{
			id: 'sqlite',
			label: 'Persistent SQLite path',
			ready: persistentDb,
			hint: 'Set FLAVORITHM_DB_PATH to a database on persistent storage.'
		},
		{
			id: 'mail',
			label: 'Verification and password recovery email',
			ready: mail,
			hint: 'Set RESEND_API_KEY and EMAIL_FROM using a verified sender.'
		},
		{
			id: 'search',
			label: 'Internet recipe search',
			ready: configured('BRAVE_SEARCH_API_KEY'),
			hint: 'Set BRAVE_SEARCH_API_KEY to enable online discovery. Recipe link import does not require it.'
		},
		{
			id: 'chatgptOAuth',
			label: 'Hosted ChatGPT OAuth',
			ready: hostedOAuth,
			hint: 'Set FLAVORITHM_CHATGPT_AUTH_FLOW=device on an HTTPS ORIGIN for Codex device login, or set approved client ID, matching auth method/secret, exact redirect URI, and canonical 32-byte base64 encryption key.'
		},
		...(env.WHISPER_TRANSCRIPTION_URL
			? [
					/** @type {ReadinessCheck} */ ({
						id: 'whisper',
						label: 'Local Whisper transcription',
						ready: validWhisperUrl(env.WHISPER_TRANSCRIPTION_URL),
						hint: 'Set WHISPER_TRANSCRIPTION_URL to an HTTP or HTTPS endpoint without credentials or a URL fragment, or leave it unset.'
					})
				]
			: []),
		...(env.FLAVORITHM_HOST_ADMIN_USER_ID
			? [
					/** @type {ReadinessCheck} */ ({
						id: 'hostAdmin',
						label: 'Host-wide ChatGPT administration',
						ready: Boolean(env.FLAVORITHM_HOST_ADMIN_USER_ID.trim()) && codexDeviceAvailable,
						hint: 'Set FLAVORITHM_HOST_ADMIN_USER_ID to a non-empty user ID with Codex device login available (use HTTPS or localhost, and set FLAVORITHM_CHATGPT_AUTH_FLOW=device if hosted OAuth keys are configured).'
					})
				]
			: [])
	];

	return {
		checks,
		ok: checks.every((check) => check.ready)
	};
}

/**
 * @returns {boolean}
 */
function isDirectExecution() {
	const entry = process.argv[1];
	if (!entry) return false;
	const modulePath = fileURLToPath(import.meta.url);
	try {
		return realpathSync(resolve(entry)) === realpathSync(modulePath);
	} catch {
		return resolve(entry) === modulePath;
	}
}

if (isDirectExecution()) {
	const { checks, ok } = evaluateReadiness(process.env);
	for (const { label, ready, hint } of checks) {
		console.log(`${ready ? 'CONFIGURED' : 'SETUP NEEDED'}: ${label}`);
		if (!ready) console.log(`  ${hint}`);
	}
	console.log(
		'\nConfiguration does not prove delivery or provider eligibility. Complete the live acceptance steps in docs/launch-checklist.md.'
	);
	if (process.argv.includes('--strict') && !ok) process.exitCode = 1;
}
