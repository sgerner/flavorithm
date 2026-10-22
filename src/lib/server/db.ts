import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { createNewUserState } from '#lib/data.ts';
import { MAX_RECIPES } from '#lib/recipe-collection.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_PREFERENCES: Preferences = {
	diet: 'none',
	allergies: '',
	maxTime: 45,
	complexity: 'Easy',
	theme: 'nosh',
	dark: false,
	provider: 'openai',
	model: 'gpt-4o-mini'
};

const databasePath =
	process.env.FLAVORITHM_DB_PATH ?? resolve(process.cwd(), 'data', 'flavorithm.sqlite');
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
export function getDatabase(): DatabaseSync {
	return db;
}

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ${databasePath === ':memory:' ? '' : 'PRAGMA journal_mode = WAL;'}
  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS users_household_idx ON users(household_id);
  CREATE TABLE IF NOT EXISTS household_state (
    household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_expiry_idx ON password_reset_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS household_invites (
    code_hash TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    uses_remaining INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS household_invites_expiry_idx ON household_invites(expires_at);
`);

function ensureVersionColumn(table: 'household_state' | 'user_preferences'): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === 'version')) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
	}
}
ensureVersionColumn('household_state');
ensureVersionColumn('user_preferences');
db.prepare('UPDATE household_invites SET uses_remaining = 1 WHERE uses_remaining > 1').run();

const id = () => randomBytes(16).toString('hex');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function deriveScrypt(password: string, salt: Buffer, length: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(
			password,
			salt,
			length,
			{ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
			(error, derived) => {
				if (error) reject(error);
				else resolve(derived);
			}
		);
	});
}

const nutritionSchema = z.object({
	calories: z.number().finite().min(0).max(1_000_000),
	fat: z.number().finite().min(0).max(1_000_000),
	saturatedFat: z.number().finite().min(0).max(1_000_000),
	sodium: z.number().finite().min(0).max(1_000_000),
	carbs: z.number().finite().min(0).max(1_000_000),
	fiber: z.number().finite().min(0).max(1_000_000),
	sugar: z.number().finite().min(0).max(1_000_000),
	protein: z.number().finite().min(0).max(1_000_000)
});

const recipeIngredientSchema = z.object({
	name: z.string().trim().min(1).max(200),
	quantity: z.number().finite().min(0).max(1_000_000),
	unit: z.string().max(40)
});

const publicUrlSchema = z
	.string()
	.max(4_000)
	.refine((value) => {
		if (!value) return true;
		try {
			const url = new URL(value);
			return url.protocol === 'https:' && !url.username && !url.password;
		} catch {
			return false;
		}
	}, 'Only public HTTPS URLs are allowed');

const recipeSchema = z.object({
	id: z.string().min(1).max(100),
	title: z.string().trim().min(1).max(200),
	description: z.string().max(10_000),
	image: publicUrlSchema,
	time: z.number().finite().min(0).max(100_000),
	servings: z.number().finite().min(1).max(10_000),
	difficulty: z.string().max(80),
	cuisine: z.string().max(100),
	tags: z.array(z.string().max(100)).max(100),
	ingredients: z.array(recipeIngredientSchema).max(250),
	steps: z.array(z.string().max(10_000)).max(200),
	nutrition: nutritionSchema,
	source: publicUrlSchema.optional(),
	provenance: z.enum(['web-import', 'ai-generated']).optional(),
	importNotes: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
	rating: z.number().finite().min(0).max(5).optional(),
	saved: z.boolean().optional()
});

const preferencesSchema = z.object({
	diet: z.string().max(200),
	allergies: z.string().max(2_000),
	maxTime: z.number().finite().min(0).max(100_000),
	complexity: z.string().max(100),
	cuisines: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
	onboardingStatus: z.enum(['completed', 'skipped']).optional(),
	theme: z.string().max(100),
	dark: z.boolean(),
	provider: z.string().max(100),
	model: z.string().max(200),
	chatgptAccountId: z.string().max(100).optional(),
	ratings: z.record(z.string().min(1).max(100), z.number().finite().min(0).max(5)).optional()
});

const appStateSchema = z.object({
	pantry: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				name: z.string().trim().min(1).max(200),
				quantity: z.number().finite().min(0).max(1_000_000),
				unit: z.string().max(40),
				category: z.string().max(100),
				expires: z.string().max(50).optional()
			})
		)
		.max(1_000),
	recipes: z.array(recipeSchema).max(MAX_RECIPES),
	meals: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				date: z.string().max(50),
				slot: z.string().max(100),
				recipeId: z.string().max(100),
				servings: z.number().finite().min(1).max(10_000)
			})
		)
		.max(1_000),
	shopping: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				name: z.string().trim().min(1).max(200),
				quantity: z.number().finite().min(0).max(1_000_000),
				unit: z.string().max(40),
				checked: z.boolean()
			})
		)
		.max(1_000),
	preferences: preferencesSchema
});

export function validateAppState(value: unknown): AppState | null {
	const parsed = appStateSchema.safeParse(value);
	return parsed.success ? (parsed.data as AppState) : null;
}

export async function readJson(request: Request): Promise<unknown> {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		throw new ApiError(413, 'Request body is too large');
	}
	const body = await request.text();
	if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES)
		throw new ApiError(413, 'Request body is too large');
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new ApiError(400, 'Request body must be valid JSON');
	}
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

export function errorResponse(error: unknown): Response {
	const status = error instanceof ApiError ? error.status : 500;
	const message = error instanceof ApiError ? error.message : 'An unexpected server error occurred';
	if (status === 500) console.error('API request failed:', error);
	return Response.json({ error: message }, { status });
}

export function assertSameOrigin(request: Request): void {
	const origin = request.headers.get('origin');
	if (origin && origin !== new URL(request.url).origin)
		throw new ApiError(403, 'Cross-origin request rejected');
}

type DbUserRow = { id: string; name: string; email: string; household_id: string };
function toUser(row: DbUserRow): User {
	return { id: row.id, name: row.name, email: row.email, householdId: row.household_id };
}

export function getUserFromSession(token: string | undefined): User | null {
	if (!token || token.length > 200) return null;
	const now = Date.now();
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const row = db
		.prepare(
			`
    SELECT users.id, users.name, users.email, users.household_id
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `
		)
		.get(hashToken(token), now) as DbUserRow | undefined;
	return row ? toUser(row) : null;
}

/** Return the stored hash for a live session without exposing its bearer token. */
export function getSessionBinding(token: string | undefined): string | null {
	if (!token || token.length > 200) return null;
	const binding = hashToken(token);
	const row = db
		.prepare('SELECT 1 AS active FROM sessions WHERE token_hash = ? AND expires_at > ?')
		.get(binding, Date.now()) as { active: number } | undefined;
	return row ? binding : null;
}

export function deleteSession(token: string | undefined): void {
	if (!token || token.length > 200) return;
	db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function createSession(user: User): { token: string; expiresAt: number } {
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	const expiresAt = now + SESSION_TTL_MS;
	db.prepare(
		'INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
	).run(hashToken(token), user.id, expiresAt, now);
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	return { token, expiresAt };
}

async function passwordDigest(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = await deriveScrypt(password, salt, 64);
	return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const [scheme, n, r, p, saltText, digestText] = encoded.split('$');
	if (scheme !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || !saltText || !digestText)
		return false;
	try {
		const expected = Buffer.from(digestText, 'base64url');
		const actual = await deriveScrypt(
			password,
			Buffer.from(saltText, 'base64url'),
			expected.length
		);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

export async function registerUser(
	name: string,
	rawEmail: string,
	password: string
): Promise<{ user: User; token: string; expiresAt: number }> {
	if (password.length < 10 || password.length > 128)
		throw new ApiError(400, 'Password must be at least 10 characters long');
	const email = rawEmail.trim().toLowerCase();
	if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
		throw new ApiError(409, 'An account with that email already exists');
	const passwordHash = await passwordDigest(password);
	const userId = id();
	const householdId = id();
	const now = Date.now();
	const user = toUser({ id: userId, name: name.trim(), email, household_id: householdId });
	const { preferences, ...initialSharedState } = createNewUserState();
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('INSERT INTO households(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
			householdId,
			`${name.trim()}’s household`,
			userId,
			now
		);
		db.prepare(
			'INSERT INTO users(id, name, email, password_hash, household_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		).run(userId, name.trim(), email, passwordHash, householdId, now);
		db.prepare(
			'INSERT INTO household_state(household_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)'
		).run(householdId, JSON.stringify(initialSharedState), now);
		db.prepare(
			'INSERT INTO user_preferences(user_id, preferences_json, version, updated_at) VALUES (?, ?, 1, ?)'
		).run(userId, JSON.stringify(preferences), now);
		const session = createSession(user);
		db.exec('COMMIT');
		return { user, ...session };
	} catch (error) {
		db.exec('ROLLBACK');
		if (String(error).includes('UNIQUE constraint failed: users.email'))
			throw new ApiError(409, 'An account with that email already exists');
		throw error;
	}
}

export async function loginUser(
	rawEmail: string,
	password: string
): Promise<{ user: User; token: string; expiresAt: number }> {
	const email = rawEmail.trim().toLowerCase();
	const row = db
		.prepare('SELECT id, name, email, household_id, password_hash FROM users WHERE email = ?')
		.get(email) as (DbUserRow & { password_hash: string }) | undefined;
	// Use a fixed dummy digest for unknown accounts to reduce account-enumeration timing differences.
	const valid = await verifyPassword(
		password,
		row?.password_hash ??
			'scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	);
	if (!row || !valid) throw new ApiError(401, 'Invalid email or password');
	const user = toUser(row);
	const session = createSession(user);
	return { user, ...session };
}

export async function deleteUserAccount(userId: string, password: string): Promise<void> {
	const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
		{ password_hash: string } | undefined;
	if (!row || !(await verifyPassword(password, row.password_hash))) {
		throw new ApiError(401, 'Current password is incorrect');
	}

	db.exec('BEGIN IMMEDIATE');
	try {
		const current = db.prepare('SELECT household_id FROM users WHERE id = ?').get(userId) as
			{ household_id: string } | undefined;
		if (!current) throw new ApiError(401, 'Current password is incorrect');
		const household = db
			.prepare('SELECT owner_id FROM households WHERE id = ?')
			.get(current.household_id) as { owner_id: string | null } | undefined;
		const nextOwner =
			household?.owner_id === userId
				? (db
						.prepare(
							'SELECT id FROM users WHERE household_id = ? AND id <> ? ORDER BY created_at, id LIMIT 1'
						)
						.get(current.household_id, userId) as { id: string } | undefined)
				: undefined;

		if (nextOwner) {
			db.prepare('UPDATE households SET owner_id = ? WHERE id = ?').run(
				nextOwner.id,
				current.household_id
			);
		}
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		if (household?.owner_id === userId && !nextOwner) {
			db.prepare('DELETE FROM households WHERE id = ?').run(current.household_id);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function issuePasswordReset(emailInput: string): { email: string; token: string } | null {
	const email = emailInput.trim().toLowerCase();
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(now);
		const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as
			{ id: string; email: string } | undefined;
		if (!user) {
			db.exec('COMMIT');
			return null;
		}
		db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
		db.prepare(
			'INSERT INTO password_reset_tokens(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
		).run(hashToken(token), user.id, now + PASSWORD_RESET_TTL_MS, now);
		db.exec('COMMIT');
		return { email: user.email, token };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export async function resetUserPassword(token: string, password: string): Promise<void> {
	if (token.length < 20 || token.length > 200 || password.length < 10 || password.length > 128) {
		throw new ApiError(400, 'Reset link is invalid or expired. Request a new one.');
	}
	const tokenHash = hashToken(token);
	const now = Date.now();
	const existing = db
		.prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?')
		.get(tokenHash, now) as { user_id: string } | undefined;
	if (!existing) throw new ApiError(400, 'Reset link is invalid or expired. Request a new one.');
	const passwordHash = await passwordDigest(password);

	db.exec('BEGIN IMMEDIATE');
	try {
		const current = db
			.prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?')
			.get(tokenHash, Date.now()) as { user_id: string } | undefined;
		if (!current || current.user_id !== existing.user_id) {
			throw new ApiError(400, 'Reset link is invalid or expired. Request a new one.');
		}
		db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
			passwordHash,
			current.user_id
		);
		db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(current.user_id);
		db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.user_id);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export async function sendPasswordResetEmail(
	email: string,
	resetUrl: string,
	apiKey: string,
	from: string,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	const safeUrl = resetUrl
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
	try {
		const response = await fetcher(RESEND_ENDPOINT, {
			method: 'POST',
			redirect: 'error',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				from,
				to: [email],
				subject: 'Reset your Flavorithm password',
				text: `Use this link to reset your password. It expires in one hour.\n\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`,
				html: `<p>Use this link to reset your Flavorithm password. It expires in one hour.</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this message.</p>`
			}),
			signal: AbortSignal.timeout(10_000)
		});
		return response.ok;
	} catch {
		return false;
	}
}

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
export function consumeRateLimit(key: string, limit: number, windowMs: number): void {
	const now = Date.now();
	if (rateBuckets.size > 2_000) {
		for (const [bucketKey, bucket] of rateBuckets)
			if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
	}
	const current = rateBuckets.get(key);
	if (!current || current.resetAt <= now) {
		rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
		return;
	}
	if (current.count >= limit) throw new ApiError(429, 'Too many attempts. Please try again later.');
	current.count += 1;
}

export function getState(user: User): AppState | null {
	const row = db
		.prepare('SELECT state_json FROM household_state WHERE household_id = ?')
		.get(user.householdId) as { state_json: string } | undefined;
	if (!row) return null;
	try {
		const shared = JSON.parse(row.state_json) as Omit<AppState, 'preferences'>;
		const preferenceRow = db
			.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?')
			.get(user.id) as { preferences_json: string } | undefined;
		const preferences = preferenceRow
			? (JSON.parse(preferenceRow.preferences_json) as Preferences)
			: DEFAULT_PREFERENCES;
		const ratings = preferences.ratings ?? {};
		const recipes = shared.recipes.map((recipe) => {
			const { rating: _householdRating, ...householdRecipe } = recipe;
			const personalRating = ratings[recipe.id];
			return personalRating === undefined
				? householdRecipe
				: { ...householdRecipe, rating: personalRating };
		});
		const parsed = appStateSchema.safeParse({ ...shared, recipes, preferences });
		return parsed.success ? (parsed.data as AppState) : null;
	} catch {
		return null;
	}
}

export function getStateEtag(user: User): string {
	const household = db
		.prepare('SELECT version FROM household_state WHERE household_id = ?')
		.get(user.householdId) as { version: number } | undefined;
	const preferences = db
		.prepare('SELECT version FROM user_preferences WHERE user_id = ?')
		.get(user.id) as { version: number } | undefined;
	return `"${hashToken(`${user.householdId}:${user.id}:${household?.version ?? 0}:${preferences?.version ?? 0}`)}"`;
}

export function saveState(
	user: User,
	value: AppState,
	conditions: { ifMatch: string | null; ifNoneMatch: string | null }
): AppState {
	const { preferences, ...stateWithoutPreferences } = value;
	const ratings: Record<string, number> = {};
	const sharedRecipes = stateWithoutPreferences.recipes.map((recipe) => {
		const { rating, ...sharedRecipe } = recipe;
		if (rating !== undefined) ratings[recipe.id] = rating;
		return sharedRecipe;
	});
	const shared = { ...stateWithoutPreferences, recipes: sharedRecipes };
	const personalPreferences: Preferences = { ...preferences, ratings };
	const now = Date.now();
	db.exec('BEGIN IMMEDIATE');
	try {
		const existing = db
			.prepare('SELECT 1 FROM household_state WHERE household_id = ?')
			.get(user.householdId);
		if (existing) {
			if (conditions.ifNoneMatch?.trim() === '*') {
				throw new ApiError(
					412,
					'This kitchen has already been initialized. Reload its latest state and try again.'
				);
			}
			if (!conditions.ifMatch)
				throw new ApiError(428, 'If-Match is required to update this kitchen.');
			if (conditions.ifMatch !== getStateEtag(user)) {
				throw new ApiError(
					412,
					'This kitchen changed in another session. Reload its latest state and try again.'
				);
			}
		} else {
			if (conditions.ifMatch)
				throw new ApiError(
					412,
					'This kitchen no longer has the state you loaded. Reload before saving.'
				);
			if (conditions.ifNoneMatch?.trim() !== '*')
				throw new ApiError(428, 'If-None-Match: * is required to initialize this kitchen.');
		}
		db.prepare(
			`INSERT INTO household_state(household_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(household_id) DO UPDATE SET state_json = excluded.state_json, version = household_state.version + 1, updated_at = excluded.updated_at`
		).run(user.householdId, JSON.stringify(shared), now);
		db.prepare(
			`INSERT INTO user_preferences(user_id, preferences_json, version, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET preferences_json = excluded.preferences_json, version = user_preferences.version + 1, updated_at = excluded.updated_at`
		).run(user.id, JSON.stringify(personalPreferences), now);
		db.exec('COMMIT');
		return value;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export type HouseholdMember = Pick<User, 'id' | 'name' | 'email'>;
export function listHouseholdMembers(user: User): HouseholdMember[] {
	return db
		.prepare('SELECT id, name, email FROM users WHERE household_id = ? ORDER BY created_at, id')
		.all(user.householdId) as HouseholdMember[];
}

export function createHouseholdInvite(user: User): { inviteCode: string; expiresAt: number } {
	const inviteCode = randomBytes(12).toString('base64url');
	const expiresAt = Date.now() + INVITE_TTL_MS;
	db.prepare('DELETE FROM household_invites WHERE expires_at <= ? OR uses_remaining <= 0').run(
		Date.now()
	);
	db.prepare(
		'INSERT INTO household_invites(code_hash, household_id, created_by, expires_at, uses_remaining) VALUES (?, ?, ?, ?, ?)'
	).run(hashToken(inviteCode), user.householdId, user.id, expiresAt, 1);
	return { inviteCode, expiresAt };
}

function makePersonalHousehold(user: User): string {
	const householdId = id();
	db.prepare('INSERT INTO households(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
		householdId,
		`${user.name}’s household`,
		user.id,
		Date.now()
	);
	db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(householdId, user.id);
	return householdId;
}

function removeUserFromOldHousehold(user: User, oldHouseholdId: string): void {
	const house = db.prepare('SELECT owner_id FROM households WHERE id = ?').get(oldHouseholdId) as
		{ owner_id: string | null } | undefined;
	if (!house || house.owner_id !== user.id) return;
	const nextOwner = db
		.prepare(
			`SELECT id FROM users WHERE household_id = ? AND id <> ? ORDER BY created_at, id LIMIT 1`
		)
		.get(oldHouseholdId, user.id) as { id: string } | undefined;
	if (nextOwner)
		db.prepare('UPDATE households SET owner_id = ? WHERE id = ?').run(nextOwner.id, oldHouseholdId);
	else db.prepare('DELETE FROM households WHERE id = ?').run(oldHouseholdId);
}

export function joinHousehold(user: User, rawCode: string): User {
	const code = rawCode.trim();
	if (code.length < 8 || code.length > 100)
		throw new ApiError(400, 'Invalid or expired invite code');
	db.exec('BEGIN IMMEDIATE');
	try {
		const now = Date.now();
		const invite = db
			.prepare(
				'SELECT household_id, expires_at, uses_remaining FROM household_invites WHERE code_hash = ?'
			)
			.get(hashToken(code)) as
			{ household_id: string; expires_at: number; uses_remaining: number } | undefined;
		if (!invite || invite.expires_at <= now || invite.uses_remaining <= 0)
			throw new ApiError(400, 'Invalid or expired invite code');
		if (invite.household_id === user.householdId)
			throw new ApiError(409, 'You are already in this household');
		const oldHouseholdId = user.householdId;
		db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(invite.household_id, user.id);
		db.prepare(
			'UPDATE household_invites SET uses_remaining = uses_remaining - 1 WHERE code_hash = ?'
		).run(hashToken(code));
		removeUserFromOldHousehold(user, oldHouseholdId);
		db.exec('COMMIT');
		return { ...user, householdId: invite.household_id };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function leaveHousehold(user: User): User {
	const oldHouseholdId = user.householdId;
	db.exec('BEGIN IMMEDIATE');
	try {
		makePersonalHousehold(user);
		removeUserFromOldHousehold(user, oldHouseholdId);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	const row = db.prepare('SELECT household_id FROM users WHERE id = ?').get(user.id) as
		{ household_id: string } | undefined;
	if (!row) throw new ApiError(401, 'Authentication required');
	return { ...user, householdId: row.household_id };
}
