import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	chatGPTResponse,
	listChatGPTModels,
	ChatGPTInferenceError
} from '../src/lib/server/chatgpt-inference.ts';
import { runAIRequest } from '../src/lib/server/ai.ts';
function stream(events: unknown[], chunkSize = 9) {
	const data =
		events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
	let offset = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (offset >= data.length) {
					controller.close();
					return;
				}
				controller.enqueue(new TextEncoder().encode(data.slice(offset, (offset += chunkSize))));
			}
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	);
}
const options = {
	accessToken: 'server-only-token',
	model: 'account-model',
	instructions: 'Return JSON',
	prompt: 'Make dinner'
};
test('ChatGPT plan uses public Responses endpoint, streaming and store:false without unsupported fields', async () => {
	let url = '';
	let body: any;
	let headers: Headers | undefined;
	const result = await chatGPTResponse(options, async (input, init) => {
		url = String(input);
		body = JSON.parse(String(init?.body));
		headers = new Headers(init?.headers);
		return stream([
			{ type: 'response.output_text.delta', delta: '{"ingredients":[]}' },
			{ type: 'response.completed', response: { status: 'completed' } }
		]);
	});
	assert.equal(url, 'https://api.openai.com/v1/responses');
	assert.equal(headers?.get('authorization'), 'Bearer server-only-token');
	assert.equal(result, '{"ingredients":[]}');
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.equal(body.instructions, 'Return JSON');
	assert.equal(body.input[0].role, 'user');
	for (const field of [
		'max_output_tokens',
		'max_completion_tokens',
		'temperature',
		'previous_response_id',
		'prompt',
		'conversation'
	])
		assert.equal(field in body, false);
});
test('ChatGPT vision sends a Responses image input', async () => {
	await chatGPTResponse(
		{ ...options, image: 'data:image/png;base64,aGVsbG8=' },
		async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.input[0].content[1].type, 'input_image');
			return stream([
				{
					type: 'response.completed',
					response: {
						status: 'completed',
						output: [{ content: [{ type: 'output_text', text: '{"ingredients":[]}' }] }]
					}
				}
			]);
		}
	);
});
test('ChatGPT reasoning uses the Responses effort field only when explicitly selected', async () => {
	for (const effort of [undefined, 'high']) {
		await chatGPTResponse(
			{ ...options, ...(effort ? { reasoning: { effort } } : {}) },
			async (_input, init) => {
				const body = JSON.parse(String(init?.body));
				assert.deepEqual(body.reasoning, effort ? { effort } : undefined);
				assert.equal(body.store, false);
				return stream([
					{
						type: 'response.completed',
						response: {
							status: 'completed',
							output: [{ content: [{ type: 'output_text', text: '{}' }] }]
						}
					}
				]);
			}
		);
	}
});
test('ChatGPT rejects incomplete, failed, or abruptly ended streams instead of saving partial recipes', async () => {
	await assert.rejects(
		() =>
			chatGPTResponse(options, async () =>
				stream([{ type: 'response.output_text.delta', delta: 'partial' }])
			),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 502 &&
			/No partial recipe was saved/.test(error.message)
	);
	await assert.rejects(
		() => chatGPTResponse(options, async () => stream([{ type: 'response.incomplete' }])),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 502 &&
			/finishing the recipe/.test(error.message)
	);
	await assert.rejects(
		() =>
			chatGPTResponse(options, async () =>
				stream([{ type: 'response.completed', response: { status: 'completed', output: [] } }])
			),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 502 &&
			/without recipe text/.test(error.message)
	);
	await assert.rejects(
		() =>
			chatGPTResponse(options, async () =>
				stream([
					{
						type: 'response.failed',
						response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } }
					}
				])
			),
		ChatGPTInferenceError
	);
});
test('ChatGPT uses action-aware stream error messages for Basil chat and non-recipe calls and returns 504 on timeouts', async () => {
	const chatRequest = {
		action: 'chat',
		provider: 'chatgpt',
		connectionId: 'owned-account',
		model: 'account-model',
		messages: [{ role: 'user', content: 'Plan Wednesday dinner.' }],
		context: JSON.stringify({
			recipes: [],
			meals: [],
			pantry: [],
			shopping: [],
			today: '2026-10-23'
		})
	};
	for (const [events, pattern] of [
		[[{ type: 'response.incomplete' }], /Basil’s reply/],
		[[{ type: 'response.output_text.delta', delta: '{"reply":' }], /No partial reply was shown/],
		[
			[{ type: 'response.completed', response: { status: 'completed', output: [] } }],
			/without a reply/
		]
	] as const) {
		await assert.rejects(
			() =>
				runAIRequest(chatRequest, async () => stream([...events]), undefined, {
					accessToken: 'resolved-by-server'
				}),
			(error: unknown) =>
				error instanceof ChatGPTInferenceError &&
				error.status === 502 &&
				pattern.test(error.message) &&
				!/recipe/i.test(error.message)
		);
	}

	await assert.rejects(
		() =>
			chatGPTResponse({ ...options, action: 'vision' }, async () =>
				stream([{ type: 'response.incomplete' }])
			),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 502 &&
			/ingredient recognition/.test(error.message)
	);

	await assert.rejects(
		() =>
			chatGPTResponse(
				{ ...options, action: 'chat', timeoutMs: 15 },
				async (_input, init) =>
					new Promise<Response>((_, reject) => {
						const socket = setTimeout(() => {}, 1000);
						init?.signal?.addEventListener(
							'abort',
							() => {
								clearTimeout(socket);
								reject(init.signal?.reason);
							},
							{ once: true }
						);
					})
			),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 504 &&
			/took too long to respond/.test(error.message)
	);

	let streamTimer: ReturnType<typeof setTimeout> | undefined;
	await assert.rejects(
		() =>
			chatGPTResponse(
				{ ...options, action: 'chat', timeoutMs: 15 },
				async () =>
					new Response(
						new ReadableStream({
							pull() {
								return new Promise<void>((resolve) => {
									streamTimer = setTimeout(resolve, 1000);
								});
							},
							cancel() {
								clearTimeout(streamTimer);
							}
						}),
						{ headers: { 'content-type': 'text/event-stream' } }
					)
			),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError &&
			error.status === 504 &&
			/took too long to respond/.test(error.message)
	);
	clearTimeout(streamTimer);
});
test('ChatGPT usage-limit failures surface without a fallback API call', async () => {
	let calls = 0;
	await assert.rejects(
		() =>
			chatGPTResponse(options, async () => {
				calls++;
				return stream([
					{
						type: 'response.failed',
						response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } }
					}
				]);
			}),
		{ code: 'subscription_sharing_usage_limit_exceeded', status: 429 }
	);
	assert.equal(calls, 1);
});
test('model choices come from the selected account catalog, preserving server ordering', async () => {
	const result = await listChatGPTModels('private', async (input) => {
		assert.equal(String(input), 'https://api.openai.com/v1/models');
		return Response.json({
			models: [
				{
					slug: 'first',
					display_name: 'First',
					visibility: 'list',
					input_modalities: ['text', 'image']
				},
				{ slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
				{ slug: 'second', display_name: 'Second', visibility: 'list' }
			]
		});
	});
	assert.deepEqual(
		result.providers[0].models.map((m) => m.id),
		['first', 'second']
	);
	assert.equal(result.providers[0].models[0].vision, true);
});
test('client-supplied bearer value cannot activate ChatGPT plan inference without server connection context', async () => {
	let called = false;
	await assert.rejects(
		() =>
			runAIRequest(
				{
					action: 'vision',
					provider: 'chatgpt',
					model: 'test',
					apiKey: 'forged',
					image: 'data:image/png;base64,aGVsbG8='
				},
				async () => {
					called = true;
					return new Response();
				}
			),
		{ status: 401 }
	);
	assert.equal(called, false);
});

test('recipe generation uses the server-resolved ChatGPT token and includes actual taste ratings', async () => {
	const { seedRecipes, defaultPreferences } = await import('../src/lib/data.ts');
	const favorite = { ...seedRecipes[0], rating: 5 };
	const result = await runAIRequest(
		{
			action: 'generate',
			provider: 'chatgpt',
			connectionId: 'owned-account',
			model: 'account-model',
			preferences: defaultPreferences,
			recipes: [favorite]
		},
		async (input, init) => {
			assert.equal(String(input), 'https://api.openai.com/v1/responses');
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer resolved-by-server');
			const body = JSON.parse(String(init?.body));
			assert.match(body.input[0].content[0].text, /"rating":5/);
			assert.match(body.input[0].content[0].text, /"time":40/);
			return stream([
				{
					type: 'response.output_text.delta',
					delta: JSON.stringify({ recipes: [seedRecipes[0]] })
				},
				{ type: 'response.completed', response: { status: 'completed' } }
			]);
		},
		undefined,
		{ accessToken: 'resolved-by-server' }
	);
	assert.ok('recipes' in result);
	assert.equal(result.recipes[0].title, favorite.title);
	assert.notEqual(result.recipes[0].id, favorite.id);
});

function rawByteStream(chunks: Uint8Array[], onCancel?: () => void) {
	let index = 0;
	return new Response(
		new ReadableStream({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				controller.enqueue(chunks[index++]);
			},
			cancel() {
				onCancel?.();
			}
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	);
}

function sliceBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		out.push(bytes.subarray(offset, offset + chunkSize));
	}
	return out;
}

