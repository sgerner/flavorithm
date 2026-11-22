import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const db = await import('../src/lib/server/db.ts');
const storage = await import('../src/lib/server/oauth-storage.ts');
const modelsRoute = await import('../src/routes/api/models/+server.ts');

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

test('GET /api/models?connection=chatgpt validates accountId before starting publicCatalog', async () => {
	const account = await db.registerUser(
		'Catalog Validation User',
		'catalog-validation@example.com',
		'correct horse battery'
	);
	let upstreamCalls = 0;
	const response = await modelsRoute.GET({
		locals: { user: account.user },
		url: new URL('https://flavorithm.example/api/models?connection=chatgpt'),
		fetch: async () => {
			upstreamCalls += 1;
			return Response.json({});
		}
	} as never);
	assert.equal(response.status, 400);
	assert.equal(upstreamCalls, 0);
});

test('cold GET /api/models?connection=chatgpt overlaps models.dev publicCatalog with OpenAI models and survives models.dev failure', async () => {
	const account = await db.registerUser(
		'Catalog Overlap User',
		'catalog-overlap@example.com',
		'correct horse battery'
	);
	const grant = storage.saveChatGPTAccount({
		userId: account.user.id,
		mode: 'local',
		clientId: 'oaiapp_catalog_overlap',
		subject: 'subject-overlap',
		email: 'catalog-overlap@example.com',
		scopes: ['openid', 'profile', 'email', 'offline_access', 'chatgpt.tokens.use.direct'],
		credentials: {
			accessToken: 'chatgpt-plan-token',
			refreshToken: 'chatgpt-refresh-token',
			idToken: 'chatgpt-id-token'
		},
		expiresAt: Date.now() + 3600_000,
		earliestRefreshAt: 0
	});

	// 1. Cold catalog load where models.dev fails: both requests start before OpenAI resolves, and entitled models still return.
	const openAIGate1 = deferred<Response>();
	const started1: string[] = [];
	const response1Promise = modelsRoute.GET({
		locals: { user: account.user },
		url: new URL(
			`https://flavorithm.example/api/models?connection=chatgpt&accountId=${encodeURIComponent(grant.id)}`
		),
		fetch: async (input: RequestInfo | URL) => {
			const url = String(input);
			started1.push(url);
			if (url === 'https://models.dev/api.json') {
				return new Response('upstream outage', { status: 503 });
			}
			if (url === 'https://api.openai.com/v1/models') {
				return openAIGate1.promise;
			}
			throw new Error(`Unexpected URL: ${url}`);
		}
	} as never);

	await new Promise((resolve) => setTimeout(resolve, 0));
	// Both models.dev and api.openai.com/v1/models are in flight concurrently before OpenAI resolves.
	assert.deepEqual(started1, ['https://models.dev/api.json', 'https://api.openai.com/v1/models']);

	openAIGate1.resolve(
		Response.json({
			models: [
				{
					slug: 'gpt-5-codex',
					display_name: 'GPT-5 Codex',
					visibility: 'list',
					input_modalities: ['text', 'image']
				}
			]
		})
	);
	const response1 = await response1Promise;
	assert.equal(response1.status, 200);
	assert.equal(response1.headers.get('cache-control'), 'no-store');
	const body1 = await response1.json();
	assert.deepEqual(
		body1.providers[0].models.map((m: { id: string }) => m.id),
		['gpt-5-codex']
	);

	// 2. Subsequent cold load (since failed publicCatalog evicted cache) enriches reasoning metadata concurrently.
	const openAIGate2 = deferred<Response>();
	const catalogGate2 = deferred<Response>();
	const started2: string[] = [];
	const response2Promise = modelsRoute.GET({
		locals: { user: account.user },
		url: new URL(
			`https://flavorithm.example/api/models?connection=chatgpt&accountId=${encodeURIComponent(grant.id)}`
		),
		fetch: async (input: RequestInfo | URL) => {
			const url = String(input);
			started2.push(url);
			if (url === 'https://models.dev/api.json') return catalogGate2.promise;
			if (url === 'https://api.openai.com/v1/models') return openAIGate2.promise;
			throw new Error(`Unexpected URL: ${url}`);
		}
	} as never);

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(started2, ['https://models.dev/api.json', 'https://api.openai.com/v1/models']);

	openAIGate2.resolve(
		Response.json({
			models: [
				{
					slug: 'gpt-5-codex',
					display_name: 'GPT-5 Codex',
					visibility: 'list',
					input_modalities: ['text', 'image']
				}
			]
		})
	);
	catalogGate2.resolve(
		Response.json({
			openai: {
				name: 'OpenAI',
				models: {
					'gpt-5-codex': {
						name: 'GPT-5 Codex',
						reasoning: true,
						reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
						modalities: { input: ['text', 'image'], output: ['text'] }
					}
				}
			}
		})
	);

	const response2 = await response2Promise;
	assert.equal(response2.status, 200);
	const body2 = await response2.json();
	assert.deepEqual(body2.providers[0].models[0].reasoning, {
		efforts: ['low', 'medium', 'high'],
		toggle: false
	});
});
