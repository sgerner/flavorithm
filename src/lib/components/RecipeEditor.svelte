<script lang="ts">
	import { COVER_PATH, prepareCover } from '#lib/cover-upload.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { tick, untrack } from 'svelte';
	import { busyAction, focusHandoff, focusTrap } from '#lib/focus.ts';
	import { backdropMotion, dialogMotion } from '#lib/motion.ts';
	import {
		describeInvalidControl,
		hasRecipeEditorChanges,
		insertDraftItem,
		MAX_DRAFT_INGREDIENTS,
		MAX_DRAFT_STEPS,
		moveDraftItem,
		openClosedImportNotes
	} from '#lib/recipe-draft.ts';
	import { ArrowDown, ArrowUp, Check, Plus, X } from '@lucide/svelte';
	import type { Recipe } from '#lib/types.ts';
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
	let error = $state('');
	let uploading = $state(false);
	let confirmingDiscard = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let formEl = $state<HTMLFormElement>();
	let nutritionDetails = $state<HTMLDetailsElement>();
	let cancelButton = $state<HTMLButtonElement>();
	let keepEditingButton = $state<HTMLButtonElement>();
	let pendingInvalid: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
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
	async function handleInvalid(event: Event) {
		const target = event.target;
		if (!(
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			target instanceof HTMLSelectElement
		)) {
			return;
		}
		openClosedImportNotes(target);
		if (nutritionDetails?.open) nutritionOpen = true;
		event.preventDefault();
		if (pendingInvalid) return;
		pendingInvalid = target;
		confirmingDiscard = false;
		error = describeInvalidControl(target);
		await tick();
		const control = pendingInvalid;
		pendingInvalid = null;
		scrollAndFocus(
			control.closest<HTMLElement>('.field, .draft-ingredient, .draft-step') ?? undefined,
			control
		);
	}
	async function requestCancel() {
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
		if (!canUploadCover || !file || uploading) return;
		uploading = true;
		confirmingDiscard = false;
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
	function isNutritionValid(target: Recipe): boolean {
		return nutritionFields.every(
			([key]) =>
				typeof target.nutrition[key] === 'number' &&
				Number.isFinite(target.nutrition[key]) &&
				target.nutrition[key] >= 0 &&
				target.nutrition[key] <= 1000000
		);
	}
	let nutritionOpen = $state(untrack(() => !isNutritionValid(draft)));
	async function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		if (uploading) return;
		error = '';
		confirmingDiscard = false;
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
		const invalidNutritionIndex = nutritionFields.findIndex(
			([key]) =>
				typeof draft.nutrition[key] !== 'number' ||
				!Number.isFinite(draft.nutrition[key]) ||
				draft.nutrition[key] < 0 ||
				draft.nutrition[key] > 1000000
		);
		const nutritionValid = invalidNutritionIndex === -1;
		if (
			!title ||
			title.length > 200 ||
			!Number.isInteger(draft.time) ||
			draft.time < 1 ||
			draft.time > 100000 ||
			!Number.isInteger(draft.servings) ||
			draft.servings < 1 ||
			draft.servings > 10000 ||
			!ingredients.length ||
			ingredients.length > MAX_DRAFT_INGREDIENTS ||
			ingredients.some(
				(item) =>
					!item.name ||
					item.name.length > 200 ||
					!item.unit ||
					item.unit.length > 40 ||
					!Number.isFinite(item.quantity) ||
					item.quantity <= 0 ||
					item.quantity > 1000000
			) ||
			!steps.length ||
			steps.length > MAX_DRAFT_STEPS ||
			steps.some((step) => step.length > 10000) ||
			tags.length > 30 ||
			tags.some((tag) => tag.length > 100) ||
			!nutritionValid
		) {
			if (!nutritionValid) nutritionOpen = true;
			error =
				'Check the title, cooking time, servings, tags, ingredient quantities, cooking steps, and nutrition values.';
			if (invalidNutritionIndex !== -1 && nutritionDetails) {
				nutritionDetails.open = true;
				await tick();
				const input =
					nutritionDetails.querySelectorAll<HTMLInputElement>('input')[invalidNutritionIndex];
				scrollAndFocus(input?.closest<HTMLElement>('.field') ?? undefined, input);
			}
			return;
		}
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
			error = cause instanceof Error ? cause.message : 'Could not save this recipe.';
		}
	}
</script>

<div class="modal-backdrop" transition:backdropMotion|global>
	<div
		class="flavor-dialog wide capture-dialog recipe-editor-dialog"
		use:focusTrap={{ onEscape: cancel }}
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
		<form
			bind:this={formEl}
			onsubmit={saveDraft}
			oninvalidcapture={handleInvalid}
			oninput={() => (confirmingDiscard = false)}
		>
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
							use:busyAction={uploading}
							onclick={() => {
								if (!uploading) photoInput?.click();
							}}>{uploading ? 'Uploading…' : 'Upload cover photo'}</button
						>{/if}
					{#if draft.image}<button
							type="button"
							class="text-button"
							use:busyAction={uploading}
							use:focusHandoff={{
								within: '.cover-picker',
								target: 'button',
								fallback: 'input[placeholder^="https://"], #recipe-editor-title'
							}}
							onclick={() => {
								if (uploading) return;
								confirmingDiscard = false;
								draft.image = '';
							}}>Remove cover</button
						>{/if}
					<p class="muted">
						{canUploadCover
							? 'JPG, PNG, or WebP up to 10 MB. Photos are resized and shared with your household.'
							: 'Paste a public HTTPS image link below, or sign in while online to upload a cover photo.'}
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
					disabled={draft.ingredients.length >= MAX_DRAFT_INGREDIENTS}
					onclick={() => void addIngredient()}><Plus size={17} />Add</button
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
					</div>{/each}
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
			<div class="draft-steps">
				{#each draft.steps as _, i}<div class="draft-step">
						<span>{i + 1}</span><textarea
							aria-label={`Step ${i + 1}`}
							bind:value={draft.steps[i]}
							required
							maxlength="10000"
							rows="2"></textarea>
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
					</div>{/each}
			</div>
			<button
				class="secondary draft-list-add"
				type="button"
				disabled={draft.steps.length >= MAX_DRAFT_STEPS}
				onclick={() => void addStep()}><Plus size={17} />Add step</button
			>
			<details class="import-notes" bind:this={nutritionDetails} bind:open={nutritionOpen}>
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
					<button class="primary" type="submit" use:busyAction={uploading}
						><Check size={18} />{mode === 'create' ? 'Save recipe' : 'Save changes'}</button
					>
				{/if}
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
