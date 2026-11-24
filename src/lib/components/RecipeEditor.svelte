<script module lang="ts">
	import type { RecipeFieldConflict, RecipeMergeOptions } from '#lib/recipe-collection.ts';

	export type RecipeEditorSaveResult =
		| { status: 'saved' }
		| { status: 'conflict'; conflicts: RecipeFieldConflict[] }
		| { status: 'unsaved' | 'deleted'; conflicts?: RecipeFieldConflict[] }
		| { status: 'error'; error: string };
</script>

<script lang="ts">
	import { COVER_PATH, prepareCover } from '#lib/cover-upload.ts';
	import { cloneRecipe } from '#lib/recipe-collection.ts';
	import { recipePlaceholder, recipeImageError } from '#lib/recipe-cover.ts';
	import { tick, untrack } from 'svelte';
	import { focusTrap } from '#lib/focus.ts';
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
		liveRecipe = recipe,
		mode = 'edit',
		canUploadCover = false,
		cancel,
		save
	}: {
		recipe: Recipe;
		liveRecipe?: Recipe | null;
		mode?: 'create' | 'edit';
		canUploadCover?: boolean;
		cancel: () => void;
		save: (recipe: Recipe, options?: RecipeMergeOptions) => RecipeEditorSaveResult | void;
	} = $props();
	const initialDraft = untrack(() => cloneRecipe(recipe));
	const initialTagsText = initialDraft.tags.join(', ');
	let draft = $state<Recipe>(cloneRecipe(initialDraft));
	let tagsText = $state(initialTagsText);
	let error = $state('');
	let conflicts = $state<RecipeFieldConflict[]>([]);
	let promptedRemoval = $state<'unsaved' | 'deleted' | null>(null);
	let remoteRemoval = $derived(
		mode === 'edit' ? (!liveRecipe ? 'deleted' : !liveRecipe.saved ? 'unsaved' : null) : null
	);
	let activeRemoval = $derived(mode === 'edit' ? (remoteRemoval ?? promptedRemoval) : null);
	let uploading = $state(false);
	let confirmingDiscard = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let alertBox = $state<HTMLElement>();
	let errorBox = $state<HTMLElement>();
	let formEl = $state<HTMLFormElement>();
	let nutritionDetails = $state<HTMLDetailsElement>();
	let cancelButton = $state<HTMLButtonElement>();
	let keepEditingButton = $state<HTMLButtonElement>();
	let pendingInvalid: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
	$effect(() => {
		if (!remoteRemoval && promptedRemoval && liveRecipe?.saved) {
			promptedRemoval = null;
		}
	});
	function summarizeValue(value: unknown): string {
		if (value === undefined || value === null || value === '') return 'None';
		if (Array.isArray(value)) {
			if (!value.length) return 'None';
			const text = value
				.map((entry) => {
					if (entry && typeof entry === 'object' && 'name' in entry) {
						const item = entry as { name: string; quantity: number; unit: string };
						return `${item.quantity} ${item.unit} ${item.name}`;
					}
					return String(entry);
				})
				.join('; ');
			return text.length > 180 ? `${text.slice(0, 180)}…` : text;
		}
		const text = String(value);
		return text.length > 180 ? `${text.slice(0, 180)}…` : text;
	}
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
		if (!canUploadCover || !file) return;
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
	async function buildValidatedDraft(): Promise<Recipe | null> {
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
				return null;
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
			} else {
				await tick();
				errorBox?.scrollIntoView({ block: 'nearest' });
			}
			return null;
		}
		return cloneRecipe({
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
	}
	async function submitDraft(options?: RecipeMergeOptions) {
		if (uploading) return;
		if (options && formEl && !formEl.checkValidity()) return;
		const validated = await buildValidatedDraft();
		if (!validated) {
			await tick();
			errorBox?.scrollIntoView({ block: 'nearest' });
			return;
		}
		try {
			const result = save(validated, options);
			if (!result || result.status === 'saved') {
				conflicts = [];
				promptedRemoval = null;
				error = '';
				return;
			}
			if (result.status === 'error') {
				error = result.error;
				await tick();
				errorBox?.scrollIntoView({ block: 'nearest' });
				return;
			}
			if (result.status === 'unsaved' || result.status === 'deleted') {
				promptedRemoval = result.status;
				conflicts = result.conflicts ? [...result.conflicts] : [];
				await tick();
				alertBox?.scrollIntoView({ block: 'nearest' });
				return;
			}
			if (result.status === 'conflict') {
				conflicts = [...result.conflicts];
				await tick();
				alertBox?.scrollIntoView({ block: 'nearest' });
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save changes.';
			await tick();
			errorBox?.scrollIntoView({ block: 'nearest' });
		}
	}
	function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		void submitDraft();
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
		{#if conflicts.length}
			<section class="editor-alert" role="alert" bind:this={alertBox}>
				<strong>Competing household edits need your choice</strong>
				<p>
					A household member updated the same fields while you were editing. Independent edits on
					other fields will be preserved either way.
				</p>
				<ul>
					{#each conflicts as conflict (conflict.field)}
						<li>
							<b>{conflict.label}</b>
							<div>Your draft: {summarizeValue(conflict.draft)}</div>
							<div>Household: {summarizeValue(conflict.household)}</div>
						</li>
					{/each}
				</ul>
				<div class="editor-alert-actions">
					<button
						class="secondary"
						type="button"
						disabled={uploading}
						onclick={() =>
							void submitDraft({
								prefer: 'household',
								...(activeRemoval ? { resave: true } : {})
							})}>Use household values</button
					>
					<button
						class="primary"
						type="button"
						disabled={uploading}
						onclick={() =>
							void submitDraft({
								prefer: 'draft',
								...(activeRemoval ? { resave: true } : {})
							})}><Check size={18} />Keep my draft</button
					>
				</div>
			</section>
		{:else if activeRemoval}
			<section class="editor-alert" role="alert" bind:this={alertBox}>
				<strong
					>{activeRemoval === 'deleted'
						? 'A household member deleted this recipe'
						: 'A household member unsaved this recipe'}</strong
				>
				<p>
					{activeRemoval === 'deleted'
						? 'This recipe was removed from your household while you were editing. Your draft and cover photo are still here — re-save to keep it, or discard your draft.'
						: 'This recipe was removed from your saved collection while you were editing. Your draft and cover photo are still here — re-save to keep it, or discard your draft.'}
				</p>
				<div class="editor-alert-actions">
					<button class="secondary" type="button" onclick={cancel}>Discard draft</button>
					<button
						class="primary"
						type="button"
						disabled={uploading}
						onclick={() => void submitDraft({ resave: true })}
						><Check size={18} />Re-save recipe</button
					>
				</div>
			</section>
		{/if}
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
			{#if error}<p class="error" role="alert" bind:this={errorBox}>{error}</p>{/if}
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
	</div>
</div>

<style>
	.editor-alert {
		padding: 14px 16px;
		margin: 0 0 18px;
		background: var(--wash);
		border: 1px solid var(--line);
		border-left: 3px solid var(--green);
		font-size: 14px;
	}
	.editor-alert strong {
		display: block;
		font-size: 15px;
		margin-bottom: 4px;
	}
	.editor-alert p {
		color: var(--muted);
		font-size: 14px;
		line-height: 1.6;
	}
	.editor-alert ul {
		margin: 10px 0 0;
		padding-inline-start: 18px;
		max-height: 14rem;
		overflow: auto;
	}
	.editor-alert li {
		padding-block: 4px;
		overflow-wrap: anywhere;
	}
	.editor-alert-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.editor-alert-actions button {
		min-height: 44px;
	}
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
		.editor-alert-actions button {
			width: 100%;
		}
	}
</style>
