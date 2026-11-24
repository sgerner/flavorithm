import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNewUserState } from '../src/lib/data.ts';
import { buildShoppingList } from '../src/lib/domain.ts';
import { completeMeal } from '../src/lib/kitchen-workflows.ts';
import {
	buildStructuredRecipeDraft,
	isStandaloneRecipeUrl,
	parseRecipeIngredientLine,
	parseRecipeServings
} from '../src/lib/recipe-scraper.ts';
import {
	AIRequestError,
	fetchCaptureRecipePage,
	importRecipeFromUrl,
	type SecureRecipePageFetcher
} from '../src/lib/server/ai.ts';

process.env.FLAVORITHM_DB_PATH = ':memory:';
process.env.ORIGIN = 'https://kitchen.example.test';
process.env.FLAVORITHM_OAUTH_SECRET = 'recipe-import-test-secret-0123456789abcdef';

const backend = await import('../src/lib/server/db.ts');
const storage = await import('../src/lib/server/oauth-storage.ts');
const host = await import('../src/lib/server/host-ai.ts');
const hooks = await import('../src/hooks.server.ts');
const recipeImportRoute = await import('../src/routes/api/recipe-import/+server.ts');

function structuredPageHtml(recipeNode: Record<string, unknown>, headExtra = '') {
	return `<!doctype html>
<html>
  <head>
    ${headExtra}
    <script type="application/ld+json">${JSON.stringify(recipeNode)}</script>
  </head>
  <body>
    <article><h1>Structured Recipe Page</h1></article>
  </body>
</html>`;
}

function createRouteEvent(options: {
	url?: string;
	method?: string;
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
	ip?: string | null;
	user?: Record<string, unknown> | null;
	authMode?: 'local' | 'oidc' | 'proxy' | 'invalid';
	fetcher?: typeof fetch;
}) {
	const url = new URL(options.url ?? 'https://kitchen.example.test/api/recipe-import');
	const headers = new Headers({
		origin: 'https://kitchen.example.test',
		'content-type': 'application/json',
		...options.headers
	});
	const serialized =
		options.rawBody !== undefined
			? options.rawBody
			: options.body !== undefined
				? JSON.stringify(options.body)
				: JSON.stringify({ url: 'https://recipes.example.com/chickpea-stew' });
	const request = new Request(url, {
		method: options.method ?? 'POST',
		headers,
		body: (options.method ?? 'POST') === 'GET' ? undefined : serialized
	});
	return {
		url,
		request,
		locals: {
			user: options.user ?? null,
			authMode: options.authMode ?? 'local'
		},
		getClientAddress: () => {
			if (options.ip === null) throw new Error('ClientAddress cannot be determined');
			return options.ip ?? '198.51.100.25';
		},
		fetch: options.fetcher ?? fetch,
		cookies: {
			get: () => undefined,
			set: () => undefined,
			delete: () => undefined
		}
	};
}

test('isStandaloneRecipeUrl recognizes standalone HTTP/HTTPS links and rejects freeform text', () => {
	assert.equal(isStandaloneRecipeUrl('https://www.seriouseats.com/lemon-pasta-recipe'), true);
	assert.equal(isStandaloneRecipeUrl('  https://example.com/recipes/soup?print=1  '), true);
	assert.equal(isStandaloneRecipeUrl('Make soup from https://example.com/recipes/soup'), false);
	assert.equal(isStandaloneRecipeUrl('https://example.com/one\nhttps://example.com/two'), false);
	assert.equal(isStandaloneRecipeUrl('2 cups flour\n1 tsp salt'), false);
});

