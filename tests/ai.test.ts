import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ChatGPTInferenceError } from '../src/lib/server/chatgpt-inference.ts';
import {
	AIRequestError,
	fetchCaptureRecipePage,
	fetchRecipePage,
	getSupportedModels,
	runAIRequest,
	transformModelCatalog,
	validateCaptureRecipeUrl,
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

const capturedRecipe = {
	...generatedRecipe,
	image: '',
	assumptions: ['Estimated 1 can of chickpeas from the listed quantity.']
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

function structuredRecipeHtml(nutrition: unknown) {
	return `<script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Recipe',
		name: 'Source Rice',
		recipeYield: '2 servings',
		totalTime: 'PT20M',
		recipeIngredient: ['1 cup rice'],
		recipeInstructions: ['Cook the rice.'],
		nutrition
	})}</script>`;
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

test('AI accepts persisted edited recipes with long descriptions and steps', async () => {
	const longDescription = 'A'.repeat(5_000);
	const longStep = 'S'.repeat(5_000);
	const editedRatedRecipe = {
		...generatedRecipe,
		id: 'edited-recipe',
		description: longDescription,
		steps: [longStep],
		tags: Array.from({ length: 50 }, (_, index) => `tag-${index}`),
		ingredients: Array.from({ length: 101 }, (_, index) => ({
			name: `ingredient-${index}`,
			quantity: 1,
			unit: 'piece'
		})),
		source: `https://recipes.example.test/${'x'.repeat(2_500)}`,
		rating: 5
	};
	let nutritionPrompt = '';
	const nutritionResult = await runAIRequest(
		{
			action: 'nutrition',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'temporary-test-key',
			recipe: editedRatedRecipe
		},
		async (_input, init) => {
			nutritionPrompt = JSON.parse(String(init?.body)).messages[1].content;
			return jsonResponse({ choices: [{ message: { content: JSON.stringify(nutrition) } }] });
		}
	);
	assert.deepEqual(nutritionResult, nutrition);
	assert.ok(nutritionPrompt.includes(longDescription));
	assert.ok(nutritionPrompt.includes(longStep));

	let generationPrompt = '';
	await runAIRequest(
		{
			action: 'generate',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'temporary-test-key',
			preferences,
			recipes: [editedRatedRecipe]
		},
		async (_input, init) => {
			generationPrompt = JSON.parse(String(init?.body)).messages[1].content;
			return jsonResponse({
				choices: [{ message: { content: JSON.stringify({ recipes: [generatedRecipe] }) } }]
			});
		}
	);
	assert.match(generationPrompt, /"rating":5/);
	assert.match(generationPrompt, /Chickpea Tomato Skillet/);
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

test('capture turns recipe text into an unsaved validated draft and never fetches embedded links', async () => {
	let observedBody: any;
	let pageFetches = 0;
	const fetcher: typeof fetch = async (_input, init) => {
		observedBody = JSON.parse(String(init?.body));
		return jsonResponse({
			choices: [{ message: { content: JSON.stringify(capturedRecipe) } }]
		});
	};

	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'temporary-capture-key',
			prompt:
				'Grandma’s chickpea skillet: chickpeas, tomatoes, simmer until tender. See https://www.allrecipes.com/recipe/example'
		},
		fetcher,
		async () => {
			pageFetches += 1;
			throw new Error('embedded links should never be fetched');
		}
	)) as any;

	assert.equal(pageFetches, 0);
	assert.equal(observedBody.response_format.type, 'json_object');
	assert.match(observedBody.messages[0].content, /assumptions/);
	assert.match(observedBody.messages[1].content, /Preserve the source title/);
	assert.match(
		observedBody.messages[1].content,
		/If steps are missing, create complete, practical, ordered steps/
	);
	assert.match(
		observedBody.messages[1].content,
		/Record generated or materially clarified steps in assumptions/
	);
	assert.match(observedBody.messages[1].content, /Grandma’s chickpea skillet/);
	assert.match(result.recipe.id, /^[0-9a-f-]{36}$/i);
	assert.equal(result.recipe.saved, false);
	assert.equal(result.recipe.image, '');
	assert.equal(result.recipe.source, undefined);
	assert.deepEqual(result.assumptions, capturedRecipe.assumptions);
	assert.equal(JSON.stringify(result).includes('temporary-capture-key'), false);
});

test('capture sends photo bytes to Anthropic and includes assumptions in its response schema', async () => {
	let observedBody: any;
	const fetcher: typeof fetch = async (_input, init) => {
		observedBody = JSON.parse(String(init?.body));
		return jsonResponse({
			content: [{ type: 'text', text: JSON.stringify({ ...capturedRecipe, assumptions: [] }) }]
		});
	};

	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
			apiKey: 'anthropic-capture-key',
			image: 'data:image/png;base64,aGVsbG8='
		},
		fetcher
	)) as any;

	assert.equal(observedBody.messages[0].content[0].type, 'image');
	assert.equal(observedBody.output_config.format.type, 'json_schema');
	assert.deepEqual(observedBody.output_config.format.schema.properties.assumptions, {
		type: 'array',
		maxItems: 30,
		items: { type: 'string', maxLength: 300 }
	});
	assert.equal(result.recipe.saved, false);
	assert.deepEqual(result.assumptions, []);
});

