<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = Omit<HTMLButtonAttributes, 'aria-pressed' | 'aria-label'> & {
		pressed: boolean;
		label?: string;
		children?: Snippet;
	};

	let { pressed, label, type = 'button', children, ...rest }: Props = $props();
</script>

<button {...rest} {type} aria-pressed={pressed} aria-label={label}>
	{@render children?.()}
</button>
