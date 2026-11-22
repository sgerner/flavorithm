<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
	import {
		statusStore,
		dismissToast,
		runToastUndo,
		setToastFocused,
		setToastHovered
	} from '#lib/status.ts';

	let { modal = false, muted = false }: { modal?: boolean; muted?: boolean } = $props();

	const isModal = untrack(() => modal);
	const scopeId = $props.id();
	const unregister =
		typeof window !== 'undefined' && isModal ? statusStore.registerModal(scopeId) : undefined;

	onDestroy(() => {
		unregister?.();
	});

	let isActive = $derived(
		!muted && (modal ? $statusStore.activeScope === scopeId : $statusStore.activeScope === 'root')
	);

	let baselineVersion = $state(
		untrack(() =>
			statusStore.state.freshInCurrentTurn
				? Math.max(0, statusStore.state.version - 1)
				: statusStore.state.version
		)
	);
	let containerReady = $state(untrack(() => !isModal));
	let wasActive = untrack(
		() => !muted && (isModal ? true : statusStore.state.activeScope === 'root')
	);

	if (typeof window !== 'undefined' && isModal) {
		void tick().then(() => {
			containerReady = true;
		});
	}

	$effect.pre(() => {
		const activeNow = isActive;
		if (activeNow && !wasActive) {
			const snap = statusStore.state;
			baselineVersion = snap.freshInCurrentTurn ? Math.max(0, snap.version - 1) : snap.version;
		}
		wasActive = activeNow;
	});

	let shouldAnnounce = $derived(
		isActive && containerReady && $statusStore.version > baselineVersion
	);
	let slot0 = $derived(shouldAnnounce ? $statusStore.buffers[0] : '');
	let slot1 = $derived(shouldAnnounce ? $statusStore.buffers[1] : '');
</script>

<div
	class="visually-hidden"
	role={isActive ? 'status' : undefined}
	aria-live={isActive ? 'polite' : 'off'}
	aria-atomic="true"
	aria-hidden={!isActive || undefined}
	data-status-slot="0"
>
	{slot0}
</div>
<div
	class="visually-hidden"
	role={isActive ? 'status' : undefined}
	aria-live={isActive ? 'polite' : 'off'}
	aria-atomic="true"
	aria-hidden={!isActive || undefined}
	data-status-slot="1"
>
	{slot1}
</div>

{#if isActive && $statusStore.toast}
	<div
		class="toast"
		class:modal-toast={modal}
		role="region"
		aria-label="Notification"
		transition:revealMotion|global={{ y: 25, duration: 250 }}
		onpointerenter={() => setToastHovered(true)}
		onpointerleave={() => setToastHovered(false)}
		onfocusin={() => setToastFocused(true)}
		onfocusout={(event) => {
			const next = event.relatedTarget as Node | null;
			if (!next || !event.currentTarget.contains(next)) setToastFocused(false);
		}}
	>
		<span aria-hidden="true">✳</span>
		<span class="toast-message">{$statusStore.toast.message}</span>
		{#if $statusStore.toast.undo}
			<button type="button" class="toast-undo" onclick={runToastUndo}>Undo</button>
		{/if}
		<button type="button" onclick={dismissToast} aria-label="Dismiss notification"
			><X size={16} aria-hidden="true" /></button
		>
	</div>
{/if}
