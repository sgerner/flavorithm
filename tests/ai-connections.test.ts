import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	CHATGPT_OAUTH_POLL_INTERVAL_MS,
	CHATGPT_OAUTH_TTL_MS,
	buildAIPayload,
	formatRetryWait,
	parseRetryAfter,
	resolveConnectionModel,
	searchConnections,
	searchModels,
	startConnectionPoll
} from '../src/lib/ai-connections.ts';
import { defaultPreferences, seedRecipes } from '../src/lib/data.ts';
import { transformModelCatalog, runAIRequest, AIRequestError } from '../src/lib/server/ai.ts';

const model = {
	name: 'Test model',
	reasoning: true,
	reasoning_options: [
		{ type: 'effort', values: ['low', 'high'] },
		{ type: 'toggle' },
		{ type: 'budget_tokens', min: 1024, max: 8192 }
	],
	modalities: { input: ['text', 'image'], output: ['text'] }
};
const catalog = {
	deepseek: {
		name: 'DeepSeek',
		env: ['DEEPSEEK_API_KEY'],
		api: 'https://evil.example/steal',
		models: { test: model }
	},
	google: { name: 'Google', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], models: { test: model } },
	openrouter: { name: 'OpenRouter', models: { test: model } },
	anthropic: { name: 'Anthropic', models: { test: model } },
	openai: { name: 'OpenAI', models: { test: model } },
	azure: { name: 'Azure', env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'], models: { test: model } }
};
const vision = {
	action: 'vision',
	model: 'test',
	apiKey: 'secret-key',
	image: 'data:image/png;base64,aGVsbG8='
};
const ingredients = {
	ingredients: [{ name: 'Eggs', quantity: 2, unit: 'whole', category: 'Dairy & eggs' }]
};
const json = (value: unknown) => Response.json(value);

test('provider discovery searches names and hosted models, preserves setup metadata, and identifies unsupported integrations', () => {
	const { providers } = transformModelCatalog(catalog);
	assert.equal(providers.find((p) => p.id === 'azure')?.supported, false);
	assert.equal(providers.find((p) => p.id === 'deepseek')?.apiKeyHint, 'DEEPSEEK_API_KEY');
	assert.equal(searchConnections(providers, 'deep seek').length, 1);
	assert.equal(searchConnections(providers, 'test model').length, 6);
	assert.equal(searchConnections(providers, 'missing').length, 0);
	assert.equal(searchModels(providers[0].models, 'test model').length, 1);
	assert.deepEqual(providers.find((p) => p.id === 'google')?.models[0].reasoning, {
		efforts: ['low', 'high'],
		toggle: false
	});
	assert.equal(providers.find((p) => p.id === 'openrouter')?.models[0].reasoning?.budgetMin, 1024);
});

test('catalog excludes non-text and deprecated models, and rejects unsafe documentation URLs', () => {
	const result = transformModelCatalog({
		groq: {
			doc: 'javascript:alert(1)',
			models: {
				text: model,
				old: { ...model, status: 'deprecated' },
				embedding: { modalities: { output: ['embedding'] } }
			}
		}
	});
	assert.deepEqual(
		result.providers[0].models.map((m) => m.id),
		['text']
	);
	assert.equal(result.providers[0].documentation, undefined);
});

test('selected reasoning is delivered to the fixed DeepSeek API endpoint, never the catalog-supplied destination', async () => {
	let observed: any;
	await runAIRequest(
		{ ...vision, provider: 'deepseek', reasoning: { effort: 'high', enabled: true } },
		async (input, init) => {
			if (String(input) === 'https://models.dev/api.json') return json(catalog);
			assert.equal(String(input), 'https://api.deepseek.com/chat/completions');
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-key');
			assert.equal(init?.redirect, 'error');
			observed = JSON.parse(String(init?.body));
			return json({ choices: [{ message: { content: JSON.stringify(ingredients) } }] });
		}
	);
	assert.equal(observed.reasoning_effort, 'high');
	assert.deepEqual(observed.thinking, { type: 'enabled' });
});