test('capture sends ChatGPT plan photos through the public Responses API', async () => {
	let observedUrl = '';
	let observedHeaders: Headers | undefined;
	let observedBody: any;
	const responseText = JSON.stringify({ ...capturedRecipe, assumptions: [] });
	const fetcher: typeof fetch = async (input, init) => {
		observedUrl = String(input);
		observedHeaders = new Headers(init?.headers);
		observedBody = JSON.parse(String(init?.body));
		return new Response(
			`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: responseText })}\n\n` +
				`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
			{ headers: { 'content-type': 'text/event-stream' } }
		);
	};

	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'chatgpt',
			model: 'gpt-4.1',
			image: 'data:image/jpeg;base64,aGVsbG8='
		},
		fetcher,
		undefined,
		{ accessToken: 'chatgpt-plan-token' }
	)) as any;

	assert.equal(observedUrl, 'https://api.openai.com/v1/responses');
	assert.equal(observedHeaders?.get('authorization'), 'Bearer chatgpt-plan-token');
	assert.equal(observedBody.store, false);
	assert.equal(observedBody.input[0].content[1].type, 'input_image');
	assert.match(observedBody.instructions, /assumptions/);
	assert.deepEqual(result.assumptions, []);
});

test('capture abort signal cancels a pending provider request', async () => {
	const controller = new AbortController();
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let abortObserved = false;
	const fetcher: typeof fetch = async (_input, init) => {
		markStarted();
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				'abort',
				() => {
					abortObserved = true;
					reject(new DOMException('Request aborted.', 'AbortError'));
				},
				{ once: true }
			);
		});
	};

	const request = runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			prompt: 'Recipe notes'
		},
		fetcher,
		undefined,
		undefined,
		controller.signal
	);
	await started;
	controller.abort();
	await assert.rejects(request, (error: unknown) => error instanceof AIRequestError);
	assert.equal(abortObserved, true);
});

test('capture abort signal reaches the ChatGPT Responses adapter without dropping its timeout', async () => {
	const controller = new AbortController();
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let abortObserved = false;
	const fetcher: typeof fetch = async (_input, init) => {
		assert.ok(init?.signal);
		assert.notEqual(init.signal, controller.signal);
		markStarted();
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener(
				'abort',
				() => {
					abortObserved = true;
					reject(new DOMException('Request aborted.', 'AbortError'));
				},
				{ once: true }
			);
		});
	};

	const request = runAIRequest(
		{ action: 'capture', provider: 'chatgpt', model: 'gpt-4.1', prompt: 'Recipe notes' },
		fetcher,
		undefined,
		{ accessToken: 'chatgpt-plan-token' },
		controller.signal
	);
	await started;
	controller.abort();
	await assert.rejects(request, (error: unknown) => error instanceof ChatGPTInferenceError);
	assert.equal(abortObserved, true);
});

test('capture abort signal cancels an in-progress recipe page fetch before provider work', async () => {
	const controller = new AbortController();
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let abortObserved = false;
	let providerCalls = 0;
	const request = runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/recipe'
		},
		async () => {
			providerCalls += 1;
			throw new Error('provider should not be called');
		},
		async (_url, _policy, signal) =>
			new Promise((_resolve, reject) => {
				markStarted();
				signal?.addEventListener(
					'abort',
					() => {
						abortObserved = true;
						reject(new DOMException('Page request aborted.', 'AbortError'));
					},
					{ once: true }
				);
			}),
		undefined,
		controller.signal
	);

	await started;
	controller.abort();
	await assert.rejects(request);
	assert.equal(abortObserved, true);
	assert.equal(providerCalls, 0);
});

test('capture autodetects a standalone recipe URL and falls back to bounded readable page text', async () => {
	let observedUrl = '';
	let observedPolicy = '';
	let observedPrompt = '';
	const pageHtml = `
		<html><head><title>Page title</title><script>private script text</script></head>
		<body><h1>Grandma's Noodles</h1><p>Ingredients: 2 cups flour, 1 egg.</p>
		<p>Mix and roll the dough, then boil it.</p></body></html>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};

	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			prompt: '  https://recipes.example.test/no-structured-data/#ingredients  '
		},
		fetcher,
		async (url, policy) => {
			observedUrl = url;
			observedPolicy = policy ?? '';
			return new Response(pageHtml, { headers: { 'content-type': 'text/html' } });
		}
	)) as any;

	assert.equal(observedUrl, 'https://recipes.example.test/no-structured-data/');
	assert.equal(observedPolicy, 'capture');
	assert.match(observedPrompt, /Grandma's Noodles/);
	assert.match(observedPrompt, /2 cups flour, 1 egg/);
	assert.doesNotMatch(observedPrompt, /private script text|Page title/);
	assert.equal(result.recipe.source, 'https://recipes.example.test/no-structured-data/');
	assert.equal(result.recipe.provenance, 'web-import');
});