test('parseRecipeIngredientLine produces positive quantities, canonical units, and shopping-compatible names', () => {
	const cases = [
		{
			line: '1½ cups all-purpose flour, sifted',
			expected: { quantity: 1.5, unit: 'cup', name: 'all-purpose flour' },
			inferred: false
		},
		{
			line: '2-1/2 tablespoons extra-virgin olive oil',
			expected: { quantity: 2.5, unit: 'tbsp', name: 'extra-virgin olive oil' },
			inferred: false
		},
		{
			line: '1 &frac12; tsp smoked paprika &amp; cumin',
			expected: { quantity: 1.5, unit: 'tsp', name: 'smoked paprika & cumin' },
			inferred: false
		},
		{
			line: '400g chopped tomatoes, drained',
			expected: { quantity: 400, unit: 'g', name: 'chopped tomatoes' },
			inferred: false
		},
		{
			line: '250ml whole milk',
			expected: { quantity: 250, unit: 'ml', name: 'whole milk' },
			inferred: false
		},
		{
			line: '2 fl. oz. fresh lime juice',
			expected: { quantity: 2, unit: 'fl oz', name: 'fresh lime juice' },
			inferred: false
		},
		{
			line: '1 (15-ounce) can chickpeas, drained and rinsed',
			expected: { quantity: 1, unit: 'can', name: 'chickpeas' },
			inferred: false
		},
		{
			line: '1 (14 oz) firm tofu, cubed',
			expected: { quantity: 14, unit: 'oz', name: 'firm tofu' },
			inferred: false
		},
		{
			line: '3 large cloves garlic, finely minced',
			expected: { quantity: 3, unit: 'clove', name: 'garlic' },
			inferred: false
		},
		{
			line: '1 medium head cauliflower',
			expected: { quantity: 1, unit: 'head', name: 'cauliflower' },
			inferred: false
		},
		{
			line: '2-3 carrots, peeled',
			expected: { quantity: 2, unit: 'each', name: 'carrots' },
			inferred: true
		},
		{
			line: 'Kosher salt, to taste',
			expected: { quantity: 1, unit: 'pinch', name: 'Kosher salt' },
			inferred: true
		},
		{
			line: 'Fresh basil leaves',
			expected: { quantity: 1, unit: 'each', name: 'Fresh basil leaves' },
			inferred: true
		}
	];

	for (const entry of cases) {
		const parsed = parseRecipeIngredientLine(entry.line);
		assert.ok(Number.isFinite(parsed.ingredient.quantity) && parsed.ingredient.quantity > 0);
		assert.ok(parsed.ingredient.unit.trim().length > 0);
		assert.equal(parsed.ingredient.name, parsed.ingredient.name.trim());
		assert.ok(parsed.ingredient.name.length > 0);
		assert.deepEqual(parsed.ingredient, entry.expected, `failed for line: ${entry.line}`);
		assert.equal(Boolean(parsed.inferredNote), entry.inferred, `note mismatch for: ${entry.line}`);
	}

	const { recipe } = buildStructuredRecipeDraft(
		{
			title: 'Pantry Chickpea Skillet',
			description: 'Quick pantry dinner.',
			image: 'https://cdn.example.com/skillet.jpg',
			yield: 'Serves 4',
			time: 25,
			ingredients: [
				'2 tablespoons olive oil',
				'400g canned tomatoes',
				'2 cans chickpeas, drained',
				'3 cloves garlic, minced'
			],
			steps: ['Warm olive oil and garlic.', 'Simmer tomatoes and chickpeas.']
		},
		'https://recipes.example.com/chickpea-skillet'
	);

	const pantry = [
		{ id: 'p1', name: 'olive oil', quantity: 3, unit: 'tsp', category: 'Pantry' },
		{ id: 'p2', name: 'canned tomatoes', quantity: 0.15, unit: 'kg', category: 'Pantry' },
		{ id: 'p3', name: 'chickpeas', quantity: 1, unit: 'can', category: 'Pantry' }
	];
	const meals = [
		{ id: 'm1', date: '2026-11-22', slot: 'dinner' as const, recipeId: recipe.id, servings: 4 }
	];
	const shopping = buildShoppingList([recipe], pantry, meals, new Date('2026-11-22T12:00:00Z'));
	assert.deepEqual(
		shopping.map((item) => ({ name: item.name, quantity: item.quantity, unit: item.unit })),
		[
			{ name: 'canned tomatoes', quantity: 0.25, unit: 'kg' },
			{ name: 'chickpeas', quantity: 1, unit: 'can' },
			{ name: 'garlic', quantity: 3, unit: 'clove' },
			{ name: 'olive oil', quantity: 1, unit: 'tbsp' }
		]
	);

	const kitchenState = createNewUserState();
	kitchenState.recipes = [{ ...recipe, saved: true }];
	kitchenState.pantry = pantry;
	kitchenState.meals = meals;
	const afterCooking = completeMeal(
		kitchenState,
		'm1',
		{ deductPantry: true, leftoverServings: 0 },
		new Date('2026-11-22T18:00:00Z')
	);
	assert.deepEqual(
		afterCooking.pantry.map((item) => item.quantity),
		[0, 0, 0]
	);
});

