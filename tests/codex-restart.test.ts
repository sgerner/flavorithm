import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every operation runs in a new Node process, sharing only the on-disk database and key.
test('device login survives process restarts with encrypted grants, durable completion, and lease recovery', () => {
	const dir = mkdtempSync(join(tmpdir(), 'flavorithm-device-restart-'));
	let now = Date.now();
	const run = (operation: string, input: object = {}) => {
		const script = `
 import assert from 'node:assert/strict';
 import { createHash } from 'node:crypto';
 import { generateKeyPair, exportJWK, SignJWT } from 'jose';
 Date.now = () => ${now};
 const db = await import('./src/lib/server/db.ts');
 const storage = await import('./src/lib/server/oauth-storage.ts');
 const device = await import('./src/lib/server/codex-device.ts');
 const input = ${JSON.stringify(input)};
 if (input.appUrl) input.appUrl = new URL(input.appUrl);
 const { privateKey, publicKey } = await generateKeyPair('RS256');
 const jwk = { ...await exportJWK(publicKey), kid:'fixture', alg:'RS256' };
 const calls = [];
 const fetcher = async (url, init) => {
 calls.push(String(url));
 if (String(url).endsWith('/usercode')) return Response.json({ device_auth_id:'private-device-id',user_code:'PRIVATE-CODE',interval:5 });
 if (String(url).endsWith('/deviceauth/token')) return Response.json({authorization_code:'once',code_verifier:'verifier',code_challenge:createHash('sha256').update('verifier').digest('base64url')});
 if (String(url) === device.CODEX_TOKEN_URL) return Response.json({ access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,id_token:await new SignJWT({'https://api.openai.com/auth':{chatgpt_account_id:'account'}}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://auth.openai.com').setAudience(device.CODEX_CLIENT_ID).setSubject('subject').setIssuedAt().setExpirationTime('1h').sign(privateKey) });
 if (String(url).endsWith('/jwks.json')) return Response.json({keys:[jwk]});
 throw new Error('Unexpected destination');
 };
 ${operation}
 db.getDatabase().close();
 `;
		const result = spawnSync(
			process.execPath,
			['--experimental-strip-types', '--input-type=module'],
			{
				cwd: new URL('..', import.meta.url),
				input: script,
				encoding: 'utf8',
				env: {
					...process.env,
					FLAVORITHM_DB_PATH: join(dir, 'test.sqlite'),
					ORIGIN: 'https://flavorithm.example'
				}
			}
		);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout);
	};
	try {
		const input = run(`
 const user = await db.registerUser('Restart tester','restart@example.com','correct horse battery');
 const owner = {userId:user.user.id,sessionBinding:db.getSessionBinding(user.token),appUrl:new URL('https://flavorithm.example')};
 const started = await device.startCodexDevice(owner,fetcher);
 const row = db.getDatabase().prepare('SELECT envelope FROM codex_device_attempts WHERE id=?').get(started.loginId);
 assert.equal(row.envelope.includes('private-device-id'),false);
 assert.equal(row.envelope.includes('PRIVATE-CODE'),false);
 console.log(JSON.stringify({...owner,loginId:started.loginId}));
 `);
		now += 6000;
		// Simulate a worker dying during a provider poll. Another worker must wait for its lease.
		run(
			`assert.equal(storage.claimCodexDeviceAttempt(input.loginId,'dead-worker',Date.now()+5000),true); console.log('{}');`,
			input
		);
		assert.deepEqual(
			run(
				`console.log(JSON.stringify(await device.pollCodexDevice(input,fetcher))); assert.equal(calls.length,0);`,
				input
			),
			{ pending: true }
		);
		now += 91_000;
		const connected = run(
			`console.log(JSON.stringify(await device.pollCodexDevice(input,fetcher)));`,
			input
		);
		assert.equal(connected.connected, true);
		assert.deepEqual(
			run(
				`
 const result = await device.pollCodexDevice(input,fetcher);
 assert.equal(calls.length,0);
 const account = storage.getChatGPTAccount(input.userId,result.accountId);
 const credentials = storage.decryptChatGPTCredentials(input.userId,account.id,account.mode,account.credentialEnvelope);
 assert.equal(credentials.refreshToken,'private-refresh');
 console.log(JSON.stringify(result));`,
				input
			),
			connected
		);
		const another = run(
			`
 const started = await device.startCodexDevice(input,fetcher);
 console.log(JSON.stringify({...input,loginId:started.loginId}));`,
			input
		);
		now += 6000;
		run(
			`assert.equal(storage.claimCodexDeviceAttempt(input.loginId,'exchange-worker',Date.now()+5000),true); assert.equal(storage.markCodexDeviceExchange(input.loginId,'exchange-worker'),true); console.log('{}');`,
			another
		);
		now += 91_000;
		run(
			`await assert.rejects(device.pollCodexDevice(input,fetcher),{status:409}); assert.equal(calls.length,0); console.log('{}');`,
			another
		);
		// A cancellation made by a later process must persist too.
		const cancelled = run(
			`const started = await device.startCodexDevice(input,fetcher); console.log(JSON.stringify({...input,loginId:started.loginId}));`,
			input
		);
		run(`device.cancelCodexDevice(input);console.log('{}');`, cancelled);
		run(
			`await assert.rejects(device.pollCodexDevice(input,fetcher),{status:404});console.log('{}');`,
			cancelled
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