test('capture fallback preserves unknown named HTML entities in recipe text', async () => {
	let observedPrompt = '';
	const pageHtml = `<main><h1>Cr&egrave;me pasta</h1>
		<p>Ingredients: &frac12; cup flour and Cr&egrave;me fra&icirc;che.</p>
		<p>Stir the ingredients together.</p></main>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};

	await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/entities'
		},
		fetcher,
		async () => new Response(pageHtml, { headers: { 'content-type': 'text/html' } })
	);

	assert.match(observedPrompt, /Cr&egrave;me pasta/);
	assert.match(observedPrompt, /&frac12; cup flour/);
	assert.match(observedPrompt, /Cr&egrave;me fra&icirc;che/);
});

test('capture prioritizes main recipe content over oversized page navigation', async () => {
	let observedPrompt = '';
	const boilerplate = 'Navigation category link. '.repeat(1_000);
	const pageHtml = `
		<html><head><title>Unrelated title</title></head><body>
		<nav>${boilerplate}</nav>
		<header>${boilerplate}</header>
		<main><h1>Late page recipe</h1>
		<p>Ingredients: 2 cups flour and 1 egg.</p>
		<p>Mix the flour and egg, then boil the noodles.</p></main>
		<footer>${boilerplate}</footer>
		</body></html>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};

	await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/long-page'
		},
		fetcher,
		async () => new Response(pageHtml, { headers: { 'content-type': 'text/html' } })
	);

	assert.ok(pageHtml.indexOf('<main>') > 20_000, 'boilerplate should exceed the text cap');
	assert.match(observedPrompt, /Late page recipe/);
	assert.match(observedPrompt, /2 cups flour and 1 egg/);
	assert.match(observedPrompt, /Mix the flour and egg, then boil the noodles/);
	assert.doesNotMatch(observedPrompt, /Navigation category link|Unrelated title/);
});

