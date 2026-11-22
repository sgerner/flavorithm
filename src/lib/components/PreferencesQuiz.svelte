<script lang="ts">
	import { Check } from '@lucide/svelte';

	const cuisineChoices = [
		'Mediterranean',
		'Italian',
		'Mexican',
		'Indian',
		'Japanese',
		'Thai',
		'Middle Eastern',
		'American'
	];

	let {
		quizTime = $bindable(45),
		quizComplexity = $bindable('Easy'),
		quizCuisines = $bindable<string[]>([]),
		quizDiet = $bindable('none'),
		quizAllergies = $bindable(''),
		onsave,
		ondismiss
	}: {
		quizTime: number;
		quizComplexity: string;
		quizCuisines: string[];
		quizDiet: string;
		quizAllergies: string;
		onsave: (event: SubmitEvent) => void;
		ondismiss: () => void;
	} = $props();
</script>

<span class="dialog-spark">✷</span>
<h2>Recipe preferences</h2>
<p class="muted onboarding-intro">Optional. Change these preferences anytime in Settings.</p>
<form onsubmit={onsave}>
	<fieldset class="quiz-group">
		<legend>Preferred cooking time</legend>
		<div class="quiz-options quiz-time">
			{#each [15, 30, 45, 60] as minutes}
				<label class="quiz-option">
					<input type="radio" name="cooking-time" value={minutes} bind:group={quizTime} />
					<span>{minutes} min</span>
				</label>
			{/each}
		</div>
	</fieldset>
	<fieldset class="quiz-group">
		<legend>Favorite cuisines</legend>
		<p class="quiz-help">Choose any, or leave blank for all cuisines.</p>
		<div class="quiz-options quiz-cuisines">
			{#each cuisineChoices as cuisine}
				<label class="quiz-option">
					<input type="checkbox" value={cuisine} bind:group={quizCuisines} />
					<span>{cuisine}</span>
				</label>
			{/each}
		</div>
	</fieldset>
	<fieldset class="quiz-group">
		<legend>Cooking complexity</legend>
		<div class="quiz-options quiz-complexity">
			{#each ['Easy', 'Moderate', 'Adventurous'] as complexity}
				<label class="quiz-option">
					<input
						type="radio"
						name="cooking-complexity"
						value={complexity}
						bind:group={quizComplexity}
					/>
					<span>{complexity}</span>
				</label>
			{/each}
		</div>
	</fieldset>
	<details class="quiz-dietary">
		<summary>Any dietary preferences or allergies? <span>Optional</span></summary>
		<label class="field">
			Dietary style
			<select bind:value={quizDiet}>
				<option value="none">No dietary restriction</option>
				<option value="vegetarian">Vegetarian</option>
				<option value="vegan">Vegan</option>
				<option value="pescatarian">Pescatarian</option>
				<option value="gluten-free">Gluten-free</option>
				<option value="dairy-free">Dairy-free</option>
			</select>
		</label>
		<label class="field">
			Allergies or ingredients to avoid
			<input bind:value={quizAllergies} maxlength="500" placeholder="e.g. peanuts, shellfish" />
		</label>
		<p class="field-help">These guide generation. Check ingredients and labels before cooking.</p>
	</details>
	<div class="dialog-actions quiz-actions">
		<button class="primary" type="submit">Save preferences <Check size={17} /></button>
		<button class="text-button" type="button" onclick={ondismiss}>Maybe later</button>
	</div>
</form>
