<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = Omit<HTMLButtonAttributes, 'aria-expanded' | 'aria-controls' | 'aria-label'> & {
		expanded: boolean;
		controls?: string;
		label?: string;
		children?: Snippet;
	};

	let { expanded, controls, label, type = 'button', children, ...rest }: Props = $props();
</script>

<button {...rest} {type} aria-expanded={expanded} aria-controls={controls} aria-label={label}>
	{@render children?.()}
</button>
