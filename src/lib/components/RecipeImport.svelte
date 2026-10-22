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
	import { onDestroy, tick } from 'svelte';
	import { Camera, Mic, Plus, X, Check, ChevronLeft } from '@lucide/svelte';
	import { revealMotion } from '#lib/motion.ts';
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
	let error = $state('');
	let dragging = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let heading = $state<HTMLHeadingElement>();
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
	let controller: AbortController | undefined;
	let alive = true;
	onDestroy(() => {
		alive = false;
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
		if (busy || reading || !alive || (!session.text.trim() && !session.photo)) return;
		error = '';
		busy = true;
		controller = new AbortController();
		try {
			const result = await capture(
				{ prompt: session.text, ...(session.photo ? { image: session.photo } : {}) },
				controller.signal
			);
			if (alive && result) {
				session.draft = result.recipe;
				session.assumptions = result.assumptions;
				await tick();
				if (alive) heading?.focus();
			}
		} catch (e) {
			if (alive && !controller.signal.aborted) error = (e as Error).message;
		} finally {
			if (alive) busy = false;
		}
	}
	function saveDraft(event: SubmitEvent) {
		event.preventDefault();
		const draft = session.draft;
		if (!draft) return;
		const ingredients = draft.ingredients.map((i) => ({
			...i,
			name: i.name.trim(),
			unit: i.unit.trim()
		}));
		const steps = draft.steps.map((step) => step.trim()).filter(Boolean);
		if (
			!draft.title.trim() ||
			!ingredients.length ||
			!steps.length ||
			ingredients.some(
				(i) => !i.name || !i.unit || !Number.isFinite(i.quantity) || i.quantity <= 0
			) ||
			!Number.isFinite(draft.time) ||
			draft.time <= 0 ||
			!Number.isFinite(draft.servings) ||
			draft.servings < 1
		) {
			error =
				'Add a title, time, servings, at least one ingredient with a quantity and unit, and a cooking step.';
			return;
		}
		try {
			save({
				...draft,
				title: draft.title.trim(),
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

{#if !session.draft}
	<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Import a recipe</h2>
	<p class="muted capture-help">Paste a recipe, link, or rough ingredient notes.</p>
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
				>Recipe text or link<textarea
					bind:value={session.text}
					onpaste={paste}
					maxlength="20000"
					rows="6"
					placeholder={'Paste anything here…\n\nOr try: chickpeas, tomatoes, spinach. Make a quick dinner for two.'}
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
		{#if error}<p class="error" role="alert">{error}</p>
			{#if /^https?:\/\/\S+$/.test(session.text.trim())}<p class="field-help">
					If a website can’t be read, copy its recipe text or attach a screenshot instead.
				</p>{/if}{/if}
		<div class="capture-actions">
			<button
				class="primary full"
				type="submit"
				disabled={busy || reading || (!session.text.trim() && !session.photo)}
				aria-busy={busy}
				>{busy ? 'Making your draft…' : 'Create recipe draft'}<Check size={18} /></button
			>
		</div>
		<p class="field-help">
			Uses your connected model. You’ll review quantities and steps before saving.
		</p>
	</form>
{:else}
	{@const draft = session.draft}
	<div class="draft-heading" in:revealMotion>
		<h2 id="recipe-import-title" bind:this={heading} tabindex="-1">Review your recipe</h2>
	</div>
	<form onsubmit={saveDraft} in:revealMotion>
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
					rows="2"></textarea><button
					class="icon-button"
					type="button"
					aria-label={`Remove step ${i + 1}`}
					onclick={() => (draft.steps = draft.steps.filter((_, index) => index !== i))}
					><X size={18} /></button
				>
			</div>{/each}
		<details class="import-notes">
			<summary>More recipe details</summary><label class="field"
				>Description<textarea bind:value={draft.description} maxlength="10000" rows="2"
				></textarea></label
			><label class="field">Cuisine<input bind:value={draft.cuisine} maxlength="100" /></label
			><label class="field">Difficulty<input bind:value={draft.difficulty} maxlength="80" /></label>
		</details>
		<details class="import-notes">
			<summary>Nutrition estimates</summary>
			<p>Estimates per serving; re-estimate after ingredient or serving changes.</p>
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
		<button
			class="text-button"
			type="button"
			onclick={() => {
				session = emptyImportSession();
				error = '';
			}}>Discard draft</button
		>
		{#if draft.source}<p class="field-help">
				<a href={draft.source} target="_blank" rel="noreferrer">Original source</a>
			</p>{/if}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="draft-footer">
			<button
				class="secondary"
				type="button"
				onclick={() => {
					session.draft = null;
					error = '';
				}}><ChevronLeft size={18} />Back</button
			><button class="primary" type="submit"><Check size={18} />Save recipe</button>
		</div>
	</form>
{/if}
