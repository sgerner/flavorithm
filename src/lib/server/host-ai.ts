import { CODEX_CLIENT_ID } from './codex-device.ts';
import { ApiError, getDatabase } from '#lib/server/db.ts';
import { getChatGPTAccount } from './oauth-storage.ts';

const db = getDatabase();
db.exec(`CREATE TABLE IF NOT EXISTS host_ai (
 id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL,
 account_id TEXT NOT NULL, model TEXT NOT NULL
)`);
export const HOST_CONNECTION_ID = 'host-chatgpt';
export function isHostAdmin(userId: string): boolean {
	const configured = process.env.FLAVORITHM_HOST_ADMIN_USER_ID?.trim();
	return Boolean(configured && configured === userId);
}
export function getHostAI() {
	const row = db.prepare('SELECT user_id, account_id, model FROM host_ai WHERE id = 1').get() as
		{ user_id: string; account_id: string; model: string } | undefined;
	if (!row || !isHostAdmin(row.user_id)) return null;
	const account = getChatGPTAccount(row.user_id, row.account_id);
	if (
		!account?.credentialEnvelope ||
		account.clientId !== CODEX_CLIENT_ID ||
		!account.scopes.includes('codex.subscription')
	)
		return null;
	return { userId: row.user_id, accountId: row.account_id, model: row.model };
}
export function configureHostAI(userId: string, accountId?: string, model?: string) {
	if (!isHostAdmin(userId)) throw new ApiError(403, 'Host administrator required.');
	if (!accountId) {
		db.prepare('DELETE FROM host_ai WHERE id = 1').run();
		return;
	}
	const account = getChatGPTAccount(userId, accountId);
	if (
		!account?.credentialEnvelope ||
		account.clientId !== CODEX_CLIENT_ID ||
		!account.scopes.includes('codex.subscription')
	)
		throw new ApiError(400, 'Connect a Codex device-code account first.');
	if (!model?.trim() || model.length > 200) throw new ApiError(400, 'Choose a host model first.');
	db.prepare(
		`INSERT INTO host_ai(id, user_id, account_id, model) VALUES (1, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, account_id=excluded.account_id, model=excluded.model`
	).run(userId, accountId, model.trim());
}
