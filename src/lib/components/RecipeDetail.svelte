<script lang="ts">
	import { recipePlaceholder } from '#lib/recipe-cover.ts';
	import { isValidServings, MAX_SERVINGS } from '#lib/recipe-draft.ts';
	import { untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion, fadeMotion, revealMotion } from '#lib/motion.ts';
	import {
		clampAllergies,
		evaluateRecipeConflicts,
		normalizeDiet,
		parseAllergies
	} from '#lib/discovery.ts';
	import type { Preferences, Recipe } from '#lib/types.ts';
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
		toggleHidden,
		busy,
		initialServings,
		preferences,
		completedSteps = $bindable<number[]>([])
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
		toggleHidden: () => void;
		busy: boolean;
		initialServings?: number;
		preferences?: Pick<Preferences, 'diet' | 'allergies'>;
		completedSteps?: number[];
	} = $props();
	let nutritionMode = $state('serving');
	let nutritionMultiplier = $derived(nutritionMode === 'recipe' ? recipe.servings : 1);
	let tab = $state('recipe');
	let completed = $derived(
		completedSteps.filter(
			(step) => Number.isInteger(step) && step >= 0 && step < recipe.steps.length
		)
	);
	let servingCount = $state<number | undefined>(untrack(() => initialServings ?? recipe.servings));
	let previousRecipeId = untrack(() => recipe.id);
	let previousRecipeServings = untrack(() => recipe.servings);
	let previousInitialServings = untrack(() => initialServings);
	$effect(() => {
		if (
			recipe.id !== previousRecipeId ||
			recipe.servings !== previousRecipeServings ||
			initialServings !== previousInitialServings
		) {
			previousRecipeId = recipe.id;
			previousRecipeServings = recipe.servings;
			previousInitialServings = initialServings;
			servingCount = initialServings ?? recipe.servings;
		}
	});
	let validServings = $derived(isValidServings(servingCount));
	let conflict = $derived(preferences ? evaluateRecipeConflicts(recipe, preferences) : null);
	let hasActiveGuidance = $derived(
		Boolean(
			preferences &&
			(normalizeDiet(preferences.diet) !== 'none' ||
				parseAllergies(clampAllergies(preferences.allergies)).length > 0)
		)
	);
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
			style:background-image={`url(${JSON.stringify(recipe.image || recipePlaceholder(recipe))}), url(${JSON.stringify(recipePlaceholder(recipe))})`}
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
				<button
					class="primary"
					disabled={!validServings}
					aria-describedby={!validServings ? 'servings-help' : undefined}
					onclick={() => {
						if (validServings && servingCount !== undefined) plan(servingCount);
					}}><CalendarPlus size={17} /> Plan a meal</button
				><button
					class="secondary"
					disabled={!validServings}
					aria-describedby={!validServings ? 'servings-help' : undefined}
					onclick={() => {
						if (validServings && servingCount !== undefined) shop(servingCount);
					}}><ShoppingBasket size={17} /> Shopping list</button
				><button
					class:active={recipe.saved}
					class="icon-button"
					onclick={save}
					aria-label="Save recipe"
					><Bookmark size={19} fill={recipe.saved ? 'currentColor' : 'none'} /></button
				>
				<button class="secondary recipe-manage-button" onclick={toggleHidden}
					>{recipe.hidden ? 'Restore' : 'Hide'}</button
				>
				{#if recipe.saved}<button class="secondary recipe-manage-button" onclick={edit}>Edit</button
					><button class="text-button recipe-manage-button" onclick={remove}>Delete</button>{/if}
			</div>
			{#if !validServings}<p class="field-help" id="servings-help">
					Enter 1–{MAX_SERVINGS.toLocaleString('en-US')} servings to plan or shop.
				</p>{/if}
			{#if conflict?.hasConflict}<div
					class="conflict-banner"
					role="region"
					aria-label="Dietary and allergen guidance"
				>
					<div class="conflict-banner-header">
						<span class="conflict-banner-badge">{conflict.badge}</span>
						<strong>{conflict.summary}</strong>
					</div>
					<p>
						Culinary guidance only — not medical certification{recipe.provenance
							? ' (especially for imported or AI-generated recipes)'
							: ''}. Always verify every ingredient, substitution, and package label before cooking.
					</p>
				</div>{/if}
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
									max={MAX_SERVINGS}
									step="1"
									aria-invalid={!validServings}
									bind:value={servingCount}
								/> servings</label
							>
						</div>
						<ul class="ingredients-list">
							{#each recipe.ingredients as item, idx}{@const reasons =
									conflict?.ingredientReasons[idx]}
								<li class:conflict-ingredient={Boolean(reasons)}>
									<span
										>{validServings && servingCount !== undefined
											? +((item.quantity * servingCount) / recipe.servings).toFixed(2)
											: '—'}
										{item.unit}</span
									><span class="ingredient-line-name"
										>{item.name}{#if reasons?.length}<small class="ingredient-conflict-tag"
												>{reasons.join(', ')}</small
											>{/if}</span
									>
								</li>{/each}
						</ul>
						{#if hasActiveGuidance}<p class="label-check-note">
								Check package labels and sub-ingredients before cooking; dietary and allergy flags
								are culinary guidance, not medical certification.
							</p>{/if}
					</div>
					<div>
						<h3>Let's make it</h3>
						<ol class="steps-list">
							{#each recipe.steps as step, i}<li>
									<button
										class:done={completed.includes(i)}
										aria-pressed={completed.includes(i)}
										aria-label={`Mark step ${i + 1} ${completed.includes(i) ? 'incomplete' : 'complete'}`}
										onclick={() =>
											(completedSteps = completed.includes(i)
												? completed.filter((n) => n !== i)
												: [...completed, i])}
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
					{#if recipe.nutritionStale}<p class="nutrition-stale" role="status">
							Ingredients or servings changed. Refresh this estimate before relying on it.
						</p>{/if}
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
	.servings input {
		width: 76px;
	}
	.nutrition-stale {
		padding: 10px 12px;
		margin-bottom: 14px;
		background: var(--wash);
		color: var(--muted);
		font-size: 14px;
	}
	.conflict-banner {
		padding: 14px 16px;
		margin: 0 0 22px;
		background: #b94e311c;
		border-left: 3px solid #8f3b26;
		color: #8f3b26;
		font-size: 14px;
	}
	:global(.dark) .conflict-banner {
		background: #b94e312b;
		border-left-color: #ffb4a2;
		color: #ffb4a2;
	}
	.conflict-banner-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.conflict-banner-badge {
		padding: 2px 7px;
		background: #8f3b26;
		color: #fffefa;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.6px;
		text-transform: uppercase;
	}
	:global(.dark) .conflict-banner-badge {
		background: #ffb4a2;
		color: #2b1410;
	}
	.conflict-banner p {
		font-size: 13px;
		line-height: 1.6;
	}
	.ingredients-list li.conflict-ingredient {
		padding-inline: 8px;
		background: #b94e3114;
		border-left: 2px solid #8f3b26;
	}
	:global(.dark) .ingredients-list li.conflict-ingredient {
		background: #b94e3126;
		border-left-color: #ffb4a2;
	}
	.ingredient-line-name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		color: var(--ink) !important;
		min-width: 0 !important;
	}
	.ingredient-conflict-tag {
		padding: 1px 6px;
		background: #b94e3120;
		color: #8f3b26;
		font-size: 12px;
		font-weight: 600;
	}
	:global(.dark) .ingredient-conflict-tag {
		background: #b94e3138;
		color: #ffb4a2;
	}
	.label-check-note {
		margin-top: 10px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--muted);
	}
</style>
