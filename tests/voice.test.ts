import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.FLAVORITHM_DB_PATH = ':memory:';
const { transcribeVoice, validateVoiceAudio, localWhisperUrl } =
	await import('../src/lib/server/voice.ts');
const { pcmWav, VoiceCapture } = await import('../src/lib/voice-capture.ts');
const { MAX_WAV_BYTES } = await import('../src/lib/voice-config.ts');
const route = await import('../src/routes/api/voice/+server.ts');
function form(provider = 'groq', model = 'whisper-large-v3-turbo') {
	const value = new FormData();
	value.set('provider', provider);
	value.set('model', model);
	value.set('apiKey', 'test-secret');
	value.set('language', 'en-US');
	value.set(
		'audio',
		new Blob([pcmWav(new Float32Array(1600).fill(0.2))], { type: 'audio/wav' }),
		'audio.wav'
	);
	return value;
}
test('PCM encoder and validator enforce mono 16kHz bounded audio, including corrupt chunk lengths', () => {
	const wav = pcmWav(new Float32Array([-2, 0, 2]));
	validateVoiceAudio(wav);
	const view = new DataView(wav.buffer);
	assert.equal(view.getInt16(44, true), -32768);
	assert.equal(view.getInt16(48, true), 32767);
	for (const index of [0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
		const bad = wav.slice();
		bad[index] ^= 1;
		assert.throws(() => validateVoiceAudio(bad));
	}
	assert.throws(() => validateVoiceAudio(new Uint8Array(MAX_WAV_BYTES + 2)));
	assert.throws(() => validateVoiceAudio(pcmWav(new Float32Array())));
});
test('Groq uses only the fixed transcription endpoint, approved model and sanitized upload', async () => {
	const value = form();
	value.set('url', 'http://127.0.0.1/private');
	const result = await transcribeVoice(value, (async (input, init) => {
		assert.equal(String(input), 'https://api.groq.com/openai/v1/audio/transcriptions');
		assert.equal(init?.redirect, 'error');
		assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-secret');
		const body = init?.body as FormData;
		assert.equal(body.get('model'), 'whisper-large-v3-turbo');
		assert.equal(body.get('language'), 'en');
		assert.equal(body.has('url'), false);
		assert.equal((body.get('file') as File).name, 'recording.wav');
		return Response.json({ text: '  tomatoes and rice  ' });
	}) as typeof fetch);
	assert.equal(result.text, 'tomatoes and rice');
});
test('Deepgram sends binary WAV using Token auth and reads transcript', async () => {
	const result = await transcribeVoice(form('deepgram', 'nova-3'), (async (input, init) => {
		const url = new URL(String(input));
		assert.equal(url.origin, 'https://api.deepgram.com');
		assert.equal(url.pathname, '/v1/listen');
		assert.equal(url.searchParams.get('model'), 'nova-3');
		assert.equal(new Headers(init?.headers).get('authorization'), 'Token test-secret');
		assert.equal(new Headers(init?.headers).get('content-type'), 'audio/wav');
		assert.ok(init?.body instanceof Blob);
		return Response.json({
			results: { channels: [{ alternatives: [{ transcript: 'two onions' }] }] }
		});
	}) as typeof fetch);
	assert.equal(result.text, 'two onions');
});
test('local endpoint is operator configured; uses operator token rather than client credentials', async () => {
	const old = process.env.WHISPER_TRANSCRIPTION_URL,
		oldKey = process.env.WHISPER_API_KEY;
	try {
		delete process.env.WHISPER_TRANSCRIPTION_URL;
		await assert.rejects(transcribeVoice(form('local', ''), fetch), /not configured/);
		process.env.WHISPER_TRANSCRIPTION_URL = 'http://whisper:8080/inference';
		process.env.WHISPER_API_KEY = 'operator-secret';
		await transcribeVoice(form('local', ''), (async (input, init) => {
			assert.equal(String(input), 'http://whisper:8080/inference');
			assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer operator-secret');
			return Response.json({ text: 'one avocado' });
		}) as typeof fetch);
		process.env.WHISPER_TRANSCRIPTION_URL = 'file:///etc/passwd';
		assert.equal(localWhisperUrl(), null);
		process.env.WHISPER_TRANSCRIPTION_URL = 'https://user:pass@example.com';
		assert.equal(localWhisperUrl(), null);
	} finally {
		if (old === undefined) delete process.env.WHISPER_TRANSCRIPTION_URL;
		else process.env.WHISPER_TRANSCRIPTION_URL = old;
		if (oldKey === undefined) delete process.env.WHISPER_API_KEY;
		else process.env.WHISPER_API_KEY = oldKey;
	}
});
test('rejects missing keys, arbitrary models, malformed audio, empty transcripts and upstream failures without exposing secrets', async () => {
	const never = (async () => {
		throw new Error('must not call');
	}) as typeof fetch;
	for (const [name, value] of [
		['model', 'unapproved'],
		['apiKey', ''],
		['provider', 'http://localhost'],
		['language', '../bad']
	]) {
		const f = form();
		f.set(name, value);
		await assert.rejects(transcribeVoice(f, never));
	}
	const bad = form();
	bad.set('audio', new Blob(['bad']));
	await assert.rejects(transcribeVoice(bad, never));
	for (const status of [401, 402, 429, 500]) {
		await assert.rejects(
			transcribeVoice(
				form(),
				(async () => new Response('secret provider payload', { status })) as typeof fetch
			),
			(error: any) => {
				assert.doesNotMatch(error.message, /secret provider payload/);
				return true;
			}
		);
	}
	await assert.rejects(
		transcribeVoice(form(), (async () => Response.json({ text: '' })) as typeof fetch),
		/No speech/
	);
	await assert.rejects(
		transcribeVoice(form(), (async () => new Response('a'.repeat(256001))) as typeof fetch)
	);
});
function event(body: FormData, signedIn = true, origin = 'https://flavorithm.example') {
	return {
		request: new Request('https://flavorithm.example/api/voice', {
			method: 'POST',
			headers: { origin },
			body
		}),
		locals: { user: signedIn ? { id: 'voice-tester' } : null },
		fetch: (async () => Response.json({ text: 'hello' })) as typeof fetch
	} as any;
}
test('voice API enforces authentication, origin and streaming upload limit; never returns credentials', async () => {
	assert.equal((await route.POST(event(form(), false))).status, 401);
	assert.equal((await route.POST(event(form(), true, 'https://evil.example'))).status, 403);
	const response = await route.POST(event(form()));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { text: 'hello' });
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const largeEvent = event(form());
	largeEvent.request = new Request('https://flavorithm.example/api/voice', {
		method: 'POST',
		headers: {
			origin: 'https://flavorithm.example',
			'content-type': 'multipart/form-data; boundary=test'
		},
		body: new Uint8Array(MAX_WAV_BYTES + 20_000)
	});
	assert.equal((await route.POST(largeEvent)).status, 413);
	const availability = await route.GET({ locals: { user: { id: 'voice-tester' } } } as any);
	assert.deepEqual(Object.keys(await availability.json()), ['localAvailable']);
});
test('cancelling a pending microphone permission releases tracks and suppresses recording', async (t) => {
	let allow!: (stream: any) => void;
	let stopped = false;
	let recorderCreated = false;
	for (const [name, value] of Object.entries({
		navigator: {
			mediaDevices: {
				getUserMedia: () =>
					new Promise((resolve) => {
						allow = resolve;
					})
			}
		},
		MediaRecorder: class {
			constructor() {
				recorderCreated = true;
			}
		}
	})) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => {
			if (previous) Object.defineProperty(globalThis, name, previous);
			else Reflect.deleteProperty(globalThis, name);
		});
	}

	const states: string[] = [];
	const capture = new VoiceCapture({
		state: (value) => states.push(value),
		text: () => assert.fail('late transcript'),
		error: () => assert.fail('late error')
	});
	const pending = capture.start({ provider: 'local', model: '', apiKey: '' });
	capture.cancel();
	allow({
		getTracks: () => [
			{
				stop: () => {
					stopped = true;
				}
			}
		]
	});
	await pending;
	assert.equal(stopped, true);
	assert.equal(recorderCreated, false);
	assert.deepEqual(states, ['idle']);
});

