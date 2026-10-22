// Deployment checks print configuration status, never secret values.
const configured = (name) => Boolean(process.env[name]?.trim());
const origin = process.env.ORIGIN;
let secureOrigin = false;
try {
	const parsed = new URL(origin);
	secureOrigin =
		parsed.protocol === 'https:' &&
		parsed.origin === origin.replace(/\/$/, '') &&
		!parsed.username &&
		!parsed.password;
} catch {}
const mail =
	configured('RESEND_API_KEY') &&
	configured('EMAIL_FROM') &&
	!/@example\.(?:com|test|org)>?$/i.test(process.env.EMAIL_FROM);
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
