<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion } from '#lib/motion.ts';

	let {
		open = false,
		modal = false,
		hidden = false,
		trigger,
		id = 'kitchen-sidebar',
		label = 'Kitchen navigation',
		closeLabel = 'Close navigation',
		onclose,
		children
	}: {
		open?: boolean;
		modal?: boolean;
		hidden?: boolean;
		trigger?: HTMLElement | null;
		id?: string;
		label?: string;
		closeLabel?: string;
		onclose: () => void;
		children: Snippet;
	} = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (modal && event.key === 'Escape' && !event.defaultPrevented) {
			event.stopPropagation();
			event.preventDefault();
			onclose();
		}
	}
</script>

{#if modal}<button
		type="button"
		class="nav-backdrop"
		tabindex="-1"
		aria-label="Dismiss navigation"
		onclick={onclose}
		transition:backdropMotion|global
	></button>{/if}
<aside
	{id}
	class:mobile-open={open}
	class="sidebar"
	role={modal ? 'dialog' : undefined}
	aria-modal={modal ? 'true' : undefined}
	aria-label={label}
	tabindex="-1"
	inert={hidden ? true : undefined}
	use:focusTrap={{ enabled: modal, returnFocus: () => trigger }}
	onkeydown={handleKeydown}
>
	<button type="button" class="icon-button sidebar-close" aria-label={closeLabel} onclick={onclose}
		><X size={20} /></button
	>
	{@render children()}
</aside>
