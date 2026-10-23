<script lang="ts">
	import { ArrowUpRight, RefreshCw, Check, Copy } from '@lucide/svelte';
	import SearchPicker from './SearchPicker.svelte';
	import { revealMotion } from '#lib/motion.ts';
	import type { Preferences } from '#lib/types.ts';
	import {
		searchConnections,
		type ConnectionModel,
		type ConnectionProvider
	} from '#lib/ai-connections.ts';
	type Account = { id: string; label: string; connected: boolean; planEnabled: boolean };
	let {
		preferences = $bindable(),
		apiKey = $bindable(''),
		providers,
		accountModels,
		chatGPT,
		activeAccount,
		signedIn,
		managedAuth,
		busy,
		loading,
		catalogError,
		authorizationUrl,
		device,
		oncancel,
		oncopycode,
		onselect,
		onaccount,
		onconnect,
		ondisconnect,
		onrefresh,
		onsignin
	}: {
		preferences: Preferences;
		apiKey: string;
		providers: ConnectionProvider[];
		accountModels: ConnectionModel[];
		chatGPT: {
			configured: boolean;
			mode: string;
			hostAdmin?: boolean;
			host?: { model: string } | null;
			safeReason?: string;
			accounts: Account[];
		};
		activeAccount?: Account;
		signedIn: boolean;
		managedAuth: boolean;
		busy: boolean;
		loading: boolean;
		catalogError: string;
		authorizationUrl: string;
		device: { userCode: string; verificationUrl: string; expiresAt: number } | null;
		oncancel: () => void;
		oncopycode: () => void;
		onselect: (id: string) => void;
		onaccount: () => void;
		onconnect: (id?: string, reconsent?: boolean) => void;
		ondisconnect: () => void;
		onrefresh: () => void;
		onsignin: () => void;
	} = $props();
	let hostError = $state('');
	async function setHost(enabled: boolean) {
		hostError = '';
		try {
			const response = await fetch('/api/connections/chatgpt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'host',
					...(enabled ? { accountId: activeAccount?.id, model: preferences.model } : {})
				})
			});
			if (!response.ok) throw new Error((await response.json()).error);
			onrefresh();
		} catch (error) {
			hostError = (error as Error).message;
		}
	}
	let provider = $derived(providers.find((p) => p.id === preferences.provider));
	let subscription = $derived(preferences.provider === 'chatgpt');
	let models = $derived(subscription ? accountModels : provider?.models || []);
	let selectedModel = $derived(models.find((m) => m.id === preferences.model));
	let reasoning = $derived(selectedModel?.reasoning);
	let options = $derived([
		{
			id: 'chatgpt',
			label: 'ChatGPT subscription',
			detail: 'Authorize your ChatGPT plan · no API key'
		},
		...searchConnections(providers, '').map((p) => ({
			id: p.id,
			label: p.name,
			detail: p.supported ? `${p.models.length} models · API key` : 'Integration not yet supported',
			searchText: `${p.id} ${p.models.map((m) => `${m.name} ${m.id}`).join(' ')}`,
			disabled: !p.supported,
			searchOnly: !p.supported
		}))
	]);
	function selectModel(id: string) {
		preferences.model = id;
		preferences.reasoning = undefined;
	}
	function setEffort(value: string) {
		const next = { ...preferences.reasoning };
		if (value) next.effort = value;
		else delete next.effort;
		preferences.reasoning = Object.keys(next).length ? next : undefined;
	}
	function setThinking(value: string) {
		preferences.reasoning = value === '' ? undefined : { enabled: value === 'on' };
	}
	function setBudget(value: string) {
		const next = { ...preferences.reasoning };
		if (value !== '') next.budgetTokens = Number(value);
		else delete next.budgetTokens;
		preferences.reasoning = Object.keys(next).length ? next : undefined;
	}
</script>

