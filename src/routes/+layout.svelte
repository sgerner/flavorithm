<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<svelte:boundary>
	{@render children()}
	{#snippet failed(_error, reset)}
		<main class="empty-state">
			<h1>Your kitchen needs a fresh start</h1>
			<p>Try opening it again. If the problem continues, reload the page.</p>
			<button class="primary" onclick={reset}>Try again</button>
			<button class="secondary" onclick={() => window.location.reload()}>Reload kitchen</button>
		</main>
	{/snippet}
</svelte:boundary>