test('importRecipeFromUrl extracts schema.org/Recipe deterministically without calling external AI even when connected', async () => {
	const html = structuredPageHtml(
		{
			'@context': 'https://schema.org',
			'@type': ['Article', 'Recipe'],
			name: 'Herbed Lemon &amp; Orzo Soup',
			description: 'Bright lemony soup with tender herbs.',
			image: ['https://images.example.com/orzo-soup.jpg'],
			recipeYield: '6 servings',
			prepTime: 'PT15M',
			cookTime: 'PT25M',
			recipeCuisine: 'Mediterranean',
			recipeCategory: 'Soup, Dinner',
			keywords: 'weeknight, vegetarian',
			recipeIngredient: [
				'For the soup:',
				'2 tbsp olive oil',
				'1 ½ cups dry orzo',
				'6 cups vegetable broth',
				'2 lemons',
				'Sea salt, to taste'
			],
			recipeInstructions: [
				{
					'@type': 'HowToSection',
					name: 'Simmer',
					itemListElement: [
						{ '@type': 'HowToStep', text: 'Step 1: Warm olive oil in a Dutch oven.' },
						{ '@type': 'HowToStep', text: '2. Simmer broth and orzo until tender.' }
					]
				}
			],
			nutrition: {
				'@type': 'NutritionInformation',
				calories: '310 calories',
				fatContent: '9 g',
				saturatedFatContent: '1.5 g',
				sodiumContent: '540 mg',
				carbohydrateContent: '46 g',
				fiberContent: '4 g',
				sugarContent: '3 g',
				proteinContent: '11 g'
			}
		},
		'<link rel="canonical" href="https://recipes.example.com/herbed-lemon-orzo-soup">'
	);

	let aiFallbackResolved = false;
	let externalAiCalls = 0;

	const result = await importRecipeFromUrl(
		{
			url: 'https://recipes.example.com/herbed-lemon-orzo-soup?utm_source=pinterest',
			authenticated: true,
			resolveFallback: async () => {
				aiFallbackResolved = true;
				return {
					provider: 'openai',
					model: 'gpt-4o-mini',
					apiKey: 'sk-should-not-be-used',
					fetcher: async () => {
						externalAiCalls += 1;
						throw new Error('External AI provider must not be called for structured recipes');
					}
				};
			}
		},
		async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
	);

	assert.equal(aiFallbackResolved, false);
	assert.equal(externalAiCalls, 0);
	assert.equal(result.recipe.title, 'Herbed Lemon & Orzo Soup');
	assert.equal(result.recipe.description, 'Bright lemony soup with tender herbs.');
	assert.equal(result.recipe.image, 'https://images.example.com/orzo-soup.jpg');
	assert.equal(result.recipe.servings, 6);
	assert.equal(result.recipe.time, 40);
	assert.equal(result.recipe.cuisine, 'Mediterranean');
	assert.deepEqual(result.recipe.tags, ['Soup', 'Dinner', 'weeknight', 'vegetarian']);
	assert.equal(result.recipe.source, 'https://recipes.example.com/herbed-lemon-orzo-soup');
	assert.equal(result.recipe.saved, false);
	assert.equal(result.recipe.provenance, 'web-import');
	assert.equal(result.recipe.nutritionStale, undefined);
	assert.deepEqual(result.recipe.nutrition, {
		calories: 310,
		fat: 9,
		saturatedFat: 1.5,
		sodium: 540,
		carbs: 46,
		fiber: 4,
		sugar: 3,
		protein: 11
	});
	assert.deepEqual(result.recipe.steps, [
		'Warm olive oil in a Dutch oven.',
		'Simmer broth and orzo until tender.'
	]);
	assert.deepEqual(result.recipe.ingredients, [
		{ name: 'olive oil', quantity: 2, unit: 'tbsp' },
		{ name: 'dry orzo', quantity: 1.5, unit: 'cup' },
		{ name: 'vegetable broth', quantity: 6, unit: 'cup' },
		{ name: 'lemons', quantity: 2, unit: 'each' },
		{ name: 'Sea salt', quantity: 1, unit: 'pinch' }
	]);
	assert.equal(result.assumptions.length, 2);
	assert.match(result.assumptions[0], /lemons/);
	assert.match(result.assumptions[1], /Sea salt/);
});

test('importRecipeFromUrl records dismissible assumptions for missing metadata, drops insecure images, and passes state validation', async () => {
	const manyUnitlessIngredients = Array.from({ length: 35 }, (_, idx) => `Herb garnish ${idx + 1}`);
	const html = structuredPageHtml({
		'@context': 'https://schema.org',
		'@type': 'Recipe',
		name: 'Minimalist Flatbread',
		image: 'http://insecure.example.com/flatbread.jpg',
		recipeIngredient: ['2 cups bread flour', ...manyUnitlessIngredients],
		recipeInstructions: 'Mix dough.\nBake on a hot stone.'
	});

	const result = await importRecipeFromUrl(
		{ url: 'https://recipes.example.com/flatbread' },
		async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
	);

	assert.equal(result.recipe.image, '');
	assert.equal(result.recipe.time, 30);
	assert.equal(result.recipe.servings, 4);
	assert.equal(result.recipe.nutritionStale, true);
	assert.deepEqual(result.recipe.steps, ['Mix dough.', 'Bake on a hot stone.']);
	assert.ok(result.assumptions.length <= 30);
	assert.ok(result.assumptions.some((note) => /Cooking time was not listed/i.test(note)));
	assert.ok(result.assumptions.some((note) => /Servings were not listed/i.test(note)));
	assert.ok(result.assumptions.some((note) => /Per-serving nutrition was not listed/i.test(note)));
	assert.ok(result.assumptions.some((note) => /additional ingredients/i.test(note)));
	assert.deepEqual(parseRecipeServings('Makes 12 cookies'), { servings: 12, inferred: false });

	const owner = await backend.registerUser(
		'Scraper State User',
		'scraper-state@example.test',
		'a strong scraper test password'
	);
	const state = backend.getState(owner.user)!;
	state.recipes.unshift({
		...result.recipe,
		importNotes: [...result.assumptions],
		saved: true
	});
	assert.ok(backend.validateAppState(state));
});

