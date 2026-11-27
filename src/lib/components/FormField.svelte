<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fieldAria, type FieldControlProps, type FieldIds } from '#lib/form-validation.ts';

	let {
		id,
		label,
		help,
		helpSnippet,
		helpIds = [],
		error = '',
		errorId,
		invalid = false,
		alert = false,
		class: className = '',
		children
	}: {
		id?: string;
		label: string;
		help?: string;
		helpSnippet?: Snippet<[string]>;
		helpIds?: (string | false | null | undefined)[];
		error?: string;
		errorId?: string;
		invalid?: boolean;
		alert?: boolean;
		class?: string;
		children: Snippet<[FieldControlProps, FieldIds]>;
	} = $props();

	const fallbackId = $props.id();
	let resolvedId = $derived(id || fallbackId);
	let hasHelp = $derived(Boolean(help || helpSnippet));
	let aria = $derived(
		fieldAria(resolvedId, {
			hasHelp,
			helpIds,
			error,
			errorId,
			invalid
		})
	);
</script>

<div class={['field', className]}>
	<label id={aria.labelId} for={aria.id}>{label}</label>
	{@render children(aria.props, aria)}
	{#if help}
		<p class="field-help" id={aria.helpId}>{help}</p>
	{/if}
	{#if helpSnippet}
		{@render helpSnippet(aria.helpId)}
	{/if}
	{#if error}
		<p class="error field-error" id={aria.errorId} role={alert ? 'alert' : undefined}>{error}</p>
	{/if}
</div>
