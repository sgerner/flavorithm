<script lang="ts">
	import { CloudOff, RefreshCw, Download } from '@lucide/svelte';
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
	let saved = $derived(online && !pending && !syncing && !conflicts.length && !error);
	let conflictLabels = $derived.by(() => {
		const counts = new Map<string, number>();
		return conflicts.map((conflict) => {
			const base = describe(conflict.path);
			const next = (counts.get(base) ?? 0) + 1;
			counts.set(base, next);
			return next === 1 ? base : `${base} (${next})`;
		});
	});
	function describe(path: string): string {
		const match = /^kitchen\.(recipes|pantry|shopping|meals)(?:\[([^\]]+)\])?(?:\.(.*))?$/.exec(
			path
		);
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
			calories: 'Calories',
			protein: 'Protein',
			carbs: 'Carbohydrates',
			fat: 'Fat',
			fiber: 'Fiber',
			ratings: 'Ratings'
		};
		if (match) {
			const group = match[1] as 'recipes' | 'pantry' | 'shopping' | 'meals';
			if (!match[2])
				return {
					recipes: 'Recipes',
					pantry: 'Pantry',
					shopping: 'Shopping list',
					meals: 'Meal plan'
				}[group];
			const item = kitchen[group].find((entry) => entry.id === match[2]);
			const name =
				item && 'title' in item
					? item.title
					: item && 'name' in item
						? item.name
						: item && 'date' in item
							? `${item.date} ${item.slot}`
							: 'Removed item';
			return `${name} · ${
				match[3]
					?.split('.')
					.map((field) => names[field] || field)
					.join(' · ') || 'Item'
			}`;
		}
		const field = path.replace(/^kitchen\.preferences\./, '').split('.')[0];
		return names[field] || 'Kitchen preferences';
	}
	function valueText(value: unknown): string {
		if (value === undefined || value === null) return 'Removed';
		if (typeof value === 'boolean') return value ? 'Yes' : 'No';
		if (Array.isArray(value)) return value.length ? value.map(valueText).join('; ') : 'None';
		if (typeof value === 'object') {
			const item = value as Record<string, unknown>;
			if (typeof item.title === 'string') return item.title;
			if (typeof item.name === 'string')
				return `${item.name}${item.quantity !== undefined ? ` · ${item.quantity} ${item.unit || ''}` : ''}`;
			return Object.entries(item)
				.map(([key, entry]) => `${key}: ${valueText(entry)}`)
				.join('; ');
		}
		return String(value);
	}
</script>

<div
	class:sync-notice={!saved}
	role={saved ? undefined : 'region'}
	aria-label={saved ? undefined : 'Kitchen synchronization'}
>
	<div
		class="sync-status-line"
		class:muted={saved}
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		{#if saved}
			<span>Kitchen saved</span>
		{:else if !online}<CloudOff size={18} aria-hidden="true" /><span
				>Offline{pending && !error ? ' · Changes pending on this device' : ''}</span
			>
		{:else if conflicts.length}<span>Some kitchen changes need your review.</span>
		{:else if syncing}<RefreshCw size={18} aria-hidden="true" /><span>Syncing your kitchen…</span>
		{:else}<span
				>{error
					? 'Kitchen sync failed. Your changes are pending.'
					: 'Changes pending on this device. Waiting to sync.'}</span
			>{/if}
	</div>
	{#if !saved}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
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
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable conflict list needs keyboard focus.) -->
				<div
					class="sync-review-list"
					tabindex="0"
					role="region"
					aria-label="Conflicting kitchen changes"
				>
					<ul>
						{#each conflicts as conflict, i}{@const label =
								conflictLabels[i] ?? describe(conflict.path)}
							<li>
								<strong>{describe(conflict.path)}</strong>
								<div>Your value: {valueText(conflict.local)?.slice(0, 180)}</div>
								<div>
									Household value: {valueText(conflict.remote)?.slice(0, 180)}
								</div>
								{#if (valueText(conflict.local)?.length || 0) > 180 || (valueText(conflict.remote)?.length || 0) > 180}<details
									>
										<summary>Show complete values</summary>
										<p>Your value</p>
										<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable conflict value needs keyboard focus.) -->
										<pre tabindex="0" role="region" aria-label={`${label}: your value`}>{valueText(
												conflict.local
											)}</pre>
										<p>Household value</p>
										<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable conflict value needs keyboard focus.) -->
										<pre
											tabindex="0"
											role="region"
											aria-label={`${label}: household value`}>{valueText(conflict.remote)}</pre>
									</details>{/if}
							</li>{/each}
					</ul>
				</div>
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
	{/if}
</div>

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
	.sync-status-line.muted {
		line-height: 1.7;
	}
	.sync-notice > .sync-status-line {
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
	.sync-review-list {
		max-height: 20rem;
		overflow: auto;
		margin-block: 0.75rem;
	}
	.sync-review ul {
		margin: 0;
		padding-inline-start: 1.25rem;
	}
	.sync-review li {
		padding-block: 0.5rem;
		overflow-wrap: anywhere;
	}
	.sync-review summary {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		min-width: 24px;
		cursor: pointer;
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
