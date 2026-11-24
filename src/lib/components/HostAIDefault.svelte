<script lang="ts">
	import { Check } from '@lucide/svelte';

	let {
		host,
		signedIn,
		usingHost,
		usePersonalAI,
		ontoggle
	}: {
		host?: { model: string } | null;
		signedIn: boolean;
		usingHost: boolean;
		usePersonalAI: boolean;
		ontoggle: (enabled: boolean) => void;
	} = $props();
</script>

{#if host}
	<div class="host-default-banner">
		<div class="plan-status">
			<span class="connection-status" class:connected={usingHost}>
				{#if usingHost}<Check size={16} /> Host ChatGPT connection active by default{:else}Personal
					AI override active{/if}
			</span>
		</div>
		<p class="field-help">
			{#if usingHost}
				AI is provided by this host by default. Your saved personal connection and reasoning
				settings remain unchanged.
			{:else}
				Requests use your personal connection below instead of shared host AI ({host.model}).
			{/if}
		</p>
		{#if signedIn}
			<label class="host-override">
				<input
					type="checkbox"
					checked={usePersonalAI}
					onchange={(event) => ontoggle(event.currentTarget.checked)}
				/>
				<span>
					<b>Use a personal AI connection instead</b>
					<small
						>Unlock your own API key or ChatGPT subscription without changing shared host settings.</small
					>
				</span>
			</label>
		{/if}
	</div>
	{#if usingHost}
		<label class="field"
			>Connection<input
				type="text"
				class="readonly-input"
				value="Host ChatGPT connection"
				readonly
			/></label
		>
		<label class="field"
			>Model<input type="text" class="readonly-input" value={host.model} readonly /></label
		>
		<p class="field-help">
			Managed by the host administrator. Turn on a personal AI connection above to choose your own
			model or reasoning settings.
		</p>
	{/if}
{/if}

<style>
	.plan-status {
		margin-top: 0;
	}
	.connection-status {
		display: inline-flex;
		gap: 7px;
		align-items: center;
		font-size: 15px;
	}
	.connection-status.connected {
		color: var(--green);
		font-weight: 600;
	}
	.host-default-banner {
		margin-block: 16px;
		padding: 14px 16px;
		background: var(--wash);
		border-left: 3px solid var(--green);
	}
	.host-default-banner .field-help {
		margin: 6px 0 0;
	}
	.host-override {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin-top: 14px;
		font-size: 14px;
		cursor: pointer;
	}
	.host-override input {
		width: 20px;
		height: 20px;
		flex: 0 0 20px;
		margin-top: 2px;
		accent-color: var(--green);
	}
	.host-override span {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.host-override small {
		color: var(--muted);
		line-height: 1.5;
	}
	.readonly-input {
		background: var(--wash);
		color: var(--muted);
		cursor: default;
	}
</style>
