import type { ShoppingItem } from './types.ts';
import { MAX_VOICE_SECONDS, type VoiceOptions } from './voice-config.ts';
export type VoiceState = 'idle' | 'recording' | 'transcribing';
export type VoiceTarget = 'import' | 'pantry' | 'shopping';

const QUICK_SHOPPING_ITEM_PATTERN =
	/^(\d+(?:\.\d+)?)(?:\s*(g|grams?|kg|kilograms?|mg|oz|ounces?|lbs?|pounds?|ml|milliliters?|millilitres?|l|liters?|litres?|cups?|tbsp|tablespoons?|tsp|teaspoons?|pt|pints?|qt|quarts?|gal|gallons?|pieces?|whole|each|cans?|cloves?|bunch(?:es)?|heads?|slices?|loaf|loaves|bottles?|packs?|packages?|bags?|boxes?|jars?)\s+(?:of\s+)?|\s+)(.+)$/i;

export function isVoiceTargetActive(
	target: VoiceTarget | '',
	view: {
		modal: string;
		page: string;
		overlay?: boolean;
	}
): boolean {
	if (!target || view.overlay) return false;
	if (target === 'shopping') return view.page === 'shopping' && !view.modal;
	return view.modal === target;
}

export function appendVoiceTranscript(
	current: string,
	transcript: string,
	separator = ', ',
	maxLength?: number
): string {
	const incoming = transcript.trim();
	if (!incoming) return maxLength !== undefined ? current.slice(0, maxLength) : current;
	const existing =
		separator === '\n' ? current.replace(/\s+$/, '') : current.replace(/[\s,;.]+$/, '');
	const merged = existing ? `${existing}${separator}${incoming}` : incoming;
	return maxLength !== undefined ? merged.slice(0, maxLength) : merged;
}

