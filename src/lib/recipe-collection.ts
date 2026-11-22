import type { Preferences, Recipe } from '#lib/types.ts';

export const MAX_RECIPES = 250;

export type RecipeFieldConflict = {
	field: string;
	label: string;
	draft: unknown;
	household: unknown;
};

export type RecipeMergePreference = 'draft' | 'household';

export type RecipeMergeOptions = {
	prefer?: RecipeMergePreference;
	resave?: boolean;
};

export type MergedRecipeResult =
	| {
			status: 'merged';
			recipe: Recipe;
			conflicts: [];
			nutritionNeedsRefresh: boolean;
	  }
	| {
			status: 'conflict';
			recipe: Recipe;
			conflicts: RecipeFieldConflict[];
			nutritionNeedsRefresh: boolean;
	  }
	| {
			status: 'unsaved' | 'deleted';
			recipe: Recipe;
			conflicts: RecipeFieldConflict[];
			nutritionNeedsRefresh: boolean;
	  };

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function cloneRecipe(recipe: Recipe): Recipe {
	return {
		...recipe,
		tags: [...recipe.tags],
		ingredients: recipe.ingredients.map((item) => ({ ...item })),
		steps: [...recipe.steps],
		nutrition: { ...recipe.nutrition },
		...(recipe.importNotes ? { importNotes: [...recipe.importNotes] } : {})
	};
}

function normalizeEditorComparable(recipe: Recipe) {
	return {
		title: recipe.title.trim(),
		description: recipe.description.trim(),
		image: recipe.image.trim(),
		time: recipe.time,
		servings: recipe.servings,
		difficulty: recipe.difficulty.trim(),
		cuisine: recipe.cuisine.trim(),
		tags: [
			...new Set(
				recipe.tags
					.join(', ')
					.split(',')
					.map((tag) => tag.trim())
					.filter(Boolean)
			)
		],
		ingredients: recipe.ingredients.map((item) => ({
			...item,
			name: item.name.trim(),
			unit: item.unit.trim()
		})),
		steps: recipe.steps.map((step) => step.trim()).filter(Boolean),
		nutrition: { ...recipe.nutrition }
	};
}

const nutritionConflictLabels: [keyof Recipe['nutrition'], string][] = [
	['calories', 'Calories'],
	['fat', 'Fat'],
	['saturatedFat', 'Saturated fat'],
	['sodium', 'Sodium'],
	['carbs', 'Carbohydrates'],
	['fiber', 'Fiber'],
	['sugar', 'Sugar'],
	['protein', 'Protein']
];

/** Apply a batch atomically, preserving existing recipes when it cannot fit. */
export function insertRecipes(existing: Recipe[], incoming: Recipe[]): Recipe[] {
	const additions = new Map(incoming.map((recipe) => [recipe.id, recipe]));
	const recipes = [
		...additions.values(),
		...existing.filter((recipe) => !additions.has(recipe.id))
	];
	if (recipes.length > MAX_RECIPES) {
		throw new Error(
			`Your kitchen can hold up to ${MAX_RECIPES} recipes. There isn’t enough room to save this.`
		);
	}
	return recipes;
}

/**
 * Three-way merge an open RecipeEditor draft against its immutable opening baseline and the
 * current live recipe in kitchen.recipes, keeping live household values for untouched fields.
 */
