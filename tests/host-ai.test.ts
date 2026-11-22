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

test('Host AI remaps unrecoverable credential failures to 503 host_ai_unavailable, clears admin credentials, and never leaks admin details', async (t) => {
	const admin = await db.registerUser(
		'Host Admin',
		'admin-secret@example.com',
		'correct horse battery'
	);
	const member = await db.registerUser(
		'Household Member',
		'member@example.com',
		'correct horse battery'
	);
	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = admin.user.id;
	try {
		const grant = storage.saveChatGPTAccount({
			userId: admin.user.id,
			mode: 'local',
			clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
			subject: 'admin-subject:codex-secret-acct',
			email: 'admin-secret@example.com',
			scopes: ['codex.subscription'],
			credentials: {
				accessToken: 'admin-stale-access-secret',
				refreshToken: 'admin-refresh-secret',
				idToken: 'admin-id-secret',
				codexAccountId: 'codex-secret-acct'
			},
			expiresAt: Date.now() + 3600_000,
			earliestRefreshAt: 0
		});
		host.configureHostAI(admin.user.id, grant.id, 'codex-shared-model');

		const aiRoute = await import('../src/routes/api/ai/+server.ts');
		const modelsRoute = await import('../src/routes/api/models/+server.ts');
		const { defaultPreferences } = await import('../src/lib/data.ts');

		// Transient refresh outage returns 502 without clearing admin credentials.
		t.mock.method(globalThis, 'fetch', async () => new Response('outage', { status: 503 }));
		const transient = await aiRoute.POST({
			locals: { user: member.user },
			fetch: async () => Response.json({ error: { message: 'Revoked' } }, { status: 401 }),
			request: new Request('https://flavorithm.example/api/ai', {
				method: 'POST',
				headers: { origin: 'https://flavorithm.example', 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'generate',
					provider: 'chatgpt',
					model: 'codex-shared-model',
					connectionId: host.HOST_CONNECTION_ID,
					preferences: defaultPreferences
				})
			})
		} as any);
		assert.equal(transient.status, 502);
		assert.ok(host.getHostAI(), 'transient refresh errors keep Host AI credentials intact');

		// Terminal refresh error clears admin credentialEnvelope and returns 503 host_ai_unavailable.
		t.mock.method(globalThis, 'fetch', async () =>
			Response.json({ error: { code: 'invalid_grant' } }, { status: 400 })
		);
		const failed = await aiRoute.POST({
			locals: { user: member.user },
			fetch: async () => Response.json({ error: { message: 'Revoked' } }, { status: 401 }),
			request: new Request('https://flavorithm.example/api/ai', {
				method: 'POST',
				headers: { origin: 'https://flavorithm.example', 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'generate',
					provider: 'chatgpt',
					model: 'codex-shared-model',
					connectionId: host.HOST_CONNECTION_ID,
					preferences: defaultPreferences
				})
			})
		} as any);
		assert.equal(failed.status, 503);
		const payload = await failed.json();
		assert.equal(payload.code, 'host_ai_unavailable');
		const serialized = JSON.stringify(payload);
		assert.equal(serialized.includes('admin-secret@example.com'), false);
		assert.equal(serialized.includes('admin-stale-access-secret'), false);
		assert.equal(serialized.includes(grant.id), false);
		assert.equal(host.getHostAI(), null);
		assert.equal(storage.getChatGPTAccount(admin.user.id, grant.id)?.credentialEnvelope, null);

		// Stale member requests still referencing host-chatgpt also receive 503 host_ai_unavailable.
		const staleModels = await modelsRoute.GET({
			locals: { user: member.user },
			fetch: async () => Response.json({}),
			url: new URL(
				`https://flavorithm.example/api/models?connection=chatgpt&accountId=${host.HOST_CONNECTION_ID}`
			)
		} as any);
		assert.equal(staleModels.status, 503);
		assert.equal((await staleModels.json()).code, 'host_ai_unavailable');
	} finally {
		host.configureHostAI(admin.user.id);
		delete process.env.FLAVORITHM_HOST_ADMIN_USER_ID;
	}
});
