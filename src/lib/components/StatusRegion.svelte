<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { X } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
	import {
		statusStore,
		dismissToast,
		isToastVisibleForOwner,
		runToastUndo,
		setToastFocused,
		setToastHovered
	} from '#lib/status.ts';

	let {
		modal = false,
		open = true,
		muted = false,
		owner
	}: {
		modal?: boolean;
		open?: boolean;
		muted?: boolean;
		owner?: string;
	} = $props();

	const isModal = untrack(() => modal);
	const scopeId = $props.id();
	let unregisterModal: (() => void) | undefined =
		typeof window !== 'undefined' && isModal && untrack(() => open)
			? statusStore.registerModal(scopeId)
			: undefined;

	onDestroy(() => {
		unregisterModal?.();
		unregisterModal = undefined;
	});

	let isActive = $derived(
		!muted &&
			open &&
			(modal ? $statusStore.activeScope === scopeId : $statusStore.activeScope === 'root')
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
		() => !muted && open && (isModal ? true : statusStore.state.activeScope === 'root')
	);

	if (typeof window !== 'undefined' && isModal) {
		void tick().then(() => {
			containerReady = true;
		});
	}

	$effect.pre(() => {
		if (typeof window !== 'undefined' && isModal) {
			if (!open && unregisterModal) {
				unregisterModal();
				unregisterModal = undefined;
			} else if (open && !$statusStore.modalScopes.includes(scopeId)) {
				unregisterModal = statusStore.registerModal(scopeId);
			}
		}
		if ($statusStore.version < baselineVersion) {
			baselineVersion = $statusStore.version;
		}
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
	let effectiveOwner = $derived(owner ?? $statusStore.owner);
	let visibleToast = $derived(
		isActive && isToastVisibleForOwner($statusStore.toast, effectiveOwner)
			? $statusStore.toast
			: null
	);

	function trackToastNode(node: HTMLElement, toastId: number) {
		const onEnter = () => setToastHovered(true);
		const onLeave = () => setToastHovered(false);
		node.addEventListener('pointerenter', onEnter);
		node.addEventListener('pointerleave', onLeave);
		const unsubscribe = statusStore.subscribe((snap) => {
			const activeForScope = isModal ? snap.activeScope === scopeId : snap.activeScope === 'root';
			if (!activeForScope || !snap.toast || snap.toast.id !== toastId) {
				node.remove();
			}
		});
		return {
			destroy() {
				unsubscribe();
				node.removeEventListener('pointerenter', onEnter);
				node.removeEventListener('pointerleave', onLeave);
			}
		};
	}
</script>

<div
	class="visually-hidden"
	role="status"
	aria-live="polite"
	aria-atomic="true"
	data-status-slot="0"
>
	{slot0}
</div>
<div
	class="visually-hidden"
	role="status"
	aria-live="polite"
	aria-atomic="true"
	data-status-slot="1"
>
	{slot1}
</div>

{#if visibleToast}
	{#key visibleToast.id}
		<div
			class="toast"
			class:modal-toast={modal}
			use:trackToastNode={visibleToast.id}
			in:revealMotion={{ y: 25, duration: 250 }}
			onfocusin={() => setToastFocused(true)}
			onfocusout={(event) => {
				const next = event.relatedTarget as Node | null;
				if (!next || !event.currentTarget.contains(next)) setToastFocused(false);
			}}
		>
			<span aria-hidden="true">✳</span>
			<span class="toast-message">{visibleToast.message}</span>
			{#if visibleToast.undo}
				<button type="button" class="toast-undo" onclick={() => runToastUndo(effectiveOwner)}
					>{visibleToast.actionLabel || 'Undo'}</button
				>
			{/if}
			<button type="button" onclick={dismissToast} aria-label="Dismiss notification"
				><X size={16} aria-hidden="true" /></button
			>
		</div>
	{/key}
{/if}