test('capture uses article content when the page has no main element', async () => {
	let observedPrompt = '';
	const pageHtml = `
		<nav>Site navigation.</nav><article>
		<h1>Article recipe</h1><p>Ingredients: 3 potatoes.</p>
		<p>Roast the potatoes until tender.</p></article><footer>Legal links.</footer>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};

	await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/article'
		},
		fetcher,
		async () => new Response(pageHtml, { headers: { 'content-type': 'text/html' } })
	);

	assert.match(observedPrompt, /Article recipe/);
	assert.match(observedPrompt, /3 potatoes/);
	assert.match(observedPrompt, /Roast the potatoes until tender/);
	assert.doesNotMatch(observedPrompt, /Site navigation|Legal links/);
});

test('malformed HTML token scans stay linear for repeated unclosed tags and angle brackets', () => {
	const childScript = `
		import { AIRequestError, runAIRequest } from './src/lib/server/ai.ts';
		const recipe = ${JSON.stringify(capturedRecipe)};
		async function capture(html, shouldSucceed = false) {
			let providerCalls = 0;
			try {
				const result = await runAIRequest(
					{ action: 'capture', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'capture-key', prompt: 'https://recipes.example.test/path' },
					async () => {
						providerCalls += 1;
						return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(recipe) } }] }), { headers: { 'content-type': 'application/json' } });
					},
					async () => new Response(html, { headers: { 'content-type': 'text/html' } })
				);
				if (!shouldSucceed || providerCalls !== 1 || result.recipe.title !== recipe.title) throw new Error('unexpected capture result');
			} catch (error) {
				if (shouldSucceed || !(error instanceof AIRequestError) || error.status !== 422 || providerCalls !== 0) throw error;
			}
		}
		for (const malformed of [
			'<script>'.repeat(100_000) + '<main>Tomato pasta</main>',
			'<!--'.repeat(100_000),
			'<link'.repeat(100_000)
		]) await capture(malformed);
		await capture('<'.repeat(100_000) + '<main><h1>Tomato pasta</h1><p>Ingredients: tomatoes.</p><p>Simmer the sauce.</p></main>', true);
	`;
	const child = spawnSync(
		process.execPath,
		['--experimental-strip-types', '--input-type=module', '-e', childScript],
		{ cwd: process.cwd(), encoding: 'utf8', timeout: 4_000, maxBuffer: 2_000_000 }
	);

	assert.equal(
		child.status,
		0,
		`child parser regression failed or timed out: ${child.error?.message ?? child.stderr}`
	);
});

test('deeply nested JSON-LD scalar values are bounded and fall back safely', async () => {
	let observedPrompt = '';
	const deeplyNestedName = '['.repeat(10_000) + '"Malformed title"' + ']'.repeat(10_000);
	const nestedNamePage = `<script type="application/ld+json">{"@type":"Recipe","name":${deeplyNestedName},"recipeYield":"2 servings","recipeIngredient":["1 cup rice"],"recipeInstructions":["Cook the rice."]}</script><main><h1>Fallback noodles</h1><p>Ingredients: 1 cup rice.</p><p>Cook the rice until tender.</p></main>`;
	const deeplyNestedCalories = '['.repeat(10_000) + '"350 kcal"' + ']'.repeat(10_000);
	const nestedNutritionPage = `<script type="application/ld+json">{"@type":"Recipe","name":"Rice","recipeYield":"2 servings","recipeIngredient":["1 cup rice"],"recipeInstructions":["Cook the rice."],"nutrition":{"calories":${deeplyNestedCalories}}}</script>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};
	const input = {
		action: 'capture' as const,
		provider: 'openai' as const,
		model: 'gpt-4.1-mini',
		apiKey: 'capture-key',
		url: 'https://recipes.example.test/deep-jsonld'
	};

	await runAIRequest(
		input,
		fetcher,
		async () => new Response(nestedNamePage, { headers: { 'content-type': 'text/html' } })
	);
	assert.match(observedPrompt, /Fallback noodles/);
	assert.doesNotMatch(observedPrompt, /Malformed title/);

	const result = (await runAIRequest(
		input,
		fetcher,
		async () => new Response(nestedNutritionPage, { headers: { 'content-type': 'text/html' } })
	)) as any;
	assert.deepEqual(result.recipe.nutrition, nutrition);
});

