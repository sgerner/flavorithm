<script lang="ts">
	import { COVER_PATH, prepareCover } from '#lib/cover-upload.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { tick, untrack } from 'svelte';
	import type { FocusTrapOptions } from '#lib/focus.ts';
	import ModalDialog from '#lib/components/ModalDialog.svelte';
	import {
		NUTRITION_FIELDS,
		emptyRecipeDraftValidation,
		fieldAria,
		focusFirstInvalid,
		validateRecipeDraftFields
	} from '#lib/form-validation.ts';
	import {
		hasRecipeEditorChanges,
		insertDraftItem,
		isValidNutrition,
		MAX_DRAFT_INGREDIENTS,
		MAX_DRAFT_STEPS,
		moveDraftItem
	} from '#lib/recipe-draft.ts';
	import { ArrowDown, ArrowUp, Check, Plus, X } from '@lucide/svelte';
	import type { Recipe } from '#lib/types.ts';
	import FormField from './FormField.svelte';
	let {
		recipe,
		mode = 'edit',
		canUploadCover = false,
		returnFocus,
		fallbackFocus,
		cancel,
		save
	}: {
		recipe: Recipe;
		mode?: 'create' | 'edit';
		canUploadCover?: boolean;
		returnFocus?: FocusTrapOptions['returnFocus'];
		fallbackFocus?: FocusTrapOptions['fallbackFocus'];
		cancel: () => void;
		save: (recipe: Recipe) => void;
	} = $props();
	const initialDraft = untrack(() => ({
		...recipe,
		tags: [...recipe.tags],
		ingredients: recipe.ingredients.map((item) => ({ ...item })),
		steps: [...recipe.steps],
		nutrition: { ...recipe.nutrition }
	}));
	const initialTagsText = initialDraft.tags.join(', ');
	let draft = $state<Recipe>({
		...initialDraft,
		tags: [...initialDraft.tags],
		ingredients: initialDraft.ingredients.map((item) => ({ ...item })),
		steps: [...initialDraft.steps],
		nutrition: { ...initialDraft.nutrition }
	});
	let tagsText = $state(initialTagsText);
	let submitted = $state(false);
	let uploadError = $state('');
	let uploading = $state(false);
	let confirmingDiscard = $state(false);
	let nutritionOpen = $state(untrack(() => !isValidNutrition(draft.nutrition)));
	let photoInput = $state<HTMLInputElement>();
	let formEl = $state<HTMLFormElement>();
	let cancelButton = $state<HTMLButtonElement>();
	let keepEditingButton = $state<HTMLButtonElement>();
	let validation = $derived(
		submitted
			? validateRecipeDraftFields(draft, {
					tagsText,
					checkImage: true,
					coverPathPattern: COVER_PATH
				})
			: emptyRecipeDraftValidation()
	);
	function scrollAndFocus(row: HTMLElement | undefined, control: HTMLElement | null | undefined) {
		row?.scrollIntoView({ block: 'nearest' });
		control?.scrollIntoView({ block: 'nearest' });
		control?.focus({ preventScroll: true });
	}
	async function addIngredient(afterIndex?: number) {
		const inserted = insertDraftItem(
			draft.ingredients,
			afterIndex ?? draft.ingredients.length - 1,
			{ name: '', quantity: 1, unit: 'piece' },
			MAX_DRAFT_INGREDIENTS
		);
		if (!inserted) return;
		confirmingDiscard = false;
		draft.ingredients = inserted.items;
		await tick();
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-ingredient')[inserted.index];
		scrollAndFocus(row, row?.querySelector<HTMLInputElement>('.ingredient-name'));
	}
	async function moveIngredient(index: number, direction: -1 | 1) {
		const moved = moveDraftItem(draft.ingredients, index, direction);
		if (!moved) return;
		confirmingDiscard = false;
		draft.ingredients = moved.items;
		await tick();
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-ingredient')[moved.index];
		const buttons = row?.querySelectorAll<HTMLButtonElement>('.draft-row-actions > button');
		const preferred = buttons?.[direction === -1 ? 0 : 1];
		const fallback = buttons?.[direction === -1 ? 1 : 0];
		scrollAndFocus(
			row,
			preferred && !preferred.disabled
				? preferred
				: fallback && !fallback.disabled
					? fallback
					: row?.querySelector<HTMLInputElement>('.ingredient-name')
		);
	}
	async function removeIngredient(index: number) {
		confirmingDiscard = false;
		draft.ingredients = draft.ingredients.filter((_, i) => i !== index);
		await tick();
		const rows = formEl?.querySelectorAll<HTMLElement>('.draft-ingredient');
		if (rows?.length) {
			const row = rows[Math.min(index, rows.length - 1)];
			row?.querySelector<HTMLInputElement>('.ingredient-name')?.focus({ preventScroll: true });
		} else {
			formEl
				?.querySelectorAll<HTMLButtonElement>('.draft-list-add')[0]
				?.focus({ preventScroll: true });
		}
	}
	async function addStep(afterIndex?: number) {
		const inserted = insertDraftItem(
			draft.steps,
			afterIndex ?? draft.steps.length - 1,
			'',
			MAX_DRAFT_STEPS
		);
		if (!inserted) return;
		confirmingDiscard = false;
		draft.steps = inserted.items;
		await tick();
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-step')[inserted.index];
		scrollAndFocus(row, row?.querySelector<HTMLTextAreaElement>('textarea'));
	}
	async function moveStep(index: number, direction: -1 | 1) {
		const moved = moveDraftItem(draft.steps, index, direction);
		if (!moved) return;
		confirmingDiscard = false;
		draft.steps = moved.items;
		await tick();
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-step')[moved.index];
		const buttons = row?.querySelectorAll<HTMLButtonElement>('.draft-row-actions > button');
		const preferred = buttons?.[direction === -1 ? 0 : 1];
		const fallback = buttons?.[direction === -1 ? 1 : 0];
		scrollAndFocus(
			row,
			preferred && !preferred.disabled
				? preferred
				: fallback && !fallback.disabled
					? fallback
					: row?.querySelector<HTMLTextAreaElement>('textarea')
		);
	}
	async function removeStep(index: number) {
		confirmingDiscard = false;
		draft.steps = draft.steps.filter((_, i) => i !== index);
		await tick();
		const rows = formEl?.querySelectorAll<HTMLElement>('.draft-step');
		if (rows?.length) {
			const row = rows[Math.min(index, rows.length - 1)];
			row?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
		} else {
			formEl
				?.querySelectorAll<HTMLButtonElement>('.draft-list-add')[1]
				?.focus({ preventScroll: true });
		}
	}
	export async function requestCancel() {
		if (
			!hasRecipeEditorChanges(
				{ draft: initialDraft, tagsText: initialTagsText },
				{ draft, tagsText }
			)
		) {
			cancel();
			return;
		}
		confirmingDiscard = true;
		await tick();
		keepEditingButton?.scrollIntoView({ block: 'nearest' });
		keepEditingButton?.focus({ preventScroll: true });
	}
	async function keepEditing() {
		confirmingDiscard = false;
		await tick();
		cancelButton?.focus({ preventScroll: true });
	}
	async function uploadCover(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!canUploadCover || !file) return;
		uploading = true;
		confirmingDiscard = false;
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
		confirmingDiscard = false;
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
				const addButtons = formEl?.querySelectorAll<HTMLButtonElement>('.draft-list-add');
				if (check.ingredientsList) addButtons?.[0]?.focus({ preventScroll: true });
				else if (check.stepsList) addButtons?.[1]?.focus({ preventScroll: true });
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