test('Google uses its own authentication, image content, JSON format, and reasoning protocol', async () => {
	let observed: any;
	const result = await runAIRequest(
		{ ...vision, provider: 'google', reasoning: { effort: 'high' } },
		async (input, init) => {
			if (String(input) === 'https://models.dev/api.json') return json(catalog);
			assert.equal(
				String(input),
				'https://generativelanguage.googleapis.com/v1beta/models/test:generateContent'
			);
			assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'secret-key');
			assert.equal(new Headers(init?.headers).has('authorization'), false);
			observed = JSON.parse(String(init?.body));
			return json({
				candidates: [
					{
						content: {
							parts: [
								{ thought: true, text: 'private thinking' },
								{ text: JSON.stringify(ingredients) }
							]
						}
					}
				]
			});
		}
	);
	assert.deepEqual(observed.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
	assert.equal(observed.generationConfig.responseMimeType, 'application/json');
	assert.equal(observed.contents[0].parts[1].inlineData.mimeType, 'image/png');
	assert.ok('ingredients' in result);
	assert.equal(result.ingredients[0].name, 'Eggs');
});

test('OpenRouter and Anthropic receive provider-specific effort, toggle, and token-budget fields', async () => {
	for (const provider of ['openrouter', 'anthropic']) {
		let observed: any;
		await runAIRequest(
			{ ...vision, provider, reasoning: { effort: 'high', enabled: true, budgetTokens: 2048 } },
			async (input, init) => {
				if (String(input) === 'https://models.dev/api.json') return json(catalog);
				observed = JSON.parse(String(init?.body));
				return provider === 'anthropic'
					? json({ content: [{ type: 'text', text: JSON.stringify(ingredients) }] })
					: json({ choices: [{ message: { content: JSON.stringify(ingredients) } }] });
			}
		);
		if (provider === 'openrouter')
			assert.deepEqual(observed.reasoning, { effort: 'high', enabled: true, max_tokens: 2048 });
		else {
			assert.equal(observed.output_config.effort, 'high');
			assert.deepEqual(observed.thinking, { type: 'enabled', budget_tokens: 2048 });
			assert.ok(observed.max_tokens > 2048);
		}
	}
});

test('unsupported providers and invalid model reasoning are rejected before any credential-bearing request', async () => {
	for (const value of [
		{ provider: 'azure' },
		{ provider: 'constructor' },
		{ provider: 'openai', reasoning: { effort: 'max' } },
		{ provider: 'google', reasoning: { budgetTokens: 2048 } },
		{ provider: 'anthropic', reasoning: { budgetTokens: 1 } }
	]) {
		await assert.rejects(
			runAIRequest({ ...vision, ...value }, async (input) => {
				assert.equal(String(input), 'https://models.dev/api.json');
				return json(catalog);
			}),
			(error: unknown) => error instanceof AIRequestError && error.status === 400
		);
	}
});