test('structured JSON-LD scalar arrays preserve their source order', async () => {
	let observedPrompt = '';
	const html = `<script type="application/ld+json">${JSON.stringify({
		'@type': 'Recipe',
		name: ['Rice', ['Bowl', 'Soup'], { name: 'Stew' }],
		recipeYield: '2 servings',
		recipeIngredient: ['1 cup rice'],
		recipeInstructions: ['Cook the rice.']
	})}</script>`;
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		observedPrompt = body.messages[1].content;
		return jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] });
	};

	await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/array-name'
		},
		fetcher,
		async () => new Response(html, { headers: { 'content-type': 'text/html' } })
	);

	assert.match(observedPrompt, /"title":"Rice, Bowl, Soup, Stew"/);
});

test('capture only returns HTTPS source images from fetched recipe metadata', async () => {
	for (const unsafeImage of [
		'javascript:alert(1)',
		'data:image/png;base64,aGVsbG8=',
		'file:///etc/passwd'
	]) {
		const html = `<script type="application/ld+json">${JSON.stringify({
			'@type': 'Recipe',
			name: 'Rice',
			image: unsafeImage,
			recipeYield: '2 servings',
			totalTime: 'PT20M',
			recipeIngredient: ['1 cup rice'],
			recipeInstructions: ['Cook the rice.']
		})}</script>`;
		const result = (await runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				url: 'https://www.allrecipes.com/recipe/rice'
			},
			async () =>
				jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] }),
			async () => new Response(html, { headers: { 'content-type': 'text/html' } })
		)) as any;

		assert.equal(result.recipe.image, '');
	}
});

test('capture canonicals stay on the fetched origin while import keeps its site allowlist', async () => {
	const cases = [
		{
			action: 'capture' as const,
			url: 'https://recipes.example.test/selected',
			canonical: 'https://recipes.example.test/normalized',
			expected: 'https://recipes.example.test/normalized'
		},
		{
			action: 'capture' as const,
			url: 'https://recipes.example.test/selected',
			canonical: 'https://publisher.example/normalized',
			expected: 'https://recipes.example.test/selected'
		},
		{
			action: 'capture' as const,
			url: 'https://recipes.example.test/selected',
			canonical: 'https://127.0.0.1/private',
			expected: 'https://recipes.example.test/selected'
		},
		{
			action: 'import' as const,
			url: 'https://www.allrecipes.com/recipe/selected',
			canonical: 'https://publisher.example/normalized',
			expected: 'https://www.allrecipes.com/recipe/selected'
		}
	];

	for (const { action, url, canonical, expected } of cases) {
		const html = `<link rel="canonical" href="${canonical}">${structuredRecipeHtml(undefined)}`;
		const modelRecipe = action === 'capture' ? capturedRecipe : generatedRecipe;
		const result = (await runAIRequest(
			{ action, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'capture-key', url },
			async () =>
				jsonResponse({ choices: [{ message: { content: JSON.stringify(modelRecipe) } }] }),
			async () => new Response(html, { headers: { 'content-type': 'text/html' } })
		)) as any;
		const recipe = action === 'capture' ? result.recipe : result.recipes[0];
		assert.equal(recipe.source, expected, `${action}: ${canonical}`);
	}
});

