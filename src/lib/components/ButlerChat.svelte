<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		X,
		Send,
		Check,
		RotateCcw,
		LoaderCircle,
		Square,
		Plus,
		Trash2,
		Pencil,
		ArrowRight
	} from '@lucide/svelte';
	import BasilAvatar from './BasilAvatar.svelte';
	import ChatMarkdown from './ChatMarkdown.svelte';
	import {
		createButlerChat,
		type ButlerChatAction as Action,
		type ButlerChatMessage as Message,
		type ButlerChatResult,
		type ButlerTurn as Turn
	} from '#lib/butler-chat.ts';
	import { focusTrap } from '#lib/focus.ts';
	import type { AppState, Recipe } from '#lib/types.ts';

	let {
		kitchen,
		owner,
		request,
		apply,
		userName = '',
		syncing = false,
		pendingSync = false,
		open = $bindable(false)
	}: {
		kitchen: AppState;
		owner: string;
		userName?: string;
		syncing?: boolean;
		pendingSync?: boolean;
		open?: boolean;
		request: (
			prompt: string,
			history: Turn[],
			signal?: AbortSignal,
			recipeDrafts?: Recipe[]
		) => Promise<ButlerChatResult>;
		apply: (commands: unknown[], expectedSnapshot: string) => string | Promise<string>;
	} = $props();
	let recipeDrafts = $state<Recipe[]>([]);
	let viewportStyle = $state('');
	$effect(() => {
		if (!open) return;
		const viewport = window.visualViewport;
		if (!viewport) return;
		const update = () => {
			viewportStyle = `--chat-viewport-height: ${viewport.height}px; --chat-viewport-bottom: ${Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height)}px`;
		};
		update();
		viewport.addEventListener('resize', update);
		viewport.addEventListener('scroll', update);
		window.addEventListener('resize', update);
		return () => {
			viewport.removeEventListener('resize', update);
			viewport.removeEventListener('scroll', update);
			window.removeEventListener('resize', update);
		};
	});
	let draft = $state('');
	let messages = $state<Message[]>([]);
	let busy = $state(false);
	let applying = $state('');
	let error = $state('');
	let failedPrompt = $state('');
	let input = $state<HTMLTextAreaElement>();
	let transcript = $state<HTMLDivElement>();
	let launcher = $state<HTMLButtonElement>();
	let currentOwner = '';
	let reaction = $state<'idle' | 'speaking' | 'pleased'>('idle');
	let reactionTimer: ReturnType<typeof setTimeout> | undefined;
	const working = $derived(busy || !!applying);
	const mood = $derived(working ? 'thinking' : error ? 'concerned' : reaction);
	const address = $derived(
		userName.trim() ? `Master ${userName.trim().slice(0, 80)}` : 'master of the house'
	);
	const status = $derived(
		working ? 'Attending to it…' : error ? 'A minor complication.' : 'Your kitchen, in hand.'
	);
	function react(value: 'speaking' | 'pleased', duration: number) {
		clearTimeout(reactionTimer);
		reaction = value;
		reactionTimer = setTimeout(() => {
			reaction = 'idle';
		}, duration);
	}
	function resetReaction() {
		clearTimeout(reactionTimer);
		reaction = 'idle';
	}
	const starters = [
		{ label: 'Plan my week', prompt: 'Plan dinners for the week using my pantry.' },
		{ label: 'Create a recipe', prompt: 'Help me build a recipe from scratch.' },
		{ label: 'Review my recipes', prompt: 'Review my recipes. Be honest.' }
	];
	const chat = createButlerChat({
		getKitchen: () => kitchen,
		getOwner: () => owner,
		isWorking: () => working,
		getDraft: () => draft,
		setDraft: (value) => {
			draft = value;
		},
		getMessages: () => messages,
		setMessages: (value) => {
			messages = value;
		},
		getRecipeDrafts: () => recipeDrafts,
		setRecipeDrafts: (value) => {
			recipeDrafts = value;
		},
		setBusy: (value) => {
			busy = value;
		},
		setError: (value) => {
			error = value;
		},
		getFailedPrompt: () => failedPrompt,
		setFailedPrompt: (value) => {
			failedPrompt = value;
		},
		request: (prompt, history, signal, drafts) => request(prompt, history, signal, drafts),
		onSpeak: (duration) => react('speaking', duration),
		onResetReaction: resetReaction,
		onScroll: () => void scroll()
	});
	$effect(() => {
		if (owner !== currentOwner) {
			currentOwner = owner;
			chat.cancelRequest();
			messages = [];
			recipeDrafts = [];
			draft = '';
			error = '';
			failedPrompt = '';
			applying = '';
			open = false;
		}
	});
	onDestroy(() => {
		chat.destroy();
	});
	async function scroll() {
		await tick();
		transcript?.scrollTo({
			top: transcript.scrollHeight,
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
		});
	}
	export async function close() {
		resetReaction();
		open = false;
		await tick();
		launcher?.focus();
	}
	async function toggle() {
		open = !open;
		if (open) {
			await tick();
			input?.focus();
		} else {
			await tick();
			launcher?.focus();
		}
	}
	function clear() {
		chat.clear();
		input?.focus();
	}
	function send(prompt = draft.trim()) {
		return chat.send(prompt);
	}
	async function stop() {
		chat.stop();
		await tick();
		input?.focus();
	}
	async function applyAction(message: Message, action: Action) {
		if (working || action.status !== 'pending' || !message.snapshot) return;
		const token = chat.generation;
		const activeOwner = owner;
		applying = `${message.id}:${action.id}`;
		error = '';
		await tick();
		if (!chat.alive || token !== chat.generation || activeOwner !== owner) return;
		try {
			if (message.snapshot !== JSON.stringify(kitchen))
				throw new Error('Your kitchen changed. Ask Basil for an updated proposal.');
			const snapshot = await apply(action.commands, message.snapshot);
			if (!chat.alive || token !== chat.generation) return;
			message.snapshot = snapshot;
			const savedIds = action.commands.flatMap((command) =>
				command.type === 'recipe.upsert' ? [command.recipe.id] : []
			);
			recipeDrafts = recipeDrafts.filter((recipe) => !savedIds.includes(recipe.id));
			action.status = 'applied';
			react('pleased', 2200);
		} catch (e) {
			if (chat.alive && token === chat.generation)
				error = e instanceof Error ? e.message : 'The changes could not be applied.';
		} finally {
			if (chat.alive && token === chat.generation) applying = '';
		}
	}
	function words(value: string) {
		return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ');
	}

	function preview(command: unknown): string {
		function format(value: unknown, depth = 0): string {
			if (Array.isArray(value))
				return value.map((item, i) => `${i + 1}. ${format(item, depth)}`).join('\n');
			if (value && typeof value === 'object')
				return Object.entries(value)
					.filter(([key]) => key !== 'type' && key !== 'id' && key !== 'image')
					.map(([key, item]) => {
						if (key === 'recipeId')
							return `Recipe: ${kitchen.recipes.find((recipe) => recipe.id === item)?.title ?? String(item)}`;
						return `${words(key)}: ${typeof item === 'object' ? '\n' : ''}${format(item, depth + 1)}`;
					})
					.join('\n');
			return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value ?? '');
		}
		const record = command as Record<string, unknown>;
		const target = record?.id;
		const name =
			kitchen.recipes.find((item) => item.id === target)?.title ??
			kitchen.pantry.find((item) => item.id === target)?.name ??
			kitchen.shopping.find((item) => item.id === target)?.name;
		return [name, format(command)].filter(Boolean).join('\n') || 'Kitchen update';
	}
