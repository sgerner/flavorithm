<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>Kitchen unavailable · Flavorithm</title></svelte:head>
<main class="empty-state">
	<h1>We couldn’t open your kitchen</h1>
	<p>Reload to try again. Saved kitchen data remains on this device or in your account.</p>
	<p class="muted">Error {page.status}</p>
	<button class="primary" onclick={() => window.location.reload()}>Reload kitchen</button>
	<a href="/">Return to kitchen</a>
</main>
