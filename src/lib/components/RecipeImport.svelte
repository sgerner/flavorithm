<script module lang="ts">
	export { emptyImportSession, type ImportSession } from '#lib/import-session.ts';
</script>

<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { ArrowDown, ArrowUp, Camera, Mic, Plus, X, Check, ChevronLeft } from '@lucide/svelte';
	import { prepareAIPhoto } from '#lib/cover-upload.ts';
	import {
		clearImportSourceInPlace,
		emptyImportSession,
		isReviewingImportDraft,
		type ImportSession
	} from '#lib/import-session.ts';
	import { revealMotion } from '#lib/motion.ts';
	import {
		createDraftBaseline,
		describeInvalidControl,
		insertDraftItem,
		isValidNutrition,
		MAX_DRAFT_INGREDIENTS,
		MAX_DRAFT_STEPS,
		MAX_SERVINGS,
		moveDraftItem,
		NUTRITION_FIELDS,
		openClosedImportNotes,
		validateRecipeDraft
	} from '#lib/recipe-draft.ts';
	import type { Recipe } from '#lib/types.ts';
	let {
		session = $bindable(),
		capture,
		save,
		dictate,
		voiceBusy = false
	}: {
		session: ImportSession;
		capture: (
			input: { url?: string; prompt: string; image?: string },
			signal: AbortSignal
		) => Promise<{ recipe: Recipe; assumptions: string[] } | null>;
		save: (recipe: Recipe) => void;
		dictate: () => void;
		voiceBusy?: boolean;
	} = $props();
	let busy = $state(false);
	let reading = $state(false);
	let nutritionOpen = $state(
		untrack(() => (session.draft ? !isValidNutrition(session.draft.nutrition) : false))
	);
	let retryAvailable = $state(false);
	let error = $state('');
	let dragging = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let heading = $state<HTMLHeadingElement>();
	let formEl = $state<HTMLFormElement>();
	let nutritionDetails = $state<HTMLDetailsElement>();
	let pendingInvalid: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null = null;
	if (untrack(() => session.draft !== null && session.baseline === null)) {
		session.baseline = untrack(() => createDraftBaseline(session.draft!));
	}
	function scrollAndFocus(row: HTMLElement | undefined, control: HTMLElement | null | undefined) {
		row?.scrollIntoView({ block: 'nearest' });
		control?.scrollIntoView({ block: 'nearest' });
		control?.focus({ preventScroll: true });
	}
	async function addIngredient(afterIndex?: number) {
		const draft = session.draft;
		if (!draft) return;
		const inserted = insertDraftItem(
			draft.ingredients,
			afterIndex ?? draft.ingredients.length - 1,
			{ name: '', quantity: 1, unit: 'piece' },
			MAX_DRAFT_INGREDIENTS
		);
		if (!inserted) return;
		draft.ingredients = inserted.items;
		await tick();
		if (!alive) return;
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-ingredient')[inserted.index];
		scrollAndFocus(row, row?.querySelector<HTMLInputElement>('.ingredient-name'));
	}
	async function moveIngredient(index: number, direction: -1 | 1) {
		const draft = session.draft;
		if (!draft) return;
		const moved = moveDraftItem(draft.ingredients, index, direction);
		if (!moved) return;
		draft.ingredients = moved.items;
		await tick();
		if (!alive) return;
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
		const draft = session.draft;
		if (!draft) return;
		draft.ingredients = draft.ingredients.filter((_, i) => i !== index);
		await tick();
		if (!alive) return;
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
		const draft = session.draft;
		if (!draft) return;
		const inserted = insertDraftItem(
			draft.steps,
			afterIndex ?? draft.steps.length - 1,
			'',
			MAX_DRAFT_STEPS
		);
		if (!inserted) return;
		draft.steps = inserted.items;
		await tick();
		if (!alive) return;
		const row = formEl?.querySelectorAll<HTMLElement>('.draft-step')[inserted.index];
		scrollAndFocus(row, row?.querySelector<HTMLTextAreaElement>('textarea'));
	}
	async function moveStep(index: number, direction: -1 | 1) {
		const draft = session.draft;
		if (!draft) return;
		const moved = moveDraftItem(draft.steps, index, direction);
		if (!moved) return;
		draft.steps = moved.items;
		await tick();
		if (!alive) return;
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
		const draft = session.draft;
		if (!draft) return;
		draft.steps = draft.steps.filter((_, i) => i !== index);
		await tick();
		if (!alive) return;
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
		error = describeInvalidControl(target);
		await tick();
		const control = pendingInvalid;
		pendingInvalid = null;
		if (!alive) return;
		scrollAndFocus(
			control.closest<HTMLElement>('.field, .draft-ingredient, .draft-step') ?? undefined,
			control
		);
	}
	let controller: AbortController | undefined;
	let captureGeneration = 0;
	let alive = true;
	let observedSession = untrack(() => session);
	$effect(() => {
		if (session !== observedSession) {
			observedSession = session;
			captureGeneration++;
			controller?.abort();
			controller = undefined;
			busy = false;
			nutritionOpen = session.draft ? !isValidNutrition(session.draft.nutrition) : false;
			error = '';
			retryAvailable = false;
		}
		if (session.draft !== null && session.baseline === null) {
			session.baseline = createDraftBaseline(session.draft);
		}
	});
	onDestroy(() => {
		alive = false;
		captureGeneration++;
		controller?.abort();
	});

	async function attachPhoto(file?: File) {
		if (!file || busy || reading || voiceBusy) {
			if (photoInput) photoInput.value = '';
			return;
		}
		reading = true;
		error = '';
		const targetSession = session;
		try {
			const photo = await prepareAIPhoto(file, {
				unsupportedMessage:
					'Choose a JPG, PNG, or WebP photo. For other files, paste their recipe text.'
			});
			if (alive && session === targetSession) {
				targetSession.photo = photo;
				targetSession.photoName = file.name || 'recipe-photo.jpg';
			}
		} catch (e) {
			if (alive && session === targetSession) {
				error = e instanceof Error ? e.message : 'Could not read that photo. Try another file.';
			}
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
	function firstDroppedUrl(uriList: string): string {
		for (const rawLine of uriList.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) continue;
			try {
				const parsed = new URL(line);
				if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
					return line.slice(0, 2048);
				}
			} catch {
				// Ignore invalid lines in text/uri-list payloads.
			}
		}
		return '';
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (busy || reading || voiceBusy) return;
		const file = event.dataTransfer?.files[0];
		if (file) {
			void attachPhoto(file);
			return;
		}
		const droppedUrl = firstDroppedUrl(event.dataTransfer?.getData('text/uri-list') ?? '');
		if (droppedUrl) {
			session.url = droppedUrl;
			return;
		}
		const text = event.dataTransfer?.getData('text/plain') || '';
		if (text) session.text = [session.text, text].filter(Boolean).join('\n').slice(0, 20_000);
	}
	async function prepare(event: SubmitEvent) {
		event.preventDefault();
		const url = session.url.trim();
		if (busy || reading || voiceBusy || !alive || (!url && !session.text.trim() && !session.photo))
			return;
		error = '';
		retryAvailable = false;
		busy = true;
		const generation = ++captureGeneration;
		const targetSession = session;
		const currentController = new AbortController();
		controller = currentController;
		try {
			const result = await capture(
				{
					...(url ? { url } : {}),
					prompt: targetSession.text,
					...(targetSession.photo ? { image: targetSession.photo } : {})
				},
				currentController.signal
			);
			if (alive && generation === captureGeneration && session === targetSession && result) {
				targetSession.draft = result.recipe;
				targetSession.baseline = createDraftBaseline(result.recipe);
				targetSession.assumptions = result.assumptions;
				targetSession.reviewingDraft = true;
				nutritionOpen = !isValidNutrition(result.recipe.nutrition);
				await tick();
				if (alive && generation === captureGeneration && session === targetSession)
					heading?.focus();
			}
		} catch (e) {
			if (alive && generation === captureGeneration && session === targetSession) {
				error = currentController.signal.aborted
					? 'Request cancelled. Your input is still here; try again when you’re ready.'
					: e instanceof Error
						? e.message
						: 'Could not create a recipe draft. Please try again.';
				retryAvailable = true;
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
		if (voiceBusy) return;
		const draft = session.draft;
		if (!draft) return;
		const validation = validateRecipeDraft(draft, {
			baseline: session.baseline,
			assumptions: session.assumptions.map((note) => note.trim()).filter(Boolean)
		});
		if (!validation.ok) {
			error = validation.error;
			if (validation.nutritionInvalid) {
				nutritionOpen = true;
				if (nutritionDetails) nutritionDetails.open = true;
				const invalidNutritionIndex = NUTRITION_FIELDS.findIndex(([key]) => {
					const value = draft.nutrition[key];
					return (
						typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000
					);
				});
				await tick();
				if (alive && invalidNutritionIndex !== -1 && nutritionDetails) {
					const input =
						nutritionDetails.querySelectorAll<HTMLInputElement>('input')[invalidNutritionIndex];
					scrollAndFocus(input?.closest<HTMLElement>('.field') ?? undefined, input);
				}
			}
			return;
		}
		error = '';
		try {
			save(validation.recipe);
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

{#if !isReviewingImportDraft(session)}
	<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Import a recipe</h2>
	<p class="muted capture-help">
		Add an optional recipe link to fetch, or paste a recipe and notes.
	</p>
	<form onsubmit={prepare}>
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
			<label class="field"
				>Recipe link (optional)<input
					type="url"
					bind:value={session.url}
					maxlength="2048"
					placeholder="https://example.com/recipe"
					disabled={busy}
				/></label
			>
			<label class="field"
				>Recipe text or notes<textarea
					bind:value={session.text}
					onpaste={paste}
					maxlength="20000"
					rows="6"
					placeholder={'Paste recipe text or notes for a linked page…\n\nOr try: chickpeas, tomatoes, spinach. Make a quick dinner for two.'}
					disabled={busy}></textarea></label
			>
			<div class="capture-tools">
				<input
					class="visually-hidden"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					bind:this={photoInput}
					onchange={(e) => attachPhoto(e.currentTarget.files?.[0])}
					tabindex="-1"
					aria-label="Recipe photo"
					disabled={busy || reading || voiceBusy}
				/>
				<button
					class="secondary"
					type="button"
					onclick={() => photoInput?.click()}
					disabled={busy || reading || voiceBusy}
					><Camera size={18} />{reading ? 'Reading photo…' : 'Add photo'}</button
				>
				<button
					class="secondary"
					type="button"
					onclick={dictate}
					disabled={busy || reading || voiceBusy}><Mic size={18} />Use voice</button
				>
				{#if session.url || session.text || session.photo}<button
						type="button"
						class="text-button"
						disabled={busy || reading || voiceBusy}
						onclick={() => {
							clearImportSourceInPlace(session);
							error = '';
							nutritionOpen = session.draft ? !isValidNutrition(session.draft.nutrition) : false;
							retryAvailable = false;
							if (photoInput) photoInput.value = '';
						}}>Clear</button
					>{/if}
			</div>
			{#if session.photo}<div class="capture-photo" in:revealMotion>
					<img src={session.photo} alt="Attached recipe" /><span>{session.photoName}</span><button
						type="button"
						class="icon-button"
						aria-label="Remove recipe photo"
						disabled={busy || voiceBusy}
						onclick={() => {
							session.photo = '';
							session.photoName = '';
						}}><X size={18} /></button
					>
				</div>{/if}
		</div>
		{#if error}<p class="error" role="alert">{error}</p>
			{#if session.url.trim() || /^https?:\/\/\S+$/i.test(session.text.trim())}<p
					class="field-help"
				>
					If a website can’t be read, copy its recipe text or attach a screenshot instead.
				</p>{/if}{/if}
		<div class="capture-actions">
			{#if busy}<button class="secondary" type="button" onclick={cancelPrepare}>Cancel</button>{/if}
			<button
				class="primary full"
				type="submit"
				disabled={busy ||
					reading ||
					voiceBusy ||
					(!session.url.trim() && !session.text.trim() && !session.photo)}
				aria-busy={busy}
				>{busy ? 'Making your draft…' : retryAvailable ? 'Try again' : 'Create recipe draft'}<Check
					size={18}
				/></button
			>
		</div>
		{#if session.draft}<button
				class="text-button"
				type="button"
				disabled={voiceBusy}
				onclick={() => {
					error = '';
					session.reviewingDraft = true;
				}}>Return to reviewed draft</button
			>{/if}
		<p class="field-help">
			Uses your connected model. You’ll review quantities and steps before saving.
		</p>
	</form>
{:else}
	{@const draft = session.draft}
	<div class="draft-heading" in:revealMotion>
		<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Review your recipe</h2>
	</div>
	<form bind:this={formEl} onsubmit={saveDraft} oninvalidcapture={handleInvalid} in:revealMotion>
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
					max={MAX_SERVINGS}
					step="1"
					required
				/></label
			>
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
		<details class="import-notes">
			<summary>More recipe details</summary><label class="field"
				>Description<textarea bind:value={draft.description} maxlength="10000" rows="2"
				></textarea></label
			><label class="field">Cuisine<input bind:value={draft.cuisine} maxlength="100" /></label
			><label class="field">Difficulty<input bind:value={draft.difficulty} maxlength="80" /></label>
		</details>
		<details class="import-notes" bind:this={nutritionDetails} bind:open={nutritionOpen}>
			<summary>Nutrition estimates</summary>
			<p>Estimates per serving; re-estimate after ingredient or serving changes.</p>
			<div class="draft-summary">
				{#each NUTRITION_FIELDS as [key, label]}<label class="field"
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
		<button
			class="text-button"
			type="button"
			onclick={() => {
				session = emptyImportSession();
				error = '';
				nutritionOpen = false;
				retryAvailable = false;
			}}>Discard draft</button
		>
		{#if draft.source}<p class="field-help">
				<a href={draft.source} target="_blank" rel="noreferrer">Original source</a>
			</p>{:else}<p class="field-help">
				{draft.provenance === 'web-import'
					? 'Imported from a recipe webpage.'
					: 'AI-generated from your input — no recipe webpage was fetched.'}
			</p>{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="draft-footer">
			<button
				class="secondary"
				type="button"
				onclick={() => {
					session.reviewingDraft = false;
					error = '';
				}}><ChevronLeft size={18} />Back</button
			><button class="primary" type="submit" disabled={voiceBusy}
				><Check size={18} />Save recipe</button
			>
		</div>
	</form>
{/if}
