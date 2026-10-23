// Deployment checks print configuration status, never secret values.
const configured = (name) => Boolean(process.env[name]?.trim());
const origin = process.env.ORIGIN;
let secureOrigin = false;
try {
	const parsed = new URL(origin);
	secureOrigin =
		parsed.protocol === 'https:' &&
		parsed.pathname === '/' &&
		!parsed.search &&
		!parsed.hash &&
		!parsed.username &&
		!parsed.password;
} catch {}
const mail =
	configured('RESEND_API_KEY') &&
	configured('EMAIL_FROM') &&
	!/@example\.(?:com|test|org)>?$/i.test(process.env.EMAIL_FROM);
const authMode = process.env.FLAVORITHM_AUTH_MODE?.trim().toLowerCase() || 'local';
const validAuthMode = ['local', 'oidc', 'proxy'].includes(authMode);
function isLoopbackHost(hostname) {
	return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}
let validAuthOrigin = false;
let authOrigin;
try {
	authOrigin = new URL(origin);
	validAuthOrigin =
		(authOrigin.protocol === 'https:' ||
			(authOrigin.protocol === 'http:' && isLoopbackHost(authOrigin.hostname))) &&
		authOrigin.pathname === '/' &&
		!authOrigin.search &&
		!authOrigin.hash &&
		!authOrigin.username &&
		!authOrigin.password;
} catch {}
let validOidcIssuer = false;
try {
	const issuer = new URL(process.env.FLAVORITHM_OIDC_ISSUER);
	validOidcIssuer =
		issuer.protocol === 'https:' &&
		!issuer.username &&
		!issuer.password &&
		!issuer.search &&
		!issuer.hash;
} catch {}
const expectedOidcRedirect = authOrigin ? `${authOrigin.origin}/auth/callback` : '';
const configuredOidcRedirect = process.env.FLAVORITHM_OIDC_REDIRECT_URI?.trim();
let validOidcRedirect = !configuredOidcRedirect;
if (configuredOidcRedirect) {
	try {
		validOidcRedirect = new URL(configuredOidcRedirect).href === expectedOidcRedirect;
	} catch {
		validOidcRedirect = false;
	}
}
const oidcClientAuthMethod =
	process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD?.trim() ||
	(configured('FLAVORITHM_OIDC_CLIENT_SECRET') ? 'post' : 'none');
const validOidcClientAuth =
	['basic', 'post', 'none'].includes(oidcClientAuthMethod) &&
	(oidcClientAuthMethod === 'none' || configured('FLAVORITHM_OIDC_CLIENT_SECRET'));
const oidcSessionTtl = process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS?.trim()
	? Number(process.env.FLAVORITHM_OIDC_SESSION_TTL_SECONDS)
	: 3600;
const validOidcSessionTtl =
	Number.isInteger(oidcSessionTtl) && oidcSessionTtl >= 300 && oidcSessionTtl <= 86_400;
const oidcReady =
	validAuthOrigin &&
	validOidcIssuer &&
	configured('FLAVORITHM_OIDC_CLIENT_ID') &&
	validOidcRedirect &&
	validOidcClientAuth &&
	validOidcSessionTtl;
const validHeaderName = (value, fallback) =>
	/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(process.env[value]?.trim() || fallback);
const proxySecret = process.env.FLAVORITHM_PROXY_SHARED_SECRET ?? '';
let validProxyLogout = true;
const proxyLogout = process.env.FLAVORITHM_PROXY_LOGOUT_URL?.trim();
if (proxyLogout) {
	try {
		const url = new URL(proxyLogout);
		validProxyLogout =
			(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) &&
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
	validProxyLogout;
let hostedOAuth = false;
try {
	const redirect = new URL(process.env.OPENAI_OAUTH_REDIRECT_URI);
	hostedOAuth =
		configured('OPENAI_OAUTH_CLIENT_ID') &&
		secureOrigin &&
		redirect.origin === new URL(origin).origin &&
		redirect.pathname === '/api/connections/chatgpt/callback' &&
		!redirect.search &&
		!redirect.hash &&
		Buffer.from(process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY || '', 'base64').length === 32;
} catch {}
const checks = [
	['Authentication mode', validAuthMode, 'Set FLAVORITHM_AUTH_MODE to local, oidc, or proxy.'],
	...(authMode === 'oidc'
		? [
				[
					'OIDC sign-in',
					oidcReady,
					'Set ORIGIN, FLAVORITHM_OIDC_ISSUER, and FLAVORITHM_OIDC_CLIENT_ID; register the exact /auth/callback URL. Match the optional client-auth method to the provider, provide a secret for basic/post, and keep the session TTL between 300 and 86400 seconds.'
				]
			]
		: []),
	...(authMode === 'proxy'
		? [
				[
					'Trusted proxy sign-in',
					proxyReady,
					'Set FLAVORITHM_PROXY_SHARED_SECRET to at least 32 bytes and configure the trusted proxy to overwrite identity headers and inject the matching secret header. Header names and an optional logout URL must also be valid.'
				]
			]
		: []),
	[
		'Public HTTPS origin',
		secureOrigin,
		'Set ORIGIN to the public HTTPS origin. Local HTTP is suitable for development.'
	],
	[
		'Persistent SQLite path',
		configured('FLAVORITHM_DB_PATH') && process.env.FLAVORITHM_DB_PATH !== ':memory:',
		'Set FLAVORITHM_DB_PATH to a database on persistent storage.'
	],
	[
		'Verification and password recovery email',
		mail,
		'Set RESEND_API_KEY and EMAIL_FROM using a verified sender.'
	],
	[
		'Internet recipe search',
		configured('BRAVE_SEARCH_API_KEY'),
		'Set BRAVE_SEARCH_API_KEY to enable online discovery. Recipe link import does not require it.'
	],
	[
		'Hosted ChatGPT OAuth',
		hostedOAuth,
		'Set approved client ID, exact redirect URI and stable encryption key; local loopback connections use their own flow.'
	]
];
for (const [label, ready, hint] of checks) {
	console.log(`${ready ? 'CONFIGURED' : 'SETUP NEEDED'}: ${label}`);
	if (!ready) console.log(`  ${hint}`);
}
console.log(
	'\nConfiguration does not prove delivery or provider eligibility. Complete the live acceptance steps in docs/launch-checklist.md.'
);
if (process.argv.includes('--strict') && checks.some(([, ready]) => !ready)) process.exitCode = 1;
