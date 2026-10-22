<script lang="ts">
	import { untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion, fadeMotion, revealMotion } from '#lib/motion.ts';
	import type { Recipe } from '#lib/types.ts';
	import {
		X,
		Clock,
		Users,
		Bookmark,
		ShoppingBasket,
		CalendarPlus,
		Star,
		ArrowUpRight,
		ChefHat,
		Check
	} from '@lucide/svelte';
	let {
		recipe,
		close,
		save,
		shop,
		plan,
		rate,
		nutrition,
		edit,
		remove,
		busy
	}: {
		recipe: Recipe;
		close: () => void;
		save: () => void;
		shop: (servings: number) => void;
		plan: (servings: number) => void;
		rate: (n: number) => void;
		nutrition: () => void;
		edit: () => void;
		remove: () => void;
		busy: boolean;
	} = $props();
	let nutritionMode = $state('serving');
	let nutritionMultiplier = $derived(nutritionMode === 'recipe' ? recipe.servings : 1);
	let tab = $state('recipe');
	let completed = $state<number[]>([]);
	let servingCount = $state(untrack(() => recipe.servings));
</script>

<div class="modal-backdrop" transition:backdropMotion|global>
	<div
		class="recipe-dialog"
		transition:dialogMotion|global
		use:focusTrap
		role="dialog"
		aria-modal="true"
		aria-label={recipe.title}
		tabindex="-1"
	>
		<div
			class="detail-photo"
			style:background-image={`url(${JSON.stringify(recipe.image || '/recipe-placeholder.svg')})`}
		>
			<button class="icon-button close-detail" onclick={close} aria-label="Close recipe"
				><X size={22} /></button
			>
		</div>
		<div class="detail-body">
			<div class="eyebrow">{recipe.cuisine} · {recipe.difficulty}</div>
			<h2>{recipe.title}</h2>
			<p class="muted">{recipe.description}</p>
			{#if recipe.importNotes?.length}<details class="import-notes">
					<summary>Import notes ({recipe.importNotes.length})</summary>
					<ul>
						{#each recipe.importNotes as note}<li>{note}</li>{/each}
					</ul>
				</details>{/if}
			<div class="detail-meta">
				<span><Clock size={16} />{recipe.time} min</span><span
					><Users size={16} />{recipe.servings} servings</span
				><span><ChefHat size={16} />{recipe.difficulty}</span>
			</div>
			<div class="detail-actions">
				<button class="primary" onclick={() => plan(servingCount)}
					><CalendarPlus size={17} /> Plan a meal</button
				><button class="secondary" onclick={() => shop(servingCount)}
					><ShoppingBasket size={17} /> Shopping list</button
				><button
					class:active={recipe.saved}
					class="icon-button"
					onclick={save}
					aria-label="Save recipe"
					><Bookmark size={19} fill={recipe.saved ? 'currentColor' : 'none'} /></button
				>
				{#if recipe.saved}<button class="secondary recipe-manage-button" onclick={edit}>Edit</button
					><button class="text-button recipe-manage-button" onclick={remove}>Delete</button>{/if}
			</div>
			<div class="tabs">
				<button class:active={tab === 'recipe'} onclick={() => (tab = 'recipe')}>The recipe</button
				><button class:active={tab === 'nutrition'} onclick={() => (tab = 'nutrition')}
					>Nutrition facts</button
				>
			</div>
			{#if tab === 'recipe'}<div class="recipe-columns" transition:revealMotion|global>
					<div>
						<div class="section-line">
							<h3>Ingredients</h3>
							<label class="servings"
								><input
									aria-label="Servings"
									type="number"
									min="1"
									max="24"
									bind:value={servingCount}
								/> servings</label
							>
						</div>
						<ul class="ingredients-list">
							{#each recipe.ingredients as item}<li>
									<span
										>{+((item.quantity * servingCount) / recipe.servings).toFixed(2)}
										{item.unit}</span
									>{item.name}
								</li>{/each}
						</ul>
					</div>
					<div>
						<h3>Let's make it</h3>
						<ol class="steps-list">
							{#each recipe.steps as step, i}<li>
									<button
										class:done={completed.includes(i)}
										onclick={() =>
											(completed = completed.includes(i)
												? completed.filter((n) => n !== i)
												: [...completed, i])}
										aria-label={`Mark step ${i + 1} complete`}
										>{#if completed.includes(i)}<span transition:fadeMotion|global
												><Check size={16} /></span
											>{:else}<span transition:fadeMotion|global
												>{String(i + 1).padStart(2, '0')}</span
											>{/if}</button
									>
									<p class:muted={completed.includes(i)}>{step}</p>
								</li>{/each}
						</ol>
					</div>
				</div>
			{:else}<div class="nutrition-panel" transition:revealMotion|global>
					{#if recipe.nutritionStale}<p class="nutrition-stale" role="status">Ingredients or servings changed. Refresh this estimate before relying on it.</p>{/if}
					<label class="servings nutrition-selector"
						>Show nutrition for<select bind:value={nutritionMode}
							><option value="serving">One serving</option><option value="recipe"
								>Whole recipe</option
							></select
						></label
					>
					<div class="nutrition-label">
						<h3>Nutrition Facts</h3>
						<div>{recipe.servings} servings per recipe</div>
						<div class="nutrition-row thick">
							<b>Serving size</b><b>{nutritionMode === 'recipe' ? 'Whole recipe' : '1 serving'}</b>
						</div>
						<b class="small">Amount per {nutritionMode === 'recipe' ? 'recipe' : 'serving'}</b>
						<div class="calories">
							<b>Calories</b><strong
								>{Math.round(recipe.nutrition.calories * nutritionMultiplier)}</strong
							>
						</div>
						<div class="nutrition-row">
							<b>Total Fat</b><span>{Math.round(recipe.nutrition.fat * nutritionMultiplier)}g</span>
						</div>
						<div class="nutrition-row">
							<span>Saturated Fat</span><span
								>{Math.round(recipe.nutrition.saturatedFat * nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<b>Sodium</b><span>{Math.round(recipe.nutrition.sodium * nutritionMultiplier)}mg</span
							>
						</div>
						<div class="nutrition-row">
							<b>Total Carbohydrate</b><span
								>{Math.round(recipe.nutrition.carbs * nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<span>Dietary Fiber</span><span
								>{Math.round(recipe.nutrition.fiber * nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<span>Total Sugars</span><span
								>{Math.round(recipe.nutrition.sugar * nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row thick">
							<b>Protein</b><span
								>{Math.round(recipe.nutrition.protein * nutritionMultiplier)}g</span
							>
						</div>
						<p>
							Estimated values. Actual nutrition varies with ingredients and preparation. Not a lab
							analysis.
						</p>
					</div>
					<button class="text-button full" onclick={nutrition} disabled={busy}
						>Refresh nutrition estimate with AI</button
					>
				</div>{/if}
			<div class="rating-box">
				<div>
					<h3>Rate this recipe</h3>
					<p class="muted">Ratings personalize future recipes.</p>
				</div>
				<div class="stars">
					{#each [1, 2, 3, 4, 5] as n}<button
							onclick={() => rate(n)}
							aria-label={`Rate ${n} stars`}
							aria-pressed={recipe.rating === n}
							><Star size={25} fill={(recipe.rating ?? 0) >= n ? 'currentColor' : 'none'} /></button
						>{/each}
				</div>
			</div>
			{#if recipe.source}<a
					class="source-link"
					href={recipe.source}
					target="_blank"
					rel="noreferrer">View original recipe <ArrowUpRight size={15} /></a
				>{/if}
		</div>
	</div>
</div>

<style>
	.recipe-manage-button {
		min-height: 44px;
		padding-inline: 12px;
		white-space: nowrap;
	}
	.nutrition-stale {
		padding: 10px 12px;
		margin-bottom: 14px;
		background: var(--wash);
		color: var(--muted);
		font-size: 14px;
	}
</style>
