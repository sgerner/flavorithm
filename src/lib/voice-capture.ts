import { MAX_VOICE_SECONDS, type VoiceOptions, type VoiceState } from './voice-config.ts';
export {
	appendDictatedText,
	appendVoiceTranscript,
	isVoiceTargetActive,
	parseQuickShoppingItems,
	planVoiceRetry,
	planVoiceStart,
	resolveClosedDialog,
	resolveVoiceProvider,
	type QuickShoppingParseOptions,
	type QuickShoppingParseResult,
	type ResumeDialog,
	type VoiceDialog,
	type VoiceRetryPlan,
	type VoiceStartPlan,
	type VoiceState,
	type VoiceTarget
} from './voice-config.ts';

class VoiceUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VoiceUserError';
	}
}

function statusFallbackMessage(status: number): string {
	if (status === 401 || status === 403) {
		return 'Voice transcription was rejected. Check your sign-in or Voice input key in Settings, then retry.';
	}
	if (status === 413) {
		return 'Recording is too large. Discard this recording and try a shorter one.';
	}
	if (status === 429) {
		return 'Voice service usage limit reached. Check your provider quota or wait a moment, then retry.';
	}
	if (status === 502 || status === 503 || status === 504) {
		return 'The voice transcription service is temporarily unavailable. Retry your recording in a moment or check Settings.';
	}
	return 'Voice transcription failed. Retry your recording or check Voice input in Settings.';
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
	private stopping = false;
	private currentState: VoiceState = 'idle';
	private retainedAudio?: Blob;
	private retainedNotified = false;
	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private recognition: any;
	private timer?: ReturnType<typeof setTimeout>;
	private abort = new AbortController();
	private callbacks: {
		state: (value: VoiceState) => void;
		text: (value: string) => void;
		error: (value: string) => void;
		retained?: (value: boolean) => void;
	};
	constructor(callbacks: {
		state: (value: VoiceState) => void;
		text: (value: string) => void;
		error: (value: string) => void;
		retained?: (value: boolean) => void;
	}) {
		this.callbacks = callbacks;
	}

	get hasRetainedAudio(): boolean {
		return Boolean(this.retainedAudio);
	}

	private setState(value: VoiceState) {
		this.currentState = value;
		this.callbacks.state(value);
	}

	private setRetained(value: boolean) {
		if (this.retainedNotified !== value) {
			this.retainedNotified = value;
			this.callbacks.retained?.(value);
		}
	}

	private clearRetained() {
		this.retainedAudio = undefined;
		this.setRetained(false);
	}

	private release() {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = undefined;
	}

	discard() {
		this.clearRetained();
	}

	cancel() {
		this.cancelled = true;
		this.stopping = true;
		this.abort.abort();
		this.recognition?.abort();
		if (this.recorder?.state === 'recording') this.recorder.stop();
		this.clearRetained();
		this.release();
		this.setState('idle');
	}

	stop() {
		this.stopping = true;
		this.recognition?.stop();
		if (this.recorder?.state === 'recording') this.recorder.stop();
		this.release();
	}

	async start(options: VoiceOptions) {
		if (this.currentState !== 'idle') return;
		this.cancelled = false;
		this.stopping = false;
		this.abort = new AbortController();
		this.clearRetained();
		try {
			if (options.provider === 'browser') {
				const Recognition =
					(window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
				if (!Recognition)
					throw new VoiceUserError(
						'Choose Groq, Deepgram, or Local Whisper in Settings → Voice input to use this browser.'
					);
				const recognition = (this.recognition = new Recognition());
				const deadline = Date.now() + MAX_VOICE_SECONDS * 1000;
				let nextResultIndex = 0;
				let startingRecognition = false;
				recognition.lang = navigator.language || 'en';
				recognition.continuous = true;
				recognition.interimResults = false;
				recognition.onresult = (event: any) => {
					if (this.cancelled || !event?.results) return;
					const begin =
						typeof event.resultIndex === 'number'
							? Math.max(event.resultIndex, nextResultIndex)
							: nextResultIndex;
					for (let i = begin; i < event.results.length; i++) {
						const result = event.results[i];
						if (!result || result.isFinal === false) continue;
						nextResultIndex = i + 1;
						const transcript = String(result[0]?.transcript ?? '').trim();
						if (transcript && !this.cancelled) this.callbacks.text(transcript);
					}
				};
				recognition.onerror = (event: any) => {
					if (this.cancelled) return;
					if (event?.error === 'no-speech' && !this.stopping && Date.now() < deadline) return;
					if (event?.error === 'aborted' && this.stopping) return;
					this.stopping = true;
					this.callbacks.error(
						event?.error === 'not-allowed' || event?.error === 'service-not-allowed'
							? 'Allow microphone access in your browser to use voice input.'
							: 'Dictation failed. Try again or choose a transcription provider in Settings.'
					);
				};
				recognition.onend = () => {
					if (!this.cancelled && !this.stopping && !startingRecognition && Date.now() < deadline) {
						nextResultIndex = 0;
						startingRecognition = true;
						try {
							recognition.start();
							startingRecognition = false;
							return;
						} catch {
							startingRecognition = false;
							this.stopping = true;
						}
					}
					this.release();
					if (!this.cancelled) this.setState('idle');
				};
				startingRecognition = true;
				try {
					recognition.start();
				} finally {
					startingRecognition = false;
				}
			} else {
				if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
					throw new VoiceUserError(
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
			if (!this.cancelled) {
				this.setState('recording');
				this.timer = setTimeout(() => this.stop(), MAX_VOICE_SECONDS * 1000);
			}
		} catch (error) {
			this.release();
			if (!this.cancelled) {
				this.setState('idle');
				this.callbacks.error(
					error instanceof DOMException && error.name === 'NotAllowedError'
						? 'Allow microphone access in your browser to use voice input.'
						: error instanceof VoiceUserError
							? error.message
							: error instanceof Error && error.message
								? error.message
								: 'Microphone recording could not start.'
				);
			}
		}
	}

	async retry(options: VoiceOptions) {
		if (!this.retainedAudio || this.currentState !== 'idle') return;
		if (options.provider === 'browser') {
			this.setRetained(true);
			this.callbacks.error(
				'Browser dictation cannot transcribe a saved recording. Choose Local Whisper, Groq, or Deepgram in Settings to retry, or discard the recording.'
			);
			return;
		}
		this.cancelled = false;
		this.abort = new AbortController();
		await this.uploadWav(this.retainedAudio, options);
	}

	private async transcribe(blob: Blob, options: VoiceOptions) {
		this.setState('transcribing');
		let wav: Blob;
		try {
			const decoder = new OfflineAudioContext(1, 1, 16000);
			const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
			const length = Math.min(Math.ceil(decoded.duration * 16000), MAX_VOICE_SECONDS * 16000);
			if (!length) throw new VoiceUserError('No audio was recorded. Try again.');
			const renderer = new OfflineAudioContext(1, length, 16000);
			const source = renderer.createBufferSource();
			source.buffer = decoded;
			source.connect(renderer.destination);
			source.start();
			const rendered = await renderer.startRendering();
			if (this.cancelled) return;
			wav = new Blob([pcmWav(rendered.getChannelData(0))], { type: 'audio/wav' });
		} catch (error) {
			if (!this.cancelled) {
				this.callbacks.error(
					error instanceof VoiceUserError
						? error.message
						: 'Could not process the recorded audio. Please record again.'
				);
				this.setState('idle');
			}
			return;
		}
		this.retainedAudio = wav;
		await this.uploadWav(wav, options);
	}

	private async uploadWav(wav: Blob, options: VoiceOptions) {
		if (this.currentState !== 'transcribing') this.setState('transcribing');
		try {
			const form = new FormData();
			form.set('provider', options.provider);
			form.set('model', options.model);
			form.set('apiKey', options.apiKey);
			form.set('language', navigator.language || 'en');
			form.set('audio', wav, 'recording.wav');
			let response: Response;
			let raw: string;
			try {
				response = await fetch('/api/voice', {
					method: 'POST',
					body: form,
					signal: this.abort.signal
				});
				raw = await response.text();
			} catch {
				throw new VoiceUserError(
					'Could not reach the transcription service. Check your connection and retry your recording.'
				);
			}
			if (this.cancelled) return;
			let parsed: unknown = null;
			let validJson = false;
			if (raw.trim()) {
				try {
					parsed = JSON.parse(raw);
					validJson = true;
				} catch {
					validJson = false;
				}
			}
			if (!response.ok) {
				const serverMessage =
					validJson &&
					parsed !== null &&
					typeof parsed === 'object' &&
					typeof (parsed as { error?: unknown }).error === 'string'
						? (parsed as { error: string }).error.trim()
						: '';
				throw new VoiceUserError(serverMessage || statusFallbackMessage(response.status));
			}
			if (!validJson || parsed === null || typeof parsed !== 'object') {
				throw new VoiceUserError(
					'Received an unreadable response from the transcription service. Retry your recording or check Settings.'
				);
			}
			const transcript = (parsed as { text?: unknown }).text;
			if (typeof transcript !== 'string') {
				throw new VoiceUserError(
					'Received an incomplete response from the transcription service. Retry your recording or check Settings.'
				);
			}
			if (!transcript.trim()) {
				throw new VoiceUserError(
					'No speech was detected in the transcription response. Retry or discard the recording.'
				);
			}
			if (!this.cancelled) {
				this.clearRetained();
				this.callbacks.text(transcript);
			}
		} catch (error) {
			if (!this.cancelled) {
				this.setRetained(Boolean(this.retainedAudio));
				this.callbacks.error(
					error instanceof VoiceUserError
						? error.message
						: 'Voice transcription failed. Retry your recording or check Voice input in Settings.'
				);
			}
		} finally {
			if (!this.cancelled) this.setState('idle');
		}
	}
}
