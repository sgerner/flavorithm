import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backend = await import('../src/lib/server/db.ts');
const aiRoute = await import('../src/routes/api/ai/+server.ts');

const nutrition = {
	calories: 420,
	fat: 14,
	saturatedFat: 4,
	sodium: 520,
	carbs: 48,
	fiber: 8,
	sugar: 7,
	protein: 22
};

const generatedRecipe = {
	title: 'Herbed Chickpea Skillet',
	description: 'A quick skillet dinner.',
	image: '',
	time: 25,
	servings: 2,
	difficulty: 'Easy',
	cuisine: 'Mediterranean',
	tags: ['vegetarian'],
	ingredients: [{ name: 'chickpeas', quantity: 1, unit: 'can' }],
	steps: ['Warm the chickpeas with herbs and olive oil.'],
	nutrition
};

const modelCatalog = {
	openai: {
		name: 'OpenAI',
		models: {
			'gpt-4.1-mini': {
				name: 'GPT-4.1 mini',
				modalities: { input: ['text', 'image'], output: ['text'] }
			},
			'o3-mini': {
				name: 'o3-mini',
				reasoning: true,
				reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
				modalities: { input: ['text'], output: ['text'] }
			}
		}
	}
};

function makeAIEvent(
	user: unknown,
	body: unknown,
	fetchImpl: typeof fetch,
	options: { rawBody?: string; signal?: AbortSignal; clientAddress?: string } = {}
) {
	return {
		request: new Request('https://flavorithm.example/api/ai', {
			method: 'POST',
			headers: {
				origin: 'https://flavorithm.example',
				'content-type': 'application/json'
			},
			body: options.rawBody ?? JSON.stringify(body),
			signal: options.signal
		}),
		locals: { user },
		fetch: fetchImpl,
		getClientAddress: () => options.clientAddress ?? '198.51.100.25'
	};
}

test('valid max-bound appStateSchema records trigger zero 400 errors across AI actions', async () => {
	const account = await backend.registerUser(
		'Max State Chef',
		'max-state-ai@example.com',
		'a secure max state password'
	);
	const maxPantry = Array.from({ length: 1_000 }, (_, i) => ({
		id: `pantry-item-${i}`,
		name: `${`Ingredient ${i} `.padEnd(200, 'x')}`,
		quantity: 1_000_000,
		unit: 'g'.repeat(40),
		category: 'Produce '.padEnd(100, 'c'),
		expires: '2027-12-31'.padEnd(50, ' ')
	}));
	const maxRecipe = {
		id: 'recipe-max-1',
		title: 'T'.repeat(200),
		description: 'D'.repeat(10_000),
		image: '',
		time: 100_000,
		servings: 10_000,
		difficulty: 'M'.repeat(80),
		cuisine: 'C'.repeat(100),
		tags: Array.from({ length: 100 }, (_, i) => `t${i}`.padEnd(100, 'z')),
		ingredients: Array.from({ length: 120 }, (_, i) => ({
			name: `ing-${i}`.padEnd(200, 'a'),
			quantity: 1_000_000,
			unit: 'u'.repeat(40)
		})),
		steps: Array.from({ length: 80 }, () => 'S'.repeat(8_000)),
		nutrition: {
			calories: 1_000_000,
			fat: 1_000_000,
			saturatedFat: 1_000_000,
			sodium: 1_000_000,
			carbs: 1_000_000,
			fiber: 1_000_000,
			sugar: 1_000_000,
			protein: 1_000_000
		},
		rating: 5,
		saved: true,
		hidden: false,
		nutritionStale: true,
		importNotes: Array.from({ length: 30 }, () => 'N'.repeat(300)),
		provenance: 'ai-generated' as const
	};
	const state = {
		pantry: maxPantry,
		recipes: [maxRecipe],
		meals: [],
		shopping: [],
		preferences: {
			diet: 'vegetarian',
			allergies: 'peanuts, '.repeat(250).slice(0, 2_000),
			maxTime: 100_000,
			complexity: 'Moderate'.padEnd(100, ' '),
			cuisines: Array.from({ length: 8 }, (_, i) => `Cuisine ${i}`.padEnd(80, 'c')),
			theme: 'nosh'.padEnd(100, ' '),
			dark: true,
			onboardingStatus: 'completed' as const,
			provider: 'openai',
			model: 'gpt-4.1-mini',
			ratings: { 'recipe-max-1': 5 }
		}
	};
	const validated = backend.validateAppState(state);
	assert.ok(validated);
	const mockFetch: typeof fetch = async (input) => {
		if (String(input) === 'https://models.dev/api.json') return Response.json(modelCatalog);
		return Response.json({
			choices: [
				{
					finish_reason: 'stop',
					message: {
						content: JSON.stringify({
							recipes: [generatedRecipe],
							ingredients: [{ name: 'Lemon', quantity: 2, unit: 'whole', category: 'Produce' }],
							...nutrition,
							reply: 'Ready to help.',
							commands: []
						})
					}
				}
			]
		});
	};

	const generateRes = await aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'generate',
				provider: validated.preferences.provider,
				model: validated.preferences.model,
				apiKey: 'tab-memory-key',
				pantry: validated.pantry,
				preferences: validated.preferences,
				recipes: validated.recipes.slice(0, 30)
			},
			mockFetch
		) as never
	);
	assert.equal(generateRes.status, 200);

	const nutritionRes = await aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'nutrition',
				provider: validated.preferences.provider,
				model: validated.preferences.model,
				apiKey: 'tab-memory-key',
				recipe: validated.recipes[0]
			},
			mockFetch
		) as never
	);
	assert.equal(nutritionRes.status, 200);

	const chatContext = JSON.stringify({
		...validated,
		today: '2026-11-21',
		page: 'discover'
	});
	assert.ok(
		chatContext.length > 500_000,
		'serialized max kitchen context exceeds previous 500 KB cap'
	);
	const chatRes = await aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'chat',
				provider: validated.preferences.provider,
				model: validated.preferences.model,
				apiKey: 'tab-memory-key',
				messages: [{ role: 'user', content: 'Review my recipe.' }],
				context: chatContext
			},
			mockFetch
		) as never
	);
	assert.equal(chatRes.status, 200);
});

