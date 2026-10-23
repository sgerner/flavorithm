import { ApiError } from './db.ts';
import { MAX_WAV_BYTES, voiceProviders } from '../voice-config.ts';

export function localWhisperUrl(): URL | null {
	try {
		const url = new URL(process.env.WHISPER_TRANSCRIPTION_URL || '');
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
			return null;
		return url;
	} catch {
		return null;
	}
}

// Accept only the bounded canonical PCM WAV produced by our recorder. No remote file URLs.
export function validateVoiceAudio(bytes: Uint8Array) {
	const b = Buffer.from(bytes);
	if (
		b.length < 46 ||
		b.length > MAX_WAV_BYTES ||
		b.length % 2 ||
		b.toString('ascii', 0, 4) !== 'RIFF' ||
		b.readUInt32LE(4) !== b.length - 8 ||
		b.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
		b.readUInt32LE(16) !== 16 ||
		b.readUInt16LE(20) !== 1 ||
		b.readUInt16LE(22) !== 1 ||
		b.readUInt32LE(24) !== 16000 ||
		b.readUInt32LE(28) !== 32000 ||
		b.readUInt16LE(32) !== 2 ||
		b.readUInt16LE(34) !== 16 ||
		b.toString('ascii', 36, 40) !== 'data' ||
		b.readUInt32LE(40) !== b.length - 44
	) {
		throw new ApiError(400, 'Record up to two minutes of audio using the microphone button.');
	}
}

export async function transcribeVoice(form: FormData, fetcher: typeof fetch, signal?: AbortSignal) {
	const provider = form.get('provider');
	const model = form.get('model');
	const key = form.get('apiKey');
	const language = form.get('language');
	const audio = form.get('audio');
	if (
		typeof provider !== 'string' ||
		!['local', 'groq', 'deepgram'].includes(provider) ||
		typeof model !== 'string' ||
		typeof key !== 'string' ||
		key.length > 2048 ||
		/[\r\n]/.test(key) ||
		typeof language !== 'string' ||
		!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) ||
		!(audio instanceof File)
	)
		throw new ApiError(400, 'Choose a voice connection and record some audio.');
	if (audio.size > MAX_WAV_BYTES) throw new ApiError(413, 'Keep recordings under two minutes.');
	const bytes = new Uint8Array(await audio.arrayBuffer());
	validateVoiceAudio(bytes);
	const spec = voiceProviders.find((p) => p.id === provider);
	if (
		provider !== 'local' &&
		(!spec || !('models' in spec) || !(spec.models as readonly string[]).includes(model))
	)
		throw new ApiError(400, 'Choose a supported transcription model.');
	if (provider !== 'local' && !key.trim())
		throw new ApiError(400, 'Enter a voice API key in Settings.');
	let url: URL;
	let body: BodyInit;
	const headers = new Headers();
	if (provider === 'deepgram') {
		url = new URL('https://api.deepgram.com/v1/listen');
		url.search = new URLSearchParams({
			model,
			smart_format: 'true',
			language: language.split('-')[0],
			mip_opt_out: 'true'
		}).toString();
		headers.set('Authorization', `Token ${key.trim()}`);
		headers.set('Content-Type', 'audio/wav');
		body = new Blob([bytes], { type: 'audio/wav' });
	} else {
		const local = localWhisperUrl();
		if (provider === 'local' && !local)
			throw new ApiError(503, 'Local Whisper is not configured on this installation.');
		url =
			provider === 'local'
				? local!
				: new URL('https://api.groq.com/openai/v1/audio/transcriptions');
		const token = provider === 'local' ? process.env.WHISPER_API_KEY : key.trim();
		if (token) headers.set('Authorization', `Bearer ${token}`);
		const upload = new FormData();
		upload.set('file', new Blob([bytes], { type: 'audio/wav' }), 'recording.wav');
		upload.set('model', provider === 'local' ? process.env.WHISPER_MODEL || 'whisper-1' : model);
		upload.set('response_format', 'json');
		upload.set('language', language.split('-')[0]);
		body = upload;
	}
	try {
		const response = await fetcher(url, {
			method: 'POST',
			headers,
			body,
			redirect: 'error',
			signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])])
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			if ([401, 403].includes(response.status))
				throw new ApiError(
					401,
					'The voice service rejected its API key. Check Voice input in Settings.'
				);
			if ([402, 429].includes(response.status))
				throw new ApiError(
					429,
					'Voice service usage limit reached. Check your provider quota or try later.'
				);
			throw new ApiError(502, 'The voice service could not transcribe this recording. Try again.');
		}
		if (!response.body) throw new Error('Empty response');
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 256_000) {
					void reader.cancel().catch(() => {});
					throw new Error('Oversize response');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		const text =
			provider === 'deepgram'
				? data.results?.channels?.[0]?.alternatives?.[0]?.transcript
				: data.text;
		if (typeof text !== 'string' || !text.trim())
			throw new ApiError(422, 'No speech was detected. Try speaking closer to the microphone.');
		if (text.length > 20_000) throw new Error('Oversize transcript');
		return { text: text.trim() };
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(
			502,
			'Voice transcription failed or timed out. Check the service and try again.'
		);
	}
}
