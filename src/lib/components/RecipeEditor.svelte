<script lang="ts">
	import { COVER_PATH, prepareCover } from '#lib/cover-upload.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion } from '#lib/motion.ts';
	import { Check, Plus, X } from '@lucide/svelte';
	import type { Recipe } from '#lib/types.ts';
	let {
		recipe,
		cancel,
		save
	}: { recipe: Recipe; cancel: () => void; save: (recipe: Recipe) => void } = $props();
	let draft = $state<Recipe>(
		untrack(() => ({
			...recipe,
			tags: [...recipe.tags],
			ingredients: recipe.ingredients.map((item) => ({ ...item })),
			steps: [...recipe.steps],
			nutrition: { ...recipe.nutrition }
		}))
	);
	let tagsText = $state(draft.tags.join(', '));
	let error = $state('');
	let uploading = $state(false);
	let photoInput: HTMLInputElement;
	async function uploadCover(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploading = true;
		error = '';
		try {
			const body = await prepareCover(file);
			const response = await fetch('/api/recipe-covers', {
				method: 'POST',
				headers: { 'Content-Type': 'image/jpeg' },
				body
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Could not upload the cover photo.');
			draft.image = result.image;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not read that photo.';
		} finally {
			uploading = false;
			input.value = '';
		}
	}
	const nutritionFields: [keyof Recipe['nutrition'], string][] = [
		['calories', 'Calories (kcal)'],
		['fat', 'Fat (g)'],
		['saturatedFat', 'Saturated fat (g)'],
		['sodium', 'Sodium (mg)'],
		['carbs', 'Carbohydrates (g)'],
		['fiber', 'Fiber (g)'],
		['sugar', 'Sugar (g)'],
		['protein', 'Protein (g)']
	];
	function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		if (uploading) return;
		const tags = [
			...new Set(
				tagsText
					.split(',')
					.map((tag) => tag.trim())
					.filter(Boolean)
			)
		];
		const ingredients = draft.ingredients.map((item) => ({
			...item,
			name: item.name.trim(),
			unit: item.unit.trim()
		}));
		const steps = draft.steps.map((step) => step.trim()).filter(Boolean);
		const image = draft.image.trim();
		if (image && !COVER_PATH.test(image)) {
			try {
				const url = new URL(image);
				if (url.protocol !== 'https:' || url.username || url.password)
					throw new Error('Invalid image');
			} catch {
				error = 'Use a public HTTPS image URL, or leave it blank.';
				return;
			}
		}
		if (
			!draft.title.trim() ||
			!Number.isFinite(draft.time) ||
			draft.time < 1 ||
			draft.time > 100000 ||
			!Number.isFinite(draft.servings) ||
			draft.servings < 1 ||
			draft.servings > 10000 ||
			!ingredients.length ||
			ingredients.length > 60 ||
			ingredients.some(
				(item) =>
					!item.name ||
					!item.unit ||
					!Number.isFinite(item.quantity) ||
					item.quantity <= 0 ||
					item.quantity > 1000000
			) ||
			!steps.length ||
			steps.length > 40 ||
			steps.some((step) => step.length > 10000) ||
			tags.length > 30 ||
			tags.some((tag) => tag.length > 100) ||
			!nutritionFields.every(
				([key]) =>
					Number.isFinite(draft.nutrition[key]) &&
					draft.nutrition[key] >= 0 &&
					draft.nutrition[key] <= 1000000
			)
		) {
			error =
				'Check the title, cooking time, servings, tags, ingredient quantities, cooking steps, and nutrition values.';
			return;
		}
		save({
			...draft,
			title: draft.title.trim(),
			description: draft.description.trim(),
			image,
			cuisine: draft.cuisine.trim(),
			difficulty: draft.difficulty.trim(),
			tags,
			ingredients,
			steps
		});
	}
</script>

<div class="modal-backdrop" transition:backdropMotion|global>
	<div
		class="flavor-dialog wide capture-dialog recipe-editor-dialog"
		use:focusTrap
		role="dialog"
		aria-modal="true"
		aria-labelledby="recipe-editor-title"
		tabindex="-1"
		transition:dialogMotion|global
	>
		<h2 id="recipe-editor-title">Edit saved recipe</h2>
		<p class="muted">Changes are saved to your recipe collection.</p>
		<form onsubmit={saveDraft}>
			<div class="draft-summary">
				<label class="field draft-title"
					>Title<input bind:value={draft.title} required maxlength="200" /></label
				>
				<label class="field"
					>Time (minutes)<input
						type="number"
						bind:value={draft.time}
						min="1"
						max="100000"
						step="1"
						required
					/></label
				>
				<label class="field"
					>Servings<input
						type="number"
						bind:value={draft.servings}
						min="1"
						max="10000"
						step="1"
						required
					/></label
				>
				<label class="field">Cuisine<input bind:value={draft.cuisine} maxlength="100" /></label>
				<label class="field">Difficulty<input bind:value={draft.difficulty} maxlength="80" /></label
				>
				<label class="field full-field"
					>Description<textarea bind:value={draft.description} maxlength="10000" rows="2"
					></textarea></label
				>
				<div class="full-field cover-picker">
					<img
						src={draft.image || recipePlaceholder(draft)}
						alt="Recipe cover preview"
						onerror={(event) => recipeImageError(event, draft)}
					/>
					<input
						hidden
						type="file"
						accept="image/jpeg,image/png,image/webp"
						bind:this={photoInput}
						onchange={uploadCover}
						disabled={uploading}
					/>
					<button
						type="button"
						class="secondary"
						disabled={uploading}
						onclick={() => photoInput.click()}
						>{uploading ? 'Uploading…' : 'Upload cover photo'}</button
					>
					{#if draft.image}<button
							type="button"
							class="text-button"
							disabled={uploading}
							onclick={() => {
								draft.image = '';
							}}>Remove cover</button
						>{/if}
					<p class="muted">
						JPG, PNG, or WebP up to 10 MB. Photos are resized and shared with your household.
						Sign-in and an internet connection are required.
					</p>
				</div>
				{#if !COVER_PATH.test(draft.image)}<label class="field full-field"
						>Image URL<input
							bind:value={draft.image}
							maxlength="4000"
							type="text"
							placeholder="https://… (optional)"
							disabled={uploading}
						/></label
					>{/if}
				<label class="field full-field"
					>Tags<input
						bind:value={tagsText}
						maxlength="3029"
						placeholder="weeknight, vegetarian"
					/></label
				>
			</div>
			<div class="draft-section-heading">
				<h3>Ingredients</h3>
				<button
					class="text-button"
					type="button"
					disabled={draft.ingredients.length >= 60}
					onclick={() => draft.ingredients.push({ name: '', quantity: 1, unit: 'piece' })}
					><Plus size={17} />Add</button
				>
			</div>
			<div class="draft-ingredients">
				{#each draft.ingredients as item, i}<div class="draft-ingredient">
						<input
							class="ingredient-name"
							aria-label={`Ingredient ${i + 1}`}
							bind:value={item.name}
							required
							maxlength="100"
							placeholder="Ingredient"
						/>
						<input
							class="ingredient-quantity"
							aria-label={`Quantity for ingredient ${i + 1}`}
							type="number"
							bind:value={item.quantity}
							required
							min="0.000001"
							max="1000000"
							step="any"
						/>
						<input
							class="ingredient-unit"
							aria-label={`Unit for ingredient ${i + 1}`}
							bind:value={item.unit}
							required
							maxlength="40"
							placeholder="Unit"
						/>
						<button
							class="icon-button"
							type="button"
							aria-label={`Remove ingredient ${i + 1}`}
							onclick={() =>
								(draft.ingredients = draft.ingredients.filter((_, index) => index !== i))}
							><X size={18} /></button
						>
					</div>{/each}
			</div>
			<div class="draft-section-heading">
				<h3>Steps</h3>
				<button
					class="text-button"
					type="button"
					disabled={draft.steps.length >= 40}
					onclick={() => draft.steps.push('')}><Plus size={17} />Add</button
				>
			</div>
			{#each draft.steps as step, i}<div class="draft-step">
					<span>{i + 1}</span><textarea
						aria-label={`Step ${i + 1}`}
						bind:value={draft.steps[i]}
						required
						maxlength="10000"
						rows="2"></textarea>
					<button
						class="icon-button"
						type="button"
						aria-label={`Remove step ${i + 1}`}
						onclick={() => (draft.steps = draft.steps.filter((_, index) => index !== i))}
						><X size={18} /></button
					>
				</div>{/each}
			<details class="import-notes">
				<summary>Nutrition estimates</summary>
				<p>
					Estimated values per serving. Ingredient or serving changes will mark these values as
					stale.
				</p>
				<div class="draft-summary">
					{#each nutritionFields as [key, label]}<label class="field"
							>{label}<input
								type="number"
								min="0"
								max="1000000"
								step="any"
								required
								bind:value={draft.nutrition[key]}
							/></label
						>{/each}
				</div>
			</details>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="draft-footer">
				<button class="secondary" type="button" onclick={cancel}>Cancel</button>
				<button class="primary" type="submit" disabled={uploading}
					><Check size={18} />Save changes</button
				>
			</div>
		</form>
	</div>
</div>

<style>
	.cover-picker img {
		width: 100%;
		height: 180px;
		object-fit: cover;
		border-radius: 12px;
		margin-bottom: 12px;
	}
	.cover-picker p {
		font-size: 13px;
		margin-top: 10px;
	}
	.recipe-editor-dialog .full-field {
		grid-column: 1 / -1;
	}
	@media (max-width: 650px) {
		.recipe-editor-dialog {
			padding: 28px 16px 20px;
		}
	}
</style>
