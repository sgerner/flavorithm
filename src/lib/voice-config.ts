import type { ShoppingItem } from './types.ts';

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
export type VoiceTarget = VoiceDialog | 'shopping';
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
			targetDialog: VoiceTarget;
			resumeDialog: ResumeDialog;
			message: string;
	  }
	| {
			action: 'settings';
			targetDialog: VoiceTarget;
			resumeDialog: ResumeDialog;
			message: string;
	  }
	| {
			action: 'start';
			targetDialog: VoiceTarget;
			provider: Exclude<VoiceProvider, 'auto'>;
	  };

export function planVoiceStart(input: {
	target?: VoiceTarget;
	forRecipe?: boolean;
	modal: string;
	provider: VoiceProvider;
	localAvailable: boolean;
	signedIn: boolean;
	apiKey: string;
}): VoiceStartPlan {
	const targetDialog: VoiceTarget = input.target ?? (input.forRecipe ? 'import' : 'pantry');
	const resumeDialog: ResumeDialog =
		input.modal === 'pantry' || input.modal === 'import'
			? input.modal
			: targetDialog === 'shopping'
				? ''
				: targetDialog;
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
			resumeDialog: ResumeDialog;
			message: string;
	  }
	| {
			action: 'settings';
			resumeDialog: ResumeDialog;
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
	voiceTarget: VoiceTarget;
	provider: VoiceProvider;
	localAvailable: boolean;
	signedIn: boolean;
	apiKey: string;
}): VoiceRetryPlan {
	const resumeDialog: ResumeDialog =
		input.modal === 'pantry' || input.modal === 'import'
			? input.modal
			: input.voiceTarget === 'shopping'
				? ''
				: input.voiceTarget;
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

export function appendDictatedText(target: VoiceTarget, current: string, incoming: string): string {
	const text = incoming.trim();
	if (!text) return target === 'import' ? current.slice(0, 20000) : current;
	if (target === 'import') {
		const base = current.replace(/\s+$/, '');
		return [base, text].filter(Boolean).join('\n').slice(0, 20000);
	}
	if (target === 'shopping') {
		return appendVoiceTranscript(current, text, ', ', 2000);
	}
	const base = current.trim().replace(/,+\s*$/, '');
	return [base, text].filter(Boolean).join(', ');
}

const QUICK_SHOPPING_ITEM_PATTERN =
	/^(\d+(?:\.\d+)?)(?:\s*(g|grams?|kg|kilograms?|mg|oz|ounces?|lbs?|pounds?|ml|milliliters?|millilitres?|l|liters?|litres?|cups?|tbsp|tablespoons?|tsp|teaspoons?|pt|pints?|qt|quarts?|gal|gallons?|pieces?|whole|each|cans?|cloves?|bunch(?:es)?|heads?|slices?|loaf|loaves|bottles?|packs?|packages?|bags?|boxes?|jars?)\s+(?:of\s+)?|\s+)(.+)$/i;

export function isVoiceTargetActive(
	target: VoiceTarget | '',
	view: {
		modal: string;
		page: string;
		overlay?: boolean;
		reviewingDraft?: boolean;
	}
): boolean {
	if (!target || view.overlay) return false;
	if (target === 'shopping') return view.page === 'shopping' && !view.modal;
	if (target === 'import' && view.reviewingDraft) return false;
	return view.modal === target;
}

export type QuickShoppingParseOptions = {
	createId?: () => string;
	split?: boolean;
};

export type QuickShoppingParseResult = {
	items: ShoppingItem[];
	error?: string;
};

export function parseQuickShoppingItems(
	input: string,
	options?: (() => string) | QuickShoppingParseOptions
): QuickShoppingParseResult {
	const resolvedOptions: QuickShoppingParseOptions =
		typeof options === 'function' ? { createId: options } : (options ?? {});
	const createId = resolvedOptions.createId ?? (() => globalThis.crypto.randomUUID());
	const split = resolvedOptions.split ?? true;
	const segments = (split ? input.split(/[,\n;]/) : [input])
		.map((segment) => segment.trim())
		.filter(Boolean);
	const items: ShoppingItem[] = [];
	for (let i = 0; i < segments.length; i++) {
		let value = split ? segments[i].replace(/\.+$/, '').trim() : segments[i];
		if (split && segments.length > 1 && i > 0) value = value.replace(/^and\s+/i, '').trim();
		if (!value) continue;
		const match = value.match(QUICK_SHOPPING_ITEM_PATTERN);
		if (match) {
			const parsedQuantity = Number(match[1]);
			if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
				return { items: [], error: 'Enter a quantity above zero.' };
			}
			const rawName = match[3].trim().slice(0, 200);
			if (!rawName) continue;
			const quantity = Math.min(
				1_000_000,
				Math.round(parsedQuantity * 100) / 100 || parsedQuantity
			);
			const unit = (match[2] ? match[2].toLowerCase() : 'piece').slice(0, 40);
			items.push({
				id: createId(),
				name: rawName,
				quantity,
				unit,
				checked: false
			});
		} else {
			const rawName = value.slice(0, 200);
			if (!rawName) continue;
			items.push({
				id: createId(),
				name: rawName,
				quantity: 1,
				unit: 'piece',
				checked: false
			});
		}
	}
	return { items };
}
