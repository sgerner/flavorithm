import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AIRequestError,
	fetchRecipePage,
	getSupportedModels,
	runAIRequest,
	transformModelCatalog,
	validateRecipeUrl
} from '../src/lib/server/ai.ts';

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
	title: 'Chickpea Tomato Skillet',
	description: 'A quick tomato and chickpea skillet.',
	image: 'https://images.example/chickpea-tomato.jpg',
	time: 25,
	servings: 2,
	difficulty: 'Easy',
	cuisine: 'Mediterranean',
	tags: ['vegetarian'],
	ingredients: [
		{ name: 'chickpeas', quantity: 1, unit: 'can' },
		{ name: 'tomatoes', quantity: 2, unit: 'cups' }
	],
	steps: ['Simmer the chickpeas and tomatoes until tender.'],
	nutrition
};

const preferences = {
	diet: 'vegetarian',
	allergies: '',
	maxTime: 40,
	complexity: 'easy',
	cuisines: ['Mediterranean', 'Indian'],
	theme: 'system',
	dark: false,
	provider: 'openai',
	model: 'gpt-4.1-mini'
};

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

test('generate uses the fixed provider host and returns validated recipes with server IDs', async () => {
	let observedUrl = '';
	let observedHeaders: Headers | undefined;
	let observedBody: any;
	const fetcher: typeof fetch = async (input, init) => {
		observedUrl = String(input);
		observedHeaders = new Headers(init?.headers);
		observedBody = JSON.parse(String(init?.body));
		return jsonResponse({
			choices: [
				{
					message: {
						content: JSON.stringify({
							recipes: [
								generatedRecipe,
								{
									...generatedRecipe,
									title: 'Recipe with an insecure image',
									image: 'http://images.example/insecure.jpg'
								}
							]
						})
					}
				}
			]
		});
	};

	const result = await runAIRequest(
		{
			action: 'generate',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'temporary-test-key',
			pantry: [{ id: 'pantry-1', name: 'chickpeas', quantity: 1, unit: 'can', category: 'Canned' }],
			preferences
		},
		fetcher
	);

	assert.equal(observedUrl, 'https://api.openai.com/v1/chat/completions');
	assert.equal(observedHeaders?.get('authorization'), 'Bearer temporary-test-key');
	assert.equal(observedBody.model, 'gpt-4.1-mini');
	assert.equal(observedBody.response_format.type, 'json_object');
	const generationPrompt = observedBody.messages
		.map((m: { content: string }) => m.content)
		.join('\n');
	assert.match(generationPrompt, /\"cuisines\":\[\"Mediterranean\",\"Indian\"\]/);
	assert.match(generationPrompt, /\"maxTime\":40/);
	assert.match(generationPrompt, /\"complexity\":\"easy\"/);
	assert.equal((result as any).recipes.length, 2);
	assert.match((result as any).recipes[0].id, /^[0-9a-f-]{36}$/i);
	assert.equal((result as any).recipes[0].image, 'https://images.example/chickpea-tomato.jpg');
	assert.equal((result as any).recipes[0].provenance, 'ai-generated');
	assert.equal((result as any).recipes[0].source, undefined);
	assert.equal((result as any).recipes[1].image, '');
	assert.equal(JSON.stringify(result).includes('temporary-test-key'), false);
});

test('vision sends image bytes to Anthropic as a base64 image block and validates ingredients', async () => {
	let observedUrl = '';
	let observedHeaders: Headers | undefined;
	let observedBody: any;
	const fetcher: typeof fetch = async (input, init) => {
		observedUrl = String(input);
		observedHeaders = new Headers(init?.headers);
		observedBody = JSON.parse(String(init?.body));
		return jsonResponse({
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						ingredients: [{ name: 'apple', quantity: 3, unit: 'items', category: 'Produce' }]
					})
				}
			]
		});
	};

	const result = await runAIRequest(
		{
			action: 'vision',
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			apiKey: 'anthropic-temporary-key',
			image: 'data:image/png;base64,aGVsbG8='
		},
		fetcher
	);

	assert.equal(observedUrl, 'https://api.anthropic.com/v1/messages');
	assert.equal(observedHeaders?.get('x-api-key'), 'anthropic-temporary-key');
	assert.deepEqual(observedBody.messages[0].content[0], {
		type: 'image',
		source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
	});
	assert.equal(observedBody.output_config.format.type, 'json_schema');
	assert.deepEqual(result, {
		ingredients: [{ name: 'apple', quantity: 3, unit: 'items', category: 'Produce' }]
	});
});

