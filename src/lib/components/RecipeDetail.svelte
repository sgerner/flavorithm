<script lang="ts">
	import { recipePlaceholder } from '#lib/recipe-cover.ts';
	import { untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion, fadeMotion, revealMotion } from '#lib/motion.ts';
	import {
		RATING_STARS,
		bookmarkLabel,
		isValidServings,
		nextRatingStarForKey,
		nextRecipeTabForKey,
		nutritionAmountHeading,
		nutritionMultiplierFor,
		nutritionServingSizeLabel,
		resolveActiveServings,
		resolveServingsFallback,
		scaleIngredientQuantity,
		scaleNutritionValue,
		starRatingLabel,
		stepServings,
		toggleRecipeRating,
		type NutritionMode,
		type RecipeTab
	} from '#lib/recipe-detail.ts';
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
		toggleHidden,
		busy,
		initialServings,
		completedSteps = $bindable<number[]>([])
	}: {
		recipe: Recipe;
		close: () => void;
		save: () => void;
		shop: (servings: number) => void;
		plan: (servings: number) => void;
		rate: (n: number | undefined) => void;
		nutrition: () => void;
		edit: () => void;
		remove: () => void;
		toggleHidden: () => void;
		busy: boolean;
		initialServings?: number;
		completedSteps?: number[];
	} = $props();
	let nutritionMode = $state<NutritionMode>('serving');
	let tab = $state<RecipeTab>('recipe');
	let completed = $derived(
		completedSteps.filter(
			(step) => Number.isInteger(step) && step >= 0 && step < recipe.steps.length
		)
	);
	const initialCount = untrack(() => initialServings ?? recipe.servings);
	let servingCount = $state<number | null | undefined>(initialCount);
	let lastValidServings = $state<number>(
		untrack(() => resolveServingsFallback(initialCount, recipe.servings))
	);
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
			const nextServings = initialServings ?? recipe.servings;
			servingCount = nextServings;
			lastValidServings = resolveServingsFallback(nextServings, recipe.servings);
		} else if (isValidServings(servingCount)) {
			lastValidServings = servingCount;
		}
	});
	let validServings = $derived(isValidServings(servingCount));
	let activeServings = $derived(resolveActiveServings(servingCount, lastValidServings));
	let nutritionMultiplier = $derived(
		nutritionMultiplierFor(nutritionMode, recipe.servings, activeServings)
	);
	let recipeTabButton = $state<HTMLButtonElement | null>(null);
	let nutritionTabButton = $state<HTMLButtonElement | null>(null);
	let starButtons = $state<Array<HTMLButtonElement | null>>([]);

	function adjustServings(delta: -1 | 1) {
		const next = stepServings(servingCount, delta, lastValidServings);
		servingCount = next;
		lastValidServings = next;
	}

	function handleTabKeydown(event: KeyboardEvent) {
		const nextTab = nextRecipeTabForKey(tab, event.key);
		if (!nextTab) return;
		event.preventDefault();
		tab = nextTab;
		(nextTab === 'recipe' ? recipeTabButton : nutritionTabButton)?.focus();
	}

	function handleRatingKeydown(event: KeyboardEvent, currentStar: number) {
		const nextStar = nextRatingStarForKey(currentStar, event.key);
		if (nextStar === undefined) return;
		event.preventDefault();
		rate(nextStar);
		starButtons[nextStar - 1]?.focus();
	}
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
						if (isValidServings(servingCount)) plan(servingCount);
					}}><CalendarPlus size={17} /> Plan a meal</button
				><button
					class="secondary"
					disabled={!validServings}
					aria-describedby={!validServings ? 'servings-help' : undefined}
					onclick={() => {
						if (isValidServings(servingCount)) shop(servingCount);
					}}><ShoppingBasket size={17} /> Shopping list</button
				><button
					class:active={recipe.saved}
					class="icon-button"
					onclick={save}
					aria-pressed={Boolean(recipe.saved)}
					aria-label={bookmarkLabel(recipe.saved)}
					><Bookmark size={19} fill={recipe.saved ? 'currentColor' : 'none'} /></button
				>
				<button class="secondary recipe-manage-button" onclick={toggleHidden}
					>{recipe.hidden ? 'Restore' : 'Hide'}</button
				>
				{#if recipe.saved}<button class="secondary recipe-manage-button" onclick={edit}>Edit</button
					><button class="text-button recipe-manage-button" onclick={remove}>Delete</button>{/if}
			</div>
			<div class="tabs" role="tablist" aria-label="Recipe details">
				<button
					bind:this={recipeTabButton}
					type="button"
					id="recipe-tab-recipe"
					role="tab"
					aria-selected={tab === 'recipe'}
					aria-controls="recipe-panel-recipe"
					tabindex={tab === 'recipe' ? 0 : -1}
					class:active={tab === 'recipe'}
					onclick={() => (tab = 'recipe')}
					onkeydown={handleTabKeydown}>The recipe</button
				><button
					bind:this={nutritionTabButton}
					type="button"
					id="recipe-tab-nutrition"
					role="tab"
					aria-selected={tab === 'nutrition'}
					aria-controls="recipe-panel-nutrition"
					tabindex={tab === 'nutrition' ? 0 : -1}
					class:active={tab === 'nutrition'}
					onclick={() => (tab = 'nutrition')}
					onkeydown={handleTabKeydown}>Nutrition facts</button
				>
			</div>
			{#if tab === 'recipe'}<div
					id="recipe-panel-recipe"
					role="tabpanel"
					aria-labelledby="recipe-tab-recipe"
					class="recipe-columns"
					in:revealMotion|global
				>
					<div>
						<div class="section-line">
							<h3>Ingredients</h3>
							<div class="servings" role="group" aria-label="Adjust servings">
								<label for="recipe-servings">Servings</label><button
									type="button"
									aria-label="Decrease servings"
									onclick={() => adjustServings(-1)}>-</button
								><input
									id="recipe-servings"
									type="number"
									inputmode="numeric"
									min="1"
									max="24"
									step="1"
									aria-invalid={!validServings}
									aria-describedby={!validServings ? 'servings-help' : undefined}
									bind:value={servingCount}
								/><button
									type="button"
									aria-label="Increase servings"
									onclick={() => adjustServings(1)}>+</button
								>
							</div>
						</div>
						<p class="servings-help" id="servings-help" aria-live="polite">
							{#if !validServings}Enter 1–24 servings to plan or shop.{/if}
						</p>
						<ul class="ingredients-list">
							{#each recipe.ingredients as item}<li>
									<span
										>{scaleIngredientQuantity(item.quantity, recipe.servings, activeServings)}
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
										aria-pressed={completed.includes(i)}
										aria-label={`Mark step ${i + 1} ${completed.includes(i) ? 'incomplete' : 'complete'}`}
										onclick={() =>
											(completedSteps = completed.includes(i)
												? completed.filter((n) => n !== i)
												: [...completed, i])}
										>{#if completed.includes(i)}<span transition:fadeMotion
												><Check size={16} /></span
											>{:else}<span transition:fadeMotion>{String(i + 1).padStart(2, '0')}</span
											>{/if}</button
									>
									<p class:muted={completed.includes(i)}>{step}</p>
								</li>{/each}
						</ol>
					</div>
				</div>
			{:else}<div
					id="recipe-panel-nutrition"
					role="tabpanel"
					aria-labelledby="recipe-tab-nutrition"
					class="nutrition-panel"
					in:revealMotion|global
				>
					<p class="visually-hidden" id="servings-help">Enter 1–24 servings to plan or shop.</p>
					{#if recipe.nutritionStale}<p class="nutrition-stale" role="status">
							Ingredients or servings changed. Refresh this estimate before relying on it.
						</p>{/if}
					<label class="servings nutrition-selector"
						>Show nutrition for<select bind:value={nutritionMode}
							><option value="serving">One serving</option><option value="scaled"
								>Scaled servings</option
							><option value="recipe">Whole recipe</option></select
						></label
					>
					<div class="nutrition-label">
						<h3>Nutrition Facts</h3>
						<div>{recipe.servings} servings per recipe</div>
						<div class="nutrition-row thick">
							<b>Serving size</b><b>{nutritionServingSizeLabel(nutritionMode, activeServings)}</b>
						</div>
						<b class="small">{nutritionAmountHeading(nutritionMode, activeServings)}</b>
						<div class="calories">
							<b>Calories</b><strong
								>{scaleNutritionValue(recipe.nutrition.calories, nutritionMultiplier)}</strong
							>
						</div>
						<div class="nutrition-row">
							<b>Total Fat</b><span
								>{scaleNutritionValue(recipe.nutrition.fat, nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<span>Saturated Fat</span><span
								>{scaleNutritionValue(recipe.nutrition.saturatedFat, nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<b>Sodium</b><span
								>{scaleNutritionValue(recipe.nutrition.sodium, nutritionMultiplier)}mg</span
							>
						</div>
						<div class="nutrition-row">
							<b>Total Carbohydrate</b><span
								>{scaleNutritionValue(recipe.nutrition.carbs, nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<span>Dietary Fiber</span><span
								>{scaleNutritionValue(recipe.nutrition.fiber, nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row">
							<span>Total Sugars</span><span
								>{scaleNutritionValue(recipe.nutrition.sugar, nutritionMultiplier)}g</span
							>
						</div>
						<div class="nutrition-row thick">
							<b>Protein</b><span
								>{scaleNutritionValue(recipe.nutrition.protein, nutritionMultiplier)}g</span
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
					<h3 id="recipe-rating-heading">Rate this recipe</h3>
					<p class="muted">Ratings personalize future recipes.</p>
				</div>
				<div class="rating-controls">
					<div class="stars" role="radiogroup" aria-labelledby="recipe-rating-heading">
						{#each RATING_STARS as n, index}<button
								bind:this={starButtons[index]}
								type="button"
								role="radio"
								aria-checked={recipe.rating === n}
								aria-label={starRatingLabel(n)}
								onclick={() => rate(toggleRecipeRating(recipe.rating, n))}
								onkeydown={(event) => handleRatingKeydown(event, n)}
								><Star
									size={25}
									fill={(recipe.rating ?? 0) >= n ? 'currentColor' : 'none'}
								/></button
							>{/each}
					</div>
					{#if recipe.rating !== undefined}<button
							type="button"
							class="text-button clear-rating"
							onclick={() => {
								const fallback = starButtons[(recipe.rating ?? 1) - 1] ?? starButtons[0];
								rate(undefined);
								fallback?.focus();
							}}>Clear rating</button
						>{/if}
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
