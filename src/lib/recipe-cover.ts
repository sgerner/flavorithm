/** Pick a stable local illustration for recipes that have no uploaded image. */
export function recipePlaceholder(recipe: { id: string; title: string; tags?: string[] }): string {
	const text = `${recipe.title} ${(recipe.tags ?? []).join(' ')}`.toLowerCase();
	const themes = [
		{ terms: /pasta|noodle|ramen|spaghetti|orzo|lasagna/, file: 'pasta' },
		{ terms: /salad|lettuce|greens|kale|cucumber|avocado/, file: 'garden' },
		{ terms: /soup|stew|chili|broth|curry/, file: 'simmer' },
		{ terms: /bread|toast|sandwich|pizza|flatbread/, file: 'bake' },
		{ terms: /rice|grain|quinoa|bowl|lentil|bean/, file: 'grains' },
		{ terms: /breakfast|pancake|waffle|oat|berry|dessert|sweet/, file: 'sunrise' }
	];
	const matched = themes.find((theme) => theme.terms.test(text));
	if (matched) return `/recipe-covers/${matched.file}.svg`;

	// FNV-1a keeps the fallback stable across sessions and independent of runtime randomness.
	let hash = 0x811c9dc5;
	for (const char of `${recipe.id}\0${recipe.title}`) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	const defaults = ['garden', 'simmer', 'grains', 'sunrise', 'bake', 'pasta'];
	return `/recipe-covers/${defaults[(hash >>> 0) % defaults.length]}.svg`;
}

/** Replace failed remote or private images with the same local illustration used for empty covers. */
export function recipeImageError(
	event: Event,
	recipe: { id: string; title: string; tags?: string[] }
): void {
	const image = event.currentTarget as HTMLImageElement;
	const fallback = recipePlaceholder(recipe);
	if (image.getAttribute('src') !== fallback) image.src = fallback;
}