<ModalDialog
	dialogClass="flavor-dialog wide capture-dialog recipe-editor-dialog"
	labelledBy="recipe-editor-title"
	closeLabel="Close recipe editor"
	{returnFocus}
	{fallbackFocus}
	onclose={() => void requestCancel()}
>
	<h2 id="recipe-editor-title">
		{mode === 'create' ? 'New recipe' : recipe.saved ? 'Edit saved recipe' : 'Edit recipe'}
	</h2>
	<p class="muted">
		{mode === 'create'
			? 'Add a personal recipe to your collection.'
			: 'Changes are saved to your recipe collection.'}
	</p>
	<form
		novalidate
		bind:this={formEl}
		onsubmit={saveDraft}
		oninput={() => (confirmingDiscard = false)}
	>
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
					<textarea bind:value={draft.description} maxlength="10000" rows="2" {...field}></textarea>
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
							confirmingDiscard = false;
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
				class="text-button"
				type="button"
				disabled={draft.ingredients.length >= MAX_DRAFT_INGREDIENTS}
				onclick={() => void addIngredient()}><Plus size={17} />Add</button
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
					<div class="draft-row-actions">
						<button
							class="icon-button"
							type="button"
							aria-label={`Move ingredient ${i + 1} up`}
							disabled={i === 0}
							onclick={() => void moveIngredient(i, -1)}><ArrowUp size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Move ingredient ${i + 1} down`}
							disabled={i === draft.ingredients.length - 1}
							onclick={() => void moveIngredient(i, 1)}><ArrowDown size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Insert below ingredient ${i + 1}`}
							disabled={draft.ingredients.length >= MAX_DRAFT_INGREDIENTS}
							onclick={() => void addIngredient(i)}><Plus size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Remove ingredient ${i + 1}`}
							onclick={() => void removeIngredient(i)}><X size={18} /></button
						>
					</div>
				</div>
				{#if rowError?.name}<p class="error draft-row-error" id={nameAria.errorId}>
						{rowError.name}
					</p>{/if}{#if rowError?.quantity}<p class="error draft-row-error" id={qtyAria.errorId}>
						{rowError.quantity}
					</p>{/if}{#if rowError?.unit}<p class="error draft-row-error" id={unitAria.errorId}>
						{rowError.unit}
					</p>{/if}{/each}
		</div>
		<button
			class="secondary draft-list-add"
			type="button"
			disabled={draft.ingredients.length >= MAX_DRAFT_INGREDIENTS}
			onclick={() => void addIngredient()}><Plus size={17} />Add ingredient</button
		>
		<div class="draft-section-heading">
			<h3>Steps</h3>
			<button
				class="text-button"
				type="button"
				disabled={draft.steps.length >= MAX_DRAFT_STEPS}
				onclick={() => void addStep()}><Plus size={17} />Add</button
			>
		</div>
		{#if validation.stepsList}<p class="error" id="editor-steps-error">
				{validation.stepsList}
			</p>{/if}
		<div class="draft-steps">
			{#each draft.steps as _, i}{@const stepError = validation.steps[i] || ''}{@const stepAria =
					fieldAria(`editor-step-${i}`, { error: stepError })}
				<div class="draft-step">
					<span>{i + 1}</span><textarea
						aria-label={`Step ${i + 1}`}
						bind:value={draft.steps[i]}
						maxlength="10000"
						rows="2"
						{...stepAria.props}></textarea>
					<div class="draft-row-actions">
						<button
							class="icon-button"
							type="button"
							aria-label={`Move step ${i + 1} up`}
							disabled={i === 0}
							onclick={() => void moveStep(i, -1)}><ArrowUp size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Move step ${i + 1} down`}
							disabled={i === draft.steps.length - 1}
							onclick={() => void moveStep(i, 1)}><ArrowDown size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Insert below step ${i + 1}`}
							disabled={draft.steps.length >= MAX_DRAFT_STEPS}
							onclick={() => void addStep(i)}><Plus size={17} /></button
						>
						<button
							class="icon-button"
							type="button"
							aria-label={`Remove step ${i + 1}`}
							onclick={() => void removeStep(i)}><X size={18} /></button
						>
					</div>
				</div>
				{#if stepError}<p class="error draft-row-error" id={stepAria.errorId}>
						{stepError}
					</p>{/if}{/each}
		</div>
		<button
			class="secondary draft-list-add"
			type="button"
			disabled={draft.steps.length >= MAX_DRAFT_STEPS}
			onclick={() => void addStep()}><Plus size={17} />Add step</button
		>
		<details class="import-notes" bind:open={nutritionOpen}>
			<summary>Nutrition estimates</summary>
			<p id="editor-nutrition-help">
				Estimated values per serving. Ingredient or serving changes will mark these values as stale.
			</p>
			<div class="draft-summary">
				{#each NUTRITION_FIELDS as [key, label]}<FormField
						id={`editor-nutrition-${key}`}
						{label}
						helpIds={['editor-nutrition-help']}
						error={validation.nutrition[key] || ''}
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
		<div class="draft-footer" class:confirming-discard={confirmingDiscard}>
			{#if confirmingDiscard}
				<p class="discard-prompt" role="status">Discard unsaved changes?</p>
				<div class="draft-footer-actions">
					<button
						class="secondary"
						type="button"
						bind:this={keepEditingButton}
						onclick={() => void keepEditing()}>Keep editing</button
					>
					<button class="primary danger-button" type="button" onclick={cancel}
						>Discard changes</button
					>
				</div>
			{:else}
				<button
					class="secondary"
					type="button"
					bind:this={cancelButton}
					onclick={() => void requestCancel()}>Cancel</button
				>
				<button class="primary" type="submit" disabled={uploading}
					><Check size={18} />{mode === 'create' ? 'Save recipe' : 'Save changes'}</button
				>
			{/if}
		</div>
	</form>
</ModalDialog>

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
	.draft-summary :global(.full-field) {
		grid-column: 1 / -1;
	}
	@media (max-width: 650px) {
		:global(.flavor-dialog.wide.recipe-editor-dialog) {
			padding: 28px 16px 20px;
		}
	}
</style>