test('resolveConnectionModel distinguishes listed vision/text models, omitted models, and catalog outages', () => {
	const { providers } = transformModelCatalog({
		openai: {
			name: 'OpenAI',
			models: {
				'gpt-4.1-mini': { name: 'GPT-4.1 mini', modalities: { input: ['text', 'image'] } },
				'o3-mini': {
					name: 'o3-mini',
					reasoning: true,
					reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
					modalities: { input: ['text'] }
				}
			}
		}
	});
	const accountModels = [
		{ id: 'gpt-4.1', name: 'GPT-4.1', vision: true },
		{ id: 'o4-mini-text', name: 'o4-mini text', vision: false }
	];

	const listedVision = resolveConnectionModel(
		{ provider: 'openai', model: 'gpt-4.1-mini' },
		providers,
		[]
	);
	assert.equal(listedVision.catalogLoaded, true);
	assert.equal(listedVision.modelOmitted, false);
	assert.equal(listedVision.selectedModel?.vision, true);

	const listedTextOnly = resolveConnectionModel(
		{ provider: 'openai', model: 'o3-mini' },
		providers,
		[]
	);
	assert.equal(listedTextOnly.catalogLoaded, true);
	assert.equal(listedTextOnly.modelOmitted, false);
	assert.equal(listedTextOnly.selectedModel?.vision, false);

	const omittedApiModel = resolveConnectionModel(
		{ provider: 'openai', model: 'retired-model-2024' },
		providers,
		[]
	);
	assert.equal(omittedApiModel.catalogLoaded, true);
	assert.equal(omittedApiModel.modelOmitted, true);
	assert.equal(omittedApiModel.selectedModel, undefined);

	const omittedAccountModel = resolveConnectionModel(
		{ provider: 'chatgpt', model: 'removed-plan-model' },
		providers,
		accountModels
	);
	assert.equal(omittedAccountModel.catalogLoaded, true);
	assert.equal(omittedAccountModel.modelOmitted, true);

	const outage = resolveConnectionModel({ provider: 'openai', model: 'gpt-4.1-mini' }, [], []);
	assert.equal(outage.catalogLoaded, false);
	assert.equal(outage.modelOmitted, false);
});

test('buildAIPayload scopes task-required fields per action and signals default reasoning headroom', () => {
	const rated = { ...seedRecipes[0], rating: 5 };
	const unrated = { ...seedRecipes[1], rating: undefined };
	const pantry = [{ id: 'p1', name: 'Tomato', quantity: 2, unit: 'whole', category: 'Produce' }];
	const reasoningModel = {
		id: 'custom-reasoner',
		name: 'Custom Reasoner',
		vision: false,
		reasoning: { efforts: ['low', 'high'], toggle: false }
	};
	const prefs = { ...defaultPreferences, provider: 'openai', model: 'custom-reasoner' };

	const searchPayload = buildAIPayload('search', {
		preferences: prefs,
		apiKey: 'secret',
		selectedModel: reasoningModel,
		pantry,
		recipes: [rated, unrated],
		prompt: 'unused dialog prompt',
		extra: { prompt: 'lentil soup' }
	});
	assert.deepEqual(searchPayload, { action: 'search', prompt: 'lentil soup' });

	for (const [action, extra] of [
		['vision', { image: 'data:image/png;base64,aGVsbG8=' }],
		['nutrition', { recipe: rated }],
		['import', { url: 'https://www.allrecipes.com/recipe/test' }],
		['capture', { prompt: '2 cups flour, 1 egg' }],
		['chat', { messages: [{ role: 'user', content: 'Hi' }], context: '{}' }]
	] as const) {
		const payload = buildAIPayload(action, {
			preferences: prefs,
			apiKey: 'secret',
			selectedModel: reasoningModel,
			pantry,
			recipes: [rated, unrated],
			prompt: 'stale prompt that must not leak',
			extra
		});
		assert.equal('pantry' in payload, false, `${action} must omit pantry`);
		assert.equal('preferences' in payload, false, `${action} must omit preferences`);
		assert.equal('recipes' in payload, false, `${action} must omit recipes`);
		if (action !== 'capture')
			assert.equal('prompt' in payload, false, `${action} must omit prompt`);
		assert.deepEqual(payload.reasoning, {});
	}

	const generatePayload = buildAIPayload('generate', {
		preferences: prefs,
		apiKey: 'secret',
		selectedModel: reasoningModel,
		pantry,
		recipes: [rated, unrated],
		prompt: '  quick dinner  '
	});
	assert.deepEqual(generatePayload.pantry, pantry);
	assert.equal((generatePayload.recipes as unknown[]).length, 1);
	assert.equal(generatePayload.prompt, 'quick dinner');
	assert.deepEqual(generatePayload.reasoning, {});

	assert.equal(parseRetryAfter('45'), 45);
	assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120);
	assert.equal(formatRetryWait(45), '45 seconds');
	assert.equal(formatRetryWait(61), '2 minutes');
});