test('record/stop converts to WAV, uploads once, and cancellation suppresses a late result', async (t) => {
	let stopped = 0,
		uploads = 0;
	let resolveUpload!: (response: Response) => void;
	const overrides = {
		navigator: {
			language: 'en-US',
			mediaDevices: {
				getUserMedia: async () => ({
					getTracks: () => [
						{
							stop: () => {
								stopped++;
							}
						}
					]
				})
			}
		},
		MediaRecorder: class {
			state = 'inactive';
			mimeType = 'audio/webm';
			ondataavailable?: (event: any) => void;
			onstop?: () => void;
			static isTypeSupported() {
				return true;
			}
			start() {
				this.state = 'recording';
			}
			stop() {
				this.state = 'inactive';
				queueMicrotask(() => {
					this.ondataavailable?.({ data: new Blob(['fake encoded recording']) });
					this.onstop?.();
				});
			}
		},
		OfflineAudioContext: class {
			destination = {};
			async decodeAudioData() {
				return { duration: 0.1 };
			}
			createBufferSource() {
				return { buffer: null, connect() {}, start() {} };
			}
			async startRendering() {
				return { getChannelData: () => new Float32Array(1600) };
			}
		},
		fetch: async (_input: any, init: any) => {
			uploads++;
			assert.equal(_input, '/api/voice');
			validateVoiceAudio(new Uint8Array(await init.body.get('audio').arrayBuffer()));
			return new Promise<Response>((resolve) => {
				resolveUpload = resolve;
			});
		}
	};
	for (const [name, value] of Object.entries(overrides)) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { configurable: true, value });
		t.after(() => {
			if (previous) Object.defineProperty(globalThis, name, previous);
			else Reflect.deleteProperty(globalThis, name);
		});
	}
	const text: string[] = [],
		states: string[] = [];
	const capture = new VoiceCapture({
		state: (value) => states.push(value),
		text: (value) => text.push(value),
		error: (message) => assert.fail(message)
	});
	await capture.start({ provider: 'groq', model: 'whisper-large-v3-turbo', apiKey: 'key' });
	assert.deepEqual(states, ['recording']);
	capture.stop();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(uploads, 1);
	assert.ok(stopped > 0);
	assert.equal(states.at(-1), 'transcribing');
	capture.cancel();
	resolveUpload(Response.json({ text: 'late carrots' }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(text.length, 0);
	assert.equal(states.at(-1), 'idle');
	const next = new VoiceCapture({
		state: (value) => states.push(value),
		text: (value) => text.push(value),
		error: (message) => assert.fail(message)
	});
	await next.start({ provider: 'local', model: '', apiKey: '' });
	next.stop();
	await new Promise((resolve) => setImmediate(resolve));
	resolveUpload(Response.json({ text: 'fresh carrots' }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(text, ['fresh carrots']);
	assert.equal(uploads, 2);
	assert.equal(states.at(-1), 'idle');
});
