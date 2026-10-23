import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchConnections, searchModels } from '../src/lib/ai-connections.ts';
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
