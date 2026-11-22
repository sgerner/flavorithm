<script module lang="ts">
	import type { Recipe } from '#lib/types.ts';
	export type ImportSession = {
		text: string;
		photo: string;
		photoName: string;
		draft: Recipe | null;
		assumptions: string[];
	};
	export const emptyImportSession = (): ImportSession => ({
		text: '',
		photo: '',
		photoName: '',
		draft: null,
		assumptions: []
	});
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { Camera, Mic, Plus, X, Check, ChevronLeft } from '@lucide/svelte';
	import { focusFirstInvalid } from '#lib/focus.ts';
	import {
		NUTRITION_FIELDS,
		emptyRecipeDraftValidation,
		fieldAria,
		validateRecipeDraftFields
	} from '#lib/form-validation.ts';
	import { revealMotion } from '#lib/motion.ts';
	import FormField from './FormField.svelte';
	let {
		session = $bindable(),
		capture,
		save,
		dictate
	}: {
		session: ImportSession;
		capture: (
			input: { prompt: string; image?: string },
			signal: AbortSignal
		) => Promise<{ recipe: Recipe; assumptions: string[] } | null>;
		save: (recipe: Recipe) => void;
		dictate: () => void;
	} = $props();
	let busy = $state(false);
	let reading = $state(false);
	let reviewingDraft = $state(untrack(() => session.draft !== null));
	let retryAvailable = $state(false);
	let error = $state('');
	let draftSubmitted = $state(false);
	let moreDetailsOpen = $state(false);
	let nutritionOpen = $state(false);
	let dragging = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let heading = $state<HTMLHeadingElement>();
	let captureFormEl = $state<HTMLFormElement>();
	let draftFormEl = $state<HTMLFormElement>();
	let addIngredientButton = $state<HTMLButtonElement>();
	let addStepButton = $state<HTMLButtonElement>();
	let draftValidation = $derived(
		draftSubmitted && session.draft
			? validateRecipeDraftFields(session.draft)
			: emptyRecipeDraftValidation()
	);
	let showLinkFallbackHelp = $derived(
		Boolean(error && /^https?:\/\/\S+$/.test(session.text.trim()))
	);
	let controller: AbortController | undefined;
	let captureGeneration = 0;
	let alive = true;
	onDestroy(() => {
		alive = false;
		captureGeneration++;
		controller?.abort();
	});

	async function attachPhoto(file?: File) {
		if (!file || busy || reading) return;
		if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
			error = 'Choose a JPG, PNG, or WebP photo. For other files, paste their recipe text.';
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			error = 'Choose a photo under 5 MB.';
			return;
		}
		reading = true;
		error = '';
		try {
			const photo = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(new Error('Could not read that photo. Try another file.'));
				reader.readAsDataURL(file);
			});
			if (alive) {
				session.photo = photo;
				session.photoName = file.name;
			}
		} catch (e) {
			if (alive) error = (e as Error).message;
		} finally {
			if (alive) reading = false;
			if (photoInput) photoInput.value = '';
		}
	}
	function paste(event: ClipboardEvent) {
		const photo = [...(event.clipboardData?.files ?? [])].find((file) =>
			file.type.startsWith('image/')
		);
		if (photo) {
			event.preventDefault();
			void attachPhoto(photo);
		}
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (busy || reading) return;
		const file = event.dataTransfer?.files[0];
		if (file) {
			void attachPhoto(file);
			return;
		}
		const text =
			event.dataTransfer?.getData('text/plain') ||
			event.dataTransfer?.getData('text/uri-list') ||
			'';
		if (text) session.text = [session.text, text].filter(Boolean).join('\n').slice(0, 20_000);
	}
	async function prepare(event: SubmitEvent) {
		event.preventDefault();
		if (busy || reading || !alive) return;
		if (!session.text.trim() && !session.photo) {
			error = 'Paste recipe text, a link, or add a photo before creating a draft.';
			await tick();
			focusFirstInvalid(captureFormEl);
			return;
		}
		error = '';
		retryAvailable = false;
		busy = true;
		const generation = ++captureGeneration;
		const currentController = new AbortController();
		controller = currentController;
		try {
			const result = await capture(
				{ prompt: session.text, ...(session.photo ? { image: session.photo } : {}) },
				currentController.signal
			);
			if (alive && generation === captureGeneration && result) {
				session.draft = result.recipe;
				session.assumptions = result.assumptions;
				draftSubmitted = false;
				moreDetailsOpen = false;
				nutritionOpen = false;
				reviewingDraft = true;
				await tick();
				if (alive && generation === captureGeneration) heading?.focus();
			}
		} catch (e) {
			if (alive && generation === captureGeneration) {
				busy = false;
				controller = undefined;
				error = currentController.signal.aborted
					? 'Request cancelled. Your input is still here; try again when you’re ready.'
					: e instanceof Error
						? e.message
						: 'Could not create a recipe draft. Please try again.';
				retryAvailable = true;
				if (!currentController.signal.aborted) {
					await tick();
					focusFirstInvalid(captureFormEl);
				}
			}
		} finally {
			if (alive && generation === captureGeneration) {
				busy = false;
				controller = undefined;
			}
		}
	}
	function cancelPrepare() {
		if (!busy) return;
		captureGeneration++;
		controller?.abort();
		controller = undefined;
		busy = false;
		error = 'Request cancelled. Your input is still here; try again when you’re ready.';
		retryAvailable = true;
	}
	async function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		const draft = session.draft;
		if (!draft) return;
		error = '';
		const check = validateRecipeDraftFields(draft);
		if (check.hasErrors) {
			draftSubmitted = true;
			if (check.hasDetailErrors) moreDetailsOpen = true;
			if (check.hasNutritionErrors) nutritionOpen = true;
			await tick();
			if (!focusFirstInvalid(draftFormEl)) {
				if (check.ingredientsList) addIngredientButton?.focus();
				else if (check.stepsList) addStepButton?.focus();
			}
			return;
		}
		draftSubmitted = false;
		const ingredients = draft.ingredients.map((i) => ({
			...i,
			name: i.name.trim(),
			unit: i.unit.trim()
		}));
		const steps = draft.steps.map((step) => step.trim()).filter(Boolean);
		try {
			save({
				...draft,
				title: draft.title.trim(),
				description: draft.description.trim(),
				cuisine: draft.cuisine.trim(),
				difficulty: draft.difficulty.trim(),
				ingredients,
				steps,
				importNotes: [...session.assumptions],
				saved: true
			});
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

{#if !reviewingDraft || !session.draft}
	<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Import a recipe</h2>
	<p class="muted capture-help">Paste a recipe, link, or rough ingredient notes.</p>
	<form novalidate bind:this={captureFormEl} onsubmit={prepare}>
		<div
			class="recipe-dropzone"
			class:dragging
			role="region"
			aria-label="Recipe input"
			ondragover={(e) => {
				e.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={drop}
		>
			<FormField
				id="import-recipe-text"
				label="Recipe text or link"
				helpIds={['import-source-help', showLinkFallbackHelp ? 'import-link-help' : undefined]}
				errorId={error ? 'import-capture-error' : undefined}
				invalid={Boolean(error)}
			>
				{#snippet children(field)}
					<textarea
						bind:value={session.text}
						onpaste={paste}
						maxlength="20000"
						rows="6"
						placeholder={'Paste anything here…\n\nOr try: chickpeas, tomatoes, spinach. Make a quick dinner for two.'}
						disabled={busy}
						{...field}></textarea>
				{/snippet}
			</FormField>
			<div class="capture-tools">
				<input
					class="visually-hidden"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					bind:this={photoInput}
					onchange={(e) => attachPhoto(e.currentTarget.files?.[0])}
					tabindex="-1"
					aria-label="Recipe photo"
					disabled={busy || reading}
				/>
				<button
					class="secondary"
					type="button"
					onclick={() => photoInput?.click()}
					disabled={busy || reading}
					><Camera size={18} />{reading ? 'Reading photo…' : 'Add photo'}</button
				>
				<button class="secondary" type="button" onclick={dictate} disabled={busy || reading}
					><Mic size={18} />Use voice</button
				>
				{#if session.text || session.photo}<button
						type="button"
						class="text-button"
						disabled={busy || reading}
						onclick={() => {
							session = emptyImportSession();
							error = '';
							draftSubmitted = false;
							retryAvailable = false;
						}}>Clear</button
					>{/if}
			</div>
			{#if session.photo}<div class="capture-photo" in:revealMotion>
					<img src={session.photo} alt="Attached recipe" /><span>{session.photoName}</span><button
						type="button"
						class="icon-button"
						aria-label="Remove recipe photo"
						disabled={busy}
						onclick={() => {
							session.photo = '';
							session.photoName = '';
						}}><X size={18} /></button
					>
				</div>{/if}
		</div>
		{#if error}<p class="error" id="import-capture-error" role="alert">{error}</p>
			{#if showLinkFallbackHelp}<p class="field-help" id="import-link-help">
					If a website can’t be read, copy its recipe text or attach a screenshot instead.
				</p>{/if}{/if}
		<div class="capture-actions">
			{#if busy}<button class="secondary" type="button" onclick={cancelPrepare}>Cancel</button>{/if}
			<button
				class="primary full"
				type="submit"
				disabled={busy || reading || (!session.text.trim() && !session.photo)}
				aria-busy={busy}
				>{busy ? 'Making your draft…' : retryAvailable ? 'Try again' : 'Create recipe draft'}<Check
					size={18}
				/></button
			>
		</div>
		{#if session.draft}<button
				class="text-button"
				type="button"
				onclick={() => {
					error = '';
					draftSubmitted = false;
					reviewingDraft = true;
				}}>Return to reviewed draft</button
			>{/if}
		<p class="field-help" id="import-source-help">
			Uses your connected model. You’ll review quantities and steps before saving.
		</p>
	</form>
{:else}
	{@const draft = session.draft}
	<div class="draft-heading" in:revealMotion>
		<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Review your recipe</h2>
	</div>
	<form novalidate bind:this={draftFormEl} onsubmit={saveDraft} in:revealMotion>
		<div class="draft-summary">
			<FormField id="import-title" class="draft-title" label="Title" error={draftValidation.title}>
				{#snippet children(field)}
					<input bind:value={draft.title} maxlength="200" {...field} />
				{/snippet}
			</FormField>
			<FormField id="import-time" label="Time (minutes)" error={draftValidation.time}>
				{#snippet children(field)}
					<input type="number" bind:value={draft.time} min="1" max="100000" step="1" {...field} />
				{/snippet}
			</FormField>
			<FormField id="import-servings" label="Servings" error={draftValidation.servings}>
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
		</div>
		{#if session.assumptions.length}<div class="import-assumptions">
				<h3>Estimates to check</h3>
				<ul>
					{#each session.assumptions as note, i}<li>
							<span>{note}</span><button
								class="icon-button"
								type="button"
								aria-label={`Dismiss estimate ${i + 1}`}
								onclick={() =>
									(session.assumptions = session.assumptions.filter((_, index) => index !== i))}
								><X size={16} /></button
							>
						</li>{/each}
				</ul>
			</div>{/if}
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
		{#if draftValidation.ingredientsList}<p class="error" id="import-ingredients-error">
				{draftValidation.ingredientsList}
			</p>{/if}
		<div class="draft-ingredients">
			{#each draft.ingredients as item, i}{@const rowError =
					draftValidation.ingredients[i]}{@const nameAria = fieldAria(
					`import-ingredient-${i}-name`,
					{ error: rowError?.name }
				)}{@const qtyAria = fieldAria(`import-ingredient-${i}-quantity`, {
					error: rowError?.quantity
				})}{@const unitAria = fieldAria(`import-ingredient-${i}-unit`, {
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
		{#if draftValidation.stepsList}<p class="error" id="import-steps-error">
				{draftValidation.stepsList}
			</p>{/if}
		{#each draft.steps as step, i}{@const stepError =
				draftValidation.steps[i] || ''}{@const stepAria = fieldAria(`import-step-${i}`, {
				error: stepError
			})}
			<div class="draft-step">
				<span>{i + 1}</span><textarea
					aria-label={`Step ${i + 1}`}
					bind:value={draft.steps[i]}
					maxlength="10000"
					rows="2"
					{...stepAria.props}></textarea><button
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
		<details class="import-notes" bind:open={moreDetailsOpen}>
			<summary>More recipe details</summary>
			<FormField id="import-description" label="Description" error={draftValidation.description}>
				{#snippet children(field)}
					<textarea bind:value={draft.description} maxlength="10000" rows="2" {...field}></textarea>
				{/snippet}
			</FormField>
			<FormField id="import-cuisine" label="Cuisine" error={draftValidation.cuisine}>
				{#snippet children(field)}
					<input bind:value={draft.cuisine} maxlength="100" {...field} />
				{/snippet}
			</FormField>
			<FormField id="import-difficulty" label="Difficulty" error={draftValidation.difficulty}>
				{#snippet children(field)}
					<input bind:value={draft.difficulty} maxlength="80" {...field} />
				{/snippet}
			</FormField>
		</details>
		<details class="import-notes" bind:open={nutritionOpen}>
			<summary>Nutrition estimates</summary>
			<p>Estimates per serving; re-estimate after ingredient or serving changes.</p>
			<div class="draft-summary">
				{#each NUTRITION_FIELDS as [key, label]}<FormField
						id={`import-nutrition-${key}`}
						{label}
						error={draftValidation.nutrition[key]}
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
		<button
			class="text-button"
			type="button"
			onclick={() => {
				session = emptyImportSession();
				error = '';
				draftSubmitted = false;
				moreDetailsOpen = false;
				nutritionOpen = false;
				reviewingDraft = false;
				retryAvailable = false;
			}}>Discard draft</button
		>
		{#if draft.source}<p class="muted">
				<a href={draft.source} target="_blank" rel="noreferrer">Original source</a>
			</p>{/if}
		{#if error || draftValidation.summary}<p class="error" role="alert">
				{error || draftValidation.summary}
			</p>{/if}
		<div class="draft-footer">
			<button
				class="secondary"
				type="button"
				onclick={() => {
					reviewingDraft = false;
					draftSubmitted = false;
					error = '';
				}}><ChevronLeft size={18} />Back</button
			><button class="primary" type="submit"><Check size={18} />Save recipe</button>
		</div>
	</form>
{/if}