test('importRecipeFromUrl falls back to connected AI on unstructured pages with a single HTML fetch or returns clear 422 guidance', async () => {
	const unstructuredHtml = `<!doctype html>
<html>
  <head><link rel="canonical" href="https://blog.example.com/grandmas-chili"></head>
  <body>
    <article>
      <h1>Grandma's Weeknight Chili</h1>
      <p>Brown 1 lb ground beef with 1 diced onion, add 2 cans kidney beans and 1 tbsp chili powder, then simmer 30 minutes.</p>
    </article>
  </body>
</html>`;

	let guestFetches = 0;
	await assert.rejects(
		() =>
			importRecipeFromUrl(
				{ url: 'https://blog.example.com/grandmas-chili', authenticated: false },
				async () => {
					guestFetches += 1;
					return new Response(unstructuredHtml, {
						status: 200,
						headers: { 'content-type': 'text/html; charset=utf-8' }
					});
				}
			),
		(error: unknown) => {
			assert.ok(error instanceof AIRequestError);
			assert.equal(error.status, 422);
			assert.match(
				error.message,
				/Sign in and connect a model in Settings.*paste the recipe text/i
			);
			return true;
		}
	);
	assert.equal(guestFetches, 1);

	await assert.rejects(
		() =>
			importRecipeFromUrl(
				{
					url: 'https://blog.example.com/grandmas-chili',
					authenticated: true,
					resolveFallback: async () => null
				},
				async () =>
					new Response(unstructuredHtml, {
						status: 200,
						headers: { 'content-type': 'text/html; charset=utf-8' }
					})
			),
		(error: unknown) => {
			assert.ok(error instanceof AIRequestError);
			assert.equal(error.status, 422);
			assert.match(
				error.message,
				/Connect a model in Settings to extract it, or paste the recipe text/i
			);
			return true;
		}
	);

	let connectedPageFetches = 0;
	let openAiRequests = 0;
	const fallbackDraft = await importRecipeFromUrl(
		{
			url: 'https://blog.example.com/grandmas-chili?ref=feed',
			authenticated: true,
			resolveFallback: async () => ({
				provider: 'openai',
				model: 'gpt-4o-mini',
				apiKey: 'sk-connected-user',
				fetcher: async (input, init) => {
					openAiRequests += 1;
					assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
					const body = JSON.parse(String(init?.body));
					assert.match(JSON.stringify(body.messages), /Grandma's Weeknight Chili/);
					return Response.json({
						choices: [
							{
								message: {
									content: JSON.stringify({
										title: "Grandma's Weeknight Chili",
										description: 'Hearty beef and kidney bean chili.',
										image: '',
										time: 35,
										servings: 4,
										difficulty: 'Easy',
										cuisine: 'American',
										tags: ['Chili', 'Dinner'],
										ingredients: [
											{ name: 'ground beef', quantity: 1, unit: 'lb' },
											{ name: 'kidney beans', quantity: 2, unit: 'can' },
											{ name: 'chili powder', quantity: 1, unit: 'tbsp' }
										],
										steps: [
											'Brown beef and onion.',
											'Simmer with beans and chili powder for 30 minutes.'
										],
										nutrition: {
											calories: 410,
											fat: 16,
											saturatedFat: 6,
											sodium: 620,
											carbs: 32,
											fiber: 9,
											sugar: 4,
											protein: 31
										},
										assumptions: ['Estimated servings at 4.']
									})
								}
							}
						]
					});
				}
			})
		},
		async () => {
			connectedPageFetches += 1;
			return new Response(unstructuredHtml, {
				status: 200,
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
	);

	assert.equal(connectedPageFetches, 1);
	assert.equal(openAiRequests, 1);
	assert.equal(fallbackDraft.recipe.title, "Grandma's Weeknight Chili");
	assert.equal(fallbackDraft.recipe.source, 'https://blog.example.com/grandmas-chili');
	assert.equal(fallbackDraft.recipe.provenance, 'web-import');
	assert.deepEqual(fallbackDraft.assumptions, ['Estimated servings at 4.']);
});

test('hooks.server and POST /api/recipe-import require sessions across all auth modes while allowing keyless imports and enforcing origin, SSRF, and rate limits', async () => {
	const structuredHtml = structuredPageHtml({
		'@context': 'https://schema.org',
		'@type': 'Recipe',
		name: 'Crispy Smashed Potatoes',
		description: 'Golden oven-roasted smashed potatoes.',
		image: 'https://images.example.com/potatoes.jpg',
		recipeYield: '4 servings',
		totalTime: 'PT45M',
		recipeIngredient: ['1.5 lbs baby potatoes', '2 tbsp olive oil', '1 tsp flaky sea salt'],
		recipeInstructions: [
			'Boil potatoes until fork-tender.',
			'Smash and roast at 425°F until crisp.'
		]
	});

	const unstructuredHtml = `<!doctype html><html><body><main><h1>Plain Note</h1><p>Toast bread and top with ricotta and honey.</p></main></body></html>`;

	const mockPageFetcher: SecureRecipePageFetcher = async (url) => {
		if (url.includes('unstructured')) {
			return new Response(unstructuredHtml, {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		}
		return new Response(structuredHtml, {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
	};

	const prevAuthMode = process.env.FLAVORITHM_AUTH_MODE;
	const prevOidcIssuer = process.env.FLAVORITHM_OIDC_ISSUER;
	const prevOidcClientId = process.env.FLAVORITHM_OIDC_CLIENT_ID;
	const prevOidcAuthMethod = process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD;
	const prevProxySecret = process.env.FLAVORITHM_PROXY_SHARED_SECRET;

	try {
		// 1. Local mode rejects unauthenticated POST /api/recipe-import with 401 (both hooks.handle and route handler).
		process.env.FLAVORITHM_AUTH_MODE = 'local';
		let unauthFetches = 0;
		const guestEvent = createRouteEvent({
			ip: '198.51.100.10',
			body: { url: 'https://recipes.example.com/smashed-potatoes' }
		});
		const guestResponse = await hooks.handle({
			event: guestEvent as never,
			resolve: async (ev) =>
				recipeImportRoute.POST(ev as never, {
					pageFetcher: async (url, policy, signal) => {
						unauthFetches += 1;
						return mockPageFetcher(url, policy, signal);
					}
				})
		});
		assert.equal(guestResponse.status, 401);
		assert.equal(unauthFetches, 0);

		const directUnauthResponse = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.10',
				body: { url: 'https://recipes.example.com/smashed-potatoes' }
			}) as never,
			{
				pageFetcher: async () => {
					unauthFetches += 1;
					return new Response(structuredHtml, { headers: { 'content-type': 'text/html' } });
				}
			}
		);
		assert.equal(directUnauthResponse.status, 401);
		assert.equal(unauthFetches, 0);

		// 2. Signed-in user without AI keys imports structured URL cleanly via hooks.handle + route handler.
		const member = await backend.registerUser(
			'Keyless Cook',
			'keyless-cook@example.test',
			'a strong keyless cook password'
		);
		const memberCookieEvent = createRouteEvent({
			ip: '198.51.100.11',
			body: { url: 'https://recipes.example.com/smashed-potatoes' }
		});
		memberCookieEvent.cookies.get = ((name: string) =>
			name === 'flavorithm_session' ? member.token : undefined) as never;
		const memberResponse = await hooks.handle({
			event: memberCookieEvent as never,
			resolve: async (ev) => recipeImportRoute.POST(ev as never, { pageFetcher: mockPageFetcher })
		});
		assert.equal(memberResponse.status, 200);
		const memberPayload = await memberResponse.json();
		assert.equal(memberPayload.recipe.title, 'Crispy Smashed Potatoes');
		assert.deepEqual(memberPayload.recipe.ingredients[0], {
			name: 'baby potatoes',
			quantity: 1.5,
			unit: 'lb'
		});

		// 3. OIDC mode rejects unauthenticated POST /api/recipe-import with 401.
		process.env.FLAVORITHM_AUTH_MODE = 'oidc';
		process.env.FLAVORITHM_OIDC_ISSUER = 'https://idp.example.test';
		process.env.FLAVORITHM_OIDC_CLIENT_ID = 'flavorithm-web';
		process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = 'none';
		const oidcGuestEvent = createRouteEvent({
			ip: '198.51.100.12',
			authMode: 'oidc',
			body: { url: 'https://recipes.example.com/smashed-potatoes' }
		});
		const oidcGuestResponse = await hooks.handle({
			event: oidcGuestEvent as never,
			resolve: async (ev) => recipeImportRoute.POST(ev as never, { pageFetcher: mockPageFetcher })
		});
		assert.equal(oidcGuestResponse.status, 401);

		// 4. Proxy mode rejects unauthenticated POST /api/recipe-import with 401.
		process.env.FLAVORITHM_AUTH_MODE = 'proxy';
		process.env.FLAVORITHM_PROXY_SHARED_SECRET = 'proxy-shared-secret-value-0123456789abcdef';
		const proxyGuestEvent = createRouteEvent({
			ip: '198.51.100.13',
			authMode: 'proxy',
			body: { url: 'https://recipes.example.com/smashed-potatoes' }
		});
		const proxyGuestResponse = await hooks.handle({
			event: proxyGuestEvent as never,
			resolve: async (ev) => recipeImportRoute.POST(ev as never, { pageFetcher: mockPageFetcher })
		});
		assert.equal(proxyGuestResponse.status, 401);

		process.env.FLAVORITHM_AUTH_MODE = 'local';

		// 5. Host-wide ChatGPT connection powers unstructured fallback for signed-in users without calling AI on structured URLs.
		const hostAdmin = await backend.registerUser(
			'Host Operator',
			'host-operator-import@example.test',
			'a strong host operator password'
		);
		process.env.FLAVORITHM_HOST_ADMIN_USER_ID = hostAdmin.user.id;
		process.env.FLAVORITHM_HOST_AI_SHARED = 'true';
		const grant = storage.saveChatGPTAccount({
			userId: hostAdmin.user.id,
			mode: 'local',
			clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
			subject: 'host-import-subject',
			email: 'host-operator-import@example.test',
			scopes: ['codex.subscription'],
			credentials: {
				accessToken: 'host-access-token',
				refreshToken: 'host-refresh-token',
				idToken: 'host-id-token',
				codexAccountId: 'acct-host-import'
			},
			expiresAt: Date.now() + 3600_000,
			earliestRefreshAt: 0
		});
		host.configureHostAI(hostAdmin.user.id, grant.id, 'gpt-4o-mini');

		let hostAiCalls = 0;
		const structuredWithHostEvent = createRouteEvent({
			ip: '198.51.100.14',
			user: member.user,
			body: { url: 'https://recipes.example.com/smashed-potatoes' },
			fetcher: async () => {
				hostAiCalls += 1;
				throw new Error('Host AI must not be called for structured recipe pages');
			}
		});
		const structuredWithHostRes = await recipeImportRoute.POST(structuredWithHostEvent as never, {
			pageFetcher: mockPageFetcher
		});
		assert.equal(structuredWithHostRes.status, 200);
		assert.equal(hostAiCalls, 0);

		const unstructuredWithHostEvent = createRouteEvent({
			ip: '198.51.100.15',
			user: member.user,
			body: { url: 'https://recipes.example.com/unstructured-ricotta-toast' },
			fetcher: async () => {
				hostAiCalls += 1;
				const draftJson = JSON.stringify({
					title: 'Honey Ricotta Toast',
					description: 'Crisp toast with ricotta and honey.',
					image: '',
					time: 10,
					servings: 2,
					difficulty: 'Easy',
					cuisine: 'Italian',
					tags: ['Breakfast'],
					ingredients: [
						{ name: 'bread', quantity: 2, unit: 'slice' },
						{ name: 'ricotta', quantity: 0.5, unit: 'cup' },
						{ name: 'honey', quantity: 1, unit: 'tbsp' }
					],
					steps: ['Toast bread.', 'Spread ricotta and drizzle with honey.'],
					nutrition: {
						calories: 260,
						fat: 9,
						saturatedFat: 5,
						sodium: 280,
						carbs: 34,
						fiber: 2,
						sugar: 11,
						protein: 11
					},
					assumptions: ['Assumed 2 slices of bread.']
				});
				const sse =
					`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: draftJson })}\r\n\r\n` +
					`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\r\n\r\n` +
					'data: [DONE]\r\n\r\n';
				return new Response(sse, {
					status: 200,
					headers: { 'content-type': 'text/event-stream' }
				});
			}
		});
		const unstructuredWithHostRes = await recipeImportRoute.POST(
			unstructuredWithHostEvent as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(unstructuredWithHostRes.status, 200);
		assert.equal(hostAiCalls, 1);
		assert.equal((await unstructuredWithHostRes.json()).recipe.title, 'Honey Ricotta Toast');
		host.configureHostAI(hostAdmin.user.id);
		delete process.env.FLAVORITHM_HOST_ADMIN_USER_ID;
		delete process.env.FLAVORITHM_HOST_AI_SHARED;

		// 6. Cross-origin & cross-site requests rejected with 403.
		const crossOriginRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.16',
				user: member.user,
				headers: { origin: 'https://evil.example' }
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(crossOriginRes.status, 403);

		const crossSiteFetchRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.17',
				user: member.user,
				headers: { 'sec-fetch-site': 'cross-site' }
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(crossSiteFetchRes.status, 403);

		const missingAddressRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: null,
				user: member.user
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(missingAddressRes.status, 403);

		// 7. Route-level SSRF defences: literal loopback/private, IPv4-mapped IPv6, decimal hosts,
		// DNS-to-private, DNS failure, and redirects to 169.254.169.254 or invalid targets return 400/502
		// and never invoke the connected AI provider.
		const ssrfUser = await backend.registerUser(
			'SSRF Guard User',
			'ssrf-guard-user@example.test',
			'a strong ssrf guard password'
		);
		let ssrfProviderCalls = 0;
		const ssrfProviderSpy: typeof fetch = async () => {
			ssrfProviderCalls += 1;
			throw new Error('AI provider must never be called when page fetch is blocked by SSRF guard');
		};

		let literalPinnedCalls = 0;
		const literalFetcher: SecureRecipePageFetcher = (url, _policy, signal) =>
			fetchCaptureRecipePage(url, {
				signal,
				resolveAddresses: async () => ['93.184.216.34'],
				requestPinned: async () => {
					literalPinnedCalls += 1;
					return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
				}
			});

		for (const forbiddenUrl of [
			'http://recipes.example.com/smashed-potatoes',
			'https://127.0.0.1/secret',
			'https://192.168.1.20/router',
			'https://localhost/internal',
			'https://[::1]/loopback',
			'https://[::ffff:127.0.0.1]/mapped-loopback',
			'https://[::ffff:169.254.169.254]/latest/meta-data',
			'https://2130706433/decimal-loopback',
			'https://2852039166/decimal-metadata',
			'https://167772161/decimal-private'
		]) {
			const badTargetRes = await recipeImportRoute.POST(
				createRouteEvent({
					ip: '198.51.100.18',
					user: ssrfUser.user,
					fetcher: ssrfProviderSpy,
					body: {
						url: forbiddenUrl,
						provider: 'openai',
						model: 'gpt-4o-mini',
						apiKey: 'sk-ssrf-guard'
					}
				}) as never,
				{ pageFetcher: literalFetcher }
			);
			assert.equal(badTargetRes.status, 400, `expected 400 for ${forbiddenUrl}`);
		}
		assert.equal(literalPinnedCalls, 0);
		assert.equal(ssrfProviderCalls, 0);

		// DNS resolving to private IPv4 and IPv4-mapped IPv6 -> 400, no connection opened, no AI call.
		for (const privateDnsAnswer of [
			'10.0.0.25',
			'127.0.0.1',
			'169.254.169.254',
			'::ffff:127.0.0.1'
		]) {
			let dnsPinnedCalls = 0;
			const dnsRes = await recipeImportRoute.POST(
				createRouteEvent({
					ip: '198.51.100.20',
					user: ssrfUser.user,
					fetcher: ssrfProviderSpy,
					body: {
						url: 'https://rebind.example.test/recipe',
						provider: 'openai',
						model: 'gpt-4o-mini',
						apiKey: 'sk-ssrf-guard'
					}
				}) as never,
				{
					pageFetcher: (url, _policy, signal) =>
						fetchCaptureRecipePage(url, {
							signal,
							resolveAddresses: async () => [privateDnsAnswer],
							requestPinned: async () => {
								dnsPinnedCalls += 1;
								return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
							}
						})
				}
			);
			assert.equal(dnsRes.status, 400, `expected 400 for DNS -> ${privateDnsAnswer}`);
			assert.equal(dnsPinnedCalls, 0);
			assert.equal(ssrfProviderCalls, 0);
		}

		// DNS lookup failure -> 502, no AI call.
		const dnsFailureRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.21',
				user: ssrfUser.user,
				fetcher: ssrfProviderSpy,
				body: {
					url: 'https://nxdomain.example.test/recipe',
					provider: 'openai',
					model: 'gpt-4o-mini',
					apiKey: 'sk-ssrf-guard'
				}
			}) as never,
			{
				pageFetcher: (url, _policy, signal) =>
					fetchCaptureRecipePage(url, {
						signal,
						resolveAddresses: async () => {
							throw new Error('ENOTFOUND nxdomain.example.test');
						},
						requestPinned: async () =>
							new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
					})
			}
		);
		assert.equal(dnsFailureRes.status, 502);
		assert.equal(ssrfProviderCalls, 0);

		// Redirect from public host to 169.254.169.254 -> 400, metadata IP never contacted, no AI call.
		const contactedAddresses: string[] = [];
		const redirectMetadataRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.22',
				user: ssrfUser.user,
				fetcher: ssrfProviderSpy,
				body: {
					url: 'https://public.example.test/shortlink',
					provider: 'openai',
					model: 'gpt-4o-mini',
					apiKey: 'sk-ssrf-guard'
				}
			}) as never,
			{
				pageFetcher: (url, _policy, signal) =>
					fetchCaptureRecipePage(url, {
						signal,
						resolveAddresses: async (hostname) =>
							hostname === 'public.example.test' ? ['93.184.216.34'] : ['169.254.169.254'],
						requestPinned: async (_target, address) => {
							contactedAddresses.push(address);
							return new Response(null, {
								status: 302,
								headers: { location: 'https://169.254.169.254/latest/meta-data/' }
							});
						}
					})
			}
		);
		assert.equal(redirectMetadataRes.status, 400);
		assert.deepEqual(contactedAddresses, ['93.184.216.34']);
		assert.equal(ssrfProviderCalls, 0);

		// Redirect without Location header -> 502, no AI call.
		const redirectMissingLocationRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.23',
				user: ssrfUser.user,
				fetcher: ssrfProviderSpy,
				body: {
					url: 'https://public.example.test/broken-redirect',
					provider: 'openai',
					model: 'gpt-4o-mini',
					apiKey: 'sk-ssrf-guard'
				}
			}) as never,
			{
				pageFetcher: (url, _policy, signal) =>
					fetchCaptureRecipePage(url, {
						signal,
						resolveAddresses: async () => ['93.184.216.34'],
						requestPinned: async () => new Response(null, { status: 302 })
					})
			}
		);
		assert.equal(redirectMissingLocationRes.status, 502);
		assert.equal(ssrfProviderCalls, 0);

		// 8. Oversized request body rejected with 413.
		const oversizedRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.19',
				user: member.user,
				rawBody: JSON.stringify({ url: 'https://recipes.example.com/a', pad: 'x'.repeat(70_000) })
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(oversizedRes.status, 413);

		// 9. Per-IP sliding-window rate limit enforced (20 requests / 15m -> 21st returns 429).
		const ipLimitUser = await backend.registerUser(
			'IP Limit User',
			'ip-limit-user@example.test',
			'a strong ip limit user password'
		);
		for (let i = 0; i < 20; i += 1) {
			const okRes = await recipeImportRoute.POST(
				createRouteEvent({
					ip: '198.51.100.99',
					user: ipLimitUser.user,
					body: { url: 'https://recipes.example.com/smashed-potatoes' }
				}) as never,
				{ pageFetcher: mockPageFetcher }
			);
			assert.equal(okRes.status, 200);
		}
		const ipLimitedRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '198.51.100.99',
				user: ipLimitUser.user,
				body: { url: 'https://recipes.example.com/smashed-potatoes' }
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(ipLimitedRes.status, 429);

		// 10. Per-user sliding-window rate limit enforced (30 requests / 1h -> 31st returns 429).
		const frequentUser = await backend.registerUser(
			'Frequent Importer',
			'frequent-importer@example.test',
			'a strong frequent importer password'
		);
		for (let i = 0; i < 30; i += 1) {
			const okRes = await recipeImportRoute.POST(
				createRouteEvent({
					ip: `203.0.113.${i + 1}`,
					user: frequentUser.user,
					body: { url: 'https://recipes.example.com/smashed-potatoes' }
				}) as never,
				{ pageFetcher: mockPageFetcher }
			);
			assert.equal(okRes.status, 200);
		}
		const userLimitedRes = await recipeImportRoute.POST(
			createRouteEvent({
				ip: '203.0.113.250',
				user: frequentUser.user,
				body: { url: 'https://recipes.example.com/smashed-potatoes' }
			}) as never,
			{ pageFetcher: mockPageFetcher }
		);
		assert.equal(userLimitedRes.status, 429);
	} finally {
		if (prevAuthMode === undefined) delete process.env.FLAVORITHM_AUTH_MODE;
		else process.env.FLAVORITHM_AUTH_MODE = prevAuthMode;
		if (prevOidcIssuer === undefined) delete process.env.FLAVORITHM_OIDC_ISSUER;
		else process.env.FLAVORITHM_OIDC_ISSUER = prevOidcIssuer;
		if (prevOidcClientId === undefined) delete process.env.FLAVORITHM_OIDC_CLIENT_ID;
		else process.env.FLAVORITHM_OIDC_CLIENT_ID = prevOidcClientId;
		if (prevOidcAuthMethod === undefined) delete process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD;
		else process.env.FLAVORITHM_OIDC_CLIENT_AUTH_METHOD = prevOidcAuthMethod;
		if (prevProxySecret === undefined) delete process.env.FLAVORITHM_PROXY_SHARED_SECRET;
		else process.env.FLAVORITHM_PROXY_SHARED_SECRET = prevProxySecret;
	}
});