function pollEnvironment(initialNow = 1_000) {
	let currentNow = initialNow;
	let hidden = false;
	let nextId = 1;
	const intervals = new Map<number, { fn: () => void; intervalMs: number }>();
	const listeners = new Set<() => void>();

	const document = {
		get hidden() {
			return hidden;
		},
		addEventListener(type: 'visibilitychange', listener: () => void) {
			assert.equal(type, 'visibilitychange');
			listeners.add(listener);
		},
		removeEventListener(type: 'visibilitychange', listener: () => void) {
			assert.equal(type, 'visibilitychange');
			listeners.delete(listener);
		}
	};

	const setIntervalFn = ((fn: () => void, intervalMs?: number) => {
		const id = nextId++;
		intervals.set(id, { fn, intervalMs: Number(intervalMs) });
		return id as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;

	const clearIntervalFn = ((id: ReturnType<typeof setInterval>) => {
		intervals.delete(Number(id));
	}) as typeof clearInterval;

	return {
		document,
		intervals,
		listeners,
		now: () => currentNow,
		advanceTime(ms: number) {
			currentNow += ms;
		},
		setHidden(value: boolean) {
			hidden = value;
			for (const listener of [...listeners]) listener();
		},
		async tickAll() {
			for (const entry of [...intervals.values()]) {
				entry.fn();
			}
			await new Promise((resolve) => setImmediate(resolve));
		},
		setInterval: setIntervalFn,
		clearInterval: clearIntervalFn
	};
}

test('connection poll cleans up interval and visibility listener on modal close', async () => {
	const env = pollEnvironment();
	let modal = 'settings';
	let attempt = 1;
	let owner: string | null = 'user-1';
	let polls = 0;

	const handle = startConnectionPoll({
		intervalMs: 5_000,
		expiresAt: env.now() + 60_000,
		attempt: 1,
		getAttempt: () => attempt,
		owner: 'user-1',
		getOwner: () => owner,
		isOpen: () => modal === 'settings',
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: async () => {
			polls++;
		}
	});

	assert.equal(handle.active, true);
	assert.equal(env.intervals.size, 1);
	assert.equal(env.listeners.size, 1);

	await env.tickAll();
	assert.equal(polls, 1);

	// Closing settings via closeDialog / cancelChatGPTDevice stops the timer and removes listener.
	modal = '';
	handle.stop();
	handle.stop();
	assert.equal(handle.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);

	await env.tickAll();
	env.setHidden(true);
	env.setHidden(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(polls, 1);

	// Starting a poll after leaving settings is an immediate no-op.
	const skipped = startConnectionPoll({
		intervalMs: 5_000,
		attempt: 1,
		getAttempt: () => attempt,
		owner: 'user-1',
		getOwner: () => owner,
		isOpen: () => modal === 'settings',
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: () => {
			polls++;
		}
	});
	assert.equal(skipped.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);

	// Modal leaving settings without explicit stop() also self-terminates on next tick.
	modal = 'settings';
	const autoStop = startConnectionPoll({
		intervalMs: CHATGPT_OAUTH_POLL_INTERVAL_MS,
		attempt: 1,
		getAttempt: () => attempt,
		owner: 'user-1',
		getOwner: () => owner,
		isOpen: () => modal === 'settings',
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: () => {
			polls++;
		}
	});
	assert.equal(env.intervals.size, 1);
	modal = 'onboarding';
	await env.tickAll();
	assert.equal(autoStop.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);
	assert.equal(polls, 1);
});

test('connection poll clears timer on owner mismatch from account deletion or attempt change', async () => {
	const env = pollEnvironment();
	let attempt = 1;
	let owner: string | null = 'user-1';
	let polls = 0;

	const handle = startConnectionPoll({
		intervalMs: 5_000,
		expiresAt: env.now() + 60_000,
		attempt: 1,
		getAttempt: () => attempt,
		owner: 'user-1',
		getOwner: () => owner,
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: () => {
			polls++;
		}
	});

	// Even if the tab is hidden when the account is deleted, the next tick clears the interval.
	env.setHidden(true);
	owner = null;
	await env.tickAll();
	assert.equal(handle.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);
	assert.equal(polls, 0);

	// Mid-flight account deletion or attempt increment stops the timer as soon as the request settles.
	env.setHidden(false);
	await new Promise((resolve) => setImmediate(resolve));
	owner = 'user-1';
	attempt = 2;
	let finishPoll!: () => void;
	const inFlightHandle = startConnectionPoll({
		intervalMs: 1_500,
		attempt: 2,
		getAttempt: () => attempt,
		owner: 'user-1',
		getOwner: () => owner,
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: () =>
			new Promise<void>((resolve) => {
				polls++;
				finishPoll = resolve;
			})
	});

	const pendingTick = env.tickAll();
	assert.equal(polls, 1);
	attempt = 3;
	owner = null;
	finishPoll();
	await pendingTick;
	assert.equal(inFlightHandle.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);
});

test('connection poll pauses while document is hidden and runs one immediate check upon return', async () => {
	const env = pollEnvironment();
	let polls = 0;

	const handle = startConnectionPoll({
		intervalMs: 5_000,
		expiresAt: env.now() + 15 * 60_000,
		attempt: 1,
		getAttempt: () => 1,
		owner: 'user-1',
		getOwner: () => 'user-1',
		isOpen: () => true,
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: async () => {
			polls++;
		}
	});

	await env.tickAll();
	assert.equal(polls, 1);

	// User switches to auth.openai.com tab: background ticks pause completely.
	env.setHidden(true);
	await env.tickAll();
	await env.tickAll();
	await env.tickAll();
	assert.equal(polls, 1);
	assert.equal(handle.active, true);

	// User returns to Flavorithm tab: one immediate poll runs, and subsequent interval ticks resume.
	env.setHidden(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(polls, 2);
	assert.equal(handle.active, true);

	await env.tickAll();
	assert.equal(polls, 3);

	handle.stop();
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);
});

test('connection poll runs one final check at wall-clock expiry before stopping', async () => {
	const env = pollEnvironment(10_000);
	const observed: boolean[] = [];

	const oauthHandle = startConnectionPoll({
		intervalMs: CHATGPT_OAUTH_POLL_INTERVAL_MS,
		expiresAt: env.now() + CHATGPT_OAUTH_TTL_MS,
		attempt: 1,
		getAttempt: () => 1,
		owner: 'user-1',
		getOwner: () => 'user-1',
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: ({ expired }) => {
			observed.push(expired);
		}
	});

	env.advanceTime(CHATGPT_OAUTH_TTL_MS - 1);
	await env.tickAll();
	assert.deepEqual(observed, [false]);
	assert.equal(oauthHandle.active, true);

	env.advanceTime(1);
	await env.tickAll();
	assert.deepEqual(observed, [false, true]);
	assert.equal(oauthHandle.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);

	// Returning to a tab after expiry also runs one final check to detect completed logins.
	env.setHidden(true);
	const returnChecks: boolean[] = [];
	const deviceHandle = startConnectionPoll({
		intervalMs: 5_000,
		expiresAt: env.now() + 30_000,
		attempt: 2,
		getAttempt: () => 2,
		owner: 'user-1',
		getOwner: () => 'user-1',
		document: env.document,
		now: env.now,
		setInterval: env.setInterval,
		clearInterval: env.clearInterval,
		poll: ({ expired }) => {
			returnChecks.push(expired);
		}
	});

	env.advanceTime(45_000);
	await env.tickAll();
	assert.deepEqual(returnChecks, []);

	env.setHidden(false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(returnChecks, [true]);
	assert.equal(deviceHandle.active, false);
	assert.equal(env.intervals.size, 0);
	assert.equal(env.listeners.size, 0);
});