test('search fails with a clear configuration error when Brave is not configured', async () => {
	const previous = process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.BRAVE_SEARCH_API_KEY;
	try {
		await assert.rejects(
			runAIRequest({ action: 'search', prompt: 'lentil soup' }, async () => {
				throw new Error('fetch should not be called');
			}),
			(error: unknown) =>
				error instanceof AIRequestError &&
				error.status === 503 &&
				error.message.includes('BRAVE_SEARCH_API_KEY')
		);
	} finally {
		if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
		else process.env.BRAVE_SEARCH_API_KEY = previous;
	}
});

test('search returns only real Brave results with HTTPS URLs', async () => {
	const previous = process.env.BRAVE_SEARCH_API_KEY;
	process.env.BRAVE_SEARCH_API_KEY = 'brave-test-key';
	let observedUrl = '';
	let observedHeaders: Headers | undefined;
	const fetcher: typeof fetch = async (input, init) => {
		observedUrl = String(input);
		observedHeaders = new Headers(init?.headers);
		return jsonResponse({
			web: {
				results: [
					{
						title: 'Lentil soup',
						url: 'https://recipes.example/lentils',
						description: 'A soup recipe.'
					},
					{
						title: 'Unsafe link',
						url: 'http://example.test/recipe',
						description: 'Should be omitted.'
					}
				]
			}
		});
	};

	try {
		const result = await runAIRequest(
			{
				action: 'search',
				prompt: 'lentil soup',
				provider: 'openai',
				model: '',
				apiKey: ''
			},
			fetcher
		);
		assert.equal(new URL(observedUrl).origin, 'https://api.search.brave.com');
		assert.match(new URL(observedUrl).searchParams.get('q') ?? '', /recipe/);
		assert.equal(observedHeaders?.get('x-subscription-token'), 'brave-test-key');
		assert.deepEqual(result, {
			results: [
				{
					title: 'Lentil soup',
					url: 'https://recipes.example/lentils',
					description: 'A soup recipe.'
				}
			]
		});
	} finally {
		if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
		else process.env.BRAVE_SEARCH_API_KEY = previous;
	}
});

test('import normalizes a real allowlisted JSON-LD recipe and preserves server-verified attribution', async () => {
	const sourceImage = 'https://images.allrecipes.com/original-recipe.jpg';
	const html = `
		<link rel="canonical" href="https://www.allrecipes.com/recipe/original/">
		<script type="application/ld+json">${JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'Recipe',
			name: 'Source Chickpea Stew',
			description: 'A source recipe.',
			image: sourceImage,
			recipeYield: '4 servings',
			totalTime: 'PT45M',
			recipeIngredient: ['1 can chickpeas', '2 cups tomatoes'],
			recipeInstructions: [
				{ '@type': 'HowToStep', text: 'Warm the oil.' },
				{ '@type': 'HowToStep', text: 'Simmer the chickpeas and tomatoes.' }
			],
			nutrition: { '@type': 'NutritionInformation', calories: '390 kcal', proteinContent: '18 g' }
		})}</script>
	`;
	let observedPrompt = '';
	let observedPageUrl = '';
	const fetcher: typeof fetch = async (_input, init) => {
		const request = JSON.parse(String(init?.body));
		observedPrompt = request.messages[1].content;
		return jsonResponse({
			choices: [
				{
					message: {
						content: JSON.stringify({
							...generatedRecipe,
							image: 'https://model-invented.example/image.jpg'
						})
					}
				}
			]
		});
	};
	const pageFetcher = async (url: string) => {
		observedPageUrl = url;
		return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
	};

	const result = (await runAIRequest(
		{
			action: 'import',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'temporary-import-key',
			url: 'https://www.allrecipes.com/recipe/selected/'
		},
		fetcher,
		pageFetcher
	)) as any;

	assert.equal(observedPageUrl, 'https://www.allrecipes.com/recipe/selected/');
	assert.match(
		observedPrompt,
		/Canonical source URL for attribution: "https:\/\/www\.allrecipes\.com\/recipe\/original\/"/
	);
	assert.match(observedPrompt, /1 can chickpeas/);
	assert.match(observedPrompt, /Simmer the chickpeas and tomatoes/);
	assert.equal(result.recipes.length, 1);
	assert.equal(result.recipes[0].source, 'https://www.allrecipes.com/recipe/original/');
	assert.equal(result.recipes[0].image, sourceImage);
	assert.equal(result.recipes[0].provenance, 'web-import');
	assert.equal(result.recipes[0].nutrition.calories, 390);
	assert.equal(result.recipes[0].nutrition.protein, 18);
	assert.match(result.recipes[0].id, /^[0-9a-f-]{36}$/i);
	assert.equal(JSON.stringify(result).includes('temporary-import-key'), false);
});