<h3 id="ai-connection-heading" tabindex="-1">AI connection</h3>
<p class="muted">Choose what powers your recipes.</p>
{#if !signedIn}
	<p class="field-help">
		{managedAuth
			? 'Sign in through your organization to connect a model.'
			: 'Sign in to save a ChatGPT connection or use an API key.'}
	</p>
	{#if !managedAuth}<button class="secondary" onclick={onsignin}>Sign in to connect</button>{/if}
{/if}
{#if chatGPT.hostAdmin}
	<div class="device-login">
		<h4>Host AI administration</h4>
		<p class="field-help">
			Use one Codex connection and model for every signed-in account on this host, across
			households.
		</p>
		{#if chatGPT.host}<p>Host connection enabled · {chatGPT.host.model}</p>
			<button class="secondary" onclick={() => setHost(false)}>Disable host connection</button>
		{:else}<p class="field-help">
				Connect ChatGPT with a device code below and choose its model, then enable sharing.
			</p>
			<button
				class="secondary"
				disabled={busy ||
					!subscription ||
					!activeAccount?.connected ||
					activeAccount.id === 'host-chatgpt' ||
					!preferences.model}
				onclick={() => setHost(true)}>Use selected connection for this host</button
			>{/if}
		{#if hostError}<p class="error" role="alert">{hostError}</p>{/if}
	</div>
{/if}
{#if chatGPT.host}<p class="field-help">
		AI is provided by this host. Model: {chatGPT.host.model}.
	</p>{/if}
<SearchPicker
	label="Connection"
	placeholder={loading ? 'Loading connections…' : 'Search providers or models…'}
	{options}
	value={preferences.provider}
	fallback={preferences.provider === 'chatgpt' ? 'ChatGPT subscription' : preferences.provider}
	{onselect}
/>
{#if catalogError}<p class="error" role="alert">{catalogError}</p>
	<button class="text-button" onclick={onrefresh}
		><RefreshCw size={15} /> Retry model catalog</button
	>{/if}
{#if loading}<p class="field-help" role="status">Loading model catalog…</p>{/if}

{#key preferences.provider}
	<div class="connection-setup" in:revealMotion>
		{#if subscription}
			<div class="plan-status">
				<span
					class="connection-status"
					class:connected={activeAccount?.connected && activeAccount?.planEnabled}
				>
					{#if activeAccount?.connected && activeAccount.planEnabled}<Check size={16} /> Connected
					{:else if activeAccount?.connected}Plan access needed{:else}Not connected{/if}
				</span>
			</div>
			{#if chatGPT.accounts.length}
				<label class="field"
					>ChatGPT account<select
						bind:value={preferences.chatgptAccountId}
						onchange={onaccount}
						disabled={busy}
					>
						{#each chatGPT.accounts as account}<option value={account.id}
								>{account.label}{!account.connected
									? ' · reconnect'
									: !account.planEnabled
										? ' · plan disabled'
										: ''}</option
							>{/each}
					</select></label
				>
			{/if}
			{#if activeAccount?.id !== 'host-chatgpt'}
				<div class="connection-actions">
					<button
						class="primary"
						disabled={busy || !signedIn || !chatGPT.configured}
						onclick={() => onconnect(activeAccount?.id)}
					>
						{busy
							? 'Connecting…'
							: activeAccount
								? 'Reconnect with ChatGPT'
								: 'Continue with ChatGPT'}<ArrowUpRight size={17} />
					</button>
					{#if activeAccount}<button
							class="secondary"
							disabled={busy || !signedIn || !chatGPT.configured}
							onclick={() => onconnect()}>Add account</button
						>{/if}
					{#if activeAccount?.connected && !activeAccount.planEnabled}<button
							class="secondary"
							disabled={busy || !chatGPT.configured}
							onclick={() => onconnect(activeAccount?.id, true)}>Enable plan usage</button
						>{/if}
				</div>
			{/if}
			{#if device}
				<div class="device-login" in:revealMotion role="status">
					<p>Open ChatGPT and enter this code:</p>
					<div class="device-code-row">
						<code>{device.userCode}</code><button
							class="text-button"
							onclick={oncopycode}
							aria-label="Copy ChatGPT authorization code"><Copy size={18} /></button
						>
					</div>
					<div class="connection-actions">
						<a
							class="primary"
							href={device.verificationUrl}
							target="_blank"
							rel="noopener noreferrer">Open ChatGPT <ArrowUpRight size={17} /></a
						><button class="secondary" onclick={oncancel}>Cancel</button>
					</div>
					<p class="field-help">Waiting for approval. This code expires in 15 minutes.</p>
				</div>
			{:else if chatGPT.mode === 'device'}
				<p class="field-help">
					Connect in your browser with a one-time code. No API key or installation needed.
				</p>
			{/if}
			{#if chatGPT.mode === 'local'}<p class="field-help">
					Complete ChatGPT authorization in your browser. Flavorithm handles the connection.
				</p>
			{:else if !chatGPT.configured && signedIn}<p class="field-help" role="status">
					{chatGPT.safeReason ||
						'Unable to load authorization options. Retry the connection settings.'}
				</p>{/if}
			{#if authorizationUrl}<a
					class="text-button auth-fallback"
					href={authorizationUrl}
					target="_blank"
					rel="noreferrer noopener">Open ChatGPT authorization <ArrowUpRight size={16} /></a
				>{/if}
			{#if activeAccount?.connected && activeAccount.id !== 'host-chatgpt'}
				<div class="connection-actions">
					<a
						class="text-button"
						href="https://chatgpt.com/settings/usage"
						target="_blank"
						rel="noreferrer">Manage plan usage <ArrowUpRight size={15} /></a
					>
					<button class="text-button danger" disabled={busy} onclick={ondisconnect}
						>Disconnect</button
					>
				</div>
			{/if}
		{:else if provider?.supported}
			<label class="field"
				>{provider.name} API key<input
					type="password"
					autocomplete="off"
					spellcheck="false"
					placeholder={provider.apiKeyHint || 'Your provider API key'}
					bind:value={apiKey}
					disabled={!signedIn}
				/></label
			>
			<p class="field-help">
				Kept in memory for this tab. Uses {provider.name} API billing.{#if provider.documentation}
					<a href={provider.documentation} target="_blank" rel="noreferrer"
						>Provider setup <ArrowUpRight size={13} /></a
					>{/if}
			</p>
		{:else if provider}<p class="field-help">
				This provider requires an integration Flavorithm does not support yet. Choose another
				connection.
			</p>{/if}
	</div>
{/key}

{#if (subscription && activeAccount?.connected && activeAccount.planEnabled) || (!subscription && provider?.supported)}
	<SearchPicker
		label="Model"
		placeholder="Search this provider’s models…"
		options={models.map((model) => ({
			id: model.id,
			label: model.name,
			detail: `${model.id}${model.vision ? ' · image input' : ''}${model.reasoning ? ' · reasoning' : ''}`
		}))}
		value={preferences.model}
		fallback={preferences.model}
		onselect={selectModel}
		disabled={!signedIn || !models.length}
	/>
	{#if subscription}<button class="text-button" disabled={loading || busy} onclick={onrefresh}
			><RefreshCw size={15} /> Refresh account models</button
		>{/if}
	{#if selectedModel && !selectedModel.vision}<p class="field-help">
			This model accepts text only. Choose a model with image input to import photos.
		</p>{/if}
	{#if reasoning}
		<div class="reasoning-fields" in:revealMotion>
			{#if reasoning.toggle}<label class="field"
					>Thinking<select
						value={preferences.reasoning?.enabled === undefined
							? ''
							: preferences.reasoning.enabled
								? 'on'
								: 'off'}
						onchange={(event) => setThinking(event.currentTarget.value)}
						><option value="">Model default</option><option value="on">On</option><option
							value="off">Off</option
						></select
					></label
				>{/if}
			{#if reasoning.efforts.length}<label class="field"
					>Reasoning level<select
						value={preferences.reasoning?.effort || ''}
						disabled={preferences.reasoning?.enabled === false}
						onchange={(event) => setEffort(event.currentTarget.value)}
						><option value="">Model default</option>{#each reasoning.efforts as effort}<option
								value={effort}
								>{effort === 'xhigh'
									? 'Extra high'
									: effort.charAt(0).toUpperCase() + effort.slice(1)}</option
							>{/each}</select
					></label
				>{/if}
			{#if reasoning.budgetMin !== undefined}<label class="field"
					>Thinking budget (tokens)<input
						type="number"
						min={reasoning.budgetMin}
						max={reasoning.budgetMax}
						step="1"
						placeholder="Model default"
						value={preferences.reasoning?.budgetTokens ?? ''}
						disabled={preferences.reasoning?.enabled === false}
						onchange={(event) => setBudget(event.currentTarget.value)}
					/></label
				>{/if}
		</div>
	{/if}
{/if}
<p class="catalog-credit">
	Provider and model options from <a href="https://models.dev" target="_blank" rel="noreferrer"
		>models.dev <ArrowUpRight size={13} /></a
	>. ChatGPT models come from your connected account.
</p>

<style>
	.connection-setup {
		min-width: 0;
	}
	.plan-status {
		margin-top: 8px;
	}
	.connection-status {
		display: inline-flex;
		gap: 7px;
		align-items: center;
		font-size: 15px;
	}
	.device-login {
		margin-block: 20px;
		padding-block: 16px;
		border-block: 1px solid var(--line);
	}
	.device-code-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-block: 12px;
	}
	.device-code-row code {
		font-size: clamp(22px, 6vw, 30px);
		font-weight: 700;
		letter-spacing: 0.08em;
		user-select: all;
		overflow-wrap: anywhere;
	}
	.device-login .primary {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		text-decoration: none;
	}
	.reasoning-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 0 16px;
		margin-top: 12px;
	}
	.auth-fallback {
		margin-top: 14px;
	}
	.field-help a,
	.catalog-credit a {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.field-help a {
		margin-inline-start: 4px;
	}
	.catalog-credit {
		color: var(--muted);
		font-size: 14px;
		line-height: 1.65;
		margin-top: 20px;
	}
	@media (max-width: 480px) {
		:global(.intelligence-settings .connection-actions > .primary),
		:global(.intelligence-settings .connection-actions > .secondary) {
			width: 100%;
			justify-content: center;
			min-height: 46px;
		}
	}
</style>
