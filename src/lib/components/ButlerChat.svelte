<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { X, Send, Check, RotateCcw, ChevronDown } from '@lucide/svelte';
	import BasilAvatar from './BasilAvatar.svelte';
	import type { AppState } from '#lib/types.ts';

	type Turn = { role: 'user' | 'assistant'; content: string };
	type Message = Turn & {
		id: number;
		commands?: unknown[];
		snapshot?: string;
		status?: 'pending' | 'applied' | 'dismissed';
	};
	let {
		kitchen,
		owner,
		request,
		apply
	}: {
		kitchen: AppState;
		owner: string;
		request: (prompt: string, history: Turn[]) => Promise<{ reply: string; commands: unknown[] }>;
		apply: (commands: unknown[]) => void;
	} = $props();
	let open = $state(false);
	let draft = $state('');
	let messages = $state<Message[]>([]);
	let busy = $state(false);
	let error = $state('');
	let failedPrompt = $state('');
	let input = $state<HTMLTextAreaElement>();
	let transcript = $state<HTMLDivElement>();
	let launcher = $state<HTMLButtonElement>();
	let sequence = 0;
	let generation = 0;
	let currentOwner = '';
	let alive = true;
	let reaction = $state<'idle' | 'speaking' | 'pleased'>('idle');
	let reactionTimer: ReturnType<typeof setTimeout> | undefined;
	const mood = $derived(busy ? 'thinking' : error ? 'concerned' : reaction);
	const status = $derived(
		busy
			? 'Considering your predicament…'
			: error
				? 'A minor complication. We shall recover.'
				: reaction === 'speaking'
					? 'If I may offer a rather good opinion…'
					: reaction === 'pleased'
						? 'There. Civilisation restored.'
						: 'Your kitchen. Properly managed.'
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
		'Plan dinners for the week using my pantry.',
		'Help me build a recipe from scratch.',
		'Review my recipes. Be honest.',
		'What can you take care of for me?'
	];
	$effect(() => {
		if (owner !== currentOwner) {
			currentOwner = owner;
			resetReaction();
			generation++;
			messages = [];
			draft = '';
			error = '';
			failedPrompt = '';
			busy = false;
			open = false;
		}
	});
	onDestroy(() => {
		alive = false;
		resetReaction();
		generation++;
	});
	async function scroll() {
		await tick();
		transcript?.scrollTo({
			top: transcript.scrollHeight,
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
		});
	}
	export function close() {
		resetReaction();
		open = false;
		launcher?.focus();
	}
	async function toggle() {
		open = !open;
		if (open) {
			await tick();
			input?.focus();
		} else launcher?.focus();
	}
	function clear() {
		resetReaction();
		generation++;
		messages = [];
		busy = false;
		error = '';
		failedPrompt = '';
		input?.focus();
	}
	async function send(prompt = draft.trim(), retry = false) {
		if (!prompt || busy || !owner) return;
		resetReaction();
		const token = ++generation;
		const history = messages
			.slice(retry ? -21 : -20, retry ? -1 : undefined)
			.map(({ role, content }) => ({ role, content }));
		for (const message of messages) if (message.status === 'pending') message.status = 'dismissed';
		if (!retry) messages.push({ id: ++sequence, role: 'user', content: prompt });
		draft = '';
		error = '';
		failedPrompt = '';
		busy = true;
		const snapshot = JSON.stringify(kitchen);
		void scroll();
		try {
			const result = await request(prompt, history);
			if (!alive || token !== generation) return;
			react('speaking', Math.min(12000, Math.max(2400, result.reply.length * 28)));
			messages.push({
				id: ++sequence,
				role: 'assistant',
				content: result.reply,
				commands: result.commands,
				snapshot,
				status: 'pending'
			});
		} catch (e) {
			if (!alive || token !== generation) return;
			error = e instanceof Error ? e.message : 'Basil could not connect. Please try again.';
			failedPrompt = prompt;
		} finally {
			if (alive && token === generation) {
				busy = false;
				void scroll();
			}
		}
	}
	function applyProposal(message: Message) {
		try {
			if (message.snapshot !== JSON.stringify(kitchen)) {
				throw new Error(
					'Your kitchen has changed since this proposal. Ask Basil to update it before applying.'
				);
			}
			apply(message.commands ?? []);
			message.status = 'applied';
			react('pleased', 2200);
			message.content += '\n\n[You applied this proposal.]';
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'The changes could not be applied.';
		}
	}
	function words(value: string) {
		return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ');
	}
	function label(command: unknown): string {
		if (!command || typeof command !== 'object') return 'Kitchen action';
		const item = command as Record<string, unknown>;
		const labels: Record<string, string> = {
			'recipe.upsert': 'Save recipe',
			'recipe.delete': 'Delete recipe',
			'pantry.upsert': 'Update pantry',
			'pantry.delete': 'Remove pantry item',
			'meal.upsert': 'Schedule meal',
			'meal.delete': 'Remove meal',
			'meal.complete': 'Complete meal',
			'shopping.upsert': 'Update shopping item',
			'shopping.delete': 'Remove shopping item',
			'shopping.generate': 'Build shopping list',
			'preferences.update': 'Update preferences',
			navigate: 'Go to ' + String(item.page ?? ''),
			'recipe.open': 'Open recipe',
			ui: 'Open ' + words(String(item.action ?? 'controls'))
		};
		return labels[String(item.type)] ?? words(String(item.type ?? 'Kitchen action'));
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
		return [name, format(command)].filter(Boolean).join('\n') || label(command);
	}