test('import rejects unapproved URLs before fetching a page or calling an AI provider', async () => {
	let pageFetches = 0;
	let providerCalls = 0;
	await assert.rejects(
		runAIRequest(
			{
				action: 'import',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'temporary-import-key',
				url: 'https://allrecipes.com.example.invalid/recipe'
			},
			async () => {
				providerCalls += 1;
				throw new Error('provider should not be called');
			},
			async () => {
				pageFetches += 1;
				throw new Error('page should not be fetched');
			}
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(pageFetches, 0);
	assert.equal(providerCalls, 0);
});

test('recipe page fetching blocks private DNS answers before opening a connection', async () => {
	let requests = 0;
	await assert.rejects(
		fetchRecipePage('https://www.allrecipes.com/recipe/test', {
			resolveAddresses: async () => ['127.0.0.1'],
			requestPinned: async () => {
				requests += 1;
				return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
			}
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(requests, 0);
});

test('recipe page redirects are manual and are rechecked against the allowlist', async () => {
	let requests = 0;
	await assert.rejects(
		fetchRecipePage('https://www.allrecipes.com/recipe/test', {
			resolveAddresses: async () => ['93.184.216.34'],
			requestPinned: async () => {
				requests += 1;
				return new Response(null, {
					status: 302,
					headers: { location: 'https://127.0.0.1/private' }
				});
			}
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(requests, 1);
});

test('recipe page response body is capped at one megabyte', async () => {
	await assert.rejects(
		fetchRecipePage('https://www.allrecipes.com/recipe/test', {
			resolveAddresses: async () => ['93.184.216.34'],
			requestPinned: async () =>
				new Response(new Uint8Array(1_000_001), {
					headers: { 'content-type': 'text/html' }
				})
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 413
	);
});

test('recipe import URL validation allows HTTPS pages on approved domains only', () => {
	assert.equal(
		validateRecipeUrl('https://www.bbcgoodfood.com/recipes/example').hostname,
		'www.bbcgoodfood.com'
	);
	for (const url of [
		'http://www.bbcgoodfood.com/recipes/example',
		'https://bbcgoodfood.com.evil.example/recipes/example',
		'https://user:pass@allrecipes.com/recipe/example',
		'https://allrecipes.com:8443/recipe/example'
	]) {
		assert.throws(
			() => validateRecipeUrl(url),
			(error: unknown) => error instanceof AIRequestError && error.status === 400
		);
	}
});

test('models catalog only exposes the supported providers and marks image input models', () => {
	const catalog = {
		openai: {
			name: 'OpenAI',
			models: {
				'gpt-4.1-mini': { name: 'GPT-4.1 mini', modalities: { input: ['text', 'image'] } },
				'o1-mini': { name: 'o1 mini', modalities: { input: ['text'] } }
			}
		},
		anthropic: {
			name: 'Anthropic',
			models: { 'claude-sonnet': { modalities: { input: ['text', 'image'] } } }
		},
		google: { name: 'Google', models: { gemini: { modalities: { input: ['text', 'image'] } } } }
	};
	assert.deepEqual(transformModelCatalog(catalog), {
		providers: [
			{
				id: 'openai',
				name: 'OpenAI',
				models: [
					{ id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', vision: true },
					{ id: 'o1-mini', name: 'o1 mini', vision: false }
				]
			},
			{
				id: 'anthropic',
				name: 'Anthropic',
				models: [{ id: 'claude-sonnet', name: 'claude-sonnet', vision: true }]
			}
		]
	});
});

test('model endpoint fetch uses the public models.dev catalog URL', async () => {
	let observedUrl = '';
	const fetcher: typeof fetch = async (input) => {
		observedUrl = String(input);
		return jsonResponse({
			openrouter: {
				name: 'OpenRouter',
				models: {
					'openai/gpt-4.1-mini': { name: 'GPT-4.1 mini', modalities: { input: ['text', 'image'] } }
				}
			}
		});
	};

	const result = await getSupportedModels(fetcher);
	assert.equal(observedUrl, 'https://models.dev/api.json');
	assert.deepEqual(result.providers, [
		{
			id: 'openrouter',
			name: 'OpenRouter',
			models: [{ id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', vision: true }]
		}
	]);
});
