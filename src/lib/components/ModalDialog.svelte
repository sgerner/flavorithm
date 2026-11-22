<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion } from '#lib/motion.ts';

	let {
		onclose,
		label,
		labelledBy,
		closeLabel = 'Close dialog',
		dialogClass = 'flavor-dialog',
		closeClass = 'icon-button dialog-close',
		closeIconSize = 21,
		viewKey,
		header,
		children
	}: {
		onclose: () => void;
		label?: string;
		labelledBy?: string;
		closeLabel?: string;
		dialogClass?: string;
		closeClass?: string;
		closeIconSize?: number;
		viewKey?: string;
		header?: Snippet;
		children: Snippet;
	} = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !event.defaultPrevented) {
			event.stopPropagation();
			event.preventDefault();
			onclose();
		}
	}
</script>

<div class="modal-backdrop" transition:backdropMotion|global>
	<div
		class={dialogClass}
		use:focusTrap={{ key: viewKey }}
		role="dialog"
		aria-modal="true"
		aria-labelledby={labelledBy}
		aria-label={labelledBy ? undefined : label}
		tabindex="-1"
		transition:dialogMotion|global
		onkeydown={handleKeydown}
	>
		{@render header?.()}
		<button type="button" class={closeClass} onclick={onclose} aria-label={closeLabel}>
			<X size={closeIconSize} />
		</button>
		{#key viewKey}
			{@render children()}
		{/key}
	</div>
</div>
