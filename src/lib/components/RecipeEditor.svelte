<script lang="ts">
	import { COVER_PATH, prepareCover } from '#lib/cover-upload.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { tick, untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
	import {
		NUTRITION_FIELDS,
		emptyRecipeDraftValidation,
		fieldAria,
		focusFirstInvalid,
		validateRecipeDraftFields
	} from '#lib/form-validation.ts';
	import { isValidNutrition } from '#lib/recipe-draft.ts';
	import { backdropMotion, dialogMotion } from '#lib/motion.ts';
	import { Check, Plus, X } from '@lucide/svelte';
	import type { Recipe } from '#lib/types.ts';
	import FormField from './FormField.svelte';
	let {
		recipe,
		mode = 'edit',
		canUploadCover = false,
		cancel,
		save
	}: {
		recipe: Recipe;
		mode?: 'create' | 'edit';
		canUploadCover?: boolean;
		cancel: () => void;
		save: (recipe: Recipe) => void;
	} = $props();
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
	let submitted = $state(false);
	let uploadError = $state('');
	let uploading = $state(false);
	let nutritionOpen = $state(untrack(() => !isValidNutrition(draft.nutrition)));
	let photoInput = $state<HTMLInputElement>();
	let formEl = $state<HTMLFormElement>();
	let addIngredientButton = $state<HTMLButtonElement>();
	let addStepButton = $state<HTMLButtonElement>();
	let validation = $derived(
		submitted
			? validateRecipeDraftFields(draft, {
					tagsText,
					checkImage: true,
					coverPathPattern: COVER_PATH
				})
			: emptyRecipeDraftValidation()
	);
	async function uploadCover(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!canUploadCover || !file) return;
		uploading = true;
		uploadError = '';
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
			uploadError = cause instanceof Error ? cause.message : 'Could not read that photo.';
		} finally {
			uploading = false;
			input.value = '';
		}
	}
	async function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		if (uploading) return;
		uploadError = '';
		const check = validateRecipeDraftFields(draft, {
			tagsText,
			checkImage: true,
			coverPathPattern: COVER_PATH
		});
		if (check.hasErrors) {
			submitted = true;
			if (check.hasNutritionErrors) nutritionOpen = true;
			await tick();
			if (!focusFirstInvalid(formEl)) {
				if (check.ingredientsList) addIngredientButton?.focus();
				else if (check.stepsList) addStepButton?.focus();
			}
			return;
		}
		submitted = false;
		const title = draft.title.trim();
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
		try {
			save({
				...draft,
				title,
				description: draft.description.trim().slice(0, 10000),
				image,
				cuisine: draft.cuisine.trim().slice(0, 100),
				difficulty: draft.difficulty.trim().slice(0, 80),
				tags,
				ingredients,
				steps
			});
		} catch (cause) {
			uploadError = cause instanceof Error ? cause.message : 'Could not save this recipe.';
		}
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
		<h2 id="recipe-editor-title">{mode === 'create' ? 'New recipe' : 'Edit saved recipe'}</h2>
		<p class="muted">
			{mode === 'create'
				? 'Add a personal recipe to your collection.'
				: 'Changes are saved to your recipe collection.'}
		</p>
		<form novalidate bind:this={formEl} onsubmit={saveDraft}>
			<div class="draft-summary">
				<FormField id="editor-title" class="draft-title" label="Title" error={validation.title}>
					{#snippet children(field)}
						<input bind:value={draft.title} maxlength="200" {...field} />
					{/snippet}
				</FormField>
				<FormField id="editor-time" label="Time (minutes)" error={validation.time}>
					{#snippet children(field)}
						<input type="number" bind:value={draft.time} min="1" max="100000" step="1" {...field} />
					{/snippet}
				</FormField>
				<FormField id="editor-servings" label="Servings" error={validation.servings}>
					{#snippet children(field)}
						<input
							type="number"
							bind:value={draft.servings}
							min="1"
							max="10000"
							step="1"
							{...field}
						/>
					{/snippet}
				</FormField>
				<FormField id="editor-cuisine" label="Cuisine" error={validation.cuisine}>
					{#snippet children(field)}
						<input bind:value={draft.cuisine} maxlength="100" {...field} />
					{/snippet}
				</FormField>
				<FormField id="editor-difficulty" label="Difficulty" error={validation.difficulty}>
					{#snippet children(field)}
						<input bind:value={draft.difficulty} maxlength="80" {...field} />
					{/snippet}
				</FormField>
				<FormField
					id="editor-description"
					class="full-field"
					label="Description"
					error={validation.description}
				>
					{#snippet children(field)}
						<textarea bind:value={draft.description} maxlength="10000" rows="2" {...field}
						></textarea>
					{/snippet}
				</FormField>
				<div class="full-field cover-picker">
					<img
						src={draft.image || recipePlaceholder(draft)}
						alt="Recipe cover preview"
						onerror={(event) => recipeImageError(event, draft)}
					/>
					{#if canUploadCover}<input
							hidden
							type="file"
							accept="image/jpeg,image/png,image/webp"
							aria-label="Upload cover photo"
							bind:this={photoInput}
							onchange={uploadCover}
							disabled={uploading}
						/>
						<button
							type="button"
							class="secondary"
							aria-describedby="editor-cover-help"
							disabled={uploading}
							onclick={() => photoInput?.click()}
							>{uploading ? 'Uploading…' : 'Upload cover photo'}</button
						>{/if}
					{#if draft.image}<button
							type="button"
							class="text-button"
							disabled={uploading}
							onclick={() => {
								draft.image = '';
							}}>Remove cover</button
						>{/if}
					<p class="muted" id="editor-cover-help">
						{canUploadCover
							? 'JPG, PNG, or WebP up to 10 MB. Photos are resized and shared with your household.'
							: 'Paste a public HTTPS image link below, or sign in while online to upload a cover photo.'}
					</p>
				</div>
				{#if !COVER_PATH.test(draft.image)}<FormField
						id="editor-image"
						class="full-field"
						label="Image URL"
						help="Optional public HTTPS image URL."
						error={validation.image}
					>
						{#snippet children(field)}
							<input
								bind:value={draft.image}
								maxlength="4000"
								type="text"
								placeholder="https://… (optional)"
								disabled={uploading}
								{...field}
							/>
						{/snippet}
					</FormField>{/if}
				<FormField
					id="editor-tags"
					class="full-field"
					label="Tags"
					help="Separate tags with commas (up to 30 tags)."
					error={validation.tags}
				>
					{#snippet children(field)}
						<input
							bind:value={tagsText}
							maxlength="3029"
							placeholder="weeknight, vegetarian"
							{...field}
						/>
					{/snippet}
				</FormField>
			</div>
			<div class="draft-section-heading">
				<h3>Ingredients</h3>
				<button
					bind:this={addIngredientButton}
					class="text-button"
					type="button"
					disabled={draft.ingredients.length >= 60}
					onclick={() => draft.ingredients.push({ name: '', quantity: 1, unit: 'piece' })}
					><Plus size={17} />Add</button
				>
			</div>
			{#if validation.ingredientsList}<p class="error" id="editor-ingredients-error">
					{validation.ingredientsList}
				</p>{/if}
			<div class="draft-ingredients">
				{#each draft.ingredients as item, i}{@const rowError =
						validation.ingredients[i]}{@const nameAria = fieldAria(`editor-ingredient-${i}-name`, {
						error: rowError?.name
					})}{@const qtyAria = fieldAria(`editor-ingredient-${i}-quantity`, {
						error: rowError?.quantity
					})}{@const unitAria = fieldAria(`editor-ingredient-${i}-unit`, {
						error: rowError?.unit
					})}
					<div class="draft-ingredient">
						<input
							class="ingredient-name"
							aria-label={`Ingredient ${i + 1}`}
							bind:value={item.name}
							maxlength="100"
							placeholder="Ingredient"
							{...nameAria.props}
						/>
						<input
							class="ingredient-quantity"
							aria-label={`Quantity for ingredient ${i + 1}`}
							type="number"
							bind:value={item.quantity}
							min="0.000001"
							max="1000000"
							step="any"
							{...qtyAria.props}
						/>
						<input
							class="ingredient-unit"
							aria-label={`Unit for ingredient ${i + 1}`}
							bind:value={item.unit}
							maxlength="40"
							placeholder="Unit"
							{...unitAria.props}
						/>
						<button
							class="icon-button"
							type="button"
							aria-label={`Remove ingredient ${i + 1}`}
							onclick={() =>
								(draft.ingredients = draft.ingredients.filter((_, index) => index !== i))}
							><X size={18} /></button
						>
					</div>
					{#if rowError?.name}<p class="error draft-row-error" id={nameAria.errorId}>
							{rowError.name}
						</p>{/if}{#if rowError?.quantity}<p class="error draft-row-error" id={qtyAria.errorId}>
							{rowError.quantity}
						</p>{/if}{#if rowError?.unit}<p class="error draft-row-error" id={unitAria.errorId}>
							{rowError.unit}
						</p>{/if}{/each}
			</div>
			<div class="draft-section-heading">
				<h3>Steps</h3>
				<button
					bind:this={addStepButton}
					class="text-button"
					type="button"
					disabled={draft.steps.length >= 40}
					onclick={() => draft.steps.push('')}><Plus size={17} />Add</button
				>
			</div>
			{#if validation.stepsList}<p class="error" id="editor-steps-error">
					{validation.stepsList}
				</p>{/if}
			{#each draft.steps as step, i}{@const stepError = validation.steps[i] || ''}{@const stepAria =
					fieldAria(`editor-step-${i}`, { error: stepError })}
				<div class="draft-step">
					<span>{i + 1}</span><textarea
						aria-label={`Step ${i + 1}`}
						bind:value={draft.steps[i]}
						maxlength="10000"
						rows="2"
						{...stepAria.props}></textarea>
					<button
						class="icon-button"
						type="button"
						aria-label={`Remove step ${i + 1}`}
						onclick={() => (draft.steps = draft.steps.filter((_, index) => index !== i))}
						><X size={18} /></button
					>
				</div>
				{#if stepError}<p class="error draft-row-error" id={stepAria.errorId}>
						{stepError}
					</p>{/if}{/each}
			<details class="import-notes" bind:open={nutritionOpen}>
				<summary>Nutrition estimates</summary>
				<p>
					Estimated values per serving. Ingredient or serving changes will mark these values as
					stale.
				</p>
				<div class="draft-summary">
					{#each NUTRITION_FIELDS as [key, label]}<FormField
							id={`editor-nutrition-${key}`}
							{label}
							error={validation.nutrition[key]}
						>
							{#snippet children(field)}
								<input
									type="number"
									min="0"
									max="1000000"
									step="any"
									bind:value={draft.nutrition[key]}
									{...field}
								/>
							{/snippet}
						</FormField>{/each}
				</div>
			</details>
			{#if uploadError || validation.summary}<p class="error" role="alert">
					{uploadError || validation.summary}
				</p>{/if}
			<div class="draft-footer">
				<button class="secondary" type="button" onclick={cancel}>Cancel</button>
				<button class="primary" type="submit" disabled={uploading}
					><Check size={18} />{mode === 'create' ? 'Save recipe' : 'Save changes'}</button
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
	.recipe-editor-dialog :global(.full-field) {
		grid-column: 1 / -1;
	}
	@media (max-width: 650px) {
		.recipe-editor-dialog {
			padding: 28px 16px 20px;
		}
	}
</style>