test('ChatGPT SSE scanner handles 1-byte and multi-byte chunks across split CRLF, LF, multi-line data, and UTF-8 boundaries', async () => {
	const encoder = new TextEncoder();
	const crlfPayload =
		'data:\r\nevent: keepalive\r\n\r\n' +
		'event: delta\r\n' +
		'data: {"type":"response.output_text.delta",\r\n' +
		'data: "delta":"Crème "}\r\n\r\n' +
		'data: {"type":"response.output_text.delta",\r\n' +
		'data: "delta":"brûlée 🍲"}\r\n\r\n' +
		'data: [DONE]\r\nevent: ignored\r\n\r\n' +
		'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';

	const lfPayload =
		'\n\n' +
		'data: {"type":"response.output_text.delta",\n' +
		'data: "delta":"Crème brûlée 🍲"}\n\n\n' +
		'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

	for (const payload of [crlfPayload, lfPayload]) {
		const bytes = encoder.encode(payload);
		for (const chunkSize of [1, 2, 3, 5, 7, 13, 64]) {
			const chunks = sliceBytes(bytes, chunkSize);
			const result = await chatGPTResponse(options, async () => rawByteStream(chunks));
			assert.equal(result, 'Crème brûlée 🍲');
		}
	}

	// Explicit lone-\r and empty Uint8Array chunks between split delimiters and data lines
	const manualChunks = [
		'data:\r',
		'',
		'\nevent: ping\r',
		'\n\r',
		'',
		'\ndata: {"type":"response.output_text.delta",\r',
		'\ndata: "delta":"ok"}\r\n',
		'\r',
		'\ndata: {"type":"response.completed","response":{"status":"completed"}}\r',
		'\n\r',
		'\n'
	].map((part) => encoder.encode(part));
	const manualResult = await chatGPTResponse(options, async () => rawByteStream(manualChunks));
	assert.equal(manualResult, 'ok');
});

