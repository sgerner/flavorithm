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

test('host AI acts as an overridable default, strips incompatible personal reasoning, and leaves search independent', async () => {
	const admin = await db.registerUser(
		'Host Admin 2',
		'host-admin-2@example.com',
		'correct horse battery'
	);
	const member = await db.registerUser(
		'Member 2',
		'host-member-2@example.com',
		'correct horse battery'
	);
	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = admin.user.id;

	const hostGrant = storage.saveChatGPTAccount({
		userId: admin.user.id,
		mode: 'local',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		subject: 'host-subject:host-codex-acct',
		email: 'host-private@example.com',
		scopes: ['codex.subscription'],
		credentials: {
			accessToken: 'host-access-token',
			refreshToken: 'host-refresh-token',
			idToken: 'host-id-token',
			codexAccountId: 'host-codex-acct'
		},
		expiresAt: Date.now() + 3_600_000,
		earliestRefreshAt: 0
	});
	host.configureHostAI(admin.user.id, hostGrant.id, 'gpt-5-codex');

	const personalGrant = storage.saveChatGPTAccount({
		userId: member.user.id,
		mode: 'local',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		subject: 'member-subject:member-codex-acct',
		email: 'member@example.com',
		scopes: ['codex.subscription'],
		credentials: {
			accessToken: 'member-access-token',
			refreshToken: 'member-refresh-token',
			idToken: 'member-id-token',
			codexAccountId: 'member-codex-acct'
		},
		expiresAt: Date.now() + 3_600_000,
		earliestRefreshAt: 0
	});

	const aiRoute = await import('../src/routes/api/ai/+server.ts');
	const { defaultPreferences } = await import('../src/lib/data.ts');

	const nutrition = {
		calories: 380,
		fat: 12,
		saturatedFat: 2,
		sodium: 410,
		carbs: 52,
		fiber: 7,
		sugar: 5,
		protein: 16
	};
	const draftRecipe = {
		title: 'Herbed Lentil Bowl',
		description: 'Warm lentils with herbs.',
		image: '',
		time: 25,
		servings: 2,
		difficulty: 'Easy',
		cuisine: 'Mediterranean',
		tags: ['vegetarian'],
		ingredients: [{ name: 'lentils', quantity: 1, unit: 'cup' }],
		steps: ['Simmer lentils until tender.'],
		nutrition
	};

	const observedCalls: Array<{
		url: string;
		auth: string | null;
		accountId: string | null;
		body: any;
	}> = [];

	const makeFetcher = (responsePayload: unknown): typeof fetch =>
		(async (input: any, init: any) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
			observedCalls.push({
				url,
				auth: headers.get('authorization'),
				accountId: headers.get('chatgpt-account-id'),
				body: parsedBody
			});

			if (url.startsWith('https://chatgpt.com/')) {
				if (new URL(url).pathname.endsWith('/models')) {
					return Response.json({
						models: [
							{
								slug: 'gpt-5-codex',
								display_name: 'GPT-5 Codex',
								visibility: 'list',
								input_modalities: ['text', 'image'],
								supported_reasoning_levels: [{ effort: 'medium' }]
							},
							{
								slug: 'gpt-5-personal',
								display_name: 'GPT-5 Personal',
								visibility: 'list',
								input_modalities: ['text', 'image'],
								supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
							}
						]
					});
				}
				return new Response(
					'data: ' +
						JSON.stringify({
							type: 'response.completed',
							response: {
								status: 'completed',
								output: [
									{ content: [{ type: 'output_text', text: JSON.stringify(responsePayload) }] }
								]
							}
						}) +
						'\n\n',
					{ headers: { 'content-type': 'text/event-stream' } }
				);
			}

			if (url === 'https://api.openai.com/v1/chat/completions') {
				return Response.json({
					choices: [{ message: { content: JSON.stringify(responsePayload) } }]
				});
			}

			if (url.startsWith('https://api.search.brave.com/')) {
				return Response.json({
					web: {
						results: [
							{
								title: 'Lentil Soup Recipe',
								url: 'https://recipes.example/lentil-soup',
								description: 'Classic lentil soup.'
							}
						]
					}
				});
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		}) as typeof fetch;

	const postAI = (body: unknown, fetcher: typeof fetch) =>
		aiRoute.POST({
			locals: { user: member.user },
			fetch: fetcher,
			request: new Request('https://flavorithm.example/api/ai', {
				method: 'POST',
				headers: {
					origin: 'https://flavorithm.example',
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			})
		} as any);

	const incompatibleReasoning = {
		enabled: true,
		budgetTokens: 4096,
		effort: 'xhigh'
	};

	// 1. Default Host AI routes generate, capture, nutrition, vision, and chat while stripping incompatible personal reasoning.
	const genRes = await postAI(
		{
			action: 'generate',
			provider: 'anthropic',
			model: 'claude-sonnet-4',
			reasoning: incompatibleReasoning,
			pantry: [{ id: 'p1', name: 'lentils', quantity: 1, unit: 'cup', category: 'Grains' }],
			preferences: { ...defaultPreferences, provider: 'anthropic', model: 'claude-sonnet-4' }
		},
		makeFetcher({ recipes: [draftRecipe] })
	);
	assert.equal(genRes.status, 200);
	const genCall = observedCalls.at(-1)!;
	assert.equal(genCall.accountId, 'host-codex-acct');
	assert.equal(genCall.auth, 'Bearer host-access-token');
	assert.equal(genCall.body.model, 'gpt-5-codex');
	assert.equal(genCall.body.reasoning, undefined);

	const captureRes = await postAI(
		{
			action: 'capture',
			usePersonalAI: false,
			provider: 'chatgpt',
			model: 'gpt-5-codex',
			connectionId: 'host-chatgpt',
			reasoning: incompatibleReasoning,
			prompt: '1 cup lentils, simmer 25 minutes.'
		},
		makeFetcher({ ...draftRecipe, assumptions: [] })
	);
	assert.equal(captureRes.status, 200);
	assert.equal(observedCalls.at(-1)!.accountId, 'host-codex-acct');
	assert.equal(observedCalls.at(-1)!.body.reasoning, undefined);

	const nutritionRes = await postAI(
		{
			action: 'nutrition',
			reasoning: incompatibleReasoning,
			recipe: { id: 'r1', ...draftRecipe }
		},
		makeFetcher(nutrition)
	);
	assert.equal(nutritionRes.status, 200);
	assert.equal(observedCalls.at(-1)!.accountId, 'host-codex-acct');
	assert.equal(observedCalls.at(-1)!.body.reasoning, undefined);

	const visionRes = await postAI(
		{
			action: 'vision',
			reasoning: incompatibleReasoning,
			image:
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
		},
		makeFetcher({
			ingredients: [{ name: 'lentils', quantity: 1, unit: 'cup', category: 'Pantry' }]
		})
	);
	assert.equal(visionRes.status, 200);
	assert.equal(observedCalls.at(-1)!.accountId, 'host-codex-acct');
	assert.equal(observedCalls.at(-1)!.body.reasoning, undefined);

	const chatContext = JSON.stringify({
		recipes: [],
		meals: [],
		pantry: [],
		shopping: [],
		today: '2026-10-23'
	});

	const chatRes = await postAI(
		{
			action: 'chat',
			reasoning: incompatibleReasoning,
			messages: [{ role: 'user', content: 'What can I cook tonight?' }],
			context: chatContext
		},
		makeFetcher({ reply: 'Try a warm herbed lentil bowl.', commands: [] })
	);
	assert.equal(chatRes.status, 200);
	assert.equal(observedCalls.at(-1)!.accountId, 'host-codex-acct');
	assert.equal(observedCalls.at(-1)!.body.reasoning, undefined);

	// 2. Online recipe search remains independent of Host AI routing.
	process.env.BRAVE_SEARCH_API_KEY = 'brave-test-key';
	try {
		const searchRes = await postAI({ action: 'search', prompt: 'lentil soup' }, makeFetcher({}));
		assert.equal(searchRes.status, 200);
		assert.match(observedCalls.at(-1)!.url, /^https:\/\/api\.search\.brave\.com\//);
	} finally {
		delete process.env.BRAVE_SEARCH_API_KEY;
	}

	// 3. Personal override with personal API key routes to personal provider, never Host AI.
	const personalKeyRes = await postAI(
		{
			action: 'chat',
			usePersonalAI: true,
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'sk-personal-override',
			messages: [{ role: 'user', content: 'Suggest a quick salad.' }],
			context: chatContext
		},
		makeFetcher({ reply: 'Cucumber herb salad.', commands: [] })
	);
	assert.equal(personalKeyRes.status, 200);
	const keyCall = observedCalls.at(-1)!;
	assert.equal(keyCall.url, 'https://api.openai.com/v1/chat/completions');
	assert.equal(keyCall.auth, 'Bearer sk-personal-override');
	assert.equal(keyCall.accountId, null);
	assert.equal(keyCall.body.model, 'gpt-4.1-mini');

	// 4. Personal override with personal ChatGPT subscription resolves member.user.id (not host.userId) and keeps valid personal reasoning.
	const personalChatGPTRes = await postAI(
		{
			action: 'chat',
			usePersonalAI: true,
			provider: 'chatgpt',
			connectionId: personalGrant.id,
			model: 'gpt-5-personal',
			reasoning: { effort: 'high' },
			messages: [{ role: 'user', content: 'Suggest dinner.' }],
			context: chatContext
		},
		makeFetcher({ reply: 'Personal Codex response.', commands: [] })
	);
	assert.equal(personalChatGPTRes.status, 200);
	const personalChatGPTCall = observedCalls.at(-1)!;
	assert.equal(personalChatGPTCall.accountId, 'member-codex-acct');
	assert.equal(personalChatGPTCall.auth, 'Bearer member-access-token');
	assert.equal(personalChatGPTCall.body.model, 'gpt-5-personal');
	assert.deepEqual(personalChatGPTCall.body.reasoning, { effort: 'high' });

	// 5. Personal override rejects host-chatgpt connectionId with HTTP 400 (never routing to Host AI and never returning 404).
	const invalidOverrideRes = await postAI(
		{
			action: 'chat',
			usePersonalAI: true,
			provider: 'chatgpt',
			connectionId: 'host-chatgpt',
			model: 'gpt-5-codex',
			messages: [{ role: 'user', content: 'Hello' }]
		},
		makeFetcher({})
	);
	assert.equal(invalidOverrideRes.status, 400);

	host.configureHostAI(admin.user.id);
	delete process.env.FLAVORITHM_HOST_ADMIN_USER_ID;
});

test('personal preferences survive Host AI cycles, never persist host-chatgpt, and avoid 404s when Host AI stops', async () => {
	const admin = await db.registerUser(
		'Host Admin 3',
		'host-admin-3@example.com',
		'correct horse battery'
	);
	const cook = await db.registerUser('Cook 3', 'host-cook-3@example.com', 'correct horse battery');
	process.env.FLAVORITHM_HOST_ADMIN_USER_ID = admin.user.id;

	const hostGrant = storage.saveChatGPTAccount({
		userId: admin.user.id,
		mode: 'local',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		subject: 'host3:acct3',
		email: 'admin3@example.com',
		scopes: ['codex.subscription'],
		credentials: {
			accessToken: 'host3-access',
			refreshToken: 'host3-refresh',
			idToken: 'host3-id',
			codexAccountId: 'acct3'
		},
		expiresAt: Date.now() + 3_600_000,
		earliestRefreshAt: 0
	});

	const { defaultPreferences } = await import('../src/lib/data.ts');
	const initial = db.getState(cook.user)!;
	const savedPersonalPreferences = {
		...defaultPreferences,
		provider: 'anthropic',
		model: 'claude-sonnet-4',
		chatgptAccountId: 'personal-chatgpt-id',
		usePersonalAI: true,
		reasoning: {
			enabled: true,
			budgetTokens: 4096,
			effort: 'high'
		}
	};

	db.saveState(
		cook.user,
		{ ...initial, preferences: savedPersonalPreferences },
		{ ifMatch: db.getStateEtag(cook.user), ifNoneMatch: null }
	);

	// Enabling and disabling Host AI leaves saved personal preferences untouched.
	host.configureHostAI(admin.user.id, hostGrant.id, 'gpt-5-codex');
	const duringHost = db.getState(cook.user)!;
	assert.equal(duringHost.preferences.provider, 'anthropic');
	assert.equal(duringHost.preferences.model, 'claude-sonnet-4');
	assert.equal(duringHost.preferences.chatgptAccountId, 'personal-chatgpt-id');
	assert.equal(duringHost.preferences.usePersonalAI, true);
	assert.deepEqual(duringHost.preferences.reasoning, savedPersonalPreferences.reasoning);

	// Even if a stale client payload attempts to save chatgptAccountId: 'host-chatgpt', user_preferences never stores it.
	db.saveState(
		cook.user,
		{
			...duringHost,
			preferences: {
				...duringHost.preferences,
				provider: 'chatgpt',
				model: 'gpt-5-codex',
				chatgptAccountId: 'host-chatgpt'
			}
		},
		{ ifMatch: db.getStateEtag(cook.user), ifNoneMatch: null }
	);
	const rawRow = db
		.getDatabase()
		.prepare('SELECT preferences_json FROM user_preferences WHERE user_id = ?')
		.get(cook.user.id) as { preferences_json: string };
	assert.equal(rawRow.preferences_json.includes('host-chatgpt'), false);
	const sanitizedSaved = db.getState(cook.user)!;
	assert.equal(sanitizedSaved.preferences.chatgptAccountId, undefined);
	assert.equal(sanitizedSaved.preferences.model, '');

	// Legacy SQLite row containing host-chatgpt is sanitized on read while keeping saved reasoning intact.
	db.getDatabase()
		.prepare('UPDATE user_preferences SET preferences_json = ? WHERE user_id = ?')
		.run(
			JSON.stringify({
				...defaultPreferences,
				provider: 'chatgpt',
				model: 'gpt-5-codex',
				chatgptAccountId: 'host-chatgpt',
				reasoning: { effort: 'high' }
			}),
			cook.user.id
		);

	// Stop Host AI and verify zero HTTP 404s for host-chatgpt on /api/models and /api/ai.
	host.configureHostAI(admin.user.id);
	assert.equal(host.getHostAI(), null);

	const afterHostStop = db.getState(cook.user)!;
	assert.equal(afterHostStop.preferences.chatgptAccountId, undefined);
	assert.equal(afterHostStop.preferences.model, '');
	assert.deepEqual(afterHostStop.preferences.reasoning, { effort: 'high' });

	const modelsRoute = await import('../src/routes/api/models/+server.ts');
	const aiRoute = await import('../src/routes/api/ai/+server.ts');

	const staleHostModelsRes = await modelsRoute.GET({
		locals: { user: cook.user },
		fetch,
		url: new URL('https://flavorithm.example/api/models?connection=chatgpt&accountId=host-chatgpt')
	} as any);
	assert.equal(staleHostModelsRes.status, 200);
	assert.deepEqual(await staleHostModelsRes.json(), {
		providers: [{ id: 'chatgpt', name: 'ChatGPT plan', models: [] }]
	});

	const staleHostAiRes = await aiRoute.POST({
		locals: { user: cook.user },
		fetch,
		request: new Request('https://flavorithm.example/api/ai', {
			method: 'POST',
			headers: {
				origin: 'https://flavorithm.example',
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				action: 'chat',
				provider: 'chatgpt',
				model: 'gpt-5-codex',
				connectionId: 'host-chatgpt',
				messages: [{ role: 'user', content: 'Hello' }]
			})
		})
	} as any);
	assert.equal(staleHostAiRes.status, 400);
	assert.notEqual(staleHostAiRes.status, 404);

	// Genuinely non-existent personal account IDs still return HTTP 404.
	const unownedModelsRes = await modelsRoute.GET({
		locals: { user: cook.user },
		fetch,
		url: new URL('https://flavorithm.example/api/models?connection=chatgpt&accountId=not-owned')
	} as any);
	assert.equal(unownedModelsRes.status, 404);

	const unownedAiRes = await aiRoute.POST({
		locals: { user: cook.user },
		fetch,
		request: new Request('https://flavorithm.example/api/ai', {
			method: 'POST',
			headers: {
				origin: 'https://flavorithm.example',
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				action: 'chat',
				usePersonalAI: true,
				provider: 'chatgpt',
				model: 'gpt-5',
				connectionId: 'not-owned',
				messages: [{ role: 'user', content: 'Hello' }]
			})
		})
	} as any);
	assert.equal(unownedAiRes.status, 404);

	delete process.env.FLAVORITHM_HOST_ADMIN_USER_ID;
});
