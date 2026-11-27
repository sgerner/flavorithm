<script lang="ts">
	import { ArrowUpRight, RefreshCw, Check, Copy } from '@lucide/svelte';
	import FormField from './FormField.svelte';
	import SearchPicker from './SearchPicker.svelte';
	import { describeBy } from '#lib/form-validation.ts';
	import { revealMotion } from '#lib/motion.ts';
	import type { Preferences } from '#lib/types.ts';
	import {
		HOST_CONNECTION_ID,
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
		onsignin,
		onoverride
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
		onoverride?: (enabled: boolean) => void;
	} = $props();
	let hostError = $state('');
	let sawCatalogLoading = $state(false);
	$effect(() => {
		if (loading) sawCatalogLoading = true;
	});
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
	let personalAccounts = $derived(chatGPT.accounts.filter((a) => a.id !== HOST_CONNECTION_ID));
	let usingHost = $derived(Boolean(chatGPT.host && !preferences.usePersonalAI));
	let provider = $derived(providers.find((p) => p.id === preferences.provider));
	let subscription = $derived(preferences.provider === 'chatgpt');
	let models = $derived(subscription ? accountModels : provider?.models || []);
	let selectedModel = $derived(models.find((m) => m.id === preferences.model));
	let reasoning = $derived(selectedModel?.reasoning);
	function togglePersonalOverride(enabled: boolean) {
		preferences.usePersonalAI = enabled ? true : undefined;
		onoverride?.(enabled);
	}
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
	<p class="field-help" id="ai-signin-help">
		{managedAuth
			? 'Sign in through your organization to connect a model.'
			: 'Sign in to save a ChatGPT connection or use an API key.'}
	</p>
	{#if !managedAuth}<button class="secondary" onclick={onsignin}>Sign in to connect</button>{/if}
{/if}
{#if chatGPT.hostAdmin}
	<div class="device-login">
		<h4>Host AI administration</h4>
		<p class="muted">
			Use one Codex connection and model for every signed-in account on this host, across
			households.
		</p>
		{#if chatGPT.host}<p>Host connection enabled · {chatGPT.host.model}</p>
			<button class="secondary" onclick={() => setHost(false)}>Disable host connection</button>
		{:else}<p class="muted">
				Connect ChatGPT with a device code below and choose its model, then enable sharing.
			</p>
			<button
				class="secondary"
				disabled={busy ||
					!subscription ||
					!activeAccount?.connected ||
					activeAccount.id === HOST_CONNECTION_ID ||
					!preferences.model}
				onclick={() => setHost(true)}>Use selected connection for this host</button
			>{/if}
		{#if hostError}<p class="error" role="alert">{hostError}</p>{/if}
	</div>
{/if}
{#if chatGPT.host}
	<div class="host-default-banner">
		<div class="plan-status" role="status" aria-live="polite" aria-atomic="true">
			<span class="connection-status" class:connected={usingHost}>
				{#if usingHost}<Check size={16} aria-hidden="true" /> Host ChatGPT connection active by default{:else}Personal
					AI override active{/if}
			</span>
		</div>
		<p class="field-help" id="ai-host-help">
			{#if usingHost}
				AI is provided by this host by default. Your saved personal connection and reasoning
				settings remain unchanged.
			{:else}
				Requests use your personal connection below instead of shared host AI ({chatGPT.host
					.model}).
			{/if}
		</p>
		{#if signedIn}
			<label class="host-override" for="ai-host-override">
				<input
					id="ai-host-override"
					type="checkbox"
					aria-describedby="ai-host-override-help"
					aria-invalid="false"
					checked={Boolean(preferences.usePersonalAI)}
					onchange={(event) => togglePersonalOverride(event.currentTarget.checked)}
				/>
				<span>
					<b>Use a personal AI connection instead</b>
					<small id="ai-host-override-help"
						>Unlock your own API key or ChatGPT subscription without changing shared host settings.</small
					>
				</span>
			</label>
		{/if}
	</div>
{/if}
{#if usingHost}
	<FormField
		id="ai-host-connection"
		label="Connection"
		helpIds={[!signedIn ? 'ai-signin-help' : undefined, 'ai-host-help']}
	>
		{#snippet children(field)}
			<input
				type="text"
				class="readonly-input"
				value="Host ChatGPT connection"
				readonly
				{...field}
			/>
		{/snippet}
	</FormField>
{:else}
	<SearchPicker
		label="Connection"
		placeholder={loading ? 'Loading connections…' : 'Search providers or models…'}
		{options}
		value={preferences.provider}
		fallback={preferences.provider === 'chatgpt' ? 'ChatGPT subscription' : preferences.provider}
		describedBy={describeBy(
			!signedIn ? 'ai-signin-help' : undefined,
			chatGPT.host ? 'ai-host-help' : undefined,
			loading ? 'ai-catalog-loading-help' : undefined,
			subscription && !device && chatGPT.mode === 'device' ? 'ai-device-mode-help' : undefined,
			subscription && chatGPT.mode === 'local' ? 'ai-local-mode-help' : undefined,
			subscription && chatGPT.mode !== 'local' && !chatGPT.configured && signedIn
				? 'ai-unconfigured-help'
				: undefined,
			!subscription && provider && !provider.supported ? 'ai-unsupported-provider-help' : undefined
		)}
		{onselect}
	/>
	{#if catalogError}<p class="error" role="alert">{catalogError}</p>
		<button class="text-button" onclick={onrefresh}
			><RefreshCw size={15} /> Retry model catalog</button
		>{/if}
{/if}
<p
	id="ai-catalog-loading-help"
	class="field-help"
	class:visually-hidden={usingHost || !loading}
	role="status"
	aria-live="polite"
	aria-atomic="true"
>
	{usingHost
		? ''
		: loading
			? 'Loading model catalog…'
			: sawCatalogLoading && !catalogError
				? 'Model catalog ready.'
				: ''}
</p>

<div
	class="plan-status"
	class:visually-hidden={usingHost || !subscription}
	role="status"
	aria-live="polite"
	aria-atomic="true"
>
	<span
		class="connection-status"
		class:connected={!usingHost &&
			subscription &&
			Boolean(activeAccount?.connected && activeAccount?.planEnabled && models.length > 0)}
	>
		{#if !usingHost}
			{#if subscription}
				{#if device}Waiting for approval<span class="visually-hidden">
						· Enter code {device.userCode} in ChatGPT</span
					>
				{:else if busy}Connecting…
				{:else if !chatGPT.configured && signedIn}Not connected<span class="visually-hidden">
						· {chatGPT.safeReason ||
							'Unable to load authorization options. Retry the connection settings.'}</span
					>
				{:else if activeAccount?.connected && activeAccount.planEnabled}
					{#if models.length > 0}<Check size={16} aria-hidden="true" /> Connected
					{:else if loading}Checking connection…
					{:else}Model catalog unavailable{/if}
				{:else if activeAccount?.connected}Plan access needed{:else}Not connected{/if}
			{:else if provider?.supported}
				{provider.name} selected. Enter an API key and model.
			{:else if provider}
				{provider.name} integration is not yet supported.
			{/if}
		{/if}
	</span>
</div>

{#if !usingHost}
	{#key preferences.provider}
		<div class="connection-setup" in:revealMotion>
			{#if subscription}
				{#if personalAccounts.length}
					<FormField id="ai-chatgpt-account" label="ChatGPT account">
						{#snippet children(field)}
							<select
								bind:value={preferences.chatgptAccountId}
								onchange={onaccount}
								disabled={busy}
								{...field}
							>
								{#each personalAccounts as account}<option value={account.id}
										>{account.label}{!account.connected
											? ' · reconnect'
											: !account.planEnabled
												? ' · plan disabled'
												: ''}</option
									>{/each}
							</select>
						{/snippet}
					</FormField>
				{/if}
				{#if activeAccount?.id !== HOST_CONNECTION_ID}
					<div class="connection-actions">
						<button
							class="primary"
							disabled={busy || !signedIn || !chatGPT.configured}
							aria-busy={busy}
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
					<div class="device-login" in:revealMotion>
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
						<p class="muted">Waiting for approval. This code expires in 15 minutes.</p>
					</div>
				{:else if chatGPT.mode === 'device'}
					<p class="field-help" id="ai-device-mode-help">
						Connect in your browser with a one-time code. No API key or installation needed.
					</p>
				{/if}
				{#if chatGPT.mode === 'local'}<p class="field-help" id="ai-local-mode-help">
						Complete ChatGPT authorization in your browser. Flavorithm handles the connection.
					</p>
				{:else if !chatGPT.configured && signedIn}<p class="field-help" id="ai-unconfigured-help">
						{chatGPT.safeReason ||
							'Unable to load authorization options. Retry the connection settings.'}
					</p>{/if}
				{#if authorizationUrl}<a
						class="text-button auth-fallback"
						href={authorizationUrl}
						target="_blank"
						rel="noreferrer noopener">Open ChatGPT authorization <ArrowUpRight size={16} /></a
					>{/if}
				{#if activeAccount?.connected && activeAccount.id !== HOST_CONNECTION_ID}
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
				<FormField id="ai-provider-api-key" label={`${provider.name} API key`}>
					{#snippet children(field)}
						<input
							type="password"
							autocomplete="off"
							spellcheck="false"
							placeholder={provider.apiKeyHint || 'Your provider API key'}
							bind:value={apiKey}
							disabled={!signedIn}
							{...field}
						/>
					{/snippet}
					{#snippet helpSnippet(helpId)}
						<p class="field-help" id={helpId}>
							Kept in memory for this tab. Uses {provider.name} API billing.{#if provider.documentation}
								<a href={provider.documentation} target="_blank" rel="noreferrer"
									>Provider setup <ArrowUpRight size={13} /></a
								>{/if}
						</p>
					{/snippet}
				</FormField>
			{:else if provider}<p class="field-help" id="ai-unsupported-provider-help">
					This provider requires an integration Flavorithm does not support yet. Choose another
					connection.
				</p>{/if}
		</div>
	{/key}
{/if}

{#if usingHost}
	<FormField
		id="ai-host-model"
		label="Model"
		help="Managed by the host administrator. Turn on a personal AI connection above to choose your own model or reasoning settings."
	>
		{#snippet children(field)}
			<input type="text" class="readonly-input" value={chatGPT.host!.model} readonly {...field} />
		{/snippet}
	</FormField>
{:else if (subscription && activeAccount?.connected && activeAccount.planEnabled && models.length > 0) || (!subscription && provider?.supported)}
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
		describedBy={selectedModel && !selectedModel.vision ? 'ai-model-vision-help' : undefined}
		onselect={selectModel}
		disabled={!signedIn || !models.length}
	/>
	{#if subscription}<button
			class="text-button"
			disabled={loading || busy}
			aria-busy={loading}
			onclick={onrefresh}><RefreshCw size={15} /> Refresh account models</button
		>{/if}
	{#if selectedModel && !selectedModel.vision}<p class="field-help" id="ai-model-vision-help">
			This model accepts text only. Choose a model with image input to import photos.
		</p>{/if}
	{#if reasoning}
		<div class="reasoning-fields" in:revealMotion>
			{#if reasoning.toggle}<FormField id="ai-thinking" label="Thinking">
					{#snippet children(field)}
						<select
							value={preferences.reasoning?.enabled === undefined
								? ''
								: preferences.reasoning.enabled
									? 'on'
									: 'off'}
							onchange={(event) => setThinking(event.currentTarget.value)}
							{...field}
							><option value="">Model default</option><option value="on">On</option><option
								value="off">Off</option
							></select
						>
					{/snippet}
				</FormField>{/if}
			{#if reasoning.efforts.length}<FormField id="ai-reasoning-level" label="Reasoning level">
					{#snippet children(field)}
						<select
							value={preferences.reasoning?.effort || ''}
							disabled={preferences.reasoning?.enabled === false}
							onchange={(event) => setEffort(event.currentTarget.value)}
							{...field}
							><option value="">Model default</option>{#each reasoning.efforts as effort}<option
									value={effort}
									>{effort === 'xhigh'
										? 'Extra high'
										: effort.charAt(0).toUpperCase() + effort.slice(1)}</option
								>{/each}</select
						>
					{/snippet}
				</FormField>{/if}
			{#if reasoning.budgetMin !== undefined}<FormField
					id="ai-thinking-budget"
					label="Thinking budget (tokens)"
				>
					{#snippet children(field)}
						<input
							type="number"
							min={reasoning.budgetMin}
							max={reasoning.budgetMax}
							step="1"
							placeholder="Model default"
							value={preferences.reasoning?.budgetTokens ?? ''}
							disabled={preferences.reasoning?.enabled === false}
							onchange={(event) => setBudget(event.currentTarget.value)}
							{...field}
						/>
					{/snippet}
				</FormField>{/if}
		</div>
	{/if}
{:else if subscription && activeAccount?.connected && activeAccount.planEnabled && !catalogError}
	<button class="text-button" disabled={loading || busy} onclick={onrefresh}
		><RefreshCw size={15} /> Refresh account models</button
	>
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
	.host-default-banner .plan-status {
		margin-top: 0;
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
