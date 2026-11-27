<script lang="ts">
	import FormField from './FormField.svelte';
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
	let showLocalMissing = $derived(provider === 'local' && !localAvailable);
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
<FormField
	id="voice-provider"
	label="Transcription"
	help={selected.help}
	helpIds={[
		!userId ? 'voice-signin-help' : undefined,
		provider === 'auto' ? 'voice-auto-help' : undefined,
		showLocalMissing ? 'voice-local-help' : undefined
	]}
>
	{#snippet children(field)}
		<select bind:value={provider} onchange={change} disabled={!userId} {...field}>
			{#each voiceProviders as option}<option value={option.id}>{option.name}</option>{/each}
		</select>
	{/snippet}
</FormField>
{#if !userId}<p class="field-help" id="voice-signin-help">
		Sign in to configure voice transcription. Browser dictation remains available.
	</p>{/if}
<p
	id={provider === 'auto'
		? 'voice-auto-help'
		: showLocalMissing
			? 'voice-local-help'
			: 'voice-status-help'}
	class="field-help"
	class:visually-hidden={provider !== 'auto' && !showLocalMissing}
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
	{:else if showLocalMissing}
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
		<FormField id="voice-model" label="Voice model">
			{#snippet children(field)}
				<select bind:value={model} onchange={save} {...field}
					>{#each selected.models as item}<option value={item}>{item}</option>{/each}</select
				>
			{/snippet}
		</FormField>
		<FormField
			id="voice-api-key"
			label="Voice API key"
			help={`Key stays in this tab until you reload or sign out. Recordings are sent to ${selected.name} for transcription.`}
		>
			{#snippet children(field)}
				<input
					type="password"
					bind:value={apiKey}
					autocomplete="off"
					spellcheck="false"
					placeholder="Paste your provider API key"
					{...field}
				/>
			{/snippet}
		</FormField>
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
