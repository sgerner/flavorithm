import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const scriptPath = resolve('scripts/seed-dev.mjs');

function runSeed(databasePath: string) {
	return spawnSync(
		process.execPath,
		['--experimental-strip-types', scriptPath, '--db', databasePath],
		{ encoding: 'utf8' }
	);
}

function countRows(db: DatabaseSync, table: string): number {
	const result = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
		{ count: number } | undefined;
	assert.ok(result);
	return result.count;
}

test('dev seed creates one isolated demo kitchen and is idempotent', () => {
	const directory = mkdtempSync(join(tmpdir(), 'flavorithm-seed-'));
	const databasePath = join(directory, 'dev-fixture.sqlite');
	let db: DatabaseSync | undefined;
	try {
		const first = runSeed(databasePath);
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /developer@flavorithm\.test/);
		const passwordLine = first.stdout.match(/Generated password \(shown once\): ([^\s]+)/);
		assert.equal(passwordLine?.[1]?.length, 32);

		db = new DatabaseSync(databasePath, { readOnly: true });
		const account = db
			.prepare('SELECT id, household_id FROM users WHERE email = ?')
			.get('developer@flavorithm.test') as { id: string; household_id: string } | undefined;
		assert.ok(account);
		const row = db
			.prepare('SELECT state_json FROM household_state WHERE household_id = ?')
			.get(account.household_id) as { state_json: string } | undefined;
		assert.ok(row);
		const state = JSON.parse(row.state_json) as {
			pantry: unknown[];
			recipes: unknown[];
			meals: unknown[];
			shopping: unknown[];
		};
		assert.equal(state.recipes.length, 8);
		assert.equal(state.pantry.length, 7);
		assert.equal(state.meals.length, 3);
		assert.deepEqual(state.shopping, []);

		const countsBefore = ['users', 'households', 'household_state', 'user_preferences'].map(
			(table) => countRows(db!, table)
		);
		const storedStateBefore = row.state_json;
		db.close();
		db = undefined;

		const second = runSeed(databasePath);
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, /already exists.*no changes made/);
		assert.doesNotMatch(second.stdout, /Generated password/);

		db = new DatabaseSync(databasePath, { readOnly: true });
		const countsAfter = ['users', 'households', 'household_state', 'user_preferences'].map(
			(table) => countRows(db!, table)
		);
		assert.deepEqual(countsAfter, countsBefore);
		assert.equal(
			(
				db
					.prepare('SELECT state_json FROM household_state WHERE household_id = ?')
					.get(account.household_id) as { state_json: string }
			).state_json,
			storedStateBefore
		);
	} finally {
		db?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('dev seed refuses nonempty databases and the application database path', () => {
	const directory = mkdtempSync(join(tmpdir(), 'flavorithm-seed-guard-'));
	const databasePath = join(directory, 'occupied.sqlite');
	try {
		const occupied = new DatabaseSync(databasePath);
		occupied.exec(
			"CREATE TABLE private_data (value TEXT); INSERT INTO private_data VALUES ('keep')"
		);
		occupied.close();
		const refused = runSeed(databasePath);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /already contains data/);

		const verify = new DatabaseSync(databasePath, { readOnly: true });
		const preserved = verify.prepare('SELECT value FROM private_data').get() as
			{ value: string } | undefined;
		assert.equal(preserved?.value, 'keep');
		verify.close();

		const productionPath = resolve('data/flavorithm.sqlite');
		const productionRefused = runSeed(productionPath);
		assert.notEqual(productionRefused.status, 0);
		assert.match(productionRefused.stderr, /Refusing to seed the application database/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
