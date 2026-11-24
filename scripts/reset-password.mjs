import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const usage =
	'Usage: npm run auth:reset-password -- --email <user@example.com> [--db /path/to/flavorithm.sqlite] [--password-stdin]';

/** @param {string[]} args */
function parseArguments(args) {
	let email = '';
	let databasePath = process.env.FLAVORITHM_DB_PATH
		? resolve(process.env.FLAVORITHM_DB_PATH)
		: resolve(process.cwd(), 'data', 'flavorithm.sqlite');
	let passwordStdin = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--email') {
			const value = args[index + 1];
			if (!value || value.startsWith('--')) throw new Error(usage);
			email = value.trim().toLowerCase();
			index += 1;
			continue;
		}
		if (arg.startsWith('--email=')) {
			email = arg.slice('--email='.length).trim().toLowerCase();
			if (!email) throw new Error(usage);
			continue;
		}
		if (arg === '--db') {
			const value = args[index + 1];
			if (!value || value.startsWith('--')) throw new Error(usage);
			databasePath = resolve(value);
			index += 1;
			continue;
		}
		if (arg.startsWith('--db=')) {
			const value = arg.slice('--db='.length).trim();
			if (!value) throw new Error(usage);
			databasePath = resolve(value);
			continue;
		}
		if (arg === '--password-stdin') {
			passwordStdin = true;
			continue;
		}
		if (arg === '--password' || arg.startsWith('--password=')) {
			throw new Error(
				`Do not pass passwords on the command line. Pipe a password with --password-stdin or omit it to generate one.\n${usage}`
			);
		}
		throw new Error(usage);
	}

	if (!email) throw new Error(usage);
	return { email, databasePath, passwordStdin };
}

function readStdinPassword() {
	const raw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
	if (/[\r\n]/.test(raw)) {
		throw new Error('Password from standard input must be a single line.');
	}
	if (raw.length < 10 || raw.length > 128) {
		throw new Error('Password must be between 10 and 128 characters long.');
	}
	return raw;
}

/**
 * @param {string} databasePath
 * @param {string} email
 */
function inspectTargetAccount(databasePath, email) {
	if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
		throw new Error(
			`Database not found at ${databasePath}. Pass --db or set FLAVORITHM_DB_PATH to an existing Flavorithm SQLite database.`
		);
	}

	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const hasUsersTable = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")
			.get();
		if (!hasUsersTable) {
			throw new Error(`No Flavorithm users table found in ${databasePath}.`);
		}
		const userColumns = db.prepare('PRAGMA table_info(users)').all();
		const hasSsoColumn = userColumns.some((column) => column.name === 'sso_only');
		const row = db
			.prepare(
				hasSsoColumn
					? 'SELECT email, sso_only FROM users WHERE email = ? COLLATE NOCASE'
					: 'SELECT email, 0 AS sso_only FROM users WHERE email = ? COLLATE NOCASE'
			)
			.get(email);
		if (!row) {
			throw new Error(`No account found for ${email} in ${databasePath}.`);
		}
		if (row.sso_only) {
			throw new Error(
				`Account ${row.email} uses organization sign-in and does not have a local password.`
			);
		}
	} finally {
		db.close();
	}
}

async function main() {
	const { email, databasePath, passwordStdin } = parseArguments(process.argv.slice(2));
	const password = passwordStdin ? readStdinPassword() : randomBytes(24).toString('base64url');
	inspectTargetAccount(databasePath, email);

	process.env.FLAVORITHM_DB_PATH = databasePath;
	const { getDatabase, resetLocalUserPassword } = await import('../src/lib/server/db.ts');
	try {
		const updated = await resetLocalUserPassword(email, password);
		console.log(`Reset local password for ${updated.email} in ${databasePath}.`);
		console.log('Revoked all active sessions and pending password reset links for this account.');
		if (!passwordStdin) {
			console.log(`Generated password (shown once): ${password}`);
		}
	} finally {
		getDatabase().close();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