test('importRecipeFromUrl honours Content-Type and meta HTML charsets for non-UTF-8 recipe pages', async () => {
	const latin1Markup = `<!doctype html>
<html>
  <head>
    <meta charset="iso-8859-1">
    <script type="application/ld+json">${JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'Recipe',
			name: 'Crème Brûlée',
			description: 'Classic vanilla custard baked at 150°C.',
			recipeYield: '4 servings',
			totalTime: 'PT50M',
			recipeIngredient: ['½ cup crème fraîche', '4 egg yolks', '¼ cup caster sugar'],
			recipeInstructions: ['Whisk yolks and sugar.', 'Bake at 150°C until set.']
		})}</script>
  </head>
  <body></body>
</html>`;
	const latin1Bytes = Buffer.from(latin1Markup, 'latin1');

	const fromHeaderCharset = await importRecipeFromUrl(
		{ url: 'https://recipes.example.com/creme-brulee' },
		async () =>
			new Response(latin1Bytes, {
				status: 200,
				headers: { 'content-type': 'text/html; charset=iso-8859-1' }
			})
	);
	assert.equal(fromHeaderCharset.recipe.title, 'Crème Brûlée');
	assert.equal(fromHeaderCharset.recipe.description, 'Classic vanilla custard baked at 150°C.');
	assert.deepEqual(fromHeaderCharset.recipe.ingredients[0], {
		name: 'crème fraîche',
		quantity: 0.5,
		unit: 'cup'
	});
	assert.deepEqual(fromHeaderCharset.recipe.ingredients[2], {
		name: 'caster sugar',
		quantity: 0.25,
		unit: 'cup'
	});

	const fromMetaCharset = await importRecipeFromUrl(
		{ url: 'https://recipes.example.com/creme-brulee-meta' },
		async () =>
			new Response(latin1Bytes, {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})
	);
	assert.equal(fromMetaCharset.recipe.title, 'Crème Brûlée');
	assert.equal(fromMetaCharset.recipe.ingredients[0].name, 'crème fraîche');
	assert.equal(fromMetaCharset.recipe.ingredients[0].quantity, 0.5);
});