test('capture converts structured nutrition into the units shown by the recipe editor', async () => {
	const html = structuredRecipeHtml({
		calories: '1,500 kJ',
		fatContent: '2,000 mg',
		saturatedFatContent: { value: '3', unitCode: 'GRM' },
		sodiumContent: '0.6 g',
		carbohydrateContent: '45,000 mg',
		fiberContent: { value: '4,000', unitCode: 'MGM' },
		sugarContent: '0,6 g',
		proteinContent: { value: '18,000', unitCode: 'MGM' }
	});
	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/rice'
		},
		async () =>
			jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] }),
		async () => new Response(html, { headers: { 'content-type': 'text/html' } })
	)) as any;

	assert.deepEqual(result.recipe.nutrition, {
		calories: 1_500 / 4.184,
		fat: 2,
		saturatedFat: 3,
		sodium: 600,
		carbs: 45,
		fiber: 4,
		sugar: 0.6,
		protein: 18
	});
});

test('capture parses leading decimals and does not turn negative decimals positive', async () => {
	const html = structuredRecipeHtml({
		calories: '-.5 kcal',
		fatContent: '.5 g',
		saturatedFatContent: '-,5 g',
		sodiumContent: '-.5 mg',
		carbohydrateContent: ',5 g',
		fiberContent: '-0,5 g',
		sugarContent: '.25 g',
		proteinContent: '-.25 g'
	});
	const result = (await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url: 'https://recipes.example.test/rice'
		},
		async () =>
			jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] }),
		async () => new Response(html, { headers: { 'content-type': 'text/html' } })
	)) as any;

	assert.deepEqual(result.recipe.nutrition, {
		calories: nutrition.calories,
		fat: 0.5,
		saturatedFat: nutrition.saturatedFat,
		sodium: nutrition.sodium,
		carbs: 0.5,
		fiber: nutrition.fiber,
		sugar: 0.25,
		protein: nutrition.protein
	});
});

test('capture keeps model nutrition when source values use per-volume or recipe-total bases', async () => {
	const sources = [
		{
			servingSize: '100 g',
			calories: '350 kcal',
			proteinContent: '12 g',
			sodiumContent: '600 mg'
		},
		{
			servingSize: '100 mL',
			calories: '350 kcal',
			proteinContent: '12 g',
			sodiumContent: '600 mg'
		},
		{
			servingSize: { value: '100', unitCode: 'MLT' },
			calories: '350 kcal',
			proteinContent: '12 g',
			sodiumContent: '600 mg'
		},
		{
			servingSize: '1 serving',
			calories: '350 kcal per 100 mL',
			proteinContent: '12 g',
			sodiumContent: '600 mg'
		},
		{
			servingSize: '1 serving',
			calories: '350 kcal',
			proteinContent: '3 g/100 g',
			sodiumContent: '600 mg'
		},
		{
			servingSize: '1 serving',
			calories: '350 kcal',
			proteinContent: '12 g',
			sodiumContent: '2 mg / 100 ml'
		},
		{
			servingSize: '1 serving',
			calories: '1,200 kcal for the whole recipe',
			proteinContent: '48 g per recipe',
			sodiumContent: '2,400 mg'
		},
		{
			servingSize: 'entire batch',
			calories: '1,200 kcal',
			proteinContent: '48 g',
			sodiumContent: '2,400 mg'
		}
	];

	for (const source of sources) {
		const result = (await runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				url: 'https://recipes.example.test/rice'
			},
			async () =>
				jsonResponse({ choices: [{ message: { content: JSON.stringify(capturedRecipe) } }] }),
			async () =>
				new Response(structuredRecipeHtml(source), {
					headers: { 'content-type': 'text/html' }
				})
		)) as any;

		assert.deepEqual(result.recipe.nutrition, nutrition, JSON.stringify(source));
	}
});

