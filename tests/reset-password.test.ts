import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const seedScriptPath = resolve('scripts/seed-dev.mjs');
const resetScriptPath = resolve('scripts/reset-password.mjs');

function runReset(args: string[], input?: string) {
	return spawnSync(process.execPath, ['--experimental-strip-types', resetScriptPath, ...args], {
		encoding: 'utf8',
		input
	});
}

function runInlineWithDb(databasePath: string, code: string) {
	return spawnSync(
		process.execPath,
		['--experimental-strip-types', '--input-type=module', '-e', code],
		{
			encoding: 'utf8',
			env: { ...process.env, FLAVORITHM_DB_PATH: databasePath }
		}
	);
}

test('CLI password reset rotates seeded passwords, revokes sessions, and unblocks account deletion', () => {
	const directory = mkdtempSync(join(tmpdir(), 'flavorithm-reset-cli-'));
	const databasePath = join(directory, 'dev-reset.sqlite');
	try {
		const seeded = spawnSync(
			process.execPath,
			['--experimental-strip-types', seedScriptPath, '--db', databasePath],
			{ encoding: 'utf8' }
		);
		assert.equal(seeded.status, 0, seeded.stderr);
		const initialPassword = seeded.stdout.match(/Generated password \(shown once\): ([^\s]+)/)?.[1];
		assert.ok(initialPassword);

		const setupSession = runInlineWithDb(
			databasePath,
			`
			import assert from 'node:assert/strict';
			import { loginUser, issuePasswordReset, getDatabase } from './src/lib/server/db.ts';
			const session = await loginUser('developer@flavorithm.test', ${JSON.stringify(initialPassword)});
			const reset = issuePasswordReset('developer@flavorithm.test');
			assert.ok(session.token);
			assert.ok(reset?.token);
			getDatabase().close();
			`
		);
		assert.equal(setupSession.status, 0, setupSession.stderr);

		const generatedReset = runReset(['--email', 'DEVELOPER@flavorithm.test', '--db', databasePath]);
		assert.equal(generatedReset.status, 0, generatedReset.stderr);
		assert.match(generatedReset.stdout, /Reset local password for developer@flavorithm\.test/);
		const generatedPassword = generatedReset.stdout.match(
			/Generated password \(shown once\): ([^\s]+)/
		)?.[1];
		assert.equal(generatedPassword?.length, 32);
		assert.notEqual(generatedPassword, initialPassword);

		const dbAfterGenerated = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(
			(
				dbAfterGenerated.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
					count: number;
				}
			).count,
			0
		);
		assert.equal(
			(
				dbAfterGenerated.prepare('SELECT COUNT(*) AS count FROM password_reset_tokens').get() as {
					count: number;
				}
			).count,
			0
		);
		dbAfterGenerated.close();

		const stdinPassword = 'operator-stdin-replacement-password';
		const stdinReset = runReset(
			['--email', 'developer@flavorithm.test', '--db', databasePath, '--password-stdin'],
			`${stdinPassword}\n`
		);
		assert.equal(stdinReset.status, 0, stdinReset.stderr);
		assert.doesNotMatch(stdinReset.stdout, /Generated password/);
		assert.equal(stdinReset.stdout.includes(stdinPassword), false);

		const verifyAndDelete = runInlineWithDb(
			databasePath,
			`
			import assert from 'node:assert/strict';
			import { loginUser, deleteUserAccount, getDatabase } from './src/lib/server/db.ts';
			await assert.rejects(() => loginUser('developer@flavorithm.test', ${JSON.stringify(generatedPassword)}), { status: 401 });
			const loggedIn = await loginUser('developer@flavorithm.test', ${JSON.stringify(stdinPassword)});
			await deleteUserAccount(loggedIn.user.id, ${JSON.stringify(stdinPassword)});
			getDatabase().close();
			`
		);
		assert.equal(verifyAndDelete.status, 0, verifyAndDelete.stderr);

		const dbAfterDelete = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(
			(dbAfterDelete.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number })
				.count,
			0
		);
		dbAfterDelete.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('CLI password reset rejects CLI password flags, missing databases, unknown emails, and SSO accounts', () => {
	const directory = mkdtempSync(join(tmpdir(), 'flavorithm-reset-guard-'));
	const missingPath = join(directory, 'missing.sqlite');
	const databasePath = join(directory, 'guards.sqlite');
	try {
		const rejectedFlag = runReset([
			'--email',
			'developer@flavorithm.test',
			'--db',
			missingPath,
			'--password',
			'never-on-argv-password'
		]);
		assert.notEqual(rejectedFlag.status, 0);
		assert.match(rejectedFlag.stderr, /Do not pass passwords on the command line/);
		assert.equal(existsSync(missingPath), false);

		const rejectedMissing = runReset(['--email', 'developer@flavorithm.test', '--db', missingPath]);
		assert.notEqual(rejectedMissing.status, 0);
		assert.match(rejectedMissing.stderr, /Database not found/);
		assert.equal(existsSync(missingPath), false);

		const createSsoUser = runInlineWithDb(
			databasePath,
			`
			import { resolveExternalIdentity, getDatabase } from './src/lib/server/db.ts';
			resolveExternalIdentity({
				issuer: 'https://idp.example.test',
				subject: 'cli-sso-subject',
				email: 'sso-user@example.test',
				name: 'SSO User',
				emailVerified: true
			});
			getDatabase().close();
			`
		);
		assert.equal(createSsoUser.status, 0, createSsoUser.stderr);

		const unknownEmail = runReset(['--email', 'missing@example.test', '--db', databasePath]);
		assert.notEqual(unknownEmail.status, 0);
		assert.match(unknownEmail.stderr, /No account found/);

		const ssoRejected = runReset(['--email', 'sso-user@example.test', '--db', databasePath]);
		assert.notEqual(ssoRejected.status, 0);
		assert.match(ssoRejected.stderr, /organization sign-in/);

		const shortStdin = runReset(
			['--email', 'sso-user@example.test', '--db', databasePath, '--password-stdin'],
			'too-short\n'
		);
		assert.notEqual(shortStdin.status, 0);
		assert.match(shortStdin.stderr, /between 10 and 128 characters/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
