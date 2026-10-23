<script lang="ts">
	import { voiceProviders, type VoiceProvider } from '#lib/voice-config.ts';
	import { revealMotion } from '#lib/motion.ts';
	let {
		provider = $bindable('auto'),
		model = $bindable(''),
		apiKey = $bindable(''),
		localAvailable,
		userId
	}: {
		provider: VoiceProvider;
		model: string;
		apiKey: string;
		localAvailable: boolean;
		userId?: string;
	} = $props();
	let selected = $derived(voiceProviders.find((item) => item.id === provider)!);
	function save() {
		if (userId) {
			try {
				localStorage.setItem(`flavorithm-voice:${userId}`, JSON.stringify({ provider, model }));
			} catch {}
		}
	}
	function change() {
		apiKey = '';
		const spec = voiceProviders.find((item) => item.id === provider)!;
		model = 'models' in spec ? spec.models[0] : '';
		save();
	}
</script>

<h3>Voice input</h3>
<label class="field"
	>Transcription<select bind:value={provider} onchange={change} disabled={!userId}>
		{#each voiceProviders as option}<option value={option.id}>{option.name}</option>{/each}
	</select></label
>
<p class="field-help">{selected.help}</p>
{#if !userId}<p class="field-help">
		Sign in to configure voice transcription. Browser dictation remains available.
	</p>{/if}
{#if provider === 'auto'}<p class="field-help">
		{localAvailable
			? 'Local Whisper is available and will be used.'
			: 'No local service configured. Select Groq or Deepgram to use voice in Firefox.'}
	</p>{/if}
{#if provider === 'local' && !localAvailable}<p class="field-help" role="status">
		Ask the server operator to configure a Whisper endpoint. <a
			href="https://github.com/sgerner/flavorithm/blob/main/docs/voice-input.md"
			target="_blank"
			rel="noopener noreferrer">Setup guide</a
		>
	</p>{/if}
{#if 'models' in selected}<div in:revealMotion>
		<label class="field"
			>Voice model<select bind:value={model} onchange={save}
				>{#each selected.models as item}<option value={item}>{item}</option>{/each}</select
			></label
		>
		<label class="field"
			>Voice API key<input
				type="password"
				bind:value={apiKey}
				autocomplete="off"
				spellcheck="false"
				placeholder="Paste your provider API key"
			/></label
		>
		<p class="field-help">
			Key stays in this tab until you reload or sign out. Recordings are sent to {selected.name} for transcription.
		</p>
		<p class="voice-links">
			<a href={selected.url} target="_blank" rel="noopener noreferrer">Get an API key ↗</a><a
				href={selected.pricing}
				target="_blank"
				rel="noopener noreferrer">Pricing & limits ↗</a
			>
		</p>
	</div>{/if}

<style>
	.voice-links {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		font-size: 16px;
	}
	select,
	input {
		width: 100%;
		min-width: 0;
	}
</style>