test('capture and import ignore source nutrition outside finite persistence bounds', async () => {
	const html = structuredRecipeHtml({
		calories: `${'9'.repeat(400)} kcal`,
		sodiumContent: '1,000,001 mg'
	});
	for (const action of ['capture', 'import'] as const) {
		const modelRecipe = action === 'capture' ? capturedRecipe : generatedRecipe;
		const input = {
			action,
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			url:
				action === 'capture'
					? 'https://recipes.example.test/rice'
					: 'https://www.allrecipes.com/recipe/rice'
		};
		const result = (await runAIRequest(
			input,
			async () =>
				jsonResponse({ choices: [{ message: { content: JSON.stringify(modelRecipe) } }] }),
			async () => new Response(html, { headers: { 'content-type': 'text/html' } })
		)) as any;
		const recipe = action === 'capture' ? result.recipe : result.recipes[0];
		assert.deepEqual(recipe.nutrition, nutrition, `${action} should retain the model estimate`);
	}
});

test('capture rejects model nutrition and ingredient values above persistence bounds', async () => {
	for (const modelRecipe of [
		{ ...capturedRecipe, nutrition: { ...nutrition, calories: 1_000_001 } },
		{
			...capturedRecipe,
			ingredients: [{ ...capturedRecipe.ingredients[0], quantity: 1_000_001 }]
		}
	]) {
		await assert.rejects(
			runAIRequest(
				{
					action: 'capture',
					provider: 'openai',
					model: 'gpt-4.1-mini',
					apiKey: 'capture-key',
					prompt: 'A rice recipe'
				},
				async () =>
					jsonResponse({ choices: [{ message: { content: JSON.stringify(modelRecipe) } }] })
			),
			(error: unknown) => error instanceof AIRequestError && error.status === 502
		);
	}
});

test('capture accepts prompts up to 20,000 characters and rejects longer prompts', async () => {
	const maxPrompt = 'recipe notes '.repeat(1_539).slice(0, 20_000);
	const fetcher: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		assert.ok(body.messages[1].content.includes(maxPrompt));
		return jsonResponse({
			choices: [{ message: { content: JSON.stringify({ ...capturedRecipe, assumptions: [] }) } }]
		});
	};
	await runAIRequest(
		{
			action: 'capture',
			provider: 'openai',
			model: 'gpt-4.1-mini',
			apiKey: 'capture-key',
			prompt: maxPrompt
		},
		fetcher
	);
	await assert.rejects(
		runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				prompt: `${maxPrompt}x`
			},
			async () => {
				throw new Error('provider should not be called');
			}
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
});

