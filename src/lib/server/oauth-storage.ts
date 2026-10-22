import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { getDatabase } from '#lib/server/db.ts';

export type OAuthMode = 'local' | 'hosted';

export type ChatGPTCredentials = {
	accessToken: string;
	refreshToken: string | null;
	idToken: string;
};

export type ChatGPTAccount = {
	id: string;
	userId: string;
	mode: OAuthMode;
	clientId: string;
	subject: string;
	email: string | null;
	label: string;
	scopes: string[];
	credentialEnvelope: string | null;
	expiresAt: number;
	earliestRefreshAt: number;
	refreshLockToken: string | null;
	refreshLockUntil: number | null;
	createdAt: number;
	updatedAt: number;
};

const db = getDatabase();
db.exec(`
	CREATE TABLE IF NOT EXISTS chatgpt_oauth_accounts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		mode TEXT NOT NULL CHECK (mode IN ('local', 'hosted')),
		client_id TEXT NOT NULL,
		subject TEXT NOT NULL,
		email TEXT,
		label TEXT NOT NULL,
		scopes_json TEXT NOT NULL,
		credential_envelope TEXT,
		expires_at INTEGER NOT NULL DEFAULT 0,
		earliest_refresh_at INTEGER NOT NULL DEFAULT 0,
		refresh_lock_token TEXT,
		refresh_lock_until INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		UNIQUE(user_id, client_id, subject)
	);
	CREATE INDEX IF NOT EXISTS chatgpt_oauth_user_idx ON chatgpt_oauth_accounts(user_id);
	CREATE TABLE IF NOT EXISTS chatgpt_oauth_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		ext_agent_host_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS chatgpt_oauth_pending (
		state_hash TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		envelope TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS chatgpt_oauth_pending_expiry_idx ON chatgpt_oauth_pending(expires_at);
`);

type AccountRow = {
	id: string;
	user_id: string;
	mode: OAuthMode;
	client_id: string;
	subject: string;
	email: string | null;
	label: string;
	scopes_json: string;
	credential_envelope: string | null;
	expires_at: number;
	earliest_refresh_at: number;
	refresh_lock_token: string | null;
	refresh_lock_until: number | null;
	created_at: number;
	updated_at: number;
};

let memoryLocalKey: Buffer | undefined;

