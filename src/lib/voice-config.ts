export const voiceProviders = [
	{
		id: 'auto',
		name: 'Automatic',
		help: 'Use local Whisper when available; otherwise use browser dictation.'
	},
	{
		id: 'browser',
		name: 'Browser dictation',
		help: 'No API key. Requires a browser with speech recognition.'
	},
	{
		id: 'local',
		name: 'Local Whisper',
		help: 'Uses the Whisper service configured for this installation.'
	},
	{
		id: 'groq',
		name: 'Groq',
		help: 'Free plan with usage limits; Whisper Turbo is a low-cost paid option.',
		url: 'https://console.groq.com/keys',
		pricing: 'https://console.groq.com/docs/speech-to-text',
		models: ['whisper-large-v3-turbo', 'whisper-large-v3']
	},
	{
		id: 'deepgram',
		name: 'Deepgram',
		help: 'Introductory free credits, then pay-as-you-go. Credits are not a recurring free tier.',
		url: 'https://console.deepgram.com/',
		pricing: 'https://deepgram.com/pricing',
		models: ['nova-3', 'nova-2']
	}
] as const;
export type VoiceProvider = (typeof voiceProviders)[number]['id'];
export type VoiceOptions = { provider: VoiceProvider; model: string; apiKey: string };
export type VoiceState = 'idle' | 'recording' | 'transcribing';
export type VoiceDialog = 'pantry' | 'import';
export type ResumeDialog = '' | VoiceDialog;
export const MAX_VOICE_SECONDS = 120;
export const MAX_WAV_BYTES = 44 + 16000 * 2 * MAX_VOICE_SECONDS;

export function resolveVoiceProvider(
	provider: VoiceProvider,
	localAvailable: boolean,
	signedIn: boolean
): Exclude<VoiceProvider, 'auto'> {
	if (provider === 'auto') return localAvailable && signedIn ? 'local' : 'browser';
	return provider;
}

export type VoiceStartPlan =
	| {
			action: 'auth';
			targetDialog: VoiceDialog;
			resumeDialog: VoiceDialog;
			message: string;
	  }
	| {
			action: 'settings';
			targetDialog: VoiceDialog;
			resumeDialog: VoiceDialog;
			message: string;
	  }
	| {
			action: 'start';
			targetDialog: VoiceDialog;
			provider: Exclude<VoiceProvider, 'auto'>;
	  };

export function planVoiceStart(input: {
	forRecipe: boolean;
	modal: string;
	provider: VoiceProvider;
	localAvailable: boolean;
	signedIn: boolean;
	apiKey: string;
}): VoiceStartPlan {
	const targetDialog: VoiceDialog = input.forRecipe ? 'import' : 'pantry';
	const resumeDialog: VoiceDialog =
		input.modal === 'pantry' || input.modal === 'import' ? input.modal : targetDialog;
	const resolved = resolveVoiceProvider(input.provider, input.localAvailable, input.signedIn);
	if (resolved !== 'browser' && !input.signedIn) {
		return {
			action: 'auth',
			targetDialog,
			resumeDialog,
			message: 'Sign in to use voice transcription.'
		};
	}
	if ((resolved === 'groq' || resolved === 'deepgram') && !input.apiKey.trim()) {
		return {
			action: 'settings',
			targetDialog,
			resumeDialog,
			message: 'Add a voice API key in Voice input settings.'
		};
	}
	if (resolved === 'local' && !input.localAvailable) {
		return {
			action: 'settings',
			targetDialog,
			resumeDialog,
			message: 'Local Whisper needs an endpoint configured by the server operator.'
		};
	}
	return {
		action: 'start',
		targetDialog,
		provider: resolved
	};
}

export type VoiceRetryPlan =
	| {
			action: 'auth';
			resumeDialog: VoiceDialog;
			message: string;
	  }
	| {
			action: 'settings';
			resumeDialog: VoiceDialog;
			message: string;
	  }
	| {
			action: 'error';
			message: string;
	  }
	| {
			action: 'retry';
			provider: 'local' | 'groq' | 'deepgram';
	  };

export function planVoiceRetry(input: {
	modal: string;
	voiceTarget: VoiceDialog;
	provider: VoiceProvider;
	localAvailable: boolean;
	signedIn: boolean;
	apiKey: string;
}): VoiceRetryPlan {
	const resumeDialog: VoiceDialog =
		input.modal === 'pantry' || input.modal === 'import' ? input.modal : input.voiceTarget;
	if (!input.signedIn) {
		return {
			action: 'auth',
			resumeDialog,
			message: 'Sign in to retry voice transcription.'
		};
	}
	const resolved = resolveVoiceProvider(input.provider, input.localAvailable, input.signedIn);
	if ((resolved === 'groq' || resolved === 'deepgram') && !input.apiKey.trim()) {
		return {
			action: 'settings',
			resumeDialog,
			message: 'Add a voice API key in Voice input settings.'
		};
	}
	if (resolved === 'local' && !input.localAvailable) {
		return {
			action: 'settings',
			resumeDialog,
			message: 'Local Whisper needs an endpoint configured by the server operator.'
		};
	}
	if (resolved === 'browser') {
		return {
			action: 'error',
			message:
				'Browser dictation cannot transcribe a saved recording. Choose Local Whisper, Groq, or Deepgram in Settings to retry, or discard the recording.'
		};
	}
	return {
		action: 'retry',
		provider: resolved
	};
}

export function resolveClosedDialog(
	currentModal: string,
	resumeDialog: ResumeDialog
): { modal: string; resumeDialog: ResumeDialog } {
	if (
		resumeDialog &&
		(currentModal === 'settings' || currentModal === 'auth' || currentModal === 'recover')
	) {
		return { modal: resumeDialog, resumeDialog: '' };
	}
	return {
		modal: '',
		resumeDialog: currentModal === 'pantry' || currentModal === 'import' ? '' : resumeDialog
	};
}

export function appendDictatedText(target: VoiceDialog, current: string, incoming: string): string {
	const text = incoming.trim();
	if (!text) return current;
	if (target === 'import') {
		const base = current.replace(/\s+$/, '');
		return [base, text].filter(Boolean).join('\n').slice(0, 20000);
	}
	const base = current.trim().replace(/,+\s*$/, '');
	return [base, text].filter(Boolean).join(', ');
}