test('importRecipeFromUrl skips unsupported per-100g nutrition and coerces zero-quantity AI fallback ingredients', async () => {
	const per100gHtml = structuredPageHtml({
		'@context': 'https://schema.org',
		'@type': 'Recipe',
		name: 'Rye Sourdough Loaf',
		recipeYield: '8 slices',
		totalTime: 'P0DT1H30M',
		recipeIngredient: ['500 g bread flour', '350 ml water'],
		recipeInstructions: ['Mix and ferment.', 'Bake until crust is deep brown.'],
		nutrition: {
			'@type': 'NutritionInformation',
			servingSize: '100 g',
			calories: '250 kcal',
			proteinContent: '9 g'
		}
	});

	const scraped = await importRecipeFromUrl(
		{ url: 'https://recipes.example.com/rye-loaf' },
		async () => new Response(per100gHtml, { status: 200, headers: { 'content-type': 'text/html' } })
	);
	assert.equal(scraped.recipe.time, 90);
	assert.equal(scraped.recipe.nutrition.calories, 0);
	assert.equal(scraped.recipe.nutritionStale, true);
	assert.ok(scraped.assumptions.some((note) => /Skipped page nutrition.*100 g/i.test(note)));

	const unstructuredHtml =
		'<!doctype html><html><body><article><h1>Pan Steak</h1><p>Sear steak with salt to taste.</p></article></body></html>';
	const fallback = await importRecipeFromUrl(
		{
			url: 'https://recipes.example.com/pan-steak',
			authenticated: true,
			resolveFallback: async () => ({
				provider: 'openai',
				model: 'gpt-4o-mini',
				apiKey: 'sk-test',
				fetcher: async () =>
					Response.json({
						choices: [
							{
								message: {
									content: JSON.stringify({
										title: 'Pan Steak',
										description: '',
										image: '',
										time: 15,
										servings: 2,
										difficulty: 'Easy',
										cuisine: 'American',
										tags: ['Dinner'],
										ingredients: [
											{ name: 'ribeye steak', quantity: 1, unit: 'lb' },
											{ name: 'kosher salt', quantity: 0, unit: 'to taste' }
										],
										steps: ['Season and sear steak.'],
										nutrition: {
											calories: 520,
											fat: 38,
											saturatedFat: 16,
											sodium: 480,
											carbs: 0,
											fiber: 0,
											sugar: 0,
											protein: 44
										},
										assumptions: []
									})
								}
							}
						]
					})
			})
		},
		async () =>
			new Response(unstructuredHtml, { status: 200, headers: { 'content-type': 'text/html' } })
	);
	assert.ok(fallback.recipe.ingredients.every((item) => item.quantity > 0));
	assert.ok(fallback.assumptions.some((note) => /kosher salt/i.test(note)));
});
