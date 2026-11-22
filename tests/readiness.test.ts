import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
	evaluateReadiness,
	type ReadinessCheckId,
	type ReadinessEnv
} from '../scripts/readiness.mjs';

process.env.FLAVORITHM_DB_PATH = ':memory:';

const db = await import('../src/lib/server/db.ts');
const sso = await import('../src/lib/server/sso.ts');
const oauth = await import('../src/lib/server/chatgpt-oauth.ts');
const storage = await import('../src/lib/server/oauth-storage.ts');
const voice = await import('../src/lib/server/voice.ts');
const hostAi = await import('../src/lib/server/host-ai.ts');

const readinessScriptPath = resolve('scripts/readiness.mjs');
const serverScriptPath = resolve('server.mjs');
const canonicalKey = Buffer.alloc(32, 0x2a).toString('base64');
const validProxySecret = 'proxy-shared-secret-with-at-least-32-bytes';

const trackedKeys = [
	'PORT',
	'ORIGIN',
	'FLAVORITHM_DB_PATH',
	'RESEND_API_KEY',
	'EMAIL_FROM',
	'BRAVE_SEARCH_API_KEY',
	'FLAVORITHM_AUTH_MODE',
	'FLAVORITHM_OIDC_ISSUER',
	'FLAVORITHM_OIDC_CLIENT_ID',
	'FLAVORITHM_OIDC_CLIENT_SECRET',
	'FLAVORITHM_OIDC_CLIENT_AUTH_METHOD',
	'FLAVORITHM_OIDC_REDIRECT_URI',
	'FLAVORITHM_OIDC_SESSION_TTL_SECONDS',
	'FLAVORITHM_PROXY_SHARED_SECRET',
	'FLAVORITHM_PROXY_SECRET_HEADER',
	'FLAVORITHM_PROXY_SUBJECT_HEADER',
	'FLAVORITHM_PROXY_EMAIL_HEADER',
	'FLAVORITHM_PROXY_NAME_HEADER',
	'FLAVORITHM_PROXY_ISSUER',
	'FLAVORITHM_PROXY_LOGOUT_URL',
	'FLAVORITHM_CHATGPT_AUTH_FLOW',
	'OPENAI_OAUTH_CLIENT_ID',
	'OPENAI_OAUTH_REDIRECT_URI',
	'OPENAI_OAUTH_CLIENT_SECRET',
	'OPENAI_OAUTH_CLIENT_AUTH_METHOD',
	'FLAVORITHM_OAUTH_ENCRYPTION_KEY',
	'WHISPER_TRANSCRIPTION_URL',
	'WHISPER_API_KEY',
	'FLAVORITHM_HOST_ADMIN_USER_ID'
] as const;