</script>

<button
	class="butler-launcher"
	class:waiting={busy || syncing}
	bind:this={launcher}
	onclick={toggle}
	aria-expanded={open}
	aria-controls="butler-panel"
	aria-label={open ? 'Close Basil chat' : 'Chat with Basil, your kitchen butler'}
	title="Chat with Basil"
>
	<BasilAvatar {mood} size={32} active={open} /><span>Basil</span>
	{#if busy || syncing}<LoaderCircle size={13} class="spin launcher-spinner" />{/if}
</button>

{#if open}
	<div
		class="butler-panel"
		style={viewportStyle}
		id="butler-panel"
		use:focusTrap
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		aria-label="Chat with Basil"
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				event.preventDefault();
				close();
			}
		}}
	>
		<header>
			<BasilAvatar {mood} size={46} active={open} />
			<div class="butler-heading">
				<h2>Basil</h2>
				<p>{status}</p>
			</div>
			<button
				class="icon-button"
				onclick={clear}
				disabled={working || messages.length === 0}
				aria-label="Clear conversation"
				title="Clear conversation"><RotateCcw size={17} /></button
			>
			<button class="icon-button" onclick={close} aria-label="Close chat"><X size={20} /></button>
		</header>
		{#if busy || syncing}<div class="request-progress" aria-hidden="true"></div>{/if}
		<div
			class="butler-transcript"
			bind:this={transcript}
			role="log"
			aria-label="Conversation"
			aria-live="polite"
			aria-relevant="additions text"
			aria-busy={working}
		>
			{#if messages.length === 0}
				<div class="butler-introduction">
					<p>At your service, {address}. Shall we impose some order upon dinner?</p>
				</div>
				<div class="butler-starters">
					{#each starters as starter}<button
							onclick={() => send(starter.prompt)}
							disabled={working || !owner}>{starter.label}<ArrowRight size={14} /></button
						>{/each}
				</div>
			{/if}
			{#each messages as message (message.id)}
				<article class:user-message={message.role === 'user'} class="butler-message">
					<span class="speaker">{message.role === 'user' ? 'You' : 'Basil'}</span>
					{#if message.role === 'assistant'}<ChatMarkdown content={message.content} />{:else}<p
							class="user-content"
						>
							{message.content}
						</p>{/if}
					{#if message.actions?.length}
						<div class="butler-actions">
							{#each message.actions as action (action.id)}
								<section
									class="action-card"
									class:action-applied={action.status === 'applied'}
									class:action-dismissed={action.status === 'dismissed'}
									aria-label={action.title}
								>
									<div class="action-info">
										<strong>{action.title}</strong>
										<p>{action.summary}</p>
									</div>
									<details>
										<summary>Details</summary>
										<div class="action-details">
											{#each action.commands as command}<pre>{preview(command)}</pre>{/each}
										</div>
									</details>
									{#if action.status === 'pending'}
										<div class="action-controls">
											<button
												class="butler-primary action-button"
												class:destructive={action.destructive}
												onclick={() => applyAction(message, action)}
												disabled={working || message.snapshot !== JSON.stringify(kitchen)}
											>
												{#if applying === `${message.id}:${action.id}`}<LoaderCircle
														size={15}
														class="spin"
													/>{:else if action.destructive}<Trash2
														size={14}
													/>{:else if action.label.startsWith('Add')}<Plus
														size={14}
													/>{:else if action.label.startsWith('Save') || action.label.startsWith('Update')}<Pencil
														size={14}
													/>{:else}<Check size={14} />{/if}{action.label}
											</button>
											<button
												class="dismiss-action"
												onclick={() => {
													action.status = 'dismissed';
													const ids = action.commands.flatMap((command) =>
														command.type === 'recipe.upsert' ? [command.recipe.id] : []
													);
													recipeDrafts = recipeDrafts.filter((recipe) => !ids.includes(recipe.id));
												}}
												disabled={working}
												aria-label={`Dismiss ${action.title}`}>Dismiss</button
											>
										</div>
									{:else}<span class="action-result"
											>{#if action.status === 'applied'}<Check
													size={13}
												/>Applied{:else}Dismissed{/if}</span
										>{/if}
								</section>
							{/each}
							{#if message.actions.some((action) => action.status === 'pending') && message.snapshot !== JSON.stringify(kitchen)}<p
									class="stale-proposal"
								>
									Kitchen changed. Ask Basil to update these actions.
								</p>{/if}
						</div>
					{/if}
					{#if message.warning}<p class="butler-warning" role="status">{message.warning}</p>{/if}
				</article>
			{/each}
		</div>
		{#if busy}<div class="butler-working" role="status">
				<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span
					>Basil is considering…</span
				>
			</div>{/if}
		{#if error}<div class="butler-error" role="alert">
				<p>{error}</p>
				{#if failedPrompt}<button onclick={() => chat.retry()} disabled={working}>Try again</button
					>{/if}
			</div>{/if}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void send();
			}}
		>
			<label class="sr-only" for="butler-message">Message Basil</label>
			<textarea
				id="butler-message"
				bind:this={input}
				bind:value={draft}
				placeholder="Your instructions…"
				rows="2"
				maxlength="2000"
				disabled={working || !owner}
				onkeydown={(event) => {
					if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
						event.preventDefault();
						void send();
					}
				}}></textarea>
			{#if busy}<button
					class="butler-primary butler-send"
					type="button"
					onclick={stop}
					aria-label="Stop reply"
					title="Stop reply"><Square size={16} /></button
				>
			{:else}<button
					class="butler-primary butler-send"
					type="submit"
					disabled={working || !draft.trim() || !owner}
					aria-label="Send message"><Send size={18} /></button
				>{/if}
		</form>
		<div class="sync-line" role="status">
			{#if syncing}<LoaderCircle size={12} class="spin" />Saving changes…{:else if pendingSync}Changes
				awaiting sync{/if}
		</div>
	</div>
{/if}

<style>
	.butler-launcher {
		position: fixed;
		right: 16px;
		bottom: max(10px, env(safe-area-inset-bottom));
		z-index: 45;
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px 4px 4px;
		border: 1px solid var(--line);
		border-radius: 40px;
		color: var(--surface);
		background: var(--ink);
		box-shadow: 0 4px 20px #0002;
		font-size: 12px;
		font-weight: 650;
	}
	.butler-panel {
		animation: butler-arrival 180ms ease-out;
		position: fixed;
		right: 16px;
		bottom: calc(var(--chat-viewport-bottom, 0px) + 60px + env(safe-area-inset-bottom));
		z-index: 46;
		width: min(440px, calc(100vw - 24px));
		height: min(
			740px,
			calc(var(--chat-viewport-height, 100dvh) - 80px - env(safe-area-inset-bottom))
		);
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 18px;
		box-shadow: 0 18px 70px #0003;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}
	.butler-heading {
		flex: 1;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font:
			24px Georgia,
			serif;
	}
	header p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 11px;
	}
	.icon-button {
		padding: 10px;
		border-radius: 8px;
	}
	.icon-button:hover {
		background: var(--wash);
	}
	.request-progress {
		height: 2px;
		flex-shrink: 0;
		background: linear-gradient(90deg, transparent, var(--green), transparent);
		background-size: 50% 100%;
		background-repeat: no-repeat;
		animation: progress 1.6s ease-in-out infinite;
	}
	.butler-transcript {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px;
		overscroll-behavior: contain;
	}
	.butler-introduction p {
		font:
			18px/1.5 Georgia,
			serif;
		margin: 8px 0 16px;
	}
	.butler-starters {
		display: grid;
		gap: 7px;
		margin-bottom: 16px;
	}
	.butler-starters button {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		text-align: left;
		border-radius: 10px;
		font-size: 12px;
	}
	.butler-starters button:hover {
		background: var(--wash);
	}
	.butler-message {
		padding: 12px 0;
		border-top: 1px solid var(--line);
		overflow-wrap: anywhere;
	}
	.butler-message.user-message {
		background: var(--wash);
		padding: 10px 12px;
		border: 0;
		border-radius: 12px;
		margin: 10px 0;
	}
	.speaker {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 1px;
		color: var(--muted);
	}
	.user-content {
		margin: 7px 0 0;
		white-space: pre-wrap;
		font-size: 13px;
		line-height: 1.6;
	}
	.butler-actions {
		display: grid;
		gap: 8px;
		margin-top: 12px;
	}
	.action-card {
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 12px;
		font-size: 12px;
		background: var(--wash);
	}
	.action-info strong {
		font-size: 13px;
		line-height: 1.4;
	}
	.action-info p {
		margin: 5px 0 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted);
	}
	summary {
		display: inline-block;
		margin-top: 8px;
		padding: 4px 0;
		font-size: 11px;
		color: var(--muted);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.action-details {
		max-height: 240px;
		overflow: auto;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: inherit;
		font-size: 11px;
		line-height: 1.5;
		padding: 8px 0;
		margin: 0;
		border-bottom: 1px solid var(--line);
	}
	.action-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 10px;
		align-items: center;
	}
	.action-button {
		min-height: 40px;
		padding: 9px 12px;
		font-size: 12px;
	}
	.dismiss-action {
		min-height: 40px;
		padding: 8px 0;
		font-size: 11px;
		color: var(--muted);
	}
	.butler-primary {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		gap: 6px;
		background: var(--ink);
		color: var(--surface);
		border-radius: 8px;
		font-weight: 600;
	}
	.destructive {
		background: #963e38;
		color: #fff;
	}
	.action-result {
		display: inline-flex;
		gap: 5px;
		align-items: center;
		margin-top: 10px;
		font-size: 11px;
		color: var(--muted);
	}
	.action-dismissed {
		background: transparent;
	}
	.stale-proposal {
		font-size: 11px;
		color: var(--muted);
		margin: 2px 0 0;
	}
	.butler-warning {
		font-size: 11px;
		color: var(--muted);
		margin: 8px 0 0;
	}
	.butler-working {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 40px;
		margin: 0 14px;
		flex-shrink: 0;
		font-size: 12px;
		color: var(--muted);
	}
	.typing-dots {
		display: flex;
		gap: 4px;
		align-items: center;
		height: 16px;
	}
	.typing-dots i {
		display: block;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--green);
		animation: dot 1.2s ease-in-out infinite;
	}
	.typing-dots i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.typing-dots i:nth-child(3) {
		animation-delay: 0.3s;
	}
	.butler-panel :global(.spin),
	.butler-launcher :global(.spin) {
		animation: spin 1s linear infinite;
	}
	.butler-error {
		margin: 0 12px 8px;
		padding: 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		font-size: 12px;
	}
	.butler-error p {
		margin: 0;
	}
	.butler-error button {
		min-height: 32px;
		text-decoration: underline;
		margin-top: 4px;
	}
	form {
		margin: 0 12px;
		flex-shrink: 0;
		display: flex;
		gap: 8px;
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 8px;
		align-items: flex-end;
	}
	textarea {
		flex: 1;
		min-width: 0;
		resize: none;
		max-height: 120px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: 14px;
		padding: 5px;
	}
	textarea:focus {
		outline: none;
	}
	form:focus-within {
		outline: 2px solid var(--green);
		outline-offset: 2px;
	}
	.butler-send {
		width: 40px;
		height: 40px;
		flex: none;
	}
	.sync-line {
		min-height: 23px;
		flex-shrink: 0;
		padding: 4px 12px 7px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		font-size: 10px;
		color: var(--muted);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	@keyframes butler-arrival {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes dot {
		0%,
		80%,
		100% {
			transform: translateY(0);
			opacity: 0.4;
		}
		40% {
			transform: translateY(-4px);
			opacity: 1;
		}
	}
	@keyframes progress {
		from {
			background-position: -100% 0;
		}
		to {
			background-position: 200% 0;
		}
	}
	@media (max-width: 640px) {
		.butler-launcher {
			right: 10px;
			bottom: max(8px, env(safe-area-inset-bottom));
		}
		.butler-panel {
			right: 8px;
			bottom: calc(var(--chat-viewport-bottom, 0px) + 8px + env(safe-area-inset-bottom));
			width: calc(100vw - 16px);
			height: calc(var(--chat-viewport-height, 100dvh) - 20px - env(safe-area-inset-bottom));
			border-radius: 14px;
		}
		.butler-transcript {
			padding: 12px;
		}
		textarea {
			font-size: 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.butler-panel,
		.request-progress,
		.typing-dots i,
		.butler-panel :global(.spin),
		.butler-launcher :global(.spin) {
			animation: none;
		}
		.request-progress {
			background: var(--green);
		}
		.typing-dots i {
			opacity: 0.75;
		}
	}
</style>
