<script lang="ts">
	import { tick } from 'svelte';
	import { Search, Check, ChevronDown } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
	export type PickerOption = {
		id: string;
		label: string;
		detail?: string;
		searchText?: string;
		disabled?: boolean;
		searchOnly?: boolean;
	};
	let {
		label,
		placeholder,
		options,
		value = '',
		fallback = '',
		disabled = false,
		onselect
	}: {
		label: string;
		placeholder: string;
		options: PickerOption[];
		value?: string;
		fallback?: string;
		disabled?: boolean;
		onselect: (id: string) => void;
	} = $props();
	const id = $props.id();
	let list = $state<HTMLDivElement>();
	let open = $state(false);
	let query = $state('');
	let active = $state(-1);
	let terms = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
	let matches = $derived(
		options
			.filter(
				(option) =>
					(!option.searchOnly || terms.length) &&
					terms.every((term) =>
						`${option.label} ${option.detail || ''} ${option.searchText || ''}`
							.toLowerCase()
							.includes(term)
					)
			)
			.sort((a, b) =>
				terms.length
					? Number(terms.every((term) => `${b.label} ${b.id}`.toLowerCase().includes(term))) -
						Number(terms.every((term) => `${a.label} ${a.id}`.toLowerCase().includes(term)))
					: 0
			)
	);
	let visible = $derived(matches.slice(0, 80));
	function choose(option: PickerOption) {
		if (option.disabled) return;
		open = false;
		query = '';
		active = -1;
		onselect(option.id);
	}
	async function keyboard(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			open = false;
			active = -1;
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (open && active >= 0 && visible[active]) choose(visible[active]);
			else open = true;
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		open = true;
		const step = event.key === 'ArrowDown' ? 1 : -1;
		for (let count = 0; count < visible.length; count++) {
			active = (active + step + visible.length) % visible.length;
			if (!visible[active]?.disabled) break;
		}
		await tick();
		list
			?.querySelector(`#${CSS.escape(id)}-option-${active}`)
			?.scrollIntoView({ block: 'nearest' });
	}
</script>

<div class="search-picker">
	<label for={id}>{label}</label>
	<div class="search-control" class:open>
		<Search size={18} aria-hidden="true" />
		<input
			{id}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls={`${id}-list`}
			aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
			value={open ? query : options.find((option) => option.id === value)?.label || fallback}
			{placeholder}
			{disabled}
			autocomplete="off"
			spellcheck="false"
			onfocus={() => {
				open = true;
				query = '';
				active = -1;
			}}
			onblur={() => {
				open = false;
				active = -1;
			}}
			oninput={(event) => {
				query = event.currentTarget.value;
				open = true;
				active = -1;
			}}
			onkeydown={keyboard}
		/>
		<ChevronDown size={17} aria-hidden="true" />
	</div>
	{#if open && !disabled}
		<div class="picker-menu" in:revealMotion={{ duration: 140 }}>
			<div
				bind:this={list}
				id={`${id}-list`}
				role="listbox"
				aria-label={label}
				class="picker-options"
			>
				{#each visible as option, index (option.id)}
					<button
						type="button"
						id={`${id}-option-${index}`}
						role="option"
						aria-selected={value === option.id}
						aria-disabled={option.disabled || undefined}
						tabindex="-1"
						class:highlighted={active === index}
						class:unavailable={option.disabled}
						onpointerdown={(event) => event.preventDefault()}
						onclick={() => choose(option)}
					>
						<span
							><b>{option.label}</b>{#if option.detail}<small>{option.detail}</small>{/if}</span
						>
						{#if value === option.id}<Check size={17} aria-hidden="true" />{/if}
					</button>
				{/each}
			</div>
			{#if !matches.length}<p role="status">No matches. Try another provider or model name.</p>
			{:else if matches.length > visible.length}<p role="status">
					{matches.length} matches. Keep typing to narrow your search.
				</p>{/if}
		</div>
	{/if}
</div>

<style>
	.search-picker {
		margin: 18px 0;
		min-width: 0;
	}
	label {
		display: block;
		font-size: 15px;
		font-weight: 600;
		margin-bottom: 8px;
	}
	.search-control {
		display: flex;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--line);
		background: var(--wash);
		padding: 0 12px;
		color: var(--muted);
	}
	.search-control:focus-within {
		outline: 2px solid var(--green);
		outline-offset: 2px;
	}
	input {
		width: 100%;
		min-width: 0;
		min-height: 48px;
		font-size: 16px;
		color: var(--ink);
		background: transparent;
		border: 0;
		outline: none;
	}
	input:disabled {
		opacity: 0.6;
	}
	.picker-menu {
		border: 1px solid var(--line);
		border-top: 0;
	}
	.picker-options {
		max-height: 260px;
		overflow: auto;
		overscroll-behavior: contain;
	}
	button {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		min-height: 58px;
		padding: 12px;
		text-align: left;
		color: var(--ink);
		background: transparent;
		border: 0;
		border-bottom: 1px solid var(--line);
		cursor: pointer;
	}
	button:last-child {
		border-bottom: 0;
	}
	button:hover,
	button.highlighted,
	button[aria-selected='true'] {
		background: var(--wash);
	}
	button.unavailable {
		opacity: 0.6;
		cursor: default;
	}
	button span {
		min-width: 0;
	}
	b {
		display: block;
		font-size: 16px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	small {
		display: block;
		font-size: 14px;
		color: var(--muted);
		margin-top: 3px;
		overflow-wrap: anywhere;
	}
	p {
		padding: 12px;
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
</style>
