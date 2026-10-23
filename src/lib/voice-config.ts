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
export const MAX_VOICE_SECONDS = 120;
export const MAX_WAV_BYTES = 44 + 16000 * 2 * MAX_VOICE_SECONDS;