export function parseQuickShoppingItems(
	input: string,
	createId: () => string = () => globalThis.crypto.randomUUID()
): ShoppingItem[] {
	const segments = input
		.split(/[,\n;]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	const items: ShoppingItem[] = [];
	for (let i = 0; i < segments.length; i++) {
		let value = segments[i].replace(/\.+$/, '').trim();
		if (segments.length > 1 && i > 0) value = value.replace(/^and\s+/i, '').trim();
		if (!value) continue;
		const match = value.match(QUICK_SHOPPING_ITEM_PATTERN);
		const parsedQuantity = match ? Number(match[1]) : NaN;
		const validQuantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0;
		const rawName = (validQuantity && match ? match[3] : value).trim().slice(0, 100);
		if (!rawName) continue;
		const quantity = validQuantity
			? Math.min(1_000_000, Math.round(parsedQuantity * 100) / 100 || parsedQuantity)
			: 1;
		const unit = (validQuantity && match?.[2] ? match[2].toLowerCase() : 'piece').slice(0, 40);
		items.push({
			id: createId(),
			name: rawName,
			quantity,
			unit,
			checked: false
		});
	}
	return items;
}

export function pcmWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(44 + samples.length * 2);
	const view = new DataView(bytes.buffer);
	const text = (at: number, value: string) =>
		[...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
	text(0, 'RIFF');
	view.setUint32(4, bytes.length - 8, true);
	text(8, 'WAVEfmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, samples.length * 2, true);
	samples.forEach((sample, i) => {
		const value = Math.max(-1, Math.min(1, sample));
		view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
	});
	return bytes;
}

export class VoiceCapture {
	private cancelled = false;
	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private recognition: any;
	private timer?: ReturnType<typeof setTimeout>;
	private abort = new AbortController();
	private callbacks: {
		state: (value: VoiceState) => void;
		text: (value: string) => void;
		error: (value: string) => void;
	};
	constructor(callbacks: {
		state: (value: VoiceState) => void;
		text: (value: string) => void;
		error: (value: string) => void;
	}) {
		this.callbacks = callbacks;
	}

	private release() {
		clearTimeout(this.timer);
		this.stream?.getTracks().forEach((track) => track.stop());
	}
	cancel() {
		this.cancelled = true;
		this.abort.abort();
		this.recognition?.abort();
		if (this.recorder?.state === 'recording') this.recorder.stop();
		this.release();
		this.callbacks.state('idle');
	}
	stop() {
		this.recognition?.stop();
		if (this.recorder?.state === 'recording') this.recorder.stop();
		this.release();
	}
	async start(options: VoiceOptions) {
		try {
			if (options.provider === 'browser') {
				const Recognition =
					(window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
				if (!Recognition)
					throw new Error(
						'Choose Groq, Deepgram, or Local Whisper in Settings → Voice input to use this browser.'
					);
				const recognition = (this.recognition = new Recognition());
				recognition.lang = navigator.language;
				recognition.interimResults = false;
				recognition.onresult = (event: any) => {
					if (!this.cancelled) this.callbacks.text(event.results[0][0].transcript);
				};
				recognition.onerror = (event: any) => {
					if (!this.cancelled)
						this.callbacks.error(
							event.error === 'not-allowed'
								? 'Allow microphone access in your browser to use voice input.'
								: 'Dictation failed. Try again or choose a transcription provider in Settings.'
						);
				};
				recognition.onend = () => {
					this.release();
					if (!this.cancelled) this.callbacks.state('idle');
				};
				recognition.start();
			} else {
				if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
					throw new Error(
						'Microphone recording requires HTTPS or localhost and a supported browser.'
					);
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				if (this.cancelled) {
					this.release();
					return;
				}
				const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
					(type) => MediaRecorder.isTypeSupported(type)
				);
				const recorder = (this.recorder = new MediaRecorder(
					this.stream,
					mimeType ? { mimeType } : undefined
				));
				const chunks: Blob[] = [];
				let size = 0;
				recorder.ondataavailable = (event) => {
					size += event.data.size;
					if (size > 6_000_000) {
						this.callbacks.error('Recording is too large. Try a shorter recording.');
						this.cancel();
						return;
					}
					if (event.data.size) chunks.push(event.data);
				};
				recorder.onerror = () => {
					if (!this.cancelled) {
						this.callbacks.error('Microphone recording failed. Please try again.');
						this.cancel();
					}
				};
				recorder.onstop = () => {
					this.release();
					if (!this.cancelled)
						void this.transcribe(new Blob(chunks, { type: recorder.mimeType }), options);
				};
				recorder.start(1000);
			}
			this.callbacks.state('recording');
			this.timer = setTimeout(() => this.stop(), MAX_VOICE_SECONDS * 1000);
		} catch (error) {
			this.release();
			if (!this.cancelled) {
				this.callbacks.state('idle');
				this.callbacks.error(
					error instanceof DOMException && error.name === 'NotAllowedError'
						? 'Allow microphone access in your browser to use voice input.'
						: error instanceof Error
							? error.message
							: 'Microphone recording could not start.'
				);
			}
		}
	}
	private async transcribe(blob: Blob, options: VoiceOptions) {
		this.callbacks.state('transcribing');
		try {
			const decoder = new OfflineAudioContext(1, 1, 16000);
			const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
			const length = Math.min(Math.ceil(decoded.duration * 16000), MAX_VOICE_SECONDS * 16000);
			if (!length) throw new Error('No audio was recorded. Try again.');
			const renderer = new OfflineAudioContext(1, length, 16000);
			const source = renderer.createBufferSource();
			source.buffer = decoded;
			source.connect(renderer.destination);
			source.start();
			const rendered = await renderer.startRendering();
			if (this.cancelled) return;
			const form = new FormData();
			form.set('provider', options.provider);
			form.set('model', options.model);
			form.set('apiKey', options.apiKey);
			form.set('language', navigator.language || 'en');
			form.set(
				'audio',
				new Blob([pcmWav(rendered.getChannelData(0))], { type: 'audio/wav' }),
				'recording.wav'
			);
			const response = await fetch('/api/voice', {
				method: 'POST',
				body: form,
				signal: this.abort.signal
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Voice transcription failed.');
			if (!this.cancelled) this.callbacks.text(result.text);
		} catch (error) {
			if (!this.cancelled)
				this.callbacks.error(
					error instanceof Error ? error.message : 'Could not transcribe the recording.'
				);
		} finally {
			if (!this.cancelled) this.callbacks.state('idle');
		}
	}
}