test('/api/ai consumes rate-limit quota only after local validation and returns Retry-After on 429', async () => {
	const account = await backend.registerUser(
		'Quota Guard Chef',
		'quota-guard-ai@example.com',
		'a secure quota guard password'
	);
	let upstreamCalls = 0;
	const mockFetch: typeof fetch = async (input) => {
		if (String(input) === 'https://models.dev/api.json') return Response.json(modelCatalog);
		upstreamCalls += 1;
		return Response.json({
			choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(nutrition) } }]
		});
	};

	const invalidPayloads: Array<{ rawBody?: string; body?: unknown; expectedStatus: number }> = [
		{ rawBody: '{invalid-json', expectedStatus: 400 },
		{ body: { action: 'unknown' }, expectedStatus: 400 },
		{
			body: { action: 'generate', provider: 'openai', model: 'gpt-4.1-mini' },
			expectedStatus: 400
		},
		{
			body: {
				action: 'nutrition',
				provider: 'chatgpt',
				model: 'gpt-4.1',
				connectionId: 'missing',
				recipe: generatedRecipe
			},
			expectedStatus: 404
		},
		{
			body: {
				action: 'vision',
				provider: 'azure',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				image: 'data:image/png;base64,aGVsbG8='
			},
			expectedStatus: 400
		},
		{
			body: {
				action: 'vision',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				image: 'data:text/plain;base64,aGVsbG8='
			},
			expectedStatus: 400
		},
		{
			body: {
				action: 'import',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				url: 'https://evil.example/recipe'
			},
			expectedStatus: 400
		},
		{
			body: {
				action: 'nutrition',
				provider: 'openai',
				model: 'o3-mini',
				apiKey: 'secret-key',
				reasoning: { effort: 'extreme' },
				recipe: generatedRecipe
			},
			expectedStatus: 400
		}
	];

	// Send 40 locally invalid requests (exceeding the 30/hr cap if counted prematurely).
	for (let i = 0; i < 40; i++) {
		const item = invalidPayloads[i % invalidPayloads.length];
		const res = await aiRoute.POST(
			makeAIEvent(account.user, item.body ?? {}, mockFetch, { rawBody: item.rawBody }) as never
		);
		assert.equal(res.status, item.expectedStatus);
	}
	assert.equal(upstreamCalls, 0);

	// All 30 hourly AI slots remain available for valid requests.
	for (let i = 0; i < 30; i++) {
		const res = await aiRoute.POST(
			makeAIEvent(
				account.user,
				{
					action: 'nutrition',
					provider: 'openai',
					model: 'gpt-4.1-mini',
					apiKey: 'secret-key',
					recipe: generatedRecipe
				},
				mockFetch
			) as never
		);
		assert.equal(res.status, 200, `valid request ${i + 1} should succeed`);
	}
	assert.equal(upstreamCalls, 30);

	// The 31st valid request hits the local rate limit with Retry-After and wait time.
	const limited = await aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'nutrition',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				recipe: generatedRecipe
			},
			mockFetch
		) as never
	);
	assert.equal(limited.status, 429);
	const retryAfterHeader = limited.headers.get('retry-after');
	assert.ok(retryAfterHeader && Number(retryAfterHeader) > 0);
	const limitedBody = (await limited.json()) as { error: string };
	assert.match(limitedBody.error, /Try again in \d+ (?:minute|minutes|second|seconds)/);
	assert.equal(upstreamCalls, 30);
});

test('/api/ai propagates upstream 429 Retry-After headers and returns 499 on cancelled requests', async () => {
	const account = await backend.registerUser(
		'Upstream Status Chef',
		'upstream-status-ai@example.com',
		'a secure upstream status password'
	);

	const upstream429 = await aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'nutrition',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				recipe: generatedRecipe
			},
			async () =>
				new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
					status: 429,
					headers: { 'content-type': 'application/json', 'retry-after': '45' }
				})
		) as never
	);
	assert.equal(upstream429.status, 429);
	assert.equal(upstream429.headers.get('retry-after'), '45');
	const body429 = (await upstream429.json()) as { error: string; code?: string };
	assert.match(body429.error, /45 seconds/);
	assert.equal(body429.code, 'rate_limited');

	const controller = new AbortController();
	let started!: () => void;
	const inFlight = new Promise<void>((resolve) => (started = resolve));
	const pending = aiRoute.POST(
		makeAIEvent(
			account.user,
			{
				action: 'nutrition',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'secret-key',
				recipe: generatedRecipe
			},
			async (_input, init) =>
				new Promise((_resolve, reject) => {
					started();
					init?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true }
					);
				}),
			{ signal: controller.signal }
		) as never
	);
	await inFlight;
	controller.abort();
	const cancelled = await pending;
	assert.equal(cancelled.status, 499);
	const cancelledBody = (await cancelled.json()) as { error: string; code?: string };
	assert.equal(cancelledBody.code, 'request_cancelled');
});
