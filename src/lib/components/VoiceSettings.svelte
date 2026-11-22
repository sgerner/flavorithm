<script lang="ts">
	import { voiceProviders, type VoiceProvider } from '#lib/voice-config.ts';
	import { revealMotion } from '#lib/motion.ts';
	let {
		provider = $bindable('auto'),
		model = $bindable(''),
		apiKey = $bindable(''),
		localAvailable,
		checking = false,
		userId
	}: {
		provider: VoiceProvider;
		model: string;
		apiKey: string;
		localAvailable: boolean;
		checking?: boolean;
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

<h3 id="voice-settings-heading" tabindex="-1">Voice input</h3>
<label class="field"
	>Transcription<select bind:value={provider} onchange={change} disabled={!userId}>
		{#each voiceProviders as option}<option value={option.id}>{option.name}</option>{/each}
	</select></label
>
<p class="field-help">{selected.help}</p>
{#if !userId}<p class="field-help">
		Sign in to configure voice transcription. Browser dictation remains available.
	</p>{/if}
<p
	class="field-help"
	class:visually-hidden={provider !== 'auto' && !(provider === 'local' && !localAvailable)}
	role="status"
	aria-live="polite"
	aria-atomic="true"
>
	{#if checking && (provider === 'auto' || provider === 'local')}
		Checking local Whisper availability…
	{:else if provider === 'auto'}
		{localAvailable
			? 'Local Whisper is available and will be used.'
			: 'No local service configured. Select Groq or Deepgram to use voice in Firefox.'}
	{:else if provider === 'local' && !localAvailable}
		Ask the server operator to configure a Whisper endpoint. <a
			href="https://github.com/sgerner/flavorithm/blob/main/docs/voice-input.md"
			target="_blank"
			rel="noopener noreferrer">Setup guide</a
		>
	{:else if provider === 'local'}
		Local Whisper is available and selected.
	{:else}
		{selected.name} transcription selected.
	{/if}
</p>
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