function keyFor(mode: OAuthMode): Buffer {
	if (mode === 'hosted') {
		const configured = process.env.FLAVORITHM_OAUTH_ENCRYPTION_KEY?.trim();
		if (!configured) throw new Error('Hosted OAuth encryption is unavailable.');
		const key = Buffer.from(configured, 'base64');
		if (key.length !== 32 || key.toString('base64') !== configured) {
			throw new Error('Hosted OAuth encryption is unavailable.');
		}
		return key;
	}

	if (process.env.FLAVORITHM_DB_PATH === ':memory:') {
		memoryLocalKey ??= randomBytes(32);
		return memoryLocalKey;
	}

	const dbPath =
		process.env.FLAVORITHM_DB_PATH ?? resolve(process.cwd(), 'data', 'flavorithm.sqlite');
	const keyPath = resolve(dirname(dbPath), 'oauth.key');
	mkdirSync(dirname(keyPath), { recursive: true });
	if (!existsSync(keyPath)) {
		const freshKey = randomBytes(32);
		try {
			writeFileSync(keyPath, freshKey, { flag: 'wx', mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	const key = readFileSync(keyPath);
	if (key.length !== 32) throw new Error('Local OAuth encryption is unavailable.');
	chmodSync(keyPath, 0o600);
	return key;
}

function aad(userId: string, accountId: string, mode: OAuthMode): Buffer {
	return Buffer.from(`flavorithm:chatgpt:${mode}:${userId}:${accountId}`);
}

function encryptHostedPending(userId: string, stateHash: string, value: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFor('hosted'), iv);
	cipher.setAAD(Buffer.from(`flavorithm:chatgpt:hosted-pending:${userId}:${stateHash}`));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return JSON.stringify({
		iv: iv.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
		data: ciphertext.toString('base64url')
	});
}

function decryptHostedPending(userId: string, stateHash: string, envelope: string): string {
	const parsed = JSON.parse(envelope) as { iv?: string; tag?: string; data?: string };
	if (!parsed.iv || !parsed.tag || !parsed.data)
		throw new Error('OAuth transaction is unavailable.');
	const decipher = createDecipheriv(
		'aes-256-gcm',
		keyFor('hosted'),
		Buffer.from(parsed.iv, 'base64url')
	);
	decipher.setAAD(Buffer.from(`flavorithm:chatgpt:hosted-pending:${userId}:${stateHash}`));
	decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
	return Buffer.concat([
		decipher.update(Buffer.from(parsed.data, 'base64url')),
		decipher.final()
	]).toString('utf8');
}

export function storeHostedOAuthTransaction(input: {
	stateHash: string;
	userId: string;
	createdAt: number;
	expiresAt: number;
	payload: string;
}): void {
	if (input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 10 * 60 * 1000) {
		throw new Error('OAuth transaction expiration is invalid.');
	}
	db.prepare('DELETE FROM chatgpt_oauth_pending WHERE expires_at <= ?').run(input.createdAt);
	const envelope = encryptHostedPending(input.userId, input.stateHash, input.payload);
	db.prepare(
		'INSERT INTO chatgpt_oauth_pending(state_hash, user_id, created_at, expires_at, envelope) VALUES (?, ?, ?, ?, ?)'
	).run(input.stateHash, input.userId, input.createdAt, input.expiresAt, envelope);
}

export function consumeHostedOAuthTransaction(
	stateHash: string,
	now = Date.now()
): { userId: string; createdAt: number; payload: string } | null {
	const row = db
		.prepare(
			'DELETE FROM chatgpt_oauth_pending WHERE state_hash = ? RETURNING user_id, created_at, expires_at, envelope'
		)
		.get(stateHash) as
		{ user_id: string; created_at: number; expires_at: number; envelope: string } | undefined;
	if (!row || row.expires_at <= now || row.created_at + 10 * 60 * 1000 <= now) return null;
	return {
		userId: row.user_id,
		createdAt: row.created_at,
		payload: decryptHostedPending(row.user_id, stateHash, row.envelope)
	};
}

export function encryptChatGPTCredentials(
	userId: string,
	accountId: string,
	mode: OAuthMode,
	credentials: ChatGPTCredentials
): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFor(mode), iv);
	cipher.setAAD(aad(userId, accountId, mode));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(credentials), 'utf8'),
		cipher.final()
	]);
	return JSON.stringify({
		iv: iv.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
		data: ciphertext.toString('base64url')
	});
}

export function decryptChatGPTCredentials(
	userId: string,
	accountId: string,
	mode: OAuthMode,
	envelope: string
): ChatGPTCredentials {
	const parsed = JSON.parse(envelope) as { iv?: string; tag?: string; data?: string };
	if (!parsed.iv || !parsed.tag || !parsed.data)
		throw new Error('OAuth credentials are unavailable.');
	const decipher = createDecipheriv(
		'aes-256-gcm',
		keyFor(mode),
		Buffer.from(parsed.iv, 'base64url')
	);
	decipher.setAAD(aad(userId, accountId, mode));
	decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(parsed.data, 'base64url')),
		decipher.final()
	]).toString('utf8');
	const credentials = JSON.parse(plaintext) as Partial<ChatGPTCredentials>;
	if (
		typeof credentials.accessToken !== 'string' ||
		typeof credentials.idToken !== 'string' ||
		!(typeof credentials.refreshToken === 'string' || credentials.refreshToken === null)
	) {
		throw new Error('OAuth credentials are unavailable.');
	}
	return credentials as ChatGPTCredentials;
}