export function mergeEditedRecipe(
	base: Recipe,
	draft: Recipe,
	live: Recipe | undefined,
	options?: RecipeMergeOptions | RecipeMergePreference
): MergedRecipeResult {
	const resolved: RecipeMergeOptions =
		typeof options === 'string' ? { prefer: options } : (options ?? {});

	if (!live) {
		const nutritionNeedsRefresh =
			base.servings !== draft.servings || !equal(base.ingredients, draft.ingredients);
		const nutritionStale = nutritionNeedsRefresh ? true : base.nutritionStale;
		const candidate = cloneRecipe({
			...base,
			...draft,
			saved: true,
			...(nutritionStale !== undefined ? { nutritionStale } : {})
		});
		if (nutritionStale === undefined) delete candidate.nutritionStale;
		if (!resolved.resave) {
			return {
				status: 'deleted',
				recipe: candidate,
				conflicts: [],
				nutritionNeedsRefresh: Boolean(nutritionStale)
			};
		}
		return {
			status: 'merged',
			recipe: candidate,
			conflicts: [],
			nutritionNeedsRefresh: Boolean(nutritionStale)
		};
	}

	const normalizedBase = normalizeEditorComparable(base);
	const conflicts: RecipeFieldConflict[] = [];

	function mergeField<T>(
		field: string,
		label: string,
		oldVal: T,
		normalizedOldVal: T,
		draftVal: T,
		liveVal: T,
		cloneVal: (val: T) => T
	): T {
		if (equal(draftVal, liveVal)) return cloneVal(liveVal);
		if (equal(draftVal, oldVal) || equal(draftVal, normalizedOldVal)) return cloneVal(liveVal);
		if (equal(liveVal, oldVal)) return cloneVal(draftVal);
		conflicts.push({
			field,
			label,
			draft: cloneVal(draftVal),
			household: cloneVal(liveVal)
		});
		return cloneVal(resolved.prefer === 'household' ? liveVal : draftVal);
	}

	const title = mergeField(
		'title',
		'Title',
		base.title,
		normalizedBase.title,
		draft.title,
		live.title,
		(v) => v
	);
	const description = mergeField(
		'description',
		'Description',
		base.description,
		normalizedBase.description,
		draft.description,
		live.description,
		(v) => v
	);
	const image = mergeField(
		'image',
		'Cover photo',
		base.image,
		normalizedBase.image,
		draft.image,
		live.image,
		(v) => v
	);
	const time = mergeField(
		'time',
		'Cooking time',
		base.time,
		normalizedBase.time,
		draft.time,
		live.time,
		(v) => v
	);
	const servings = mergeField(
		'servings',
		'Servings',
		base.servings,
		normalizedBase.servings,
		draft.servings,
		live.servings,
		(v) => v
	);
	const difficulty = mergeField(
		'difficulty',
		'Difficulty',
		base.difficulty,
		normalizedBase.difficulty,
		draft.difficulty,
		live.difficulty,
		(v) => v
	);
	const cuisine = mergeField(
		'cuisine',
		'Cuisine',
		base.cuisine,
		normalizedBase.cuisine,
		draft.cuisine,
		live.cuisine,
		(v) => v
	);
	const tags = mergeField(
		'tags',
		'Tags',
		base.tags,
		normalizedBase.tags,
		draft.tags,
		live.tags,
		(v) => [...v]
	);
	const ingredients = mergeField(
		'ingredients',
		'Ingredients',
		base.ingredients,
		normalizedBase.ingredients,
		draft.ingredients,
		live.ingredients,
		(v) => v.map((item) => ({ ...item }))
	);
	const steps = mergeField(
		'steps',
		'Steps',
		base.steps,
		normalizedBase.steps,
		draft.steps,
		live.steps,
		(v) => [...v]
	);

	const nutrition = { ...live.nutrition };
	for (const [key, label] of nutritionConflictLabels) {
		nutrition[key] = mergeField(
			`nutrition.${key}`,
			label,
			base.nutrition[key],
			normalizedBase.nutrition[key],
			draft.nutrition[key],
			live.nutrition[key],
			(v) => v
		);
	}

	const changedFromLive = live.servings !== servings || !equal(live.ingredients, ingredients);
	const changedFromBaseWithoutNewNutrition =
		(base.servings !== servings || !equal(base.ingredients, ingredients)) &&
		equal(nutrition, base.nutrition);
	const nutritionNeedsRefresh = changedFromLive || changedFromBaseWithoutNewNutrition;
	const nutritionStale = nutritionNeedsRefresh ? true : live.nutritionStale;

	const merged: Recipe = cloneRecipe({
		...live,
		id: live.id,
		title,
		description,
		image,
		time,
		servings,
		difficulty,
		cuisine,
		tags,
		ingredients,
		steps,
		nutrition,
		saved: true
	});
	if (nutritionStale !== undefined) merged.nutritionStale = nutritionStale;
	else delete merged.nutritionStale;

	if (!live.saved && !resolved.resave) {
		return {
			status: 'unsaved',
			recipe: merged,
			conflicts,
			nutritionNeedsRefresh: Boolean(nutritionStale)
		};
	}

	if (conflicts.length && !resolved.prefer) {
		return {
			status: 'conflict',
			recipe: merged,
			conflicts,
			nutritionNeedsRefresh: Boolean(nutritionStale)
		};
	}

	return {
		status: 'merged',
		recipe: merged,
		conflicts: [],
		nutritionNeedsRefresh: Boolean(nutritionStale)
	};
}

export function applyEditedRecipe(
	recipes: Recipe[],
	base: Recipe,
	draft: Recipe,
	options?: RecipeMergeOptions | RecipeMergePreference
): MergedRecipeResult & { recipes: Recipe[] } {
	const live = recipes.find((item) => item.id === draft.id);
	const result = mergeEditedRecipe(base, draft, live, options);
	if (result.status !== 'merged') {
		return { ...result, recipes };
	}
	const nextRecipes =
		!live || !live.saved
			? insertRecipes(recipes, [result.recipe])
			: recipes.map((item) => (item.id === result.recipe.id ? result.recipe : item));
	return { ...result, recipes: nextRecipes };
}

export function toggleSavedRecipe(
	recipes: Recipe[],
	recipeId: string
): { recipes: Recipe[]; saved: boolean } | null {
	const current = recipes.find((item) => item.id === recipeId);
	if (!current) return null;
	const saved = !current.saved;
	return {
		recipes: recipes.map((item) => (item.id === recipeId ? { ...item, saved } : item)),
		saved
	};
}

export function rateRecipeById(
	recipes: Recipe[],
	preferences: Preferences,
	recipeId: string,
	rating: number
): { recipes: Recipe[]; preferences: Preferences } | null {
	const current = recipes.find((item) => item.id === recipeId);
	if (!current) return null;
	return {
		recipes: recipes.map((item) => (item.id === recipeId ? { ...item, rating } : item)),
		preferences: {
			...preferences,
			ratings: { ...(preferences.ratings ?? {}), [recipeId]: rating }
		}
	};
}

export function applyNutritionRefresh(
	recipes: Recipe[],
	recipeId: string,
	requested: Pick<Recipe, 'servings' | 'ingredients'>,
	nutrition: Recipe['nutrition']
): { recipes: Recipe[]; nutritionStale: boolean } | null {
	const latest = recipes.find((item) => item.id === recipeId);
	if (!latest) return null;
	const nutritionStale =
		latest.servings !== requested.servings || !equal(latest.ingredients, requested.ingredients);
	return {
		recipes: recipes.map((item) =>
			item.id === recipeId
				? {
						...item,
						nutrition: nutritionStale ? { ...item.nutrition } : { ...nutrition },
						nutritionStale
					}
				: item
		),
		nutritionStale
	};
}