test('ChatGPT SSE scanner flushes trailing EOF frames without a final event delimiter', async () => {
	const encoder = new TextEncoder();
	for (const suffix of ['', '\r', '\r\n', '\n']) {
		const eofStream =
			'data: {"type":"response.output_text.delta","delta":"{\\"ok\\":"}\r\n\r\n' +
			`data: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"{\\"ok\\":true}"}]}]}}${suffix}`;
		const bytes = encoder.encode(eofStream);
		for (const chunkSize of [1, 4, 17]) {
			const result = await chatGPTResponse(options, async () =>
				rawByteStream(sliceBytes(bytes, chunkSize))
			);
			assert.equal(result, '{"ok":true}');
		}
	}
});

test('ChatGPT SSE scanner rejects streams exceeding MAX_RESPONSE_BYTES and cancels the reader', async () => {
	let cancelled = false;
	const chunk = new Uint8Array(250_000).fill(0x61); // 'a'
	const oversizedChunks = Array.from({ length: 16 }, () => chunk); // 4,000,000 bytes > 3,000,000
	let responseStream: Response | undefined;
	await assert.rejects(
		() =>
			chatGPTResponse(options, async () => {
				responseStream = rawByteStream(oversizedChunks, () => {
					cancelled = true;
				});
				return responseStream;
			}),
		(error: unknown) =>
			error instanceof ChatGPTInferenceError && /oversized response/i.test(error.message)
	);
	assert.equal(cancelled, true);
	assert.equal(responseStream?.body?.locked, false);
});

test('ChatGPT SSE scanner parses multi-megabyte response.completed streams in linear time', async () => {
	const largeText = '{"recipe":"' + 'x'.repeat(2_750_000) + '"}';
	const sse =
		'data: {"type":"response.output_text.delta","delta":"{}"}\r\n\r\n' +
		`data: ${JSON.stringify({
			type: 'response.completed',
			response: {
				status: 'completed',
				output: [{ content: [{ type: 'output_text', text: largeText }] }]
			}
		})}\r\n\r\n` +
		'data: [DONE]\r\n\r\n';
	const encoded = new TextEncoder().encode(sse);
	assert.ok(encoded.byteLength > 2_750_000 && encoded.byteLength < 3_000_000);

	const chunks = sliceBytes(encoded, 512);
	const start = performance.now();
	const result = await chatGPTResponse(options, async () => rawByteStream(chunks));
	const elapsedMs = performance.now() - start;

	assert.equal(result, largeText);
	assert.ok(
		elapsedMs < 750,
		`Expected incremental SSE scan under 750ms for 2.75MB in 512B chunks, got ${elapsedMs.toFixed(2)}ms`
	);
});