</script>

<button
	class="butler-launcher"
	bind:this={launcher}
	onclick={toggle}
	aria-expanded={open}
	aria-controls="butler-panel"
	aria-label={open ? 'Close Basil chat' : 'Chat with Basil, your kitchen butler'}
>
	<BasilAvatar {mood} size={36} active={open} /><span>Ask Basil</span>
</button>

{#if open}
	<div
		class="butler-panel"
		id="butler-panel"
		role="dialog"
		tabindex="-1"
		aria-label="Chat with Basil"
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				event.preventDefault();
				void toggle();
			}
		}}
	>
		<header>
			<BasilAvatar {mood} size={62} active={open} />
			<div class="butler-heading">
				<h2>Basil</h2>
				<p>{status}</p>
			</div>
			<button
				class="icon-button"
				onclick={clear}
				disabled={busy || messages.length === 0}
				aria-label="Clear conversation"
				title="Clear conversation"><RotateCcw size={17} /></button
			>
			<button class="icon-button" onclick={toggle} aria-label="Close chat"><X size={20} /></button>
		</header>
		<div
			class="butler-transcript"
			bind:this={transcript}
			role="log"
			aria-label="Conversation"
			aria-live="polite"
			aria-relevant="additions text"
			aria-busy={busy}
		>
			<div class="butler-introduction">
				<span class="eyebrow">AT YOUR SERVICE. NATURALLY.</span>
				<p>
					I’m Basil. Your butler, culinary counsel, and the reason dinner will happen at a sensible
					hour. You retain the final say, naturally. I shall endeavour to make it a good one.
				</p>
				<p class="butler-hint">
					Recipes, pantry, meal plans, shopping, settings—ask away. You can review my proposed
					changes before applying them.
				</p>
			</div>
			{#if messages.length === 0}
				<div class="butler-starters">
					{#each starters as starter}<button onclick={() => send(starter)} disabled={busy || !owner}
							>{starter}</button
						>{/each}
				</div>
			{/if}
			{#each messages as message (message.id)}
				<article class:user-message={message.role === 'user'} class="butler-message">
					<span class="speaker">{message.role === 'user' ? 'You' : 'Basil'}</span>
					<p>{message.content}</p>
					{#if message.commands?.length}
						<div class="butler-proposal">
							<strong
								>{message.commands.length} proposed {message.commands.length === 1
									? 'action'
									: 'actions'}</strong
							>
							{#each message.commands as command}<details>
									<summary>{label(command)}<ChevronDown size={13} /></summary>
									<pre>{preview(command)}</pre>
								</details>{/each}
							{#if message.status === 'pending'}
								<div class="proposal-buttons">
									<button
										class="butler-primary"
										onclick={() => applyProposal(message)}
										disabled={busy}><Check size={15} />Apply changes</button
									><button onclick={() => (message.status = 'dismissed')}>Dismiss</button>
								</div>
							{:else}<small
									>{message.status === 'applied'
										? 'Applied to your kitchen'
										: 'Proposal closed'}</small
								>{/if}
						</div>
					{/if}
				</article>
			{/each}
			{#if busy}<p class="butler-working" role="status">
					Basil is consulting the pantry and raising an eyebrow…
				</p>{/if}
		</div>
		{#if error}<div class="butler-error" role="alert">
				<p>{error}</p>
				{#if failedPrompt}<button onclick={() => send(failedPrompt, true)} disabled={busy}
						>Try again</button
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
				placeholder={owner ? 'What shall we attend to?' : 'Sign in to consult Basil'}
				rows="2"
				maxlength="2000"
				disabled={busy || !owner}
				onkeydown={(event) => {
					if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
						event.preventDefault();
						void send();
					}
				}}></textarea>
			<button
				class="butler-primary butler-send"
				type="submit"
				disabled={busy || !draft.trim() || !owner}
				aria-label="Send message"><Send size={18} /></button
			>
		</form>
		<footer>AI assistance · Check recipes and dietary requirements.</footer>
	</div>
{/if}

<style>
	@keyframes butler-arrival {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.butler-panel {
			animation: none;
		}
	}

	.butler-launcher {
		position: fixed;
		right: 24px;
		bottom: 24px;
		z-index: 45;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 6px 16px 6px 7px;
		border: 1px solid var(--line);
		border-radius: 50px;
		color: var(--surface);
		background: var(--ink);
		box-shadow: 0 5px 24px #0002;
		font-weight: 650;
	}
	.butler-panel {
		animation: butler-arrival 180ms ease-out;
		position: fixed;
		right: 24px;
		bottom: 86px;
		z-index: 46;
		width: min(440px, calc(100vw - 32px));
		height: min(740px, calc(100dvh - 112px));
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--line);
		border-radius: 20px;
		box-shadow: 0 18px 70px #0003;
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 18px;
		border-bottom: 1px solid var(--line);
	}
	.butler-heading {
		flex: 1;
	}
	h2 {
		margin: 0;
		font:
			26px Georgia,
			serif;
	}
	header p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 11px;
	}
	.icon-button {
		padding: 8px;
		border-radius: 8px;
	}
	.icon-button:hover {
		background: var(--wash);
	}
	.butler-transcript {
		flex: 1;
		overflow-y: auto;
		padding: 20px;
		overscroll-behavior: contain;
	}
	.eyebrow {
		font-size: 9px;
		letter-spacing: 1.5px;
		font-weight: 700;
		color: var(--muted);
	}
	.butler-introduction p {
		font:
			18px/1.55 Georgia,
			serif;
		margin: 12px 0;
	}
	.butler-introduction .butler-hint {
		font:
			12px/1.6 'DM Sans',
			sans-serif;
		color: var(--muted);
	}
	.butler-starters {
		display: grid;
		gap: 8px;
		margin: 22px 0;
	}
	.butler-starters button {
		padding: 11px 13px;
		border: 1px solid var(--line);
		text-align: left;
		border-radius: 10px;
		font-size: 12px;
	}
	.butler-starters button:hover {
		background: var(--wash);
	}
	.butler-message {
		padding: 14px 0;
		border-top: 1px solid var(--line);
	}
	.butler-message.user-message {
		background: var(--wash);
		padding: 12px 14px;
		border: 0;
		border-radius: 12px;
		margin: 16px 0;
	}
	.speaker {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 1px;
		color: var(--muted);
	}
	.butler-message p {
		margin: 7px 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 13px;
		line-height: 1.65;
	}
	.butler-proposal {
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 10px;
		margin-top: 14px;
		font-size: 12px;
	}
	.butler-proposal strong {
		display: block;
		margin-bottom: 8px;
	}
	details {
		border-top: 1px solid var(--line);
	}
	summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 9px 0;
		cursor: pointer;
		text-transform: capitalize;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 240px;
		overflow: auto;
		font-size: 10px;
		background: var(--wash);
		padding: 8px;
		border-radius: 5px;
	}
	.proposal-buttons {
		display: flex;
		gap: 10px;
		margin-top: 12px;
		align-items: center;
	}
	.proposal-buttons button {
		padding: 9px 10px;
		font-size: 11px;
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
	.butler-working {
		font-size: 12px;
		color: var(--muted);
		font-style: italic;
	}
	.butler-error {
		margin: 0 16px 10px;
		padding: 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		font-size: 12px;
	}
	.butler-error p {
		margin: 0;
	}
	.butler-error button {
		text-decoration: underline;
		margin-top: 8px;
	}
	form {
		margin: 0 14px;
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
		font-size: 13px;
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
		width: 36px;
		height: 36px;
		flex: none;
	}
	footer {
		padding: 9px 15px 12px;
		font-size: 9px;
		color: var(--muted);
		text-align: center;
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
	@media (max-width: 640px) {
		.butler-launcher {
			right: 16px;
			bottom: 84px;
			padding: 12px 16px;
		}
		.butler-panel {
			right: 12px;
			bottom: 146px;
			width: calc(100vw - 24px);
			height: min(680px, calc(100dvh - 164px));
			border-radius: 16px;
		}
		header {
			padding: 12px;
		}
		.butler-transcript {
			padding: 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.butler-transcript) {
			scroll-behavior: auto;
		}
	}
</style>