test('capture rejects empty input, unsafe URLs, malformed provider results, and oversized photos', async () => {
	let fetches = 0;
	const noFetch: typeof fetch = async () => {
		fetches += 1;
		throw new Error('provider should not be called');
	};
	await assert.rejects(
		runAIRequest({ action: 'capture' }, noFetch),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	await assert.rejects(
		runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				url: 'https://127.0.0.1/recipe'
			},
			noFetch,
			async () => {
				throw new Error('page should not be fetched');
			}
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(fetches, 0);

	await assert.rejects(
		runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				prompt: 'some recipe text',
				image: 'data:image/png;base64,not valid'
			},
			noFetch
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	const oversizedImage = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}`;
	await assert.rejects(
		runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				image: oversizedImage
			},
			noFetch
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 413
	);

	await assert.rejects(
		runAIRequest(
			{
				action: 'capture',
				provider: 'openai',
				model: 'gpt-4.1-mini',
				apiKey: 'capture-key',
				prompt: 'some recipe text'
			},
			async () =>
				jsonResponse({
					choices: [
						{
							message: {
								content: JSON.stringify({
									...capturedRecipe,
									assumptions: Array(31).fill('Extra assumption')
								})
							}
						}
					]
				})
		),
		(error: unknown) => error instanceof AIRequestError && error.status === 502
	);
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
			nutrition: {
				'@type': 'NutritionInformation',
				calories: '390 kcal',
				proteinContent: '18 g',
				sodiumContent: '0.6 g'
			}
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
	assert.equal(result.recipes[0].nutrition.sodium, 600);
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

test('capture URL validation allows arbitrary public HTTPS hosts while blocking unsafe targets', () => {
	assert.equal(validateCaptureRecipeUrl('https://recipes.example.test/path#section').hash, '');
	assert.equal(validateCaptureRecipeUrl('https://8.8.8.8/recipe').hostname, '8.8.8.8');
	assert.equal(
		validateCaptureRecipeUrl('https://[2606:4700:4700::1111]/recipe').protocol,
		'https:'
	);
	for (const url of [
		'http://recipes.example.test/recipe',
		'https://user:pass@recipes.example.test/recipe',
		'https://recipes.example.test:8443/recipe',
		'https://127.0.0.1/recipe',
		'https://10.2.3.4/recipe',
		'https://169.254.169.254/latest/meta-data',
		'https://192.168.1.3/recipe',
		'https://[::1]/recipe',
		'https://[fc00::1]/recipe',
		'https://localhost/recipe',
		'https://private.local/recipe'
	]) {
		assert.throws(
			() => validateCaptureRecipeUrl(url),
			(error: unknown) => error instanceof AIRequestError && error.status === 400,
			url
		);
	}
});

test('capture page transport rejects private DNS answers and unsafe redirects', async () => {
	let requests = 0;
	await assert.rejects(
		fetchCaptureRecipePage('https://recipes.example.test/recipe', {
			resolveAddresses: async () => ['127.0.0.1'],
			requestPinned: async () => {
				requests += 1;
				return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
			}
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(requests, 0);

	await assert.rejects(
		fetchCaptureRecipePage('https://recipes.example.test/recipe', {
			resolveAddresses: async () => ['93.184.216.34'],
			requestPinned: async () => {
				requests += 1;
				return new Response(null, {
					status: 302,
					headers: { location: 'https://169.254.169.254/latest/meta-data' }
				});
			}
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 400
	);
	assert.equal(requests, 1);
});

test('capture page transport aborts a pending pinned request when its caller disconnects', async () => {
	const controller = new AbortController();
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let abortObserved = false;
	const request = fetchCaptureRecipePage('https://recipes.example.test/recipe', {
		signal: controller.signal,
		resolveAddresses: async () => ['93.184.216.34'],
		requestPinned: async (_url, _address, signal) =>
			new Promise((_resolve, reject) => {
				markStarted();
				signal.addEventListener(
					'abort',
					() => {
						abortObserved = true;
						reject(new DOMException('Page request aborted.', 'AbortError'));
					},
					{ once: true }
				);
			})
	});

	await started;
	controller.abort();
	await assert.rejects(request);
	assert.equal(abortObserved, true);
});

test('capture page transport pins an arbitrary public host before requesting it', async () => {
	let observedHost = '';
	let observedAddress = '';
	const response = await fetchCaptureRecipePage('https://recipes.example.test/recipe', {
		resolveAddresses: async (hostname) => {
			assert.equal(hostname, 'recipes.example.test');
			return ['93.184.216.34'];
		},
		requestPinned: async (url, address) => {
			observedHost = url.hostname;
			observedAddress = address;
			return new Response('<html><body>recipe</body></html>', {
				headers: { 'content-type': 'text/html' }
			});
		}
	});

	assert.equal(observedHost, 'recipes.example.test');
	assert.equal(observedAddress, '93.184.216.34');
	assert.match(await response.text(), /recipe/);
});

test('capture page transport caps arbitrary-host pages at one megabyte', async () => {
	await assert.rejects(
		fetchCaptureRecipePage('https://recipes.example.test/recipe', {
			resolveAddresses: async () => ['93.184.216.34'],
			requestPinned: async () =>
				new Response(new Uint8Array(1_000_001), {
					headers: { 'content-type': 'text/html' }
				})
		}),
		(error: unknown) => error instanceof AIRequestError && error.status === 413
	);
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
