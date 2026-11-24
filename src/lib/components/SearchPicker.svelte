<script lang="ts">
	import { tick } from 'svelte';
	import { Search, Check, ChevronDown } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
	import {
		PICKER_VISIBLE_LIMIT,
		activeOptionId,
		closePickerState,
		escapePickerState,
		filterPickerOptions,
		focusPickerState,
		inputPickerState,
		resolvePickerValue,
		stepPickerActive,
		type PickerOption
	} from '#lib/search-picker.ts';
	export type { PickerOption } from '#lib/search-picker.ts';
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
	let filtering = $state(false);
	let query = $state('');
	let active = $state(-1);
	let selectingOnFocus = false;
	let matches = $derived(filterPickerOptions(options, query, filtering));
	let visible = $derived(matches.slice(0, PICKER_VISIBLE_LIMIT));
	function choose(option: PickerOption) {
		if (option.disabled) return;
		({ open, filtering, query, active } = closePickerState());
		onselect(option.id);
	}
	async function keyboard(event: KeyboardEvent) {
		selectingOnFocus = false;
		if (disabled) return;
		if (event.key === 'Escape') {
			const next = escapePickerState({ open, filtering });
			if (!next.handled) return;
			event.preventDefault();
			event.stopPropagation();
			({ open, filtering, query, active } = next.state);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (open && active >= 0 && visible[active] && !visible[active].disabled)
				choose(visible[active]);
			else open = true;
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		open = true;
		active = stepPickerActive(visible, active, event.key);
		if (active < 0) return;
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
			aria-expanded={open && !disabled}
			aria-controls={open && !disabled ? `${id}-list` : undefined}
			aria-activedescendant={activeOptionId(id, open, disabled, visible, active)}
			value={resolvePickerValue({ options, value, fallback, query, filtering })}
			{placeholder}
			{disabled}
			autocomplete="off"
			spellcheck="false"
			onfocus={(event) => {
				selectingOnFocus = true;
				({ open, filtering, query, active } = focusPickerState());
				event.currentTarget.select();
			}}
			onmouseup={(event) => {
				if (selectingOnFocus) {
					event.preventDefault();
					selectingOnFocus = false;
				}
			}}
			onclick={() => {
				if (!open && !disabled) {
					open = true;
					active = -1;
				}
			}}
			onblur={() => {
				selectingOnFocus = false;
				({ open, filtering, query, active } = closePickerState());
			}}
			oninput={(event) => {
				selectingOnFocus = false;
				({ open, filtering, query, active } = inputPickerState(event.currentTarget.value));
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
		border: 1px solid var(--control-border);
		background: var(--wash);
		padding: 0 12px;
		color: var(--icon-subtle);
	}
	.search-control:focus-within {
		outline: 2px solid var(--focus-outer);
		outline-offset: 2px;
		box-shadow: 0 0 0 2px var(--focus-inner);
	}
	.search-control input,
	.search-control input:focus,
	.search-control input:focus-visible {
		width: 100%;
		min-width: 0;
		min-height: 48px;
		font-size: 16px;
		color: var(--ink);
		background: transparent;
		border: 0;
		outline: none;
		box-shadow: none;
	}
	input:disabled {
		opacity: 0.6;
	}
	.picker-menu {
		border: 1px solid var(--control-border);
		border-top: 0;
	}
	@media (forced-colors: active) {
		.search-control:focus-within {
			outline: 2px solid Highlight;
			outline-offset: 2px;
			box-shadow: none;
		}
		.search-control input:focus,
		.search-control input:focus-visible {
			outline: none;
			box-shadow: none;
		}
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
	button[aria-selected='true'] {
		background: var(--wash);
	}
	button.highlighted {
		outline: 2px solid var(--ink);
		outline-offset: -2px;
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
