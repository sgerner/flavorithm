import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { createNewUserState } from '#lib/data.ts';
import { COVER_PATH } from '#lib/cover-upload.ts';
import { MAX_RECIPES } from '#lib/recipe-collection.ts';
import type { AppState, Preferences, User } from '#lib/types.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
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
    email_verified_at INTEGER,
    sso_only INTEGER NOT NULL DEFAULT 0,
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
    auth_source TEXT NOT NULL DEFAULT 'local',
    issuer TEXT,
    subject TEXT,
    client_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS external_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (issuer, subject)
  );
  CREATE INDEX IF NOT EXISTS external_identities_user_idx ON external_identities(user_id);
  CREATE TABLE IF NOT EXISTS oidc_login_transactions (
    state_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_to TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oidc_login_transactions_expiry_idx ON oidc_login_transactions(expires_at);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS password_reset_expiry_idx ON password_reset_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS household_invites (
    code_hash TEXT PRIMARY KEY,
    invite_id TEXT,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    uses_remaining INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS household_invites_expiry_idx ON household_invites(expires_at);
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_verification_expiry_idx ON email_verification_tokens(expires_at);
`);

function ensureVersionColumn(table: 'household_state' | 'user_preferences'): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === 'version')) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
	}
}
ensureVersionColumn('household_state');
ensureVersionColumn('user_preferences');
const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
if (!userColumns.some((column) => column.name === 'email_verified_at')) {
	db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
}
const inviteColumns = db.prepare('PRAGMA table_info(household_invites)').all() as Array<{
	name: string;
}>;
if (!inviteColumns.some((column) => column.name === 'invite_id')) {
	db.exec('ALTER TABLE household_invites ADD COLUMN invite_id TEXT');
}
db.exec(`
  UPDATE household_invites SET invite_id = code_hash WHERE invite_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS household_invites_id_idx ON household_invites(invite_id);
`);
db.prepare('UPDATE household_invites SET uses_remaining = 1 WHERE uses_remaining > 1').run();
const userAuthColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
if (!userAuthColumns.some((column) => column.name === 'sso_only')) {
	db.exec('ALTER TABLE users ADD COLUMN sso_only INTEGER NOT NULL DEFAULT 0');
}
const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
if (!sessionColumns.some((column) => column.name === 'auth_source')) {
	db.exec("ALTER TABLE sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
}
if (!sessionColumns.some((column) => column.name === 'issuer')) {
	db.exec('ALTER TABLE sessions ADD COLUMN issuer TEXT');
}
if (!sessionColumns.some((column) => column.name === 'subject')) {
	db.exec('ALTER TABLE sessions ADD COLUMN subject TEXT');
}
if (!sessionColumns.some((column) => column.name === 'client_id')) {
	db.exec('ALTER TABLE sessions ADD COLUMN client_id TEXT');
}

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
	image: z.union([publicUrlSchema, z.string().regex(COVER_PATH)]),
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
	nutritionStale: z.boolean().optional(),
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
	reasoning: z
		.object({
			effort: z
				.string()
				.regex(/^[a-z_]{1,24}$/)
				.optional(),
			enabled: z.boolean().optional(),
			budgetTokens: z.number().int().min(0).max(32_768).optional()
		})
		.optional(),
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
				servings: z.number().finite().min(1).max(10_000),
				completedAt: z.string().max(50).optional(),
				leftoverServings: z.number().finite().min(0).max(10_000).optional()
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
				checked: z.boolean(),
				sourceKey: z.string().max(200).optional()
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

type DbUserRow = {
	id: string;
	name: string;
	email: string;
	household_id: string;
	email_verified_at?: number | null;
};
function toUser(row: DbUserRow): User {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		householdId: row.household_id,
		emailVerified: row.email_verified_at != null
	};
}

function getCurrentUser(userId: string): DbUserRow | undefined {
	return db
		.prepare('SELECT id, name, email, household_id, email_verified_at FROM users WHERE id = ?')
		.get(userId) as DbUserRow | undefined;
}

function assertCurrentHousehold(user: User): DbUserRow {
	const current = getCurrentUser(user.id);
	if (!current) throw new ApiError(401, 'Authentication required');
	if (current.household_id !== user.householdId)
		throw new ApiError(409, 'Your household changed. Reload the latest kitchen and try again.');
	return current;
}

export function getUserFromSession(token: string | undefined): User | null {
	if (!token || token.length > 200) return null;
	const now = Date.now();
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const row = db
		.prepare(
			`
			SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.auth_source = 'local'
  `
		)
		.get(hashToken(token), now) as DbUserRow | undefined;
	return row ? toUser(row) : null;
}

function getUserFromSsoSession(token: string | undefined, source: 'oidc' | 'proxy'): User | null {
	if (!token || token.length > 200) return null;
	const now = Date.now();
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const row = db
		.prepare(
			`SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
			 FROM sessions JOIN users ON users.id = sessions.user_id
			 WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND sessions.auth_source = ?`
		)
		.get(hashToken(token), now, source) as DbUserRow | undefined;
	return row ? toUser(row) : null;
}

export function getUserFromOidcSession(
	token: string | undefined,
	issuer: string,
	clientId: string
): User | null {
	if (!token || token.length > 200) return null;
	const now = Date.now();
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const row = db
		.prepare(
			`SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
			 FROM sessions JOIN users ON users.id = sessions.user_id
			 WHERE sessions.token_hash = ? AND sessions.expires_at > ?
			   AND sessions.auth_source = 'oidc' AND sessions.issuer = ? AND sessions.client_id = ?`
		)
		.get(hashToken(token), now, issuer, clientId) as DbUserRow | undefined;
	return row ? toUser(row) : null;
}

/** Return the stored hash for a live session without exposing its bearer token. */
export function getSessionBinding(token: string | undefined): string | null {
	if (!token || token.length > 200) return null;
	const rawMode = process.env.FLAVORITHM_AUTH_MODE;
	const configuredMode = rawMode === undefined ? 'local' : rawMode.trim().toLowerCase();
	const source =
		configuredMode === 'local'
			? 'local'
			: configuredMode === 'oidc'
				? 'oidc'
				: configuredMode === 'proxy'
					? 'proxy'
					: null;
	if (!source) return null;
	const binding = hashToken(token);
	let oidcIssuer = '';
	if (source === 'oidc') {
		try {
			oidcIssuer = new URL(process.env.FLAVORITHM_OIDC_ISSUER?.trim() ?? '').href;
		} catch {
			return null;
		}
	}
	const query =
		source === 'oidc'
			? {
					sql: 'SELECT 1 AS active FROM sessions WHERE token_hash = ? AND expires_at > ? AND auth_source = ? AND issuer = ? AND client_id = ?',
					parameters: [
						binding,
						Date.now(),
						source,
						oidcIssuer,
						process.env.FLAVORITHM_OIDC_CLIENT_ID?.trim() ?? ''
					]
				}
			: source === 'proxy'
				? {
						sql: 'SELECT 1 AS active FROM sessions WHERE token_hash = ? AND expires_at > ? AND auth_source = ? AND issuer = ?',
						parameters: [
							binding,
							Date.now(),
							source,
							process.env.FLAVORITHM_PROXY_ISSUER?.trim() || 'flavorithm:proxy'
						]
					}
				: {
						sql: 'SELECT 1 AS active FROM sessions WHERE token_hash = ? AND expires_at > ? AND auth_source = ?',
						parameters: [binding, Date.now(), source]
					};
	const row = db.prepare(query.sql).get(...query.parameters) as { active: number } | undefined;
	return row ? binding : null;
}

export function deleteSession(token: string | undefined): void {
	if (!token || token.length > 200) return;
	db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function createOidcLoginTransaction(input: {
	state: string;
	browserToken: string;
	codeVerifier: string;
	nonce: string;
	returnTo: string;
	ttlMs?: number;
}): void {
	const now = Date.now();
	db.prepare('DELETE FROM oidc_login_transactions WHERE expires_at <= ?').run(now);
	db.prepare(
		`INSERT INTO oidc_login_transactions
		 (state_hash, browser_hash, code_verifier, nonce, return_to, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(
		hashToken(input.state),
		hashToken(input.browserToken),
		input.codeVerifier,
		input.nonce,
		input.returnTo,
		now + (input.ttlMs ?? 10 * 60 * 1000),
		now
	);
}

export function consumeOidcLoginTransaction(
	state: string,
	browserToken: string
): { codeVerifier: string; nonce: string; returnTo: string } | null {
	if (state.length > 500 || browserToken.length > 200) return null;
	const row = db
		.prepare(
			`DELETE FROM oidc_login_transactions
			 WHERE state_hash = ? AND browser_hash = ? AND expires_at > ?
			 RETURNING code_verifier, nonce, return_to`
		)
		.get(hashToken(state), hashToken(browserToken), Date.now()) as
		{ code_verifier: string; nonce: string; return_to: string } | undefined;
	return row
		? { codeVerifier: row.code_verifier, nonce: row.nonce, returnTo: row.return_to }
		: null;
}

function createSession(
	user: User,
	source: 'local' | 'oidc' | 'proxy' = 'local',
	issuer?: string,
	subject?: string,
	clientId?: string,
	ttlMs = SESSION_TTL_MS
): { token: string; expiresAt: number } {
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	const expiresAt = now + ttlMs;
	db.prepare(
		'INSERT INTO sessions(token_hash, user_id, auth_source, issuer, subject, client_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	).run(
		hashToken(token),
		user.id,
		source,
		issuer ?? null,
		subject ?? null,
		clientId ?? null,
		expiresAt,
		now
	);
	db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	return { token, expiresAt };
}

export function createOidcSession(
	user: User,
	issuer: string,
	subject: string,
	clientId: string,
	ttlMs: number
): { token: string; expiresAt: number } {
	return createSession(user, 'oidc', issuer, subject, clientId, ttlMs);
}

export function ensureProxyBindingSession(
	currentToken: string | undefined,
	user: User,
	issuer: string,
	subject: string,
	ttlMs: number
): { token: string; expiresAt: number } {
	const now = Date.now();
	if (currentToken && currentToken.length <= 200) {
		const tokenHash = hashToken(currentToken);
		const activeProxyBinding = db
			.prepare(
				`SELECT issuer, subject FROM sessions
				 WHERE token_hash = ? AND auth_source = 'proxy' AND expires_at > ?`
			)
			.get(tokenHash, now) as { issuer: string | null; subject: string | null } | undefined;
		const existing = db
			.prepare(
				`SELECT 1 AS active FROM sessions
				 WHERE token_hash = ? AND user_id = ? AND auth_source = 'proxy'
				   AND issuer = ? AND subject = ? AND expires_at > ?`
			)
			.get(tokenHash, user.id, issuer, subject, now) as { active: number } | undefined;
		if (existing) {
			const expiresAt = now + ttlMs;
			db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
				expiresAt,
				tokenHash
			);
			return { token: currentToken, expiresAt };
		}
		if (activeProxyBinding) {
			// Identity changes revoke the previous binding so an outstanding OAuth
			// callback cannot be completed under a different proxy identity.
			db.prepare("DELETE FROM sessions WHERE token_hash = ? AND auth_source = 'proxy'").run(
				tokenHash
			);
		}
	}
	return createSession(user, 'proxy', issuer, subject, undefined, ttlMs);
}

export function revokeProxyBindingSession(token: string | undefined): void {
	if (!token || token.length > 200) return;
	db.prepare("DELETE FROM sessions WHERE token_hash = ? AND auth_source = 'proxy'").run(
		hashToken(token)
	);
}

export function revokeOidcSession(token: string | undefined): void {
	if (!token || token.length > 200) return;
	db.prepare("DELETE FROM sessions WHERE token_hash = ? AND auth_source = 'oidc'").run(
		hashToken(token)
	);
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
	const user = toUser({
		id: userId,
		name: name.trim(),
		email,
		household_id: householdId,
		email_verified_at: null
	});
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

export function resolveExternalIdentity(input: {
	issuer: string;
	subject: string;
	email: string;
	name?: string | null;
	emailVerified: boolean;
}): User {
	const issuer = input.issuer.trim();
	// Provider subjects are opaque identifiers: normalization could merge two accounts.
	const subject = input.subject;
	const email = input.email.trim().toLowerCase();
	const name = (input.name?.trim() || email).slice(0, 80);
	if (!issuer || issuer.length > 2_000 || !subject || subject.length > 500) {
		throw new ApiError(401, 'The identity provider returned an invalid identity');
	}
	if (email.length > 254 || !z.string().email().safeParse(email).success) {
		throw new ApiError(401, 'The identity provider did not provide a valid email address');
	}
	const now = Date.now();
	db.exec('BEGIN IMMEDIATE');
	try {
		const identity = db
			.prepare(
				`SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
				 FROM external_identities JOIN users ON users.id = external_identities.user_id
				 WHERE external_identities.issuer = ? AND external_identities.subject = ?`
			)
			.get(issuer, subject) as DbUserRow | undefined;
		if (identity) {
			const collision = db
				.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?')
				.get(email, identity.id) as { id: string } | undefined;
			if (collision) throw new ApiError(409, 'This identity cannot be linked to the account');
			const emailChanged = identity.email.toLowerCase() !== email;
			const emailVerifiedAt = emailChanged
				? input.emailVerified
					? now
					: null
				: input.emailVerified
					? (identity.email_verified_at ?? now)
					: (identity.email_verified_at ?? null);
			db.prepare('UPDATE users SET name = ?, email = ?, email_verified_at = ? WHERE id = ?').run(
				name,
				email,
				emailVerifiedAt,
				identity.id
			);
			db.prepare(
				'UPDATE external_identities SET email = ?, updated_at = ? WHERE issuer = ? AND subject = ?'
			).run(email, now, issuer, subject);
			const updated = getCurrentUser(identity.id);
			if (!updated) throw new ApiError(401, 'Authentication required');
			db.exec('COMMIT');
			return toUser(updated);
		}

		// Email is only a profile attribute. It never authorizes linking an external
		// identity to a pre-existing local account.
		if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
			throw new ApiError(409, 'This identity cannot be linked to the account');
		}
		const userId = id();
		const householdId = id();
		const user = toUser({
			id: userId,
			name,
			email,
			household_id: householdId,
			email_verified_at: input.emailVerified ? now : null
		});
		const { preferences, ...initialSharedState } = createNewUserState();
		db.prepare('INSERT INTO households(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
			householdId,
			`${name}’s household`,
			userId,
			now
		);
		db.prepare(
			'INSERT INTO users(id, name, email, password_hash, household_id, email_verified_at, sso_only, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
		).run(userId, name, email, '', householdId, user.emailVerified ? now : null, now);
		db.prepare(
			'INSERT INTO household_state(household_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)'
		).run(householdId, JSON.stringify(initialSharedState), now);
		db.prepare(
			'INSERT INTO user_preferences(user_id, preferences_json, version, updated_at) VALUES (?, ?, 1, ?)'
		).run(userId, JSON.stringify(preferences), now);
		db.prepare(
			'INSERT INTO external_identities(issuer, subject, user_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
		).run(issuer, subject, userId, email, now, now);
		db.exec('COMMIT');
		return user;
	} catch (error) {
		db.exec('ROLLBACK');
		if (String(error).includes('UNIQUE constraint failed: users.email')) {
			throw new ApiError(409, 'This identity cannot be linked to the account');
		}
		if (
			String(error).includes(
				'UNIQUE constraint failed: external_identities.issuer, external_identities.subject'
			)
		) {
			// A concurrent request may have created the same identity between lookup and insert.
			const existing = db
				.prepare(
					`SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
					 FROM external_identities JOIN users ON users.id = external_identities.user_id
					 WHERE external_identities.issuer = ? AND external_identities.subject = ?`
				)
				.get(issuer, subject) as DbUserRow | undefined;
			if (existing) return toUser(existing);
		}
		throw error;
	}
}

export async function loginUser(
	rawEmail: string,
	password: string
): Promise<{ user: User; token: string; expiresAt: number }> {
	const email = rawEmail.trim().toLowerCase();
	const row = db
		.prepare(
			'SELECT id, name, email, household_id, email_verified_at, password_hash, sso_only FROM users WHERE email = ?'
		)
		.get(email) as (DbUserRow & { password_hash: string; sso_only: number }) | undefined;
	// Use a fixed dummy digest for unknown accounts to reduce account-enumeration timing differences.
	const valid = await verifyPassword(
		password,
		row && !row.sso_only
			? row.password_hash
			: 'scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
	);
	if (!row || row.sso_only || !valid) throw new ApiError(401, 'Invalid email or password');
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
		const user = db.prepare('SELECT id, email, sso_only FROM users WHERE email = ?').get(email) as
			{ id: string; email: string; sso_only: number } | undefined;
		if (!user || user.sso_only) {
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
		.prepare(
			`SELECT password_reset_tokens.user_id, users.sso_only
			 FROM password_reset_tokens JOIN users ON users.id = password_reset_tokens.user_id
			 WHERE password_reset_tokens.token_hash = ? AND password_reset_tokens.expires_at > ?`
		)
		.get(tokenHash, now) as { user_id: string; sso_only: number } | undefined;
	if (!existing || existing.sso_only)
		throw new ApiError(400, 'Reset link is invalid or expired. Request a new one.');
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

export function issueEmailVerification(userId: string): { email: string; token: string } | null {
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('DELETE FROM email_verification_tokens WHERE expires_at <= ?').run(now);
		const user = db
			.prepare('SELECT email, email_verified_at FROM users WHERE id = ?')
			.get(userId) as { email: string; email_verified_at: number | null } | undefined;
		if (!user) throw new ApiError(401, 'Authentication required');
		if (user.email_verified_at != null) {
			db.exec('COMMIT');
			return null;
		}
		db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
		db.prepare(
			'INSERT INTO email_verification_tokens(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
		).run(hashToken(token), userId, now + EMAIL_VERIFICATION_TTL_MS, now);
		db.exec('COMMIT');
		return { email: user.email, token };
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function verifyEmailToken(token: string): User {
	if (token.length < 20 || token.length > 200)
		throw new ApiError(400, 'Verification link is invalid or expired. Request a new one.');
	const tokenHash = hashToken(token);
	const now = Date.now();
	db.exec('BEGIN IMMEDIATE');
	try {
		db.prepare('DELETE FROM email_verification_tokens WHERE expires_at <= ?').run(now);
		const row = db
			.prepare(
				`SELECT users.id, users.name, users.email, users.household_id, users.email_verified_at
				 FROM email_verification_tokens
				 JOIN users ON users.id = email_verification_tokens.user_id
				 WHERE email_verification_tokens.token_hash = ?
				   AND email_verification_tokens.expires_at > ?`
			)
			.get(tokenHash, now) as DbUserRow | undefined;
		if (!row)
			throw new ApiError(400, 'Verification link is invalid or expired. Request a new one.');
		db.prepare(
			'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?'
		).run(now, row.id);
		db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(row.id);
		db.exec('COMMIT');
		return toUser({ ...row, email_verified_at: row.email_verified_at ?? now });
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export async function sendEmailVerificationEmail(
	email: string,
	verificationUrl: string,
	apiKey: string,
	from: string,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	const safeUrl = verificationUrl
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
				subject: 'Verify your Flavorithm email',
				text: `Use this link to verify your email address. It expires in 24 hours.\n\n${verificationUrl}\n\nIf you did not request this, you can ignore this message.`,
				html: `<p>Use this link to verify your Flavorithm email address. It expires in 24 hours.</p><p><a href="${safeUrl}">Verify email</a></p><p>If you did not request this, you can ignore this message.</p>`
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
	assertCurrentHousehold(user);
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
	assertCurrentHousehold(user);
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
		assertCurrentHousehold(user);
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

export type HouseholdMember = Pick<User, 'id' | 'name' | 'email'> & { role: 'owner' | 'member' };
export function listHouseholdMembers(user: User): HouseholdMember[] {
	return db
		.prepare(
			`SELECT users.id, users.name, users.email,
			  CASE WHEN households.owner_id = users.id THEN 'owner' ELSE 'member' END AS role
			 FROM users JOIN households ON households.id = users.household_id
			 WHERE users.household_id = ? ORDER BY users.created_at, users.id`
		)
		.all(user.householdId) as HouseholdMember[];
}

export type HouseholdInvite = { inviteId: string; expiresAt: number };
export function listHouseholdInvites(user: User): HouseholdInvite[] {
	const now = Date.now();
	db.prepare('DELETE FROM household_invites WHERE expires_at <= ? OR uses_remaining <= 0').run(now);
	return db
		.prepare(
			`SELECT invite_id AS inviteId, expires_at AS expiresAt
			 FROM household_invites
			 WHERE household_id = ? AND expires_at > ? AND uses_remaining > 0
			 ORDER BY expires_at`
		)
		.all(user.householdId, now) as HouseholdInvite[];
}

function assertHouseholdOwner(user: User): void {
	assertCurrentHousehold(user);
	const household = db
		.prepare('SELECT owner_id FROM households WHERE id = ?')
		.get(user.householdId) as { owner_id: string | null } | undefined;
	if (!household || household.owner_id !== user.id)
		throw new ApiError(403, 'Only the household owner can manage members and invitations');
}

export function createHouseholdInvite(user: User): {
	inviteCode: string;
	inviteId: string;
	expiresAt: number;
} {
	assertHouseholdOwner(user);
	const inviteCode = randomBytes(12).toString('base64url');
	const inviteId = hashToken(inviteCode);
	const expiresAt = Date.now() + INVITE_TTL_MS;
	db.prepare('DELETE FROM household_invites WHERE expires_at <= ? OR uses_remaining <= 0').run(
		Date.now()
	);
	db.prepare(
		'INSERT INTO household_invites(code_hash, invite_id, household_id, created_by, expires_at, uses_remaining) VALUES (?, ?, ?, ?, ?, ?)'
	).run(hashToken(inviteCode), inviteId, user.householdId, user.id, expiresAt, 1);
	return { inviteCode, inviteId, expiresAt };
}

export function revokeHouseholdInvite(user: User, inviteId: string): void {
	assertHouseholdOwner(user);
	const result = db
		.prepare('DELETE FROM household_invites WHERE invite_id = ? AND household_id = ?')
		.run(inviteId, user.householdId);
	if (Number(result.changes) === 0) throw new ApiError(404, 'Invitation not found');
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
		assertCurrentHousehold(user);
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
		assertCurrentHousehold(user);
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

export function removeHouseholdMember(owner: User, memberId: string): User {
	if (memberId === owner.id)
		throw new ApiError(400, 'The household owner cannot remove themselves');
	db.exec('BEGIN IMMEDIATE');
	try {
		assertHouseholdOwner(owner);
		const member = db
			.prepare('SELECT id, name, household_id FROM users WHERE id = ?')
			.get(memberId) as { id: string; name: string; household_id: string } | undefined;
		if (!member) throw new ApiError(404, 'Household member not found');
		if (member.household_id !== owner.householdId)
			throw new ApiError(403, 'That user is not a member of your household');

		const personalHouseholdId = id();
		const now = Date.now();
		const { preferences: _preferences, ...initialSharedState } = createNewUserState();
		db.prepare('INSERT INTO households(id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
			personalHouseholdId,
			`${member.name}’s household`,
			member.id,
			now
		);
		db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(
			personalHouseholdId,
			member.id
		);
		db.prepare(
			'INSERT INTO household_state(household_id, state_json, version, updated_at) VALUES (?, ?, 1, ?)'
		).run(personalHouseholdId, JSON.stringify(initialSharedState), now);
		const currentMember = getCurrentUser(member.id);
		if (!currentMember) throw new ApiError(404, 'Household member not found');
		db.exec('COMMIT');
		return toUser(currentMember);
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