function toAccount(row: AccountRow): ChatGPTAccount {
	let scopes: string[] = [];
	try {
		const parsed: unknown = JSON.parse(row.scopes_json);
		if (Array.isArray(parsed))
			scopes = parsed.filter((scope): scope is string => typeof scope === 'string');
	} catch {
		// A malformed grant is treated as having no granted scopes.
	}
	return {
		id: row.id,
		userId: row.user_id,
		mode: row.mode,
		clientId: row.client_id,
		subject: row.subject,
		email: row.email,
		label: row.label,
		scopes,
		credentialEnvelope: row.credential_envelope,
		expiresAt: row.expires_at,
		earliestRefreshAt: row.earliest_refresh_at,
		refreshLockToken: row.refresh_lock_token,
		refreshLockUntil: row.refresh_lock_until,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

const selectColumns = `id, user_id, mode, client_id, subject, email, label, scopes_json,
	credential_envelope, expires_at, earliest_refresh_at, refresh_lock_token,
	refresh_lock_until, created_at, updated_at`;

export function getChatGPTAccount(userId: string, accountId: string): ChatGPTAccount | null {
	const row = db
		.prepare(`SELECT ${selectColumns} FROM chatgpt_oauth_accounts WHERE user_id = ? AND id = ?`)
		.get(userId, accountId) as AccountRow | undefined;
	return row ? toAccount(row) : null;
}

export function listStoredChatGPTAccounts(userId: string): ChatGPTAccount[] {
	return (
		db
			.prepare(
				`SELECT ${selectColumns} FROM chatgpt_oauth_accounts WHERE user_id = ? ORDER BY created_at, id`
			)
			.all(userId) as AccountRow[]
	).map(toAccount);
}

export function saveChatGPTAccount(input: {
	userId: string;
	accountId?: string;
	mode: OAuthMode;
	clientId: string;
	subject: string;
	email: string | null;
	scopes: string[];
	credentials: ChatGPTCredentials;
	expiresAt: number;
	earliestRefreshAt: number;
}): ChatGPTAccount {
	const mappedByClient = db
		.prepare(
			`SELECT ${selectColumns} FROM chatgpt_oauth_accounts WHERE user_id = ? AND client_id = ? AND subject = ?`
		)
		.get(input.userId, input.clientId, input.subject) as AccountRow | undefined;
	if (!input.accountId && input.mode === 'local') {
		const conflictingRegistration = db
			.prepare(
				'SELECT 1 AS present FROM chatgpt_oauth_accounts WHERE user_id = ? AND client_id = ? AND subject <> ?'
			)
			.get(input.userId, input.clientId, input.subject) as { present: number } | undefined;
		if (conflictingRegistration)
			throw new Error('This ChatGPT registration belongs to a different account.');
	}
	let existing: AccountRow | undefined;
	if (input.accountId) {
		existing = db
			.prepare(`SELECT ${selectColumns} FROM chatgpt_oauth_accounts WHERE user_id = ? AND id = ?`)
			.get(input.userId, input.accountId) as AccountRow | undefined;
		if (!existing || existing.client_id !== input.clientId || existing.subject !== input.subject) {
			throw new Error('The selected ChatGPT account could not be verified.');
		}
	} else if (mappedByClient) {
		if (mappedByClient.subject !== input.subject) {
			throw new Error('This ChatGPT registration belongs to a different account.');
		}
		existing = mappedByClient;
	}

	const now = Date.now();
	const accountId = existing?.id ?? randomUUID();
	const label = input.email?.trim() || existing?.label || 'ChatGPT account';
	const envelope = encryptChatGPTCredentials(
		input.userId,
		accountId,
		input.mode,
		input.credentials
	);
	const write = db.prepare(`
		INSERT INTO chatgpt_oauth_accounts (
			id, user_id, mode, client_id, subject, email, label, scopes_json,
			credential_envelope, expires_at, earliest_refresh_at,
			created_at, updated_at, refresh_lock_token, refresh_lock_until
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		ON CONFLICT(user_id, client_id, subject) DO UPDATE SET
			mode = excluded.mode,
			subject = excluded.subject,
			email = excluded.email,
			label = excluded.label,
			scopes_json = excluded.scopes_json,
			credential_envelope = excluded.credential_envelope,
			expires_at = excluded.expires_at,
			earliest_refresh_at = excluded.earliest_refresh_at,
			updated_at = excluded.updated_at,
			refresh_lock_token = NULL,
			refresh_lock_until = NULL
	`);
	write.run(
		accountId,
		input.userId,
		input.mode,
		input.clientId,
		input.subject,
		input.email,
		label,
		JSON.stringify([...new Set(input.scopes)]),
		envelope,
		input.expiresAt,
		input.earliestRefreshAt,
		existing?.created_at ?? now,
		now
	);
	const saved = db
		.prepare(
			`SELECT ${selectColumns} FROM chatgpt_oauth_accounts WHERE user_id = ? AND client_id = ? AND subject = ?`
		)
		.get(input.userId, input.clientId, input.subject) as AccountRow;
	return toAccount(saved);
}

export function persistRefreshedChatGPTCredentials(input: {
	userId: string;
	accountId: string;
	leaseToken: string;
	credentials: ChatGPTCredentials;
	expiresAt: number;
	earliestRefreshAt: number;
	scopes: string[];
}): boolean {
	const account = getChatGPTAccount(input.userId, input.accountId);
	if (!account) return false;
	const envelope = encryptChatGPTCredentials(
		input.userId,
		input.accountId,
		account.mode,
		input.credentials
	);
	const result = db
		.prepare(
			`
			UPDATE chatgpt_oauth_accounts
			SET credential_envelope = ?, expires_at = ?, earliest_refresh_at = ?, scopes_json = ?,
				updated_at = ?, refresh_lock_token = NULL, refresh_lock_until = NULL
			WHERE id = ? AND user_id = ? AND refresh_lock_token = ?
		`
		)
		.run(
			envelope,
			input.expiresAt,
			input.earliestRefreshAt,
			JSON.stringify([...new Set(input.scopes)]),
			Date.now(),
			input.accountId,
			input.userId,
			input.leaseToken
		);
	return Number(result.changes) === 1;
}

export function claimChatGPTRefreshLease(
	userId: string,
	accountId: string,
	leaseToken: string,
	leaseUntil: number,
	now = Date.now()
): boolean {
	const result = db
		.prepare(
			`
			UPDATE chatgpt_oauth_accounts
			SET refresh_lock_token = ?, refresh_lock_until = ?
			WHERE user_id = ? AND id = ?
				AND (refresh_lock_until IS NULL OR refresh_lock_until <= ?)
		`
		)
		.run(leaseToken, leaseUntil, userId, accountId, now);
	return Number(result.changes) === 1;
}

export function releaseChatGPTRefreshLease(
	userId: string,
	accountId: string,
	leaseToken: string
): void {
	db.prepare(
		`
		UPDATE chatgpt_oauth_accounts
		SET refresh_lock_token = NULL, refresh_lock_until = NULL
		WHERE user_id = ? AND id = ? AND refresh_lock_token = ?
	`
	).run(userId, accountId, leaseToken);
}

export function clearChatGPTCredentials(
	userId: string,
	accountId: string,
	leaseToken?: string
): boolean {
	const result = db
		.prepare(
			`
		UPDATE chatgpt_oauth_accounts
		SET credential_envelope = NULL, expires_at = 0, earliest_refresh_at = 0,
			updated_at = ?, refresh_lock_token = NULL, refresh_lock_until = NULL
		WHERE user_id = ? AND id = ? AND (? IS NULL OR refresh_lock_token = ?)
	`
		)
		.run(Date.now(), userId, accountId, leaseToken ?? null, leaseToken ?? null);
	return Number(result.changes) === 1;
}

export function ensureChatGPTHostId(): string {
	const row = db
		.prepare('SELECT ext_agent_host_id FROM chatgpt_oauth_settings WHERE id = 1')
		.get() as { ext_agent_host_id: string } | undefined;
	if (row) return row.ext_agent_host_id;
	const value = `urn:uuid:${randomUUID()}`;
	db.prepare(
		'INSERT OR IGNORE INTO chatgpt_oauth_settings(id, ext_agent_host_id) VALUES (1, ?)'
	).run(value);
	const saved = db
		.prepare('SELECT ext_agent_host_id FROM chatgpt_oauth_settings WHERE id = 1')
		.get() as { ext_agent_host_id: string };
	return saved.ext_agent_host_id;
}

export function isSessionBindingActive(userId: string, binding: string): boolean {
	const row = db
		.prepare(
			'SELECT 1 AS active FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?'
		)
		.get(binding, userId, Date.now()) as { active: number } | undefined;
	return !!row;
}
