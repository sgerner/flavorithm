<script lang="ts">
	import { CloudOff, RefreshCw, Download } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
	import type { AppState } from '#lib/types.ts';
	import type { SyncConflict } from '#lib/offline-sync.ts';
	let {
		kitchen,
		online,
		pending,
		syncing,
		conflicts,
		retry,
		resolve,
		exportPending,
		error = ''
	}: {
		kitchen: AppState;
		online: boolean;
		pending: boolean;
		syncing: boolean;
		conflicts: SyncConflict[];
		retry: () => void;
		resolve: (choice: 'local' | 'remote') => void;
		exportPending: () => void;
		error?: string;
	} = $props();
	let review = $state(false);
	function describe(path: string): string {
		const match = /^kitchen\.(recipes|pantry|shopping|meals)\[([^\]]+)\](?:\.(.*))?$/.exec(path);
		const names: Record<string, string> = {
			maxTime: 'Cooking time',
			complexity: 'Difficulty',
			cuisines: 'Cuisines',
			diet: 'Diet',
			allergies: 'Allergies',
			quantity: 'Quantity',
			unit: 'Unit',
			recipeId: 'Recipe',
			completedAt: 'Cooking status',
			leftoverServings: 'Leftovers',
			title: 'Title',
			ingredients: 'Ingredients',
			steps: 'Instructions',
			servings: 'Servings',
			date: 'Date',
			slot: 'Meal',
			checked: 'Purchased',
			nutrition: 'Nutrition',
			ratings: 'Ratings'
		};
		if (match) {
			const group = match[1] as 'recipes' | 'pantry' | 'shopping' | 'meals';
			const item = kitchen[group].find((entry) => entry.id === match[2]);
			const name =
				item && 'title' in item
					? item.title
					: item && 'name' in item
						? item.name
						: item && 'date' in item
							? `${item.date} ${item.slot}`
							: 'Removed item';
			return `${name} · ${names[match[3]] || match[3] || 'Item'}`;
		}
		const field = path.replace(/^kitchen\.preferences\./, '').split('.')[0];
		return names[field] || 'Kitchen preferences';
	}
	const valueText = (value: unknown) =>
		value === undefined
			? 'Removed'
			: typeof value === 'string'
				? value
				: JSON.stringify(value, null, 2);
</script>

{#if !online || pending || conflicts.length || error}
	<section class="sync-notice" aria-label="Kitchen synchronization" in:revealMotion|global>
		<div role="status">
			{#if !online}<CloudOff size={18} /><span
					>Offline{pending && !error ? ' · Changes saved on this device' : ''}</span
				>
			{:else if conflicts.length}<span>Some kitchen changes need your review.</span>
			{:else if syncing}<RefreshCw size={18} /><span>Syncing your kitchen…</span>
			{:else}<span>{error || 'Changes saved on this device. Waiting to sync.'}</span>{/if}
		</div>
		{#if error && (!online || conflicts.length)}<p class="error" role="alert">{error}</p>{/if}
		{#if conflicts.length}
			<button class="secondary" onclick={() => (review = !review)}
				>{review ? 'Hide changes' : 'Review changes'}</button
			>
		{:else if online && !syncing}<button class="secondary" onclick={retry}>Retry sync</button>{/if}
		{#if review && conflicts.length}
			<div class="sync-review">
				<p>
					Your edits are kept on this device until you choose. Independent changes will be kept
					either way.
				</p>
				<ul>
					{#each conflicts as conflict}<li>
							<strong>{describe(conflict.path)}</strong>
							<div>Your value: {valueText(conflict.local)?.slice(0, 180)}</div>
							<div>
								Household value: {valueText(conflict.remote)?.slice(0, 180)}
							</div>
							{#if (valueText(conflict.local)?.length || 0) > 180 || (valueText(conflict.remote)?.length || 0) > 180}<details
								>
									<summary>Show complete values</summary>
									<p>Your value</p>
									<pre>{valueText(conflict.local)}</pre>
									<p>Household value</p>
									<pre>{valueText(conflict.remote)}</pre>
								</details>{/if}
						</li>{/each}
				</ul>
				<div class="sync-actions">
					<button class="secondary" onclick={exportPending}
						><Download size={16} /> Back up my changes</button
					>
					<button class="secondary" disabled={syncing || !online} onclick={() => resolve('remote')}
						>Use household values</button
					>
					<button class="primary" disabled={syncing || !online} onclick={() => resolve('local')}
						>Use my values</button
					>
				</div>
			</div>
		{/if}
	</section>
{/if}

<style>
	.sync-notice {
		padding: 1rem;
		border-block: 1px solid var(--line);
		background: var(--wash);
		margin-block-end: 1rem;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}
	.sync-notice > div:first-child {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex: 1;
		min-width: 12rem;
	}
	.sync-review {
		flex-basis: 100%;
		font-size: 1rem;
	}
	.sync-review ul {
		padding-inline-start: 1.25rem;
		max-height: 20rem;
		overflow: auto;
	}
	.sync-review li {
		padding-block: 0.5rem;
		overflow-wrap: anywhere;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 24rem;
		overflow: auto;
	}
	.sync-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	@media (max-width: 600px) {
		.sync-actions button {
			width: 100%;
		}
	}
</style>