function withRuntimeEnv<T>(env: ReadinessEnv, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const key of trackedKeys) {
		previous.set(key, process.env[key]);
		if (env[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = env[key];
		}
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCheck(env: ReadinessEnv, id: ReadinessCheckId) {
	return evaluateReadiness(env).checks.find((check) => check.id === id);
}

function strictDeviceEnv(overrides: ReadinessEnv = {}): ReadinessEnv {
	return {
		PORT: '3000',
		ORIGIN: 'https://kitchen.flavorithm.test',
		FLAVORITHM_DB_PATH: '/var/lib/flavorithm/flavorithm.sqlite',
		RESEND_API_KEY: 're_live_test_token',
		EMAIL_FROM: 'Flavorithm <kitchen@flavorithm.test>',
		BRAVE_SEARCH_API_KEY: 'bsa_live_test_token',
		FLAVORITHM_CHATGPT_AUTH_FLOW: 'device',
		...overrides
	};
}

function strictHostedOAuthEnv(overrides: ReadinessEnv = {}): ReadinessEnv {
	return {
		PORT: '3000',
		ORIGIN: 'https://kitchen.flavorithm.test',
		FLAVORITHM_DB_PATH: '/var/lib/flavorithm/flavorithm.sqlite',
		RESEND_API_KEY: 're_live_test_token',
		EMAIL_FROM: 'Flavorithm <kitchen@flavorithm.test>',
		BRAVE_SEARCH_API_KEY: 'bsa_live_test_token',
		OPENAI_OAUTH_CLIENT_ID: 'oaiapp_test_client',
		OPENAI_OAUTH_REDIRECT_URI: 'https://kitchen.flavorithm.test/api/connections/chatgpt/callback',
		FLAVORITHM_OAUTH_ENCRYPTION_KEY: canonicalKey,
		...overrides
	};
}

test('evaluateReadiness is pure and accepts device-flow HTTPS or hosted SIWC under strict mode', () => {
	process.env.ORIGIN = 'https://ambient-process-env-should-not-leak.test';
	const emptyReport = evaluateReadiness({});
	assert.equal(emptyReport.ok, false);
	assert.equal(
		emptyReport.checks.find((check) => check.id === 'origin')?.ready,
		false,
		'ambient process.env must not leak into pure evaluateReadiness(env)'
	);

	const deviceStrict = evaluateReadiness(strictDeviceEnv());
	assert.equal(deviceStrict.ok, true);
	assert.equal(
		deviceStrict.checks.some((check) => check.id === 'whisper' || check.id === 'hostAdmin'),
		false
	);

	const emptyOptionals = evaluateReadiness(
		strictDeviceEnv({
			WHISPER_TRANSCRIPTION_URL: '',
			FLAVORITHM_HOST_ADMIN_USER_ID: ''
		})
	);
	assert.equal(emptyOptionals.ok, true);

	const hostedStrict = evaluateReadiness(strictHostedOAuthEnv());
	assert.equal(hostedStrict.ok, true);
});

test('PORT readiness matches server.mjs integer range validation', () => {
	for (const validPort of [undefined, '', '1', '3000', '65535', ' 8080 ']) {
		const check = getCheck({ PORT: validPort }, 'port');
		assert.equal(check?.ready, true, `expected PORT=${String(validPort)} to be valid`);
	}

	for (const invalidPort of ['0', '-1', '65536', '3000.5', 'abc', '   ']) {
		const check = getCheck({ PORT: invalidPort }, 'port');
		assert.equal(check?.ready, false, `expected PORT=${JSON.stringify(invalidPort)} to be invalid`);
	}

	const bootZero = spawnSync(process.execPath, [serverScriptPath], {
		env: { ...process.env, PORT: '0' },
		encoding: 'utf8'
	});
	assert.notEqual(bootZero.status, 0);
	assert.match(bootZero.stderr, /PORT must be between 1 and 65535/);

	const bootWhitespace = spawnSync(process.execPath, [serverScriptPath], {
		env: { ...process.env, PORT: '   ' },
		encoding: 'utf8'
	});
	assert.notEqual(bootWhitespace.status, 0);
	assert.match(bootWhitespace.stderr, /PORT must be between 1 and 65535/);
});

test('authentication mode, OIDC, and proxy readiness match runtime sso.ts validators', () => {
	const modeCases: Array<string | undefined> = [
		undefined,
		'local',
		' LOCAL ',
		'oidc',
		'proxy',
		'',
		'   ',
		'saml'
	];
	for (const rawMode of modeCases) {
		const env: ReadinessEnv = { FLAVORITHM_AUTH_MODE: rawMode };
		const expected = withRuntimeEnv(env, () => sso.getAuthMode() !== null);
		assert.equal(
			getCheck(env, 'authMode')?.ready,
			expected,
			`authMode parity failed for ${JSON.stringify(rawMode)}`
		);
	}

	const baseOidc: ReadinessEnv = {
		FLAVORITHM_AUTH_MODE: 'oidc',
		ORIGIN: 'https://kitchen.flavorithm.test',
		FLAVORITHM_OIDC_ISSUER: 'https://idp.flavorithm.test/application/o/flavorithm/',
		FLAVORITHM_OIDC_CLIENT_ID: 'flavorithm-oidc'
	};
	const oidcCases: ReadinessEnv[] = [
		baseOidc,
		{ ...baseOidc, ORIGIN: 'http://localhost:3000' },
		{ ...baseOidc, ORIGIN: 'http://127.0.0.1:3000' },
		{ ...baseOidc, ORIGIN: 'http://[::1]:3000' },
		{ ...baseOidc, ORIGIN: 'http://kitchen.flavorithm.test' },
		{
			...baseOidc,
			FLAVORITHM_OIDC_CLIENT_SECRET: 'top-secret',
			FLAVORITHM_OIDC_CLIENT_AUTH_METHOD: 'BASIC'
		},
		{
			...baseOidc,
			FLAVORITHM_OIDC_CLIENT_SECRET: 'top-secret',
			FLAVORITHM_OIDC_CLIENT_AUTH_METHOD: 'Post'
		},
		{
			...baseOidc,
			FLAVORITHM_OIDC_CLIENT_AUTH_METHOD: 'NONE'
		},
		{
			...baseOidc,
			FLAVORITHM_OIDC_CLIENT_AUTH_METHOD: 'basic'
		},
		{
			...baseOidc,
			FLAVORITHM_OIDC_CLIENT_AUTH_METHOD: 'private_key_jwt',
			FLAVORITHM_OIDC_CLIENT_SECRET: 'top-secret'
		},
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '   ' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '300' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '86400' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '299' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '86401' },
		{ ...baseOidc, FLAVORITHM_OIDC_SESSION_TTL_SECONDS: '3600.5' },
		{
			...baseOidc,
			FLAVORITHM_OIDC_REDIRECT_URI: 'https://kitchen.flavorithm.test/auth/callback'
		},
		{
			...baseOidc,
			FLAVORITHM_OIDC_REDIRECT_URI: 'https://other.flavorithm.test/auth/callback'
		},
		{ ...baseOidc, FLAVORITHM_OIDC_ISSUER: 'http://idp.flavorithm.test' },
		{ ...baseOidc, FLAVORITHM_OIDC_ISSUER: 'https://user:pass@idp.flavorithm.test' }
	];
	for (const env of oidcCases) {
		const expected = withRuntimeEnv(env, () => sso.isAuthModeConfigured('oidc'));
		assert.equal(
			getCheck(env, 'oidc')?.ready,
			expected,
			`OIDC parity failed for ${JSON.stringify(env)}`
		);
	}

	const baseProxy: ReadinessEnv = {
		FLAVORITHM_AUTH_MODE: 'proxy',
		FLAVORITHM_PROXY_SHARED_SECRET: validProxySecret
	};
	const proxyCases: ReadinessEnv[] = [
		baseProxy,
		{ ...baseProxy, FLAVORITHM_PROXY_SHARED_SECRET: 'short-secret' },
		{ ...baseProxy, FLAVORITHM_PROXY_ISSUER: 'x'.repeat(2_000) },
		{ ...baseProxy, FLAVORITHM_PROXY_ISSUER: `  ${'x'.repeat(2_000)}  ` },
		{ ...baseProxy, FLAVORITHM_PROXY_ISSUER: 'x'.repeat(2_001) },
		{ ...baseProxy, FLAVORITHM_PROXY_SECRET_HEADER: 'bad header' },
		{
			...baseProxy,
			FLAVORITHM_PROXY_LOGOUT_URL: 'https://kitchen.flavorithm.test/outpost.goauthentik.io/sign_out'
		},
		{ ...baseProxy, FLAVORITHM_PROXY_LOGOUT_URL: 'http://localhost:9000/logout' },
		{ ...baseProxy, FLAVORITHM_PROXY_LOGOUT_URL: 'http://kitchen.flavorithm.test/logout' },
		{
			...baseProxy,
			FLAVORITHM_PROXY_LOGOUT_URL: 'https://user:pass@kitchen.flavorithm.test/logout'
		},
		{ ...baseProxy, FLAVORITHM_PROXY_LOGOUT_URL: 'https://kitchen.flavorithm.test/logout#frag' }
	];
	for (const env of proxyCases) {
		const expected = withRuntimeEnv(
			env,
			() =>
				sso.isAuthModeConfigured('proxy') &&
				(!env.FLAVORITHM_PROXY_LOGOUT_URL?.trim() || sso.getProxyLogoutUrl() !== null)
		);
		assert.equal(
			getCheck(env, 'proxy')?.ready,
			expected,
			`proxy parity failed for ${JSON.stringify(env)}`
		);
	}
});

test('hosted ChatGPT OAuth enforces canonical Base64 keys, client auth rules, and clean redirects', async () => {
	const user = await db.registerUser(
		'Readiness User',
		'readiness-oauth@example.com',
		'test pass 12345'
	);
	// Flip the final 6-bit group's unused padding bit so Buffer.from(nonCanonicalPadding, 'base64')
	// still yields 32 bytes while re-encoding produces canonicalKey !== nonCanonicalPadding.
	const nonCanonicalPadding = `${canonicalKey.slice(0, -2)}B=`;
	assert.equal(Buffer.from(nonCanonicalPadding, 'base64').length, 32);
	assert.notEqual(
		Buffer.from(nonCanonicalPadding, 'base64').toString('base64'),
		nonCanonicalPadding
	);

	const unpaddedKey = canonicalKey.slice(0, -1);
	assert.equal(Buffer.from(unpaddedKey, 'base64').length, 32);

	const base64UrlKey = Buffer.alloc(32, 0xfb).toString('base64url');
	const embeddedWhitespaceKey = `${canonicalKey.slice(0, 10)} ${canonicalKey.slice(10)}`;
	const shortKey = Buffer.alloc(31, 0x2a).toString('base64');

	for (const [keyValue, expectedValid] of [
		[canonicalKey, true],
		[nonCanonicalPadding, false],
		[unpaddedKey, false],
		[base64UrlKey, false],
		[embeddedWhitespaceKey, false],
		[shortKey, false]
	] as const) {
		const env = strictHostedOAuthEnv({ FLAVORITHM_OAUTH_ENCRYPTION_KEY: keyValue });
		const check = getCheck(env, 'chatgptOAuth');
		assert.equal(check?.ready, expectedValid, `key check failed for ${keyValue}`);

		withRuntimeEnv({ ...env, FLAVORITHM_DB_PATH: ':memory:' }, () => {
			const availability = oauth.getChatGPTOAuthAvailability({
				url: new URL(env.ORIGIN!),
				clientAddress: '203.0.113.10'
			});
			assert.equal(availability.mode === 'hosted', expectedValid);

			const storeAttempt = () =>
				storage.storeHostedOAuthTransaction({
					stateHash: `state-${keyValue}`,
					userId: user.user.id,
					createdAt: Date.now(),
					expiresAt: Date.now() + 60_000,
					payload: JSON.stringify({ ok: true })
				});
			if (expectedValid) {
				storeAttempt();
			} else {
				assert.throws(storeAttempt, /Hosted OAuth encryption is unavailable/);
			}
		});
	}

	const oauthCases: Array<{ overrides: ReadinessEnv; expected: boolean }> = [
		{ overrides: {}, expected: true },
		{ overrides: { OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'none' }, expected: true },
		{ overrides: { OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'NONE' }, expected: false },
		{ overrides: { OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'client_secret_basic' }, expected: false },
		{ overrides: { OPENAI_OAUTH_CLIENT_SECRET: 'conf-secret' }, expected: true },
		{
			overrides: {
				OPENAI_OAUTH_CLIENT_SECRET: 'conf-secret',
				OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'client_secret_basic'
			},
			expected: true
		},
		{
			overrides: {
				OPENAI_OAUTH_CLIENT_SECRET: 'conf-secret',
				OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'none'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_CLIENT_SECRET: 'conf-secret',
				OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'client_secret_post'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_CLIENT_SECRET: 'conf-secret',
				OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'CLIENT_SECRET_BASIC'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_REDIRECT_URI:
					'https://user:pass@kitchen.flavorithm.test/api/connections/chatgpt/callback'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_REDIRECT_URI:
					'https://kitchen.flavorithm.test/api/connections/chatgpt/callback?extra=1'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_REDIRECT_URI:
					'https://kitchen.flavorithm.test/api/connections/chatgpt/callback#frag'
			},
			expected: false
		},
		{
			overrides: {
				OPENAI_OAUTH_REDIRECT_URI: 'https://other.flavorithm.test/api/connections/chatgpt/callback'
			},
			expected: false
		}
	];

	for (const { overrides, expected } of oauthCases) {
		const env = strictHostedOAuthEnv(overrides);
		assert.equal(
			getCheck(env, 'chatgptOAuth')?.ready,
			expected,
			`chatgptOAuth failed for ${JSON.stringify(overrides)}`
		);
		withRuntimeEnv({ ...env, FLAVORITHM_DB_PATH: ':memory:' }, () => {
			const availability = oauth.getChatGPTOAuthAvailability({
				url: new URL(env.ORIGIN!),
				clientAddress: '203.0.113.10'
			});
			assert.equal(availability.mode === 'hosted', expected);
		});
	}

	assert.equal(
		getCheck(strictDeviceEnv({ ORIGIN: 'http://localhost:3000' }), 'chatgptOAuth')?.ready,
		false
	);
});

test('host admin and local Whisper checks match runtime validators and strict optionality', () => {
	for (const [whisperUrl, expected] of [
		['http://whisper:8080/inference', true],
		['https://whisper.internal/v1/audio/transcriptions?lang=en', true],
		['   ', false],
		['file:///etc/passwd', false],
		['ftp://whisper:8080/inference', false],
		['https://user:pass@whisper.internal/inference', false],
		['http://whisper:8080/inference#frag', false],
		['not-a-url', false]
	] as const) {
		const env = strictDeviceEnv({ WHISPER_TRANSCRIPTION_URL: whisperUrl });
		const report = evaluateReadiness(env);
		const check = report.checks.find((item) => item.id === 'whisper');
		assert.ok(check, `expected whisper check for ${JSON.stringify(whisperUrl)}`);
		assert.equal(check.ready, expected);
		assert.equal(report.ok, expected);
		withRuntimeEnv({ ...env, FLAVORITHM_DB_PATH: ':memory:' }, () => {
			assert.equal(voice.localWhisperUrl() !== null, expected);
		});
	}

	const whitespaceAdmin = evaluateReadiness(
		strictDeviceEnv({ FLAVORITHM_HOST_ADMIN_USER_ID: '   ' })
	);
	assert.equal(whitespaceAdmin.ok, false);
	assert.equal(whitespaceAdmin.checks.find((item) => item.id === 'hostAdmin')?.ready, false);
	withRuntimeEnv({ FLAVORITHM_HOST_ADMIN_USER_ID: '   ', FLAVORITHM_DB_PATH: ':memory:' }, () => {
		assert.equal(hostAi.isHostAdmin('   '), false);
	});

	const shadowedByHosted = evaluateReadiness(
		strictHostedOAuthEnv({ FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id' })
	);
	assert.equal(shadowedByHosted.ok, false);
	assert.equal(shadowedByHosted.checks.find((item) => item.id === 'hostAdmin')?.ready, false);
	withRuntimeEnv(
		{
			...strictHostedOAuthEnv({ FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id' }),
			FLAVORITHM_DB_PATH: ':memory:'
		},
		() => {
			const availability = oauth.getChatGPTOAuthAvailability({
				url: new URL('https://kitchen.flavorithm.test'),
				clientAddress: '203.0.113.10'
			});
			assert.equal(availability.mode, 'hosted');
		}
	);

	const unshadowedWithDevice = evaluateReadiness(
		strictHostedOAuthEnv({
			FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id',
			FLAVORITHM_CHATGPT_AUTH_FLOW: 'device'
		})
	);
	assert.equal(unshadowedWithDevice.ok, true);
	assert.equal(unshadowedWithDevice.checks.find((item) => item.id === 'hostAdmin')?.ready, true);

	assert.equal(
		getCheck(
			{
				ORIGIN: 'http://127.0.0.1:3000',
				FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id'
			},
			'hostAdmin'
		)?.ready,
		true
	);
	assert.equal(
		getCheck(
			{
				ORIGIN: 'http://127.0.0.1:3000',
				FLAVORITHM_CHATGPT_AUTH_FLOW: 'local',
				FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id'
			},
			'hostAdmin'
		)?.ready,
		false
	);
	assert.equal(
		getCheck(
			{
				ORIGIN: 'http://kitchen.flavorithm.test',
				FLAVORITHM_HOST_ADMIN_USER_ID: 'admin-user-id'
			},
			'hostAdmin'
		)?.ready,
		false
	);
});

test('CLI entrypoint enforces --strict exit codes and never prints secret values', () => {
	const secrets = [
		'secret-resend-token-9182',
		'secret-brave-token-7364',
		'secret-proxy-value-with-more-than-thirty-two-bytes-5544',
		'secret-oidc-client-3322',
		'secret-openai-client-1100',
		canonicalKey,
		'secret-whisper-token-8877',
		'secret-host-admin-user-6655'
	];
	const cliEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		PORT: '3000',
		ORIGIN: 'https://kitchen.flavorithm.test',
		FLAVORITHM_DB_PATH: '/app/data/flavorithm.sqlite',
		FLAVORITHM_AUTH_MODE: 'proxy',
		FLAVORITHM_PROXY_SHARED_SECRET: secrets[2],
		FLAVORITHM_OIDC_CLIENT_SECRET: secrets[3],
		RESEND_API_KEY: secrets[0],
		EMAIL_FROM: 'Flavorithm <kitchen@flavorithm.test>',
		BRAVE_SEARCH_API_KEY: secrets[1],
		OPENAI_OAUTH_CLIENT_ID: 'oaiapp_cli_test',
		OPENAI_OAUTH_REDIRECT_URI: 'https://kitchen.flavorithm.test/api/connections/chatgpt/callback',
		OPENAI_OAUTH_CLIENT_SECRET: secrets[4],
		OPENAI_OAUTH_CLIENT_AUTH_METHOD: 'client_secret_basic',
		FLAVORITHM_OAUTH_ENCRYPTION_KEY: secrets[5],
		WHISPER_TRANSCRIPTION_URL: 'https://user:secret-url-pass@whisper.internal/inference',
		WHISPER_API_KEY: secrets[6],
		FLAVORITHM_HOST_ADMIN_USER_ID: secrets[7]
	};

	const nonStrict = spawnSync(process.execPath, [readinessScriptPath], {
		env: cliEnv,
		encoding: 'utf8'
	});
	assert.equal(nonStrict.status, 0, nonStrict.stderr);
	assert.match(nonStrict.stdout, /CONFIGURED: Trusted proxy sign-in/);
	assert.match(nonStrict.stdout, /SETUP NEEDED: Local Whisper transcription/);
	assert.match(nonStrict.stdout, /SETUP NEEDED: Host-wide ChatGPT administration/);
	for (const secret of [...secrets, 'secret-url-pass']) {
		assert.equal(nonStrict.stdout.includes(secret), false, `leaked ${secret} to stdout`);
		assert.equal(nonStrict.stderr.includes(secret), false, `leaked ${secret} to stderr`);
	}

	const strictFail = spawnSync(process.execPath, [readinessScriptPath, '--strict'], {
		env: cliEnv,
		encoding: 'utf8'
	});
	assert.equal(strictFail.status, 1);

	const strictPass = spawnSync(process.execPath, [readinessScriptPath, '--strict'], {
		env: {
			...cliEnv,
			FLAVORITHM_CHATGPT_AUTH_FLOW: 'device',
			WHISPER_TRANSCRIPTION_URL: 'http://whisper:8080/inference'
		},
		encoding: 'utf8'
	});
	assert.equal(strictPass.status, 0, strictPass.stderr);
});
