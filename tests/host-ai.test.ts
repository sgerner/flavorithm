import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.FLAVORITHM_DB_PATH = ':memory:';
const db = await import('../src/lib/server/db.ts');
const storage = await import('../src/lib/server/oauth-storage.ts');
const host = await import('../src/lib/server/host-ai.ts');

test('only the explicitly configured host admin can share an encrypted Codex grant', async () => {
	const admin = await db.registerUser('Admin', 'host-admin@example.com', 'correct horse battery');
	const other = await db.registerUser('Other', 'host-other@example.com', 'correct horse battery');
	assert.equal(host.isHostAdmin(admin.user.id), false);
	assert.throws(() => host.configureHostAI(admin.user.id), /administrator/);
	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = admin.user.id;
	assert.throws(() => host.configureHostAI(other.user.id), /administrator/);
	const grant = storage.saveChatGPTAccount({
		userId: admin.user.id,
		mode: 'local',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		subject: 'subject',
		email: 'private@example.com',
		scopes: ['codex.subscription'],
		credentials: {
			accessToken: 'secret',
			refreshToken: 'refresh',
			idToken: 'identity',
			codexAccountId: 'account'
		},
		expiresAt: Date.now() + 3600000,
		earliestRefreshAt: 0
	});
	assert.throws(() => host.configureHostAI(other.user.id, grant.id, 'model'), /administrator/);
	assert.throws(() => host.configureHostAI(admin.user.id, grant.id), /model/);
	host.configureHostAI(admin.user.id, grant.id, 'model');
	assert.deepEqual(host.getHostAI(), {
		userId: admin.user.id,
		accountId: grant.id,
		model: 'model'
	});
	assert.equal(storage.listStoredChatGPTAccounts(other.user.id).length, 0);
	const route = await import('../src/routes/api/connections/chatgpt/+server.ts');
	const event = {
		locals: { user: other.user },
		url: new URL('https://flavorithm.example/api/connections/chatgpt'),
		getClientAddress: () => '127.0.0.1'
	};
	const response = await route.GET(event as any);
	const publicState = await response.json();
	assert.equal(publicState.hostAdmin, false);
	assert.deepEqual(publicState.host, { model: 'model' });
	assert.deepEqual(publicState.accounts, [
		{ id: 'host-chatgpt', label: 'Host ChatGPT connection', connected: true, planEnabled: true }
	]);
	assert.equal(JSON.stringify(publicState).includes('private@example.com'), false);
	const denied = await route.POST({
		...event,
		request: new Request(event.url, {
			method: 'POST',
			headers: { origin: event.url.origin, 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'host' })
		})
	} as any);
	assert.equal(denied.status, 403);
	assert.ok(host.getHostAI());

	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = other.user.id;
	assert.equal(host.getHostAI(), null);
	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = admin.user.id;
	storage.clearChatGPTCredentials(admin.user.id, grant.id);
	assert.equal(host.getHostAI(), null);
	host.configureHostAI(admin.user.id);
	assert.equal(host.getHostAI(), null);
	delete process.env.FLAVORITHM_HOST_ADMIN_USER_ID;
});
