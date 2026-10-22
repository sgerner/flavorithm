import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const demoEmail = 'developer@flavorithm.test';
const demoName = 'Local Demo';
const defaultDatabasePath = resolve(process.cwd(), 'data', 'flavorithm.dev.sqlite');
const applicationDatabasePath = resolve(process.cwd(), 'data', 'flavorithm.sqlite');

function parseDatabasePath(args) {
	if (args.length === 0) return defaultDatabasePath;
	if (args.length === 2 && args[0] === '--db' && args[1]) return resolve(args[1]);
	throw new Error('Usage: npm run seed:dev [-- --db /path/to/new-or-empty-dev.sqlite]');
}

function inspectTarget(databasePath) {
	if (databasePath === applicationDatabasePath) {
		throw new Error(
			`Refusing to seed the application database at ${applicationDatabasePath}. Use the isolated default ${defaultDatabasePath}.`
		);
	}
	if (!databasePath.endsWith('.sqlite')) {
		throw new Error('The dev seed target must be a persistent .sqlite file.');
	}
	if (!existsSync(databasePath)) return { isSeeded: false };
	if (statSync(databasePath).size === 0) return { isSeeded: false };

	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => row.name)
			.filter((name) => !name.startsWith('sqlite_'));

		if (tables.includes('users')) {
			const users = db.prepare('SELECT email FROM users').all();
			if (users.length === 1 && users[0].email?.toLowerCase() === demoEmail) {
				return { isSeeded: true };
			}
		}

		for (const table of tables) {
			const escapedTable = table.replaceAll('"', '""');
			const count = db.prepare(`SELECT COUNT(*) AS count FROM "${escapedTable}"`).get().count;
			if (count > 0) {
				throw new Error(
					`Refusing to seed ${databasePath}: table ${table} already contains data. Choose an empty dev database.`
				);
			}
		}
		return { isSeeded: false };
	} finally {
		db.close();
	}
}

async function main() {
	const databasePath = parseDatabasePath(process.argv.slice(2));
	const target = inspectTarget(databasePath);
	if (target.isSeeded) {
		console.log(`The local demo account already exists in ${databasePath}; no changes made.`);
		return;
	}

	process.env.FLAVORITHM_DB_PATH = databasePath;
	const [{ registerUser, getDatabase, getStateEtag, saveState }, { createInitialState }] =
		await Promise.all([import('../src/lib/server/db.ts'), import('../src/lib/data.ts')]);
	const password = randomBytes(24).toString('base64url');
	const account = await registerUser(demoName, demoEmail, password);
	const state = createInitialState();
	saveState(account.user, state, {
		ifMatch: getStateEtag(account.user),
		ifNoneMatch: null
	});
	getDatabase().close();

	console.log(`Seeded an isolated Flavorithm demo kitchen at ${databasePath}.`);
	console.log(`Sign-in email: ${demoEmail}`);
	console.log(`Generated password (shown once): ${password}`);
	console.log(
		`Run FLAVORITHM_DB_PATH=${databasePath} npm run dev to use this database. The seed command will not modify a database that already contains user or kitchen data.`
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
