import { z } from 'zod';
import type { AppState, Ingredient, ShoppingItem } from './types.ts';
import { COVER_PATH } from './cover-upload.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import {
	activeWeeklyScopes,
	completeMeal,
	convertCompatibleQuantity,
	deleteMeal,
	deleteRecipe,
	expiryStatus,
	findPantryMergeDestination,
	normalizeName,
	promoteSampleIngredient,
	refreshRecipeShopping,
	refreshWeekShopping,
	retireCheckedShoppingItems,
	transferPurchasedItemsToPantry,
	unitInfo,
	upsertMeal,
	upsertRecipe,
	weekStartForDate
} from './kitchen-workflows.ts';

const id = z.string().trim().min(1).max(100);
const text = z.string().max(10000);
const quantity = z.number().nonnegative().max(1000000);
const cookingTime = z.number().nonnegative().max(100000);
const servings = z.number().int().min(1).max(24);
const leftoverServings = z.number().finite().nonnegative().max(10000);
const publicUrl = z
	.string()
	.max(4000)
	.refine((value) => {
		if (!value) return true;
		try {
			const url = new URL(value);
			return url.protocol === 'https:' && !url.username && !url.password;
		} catch {
			return false;
		}
	}, 'Use a public HTTPS URL.');
const nutrition = z.object({
	calories: quantity,
	fat: quantity,
	saturatedFat: quantity,
	sodium: quantity,
	carbs: quantity,
	fiber: quantity,
	sugar: quantity,
	protein: quantity
});
const recipe = z.object({
	id,
	title: z.string().trim().min(1).max(200),
	description: text,
	image: z.union([publicUrl, z.string().regex(COVER_PATH)]),
	time: cookingTime,
	servings,
	difficulty: z.string().max(80),
	cuisine: z.string().max(100),
	tags: z.array(z.string().max(100)).max(100),
	ingredients: z
		.array(
			z.object({ name: z.string().trim().min(1).max(200), quantity, unit: z.string().max(40) })
		)
		.max(250),
	steps: z.array(text).max(200),
	nutrition,
	source: publicUrl.optional(),
	provenance: z.enum(['web-import', 'ai-generated', 'manual']).optional(),
	importNotes: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
	nutritionStale: z.boolean().optional(),
	rating: z.number().min(0).max(5).optional(),
	saved: z.boolean().optional(),
	sampleSaved: z.boolean().optional(),
	hidden: z.boolean().optional()
});
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const d = new Date(value + 'T12:00:00Z');
		return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
	}, 'Use a real calendar date.');
const pantry = z.object({
	id,
	name: z.string().trim().min(1).max(200),
	quantity,
	unit: z.string().max(40),
	category: z.string().max(80),
	expires: z.union([date, z.literal('')]).optional(),
	sample: z.boolean().optional()
});
const meal = z.object({
	id,
	date,
	slot: z.enum(['Breakfast', 'Lunch', 'Dinner']),
	recipeId: id,
	servings,
	completedAt: z.iso
		.datetime()
		.max(50)
		.optional()
		.describe(
			'Read-only ISO completion timestamp preserved on already-cooked meals and ignored on uncompleted meals; use meal.complete to finish a planned meal.'
		),
	leftoverServings: leftoverServings
		.optional()
		.describe(
			'Remaining leftover servings on an already-cooked meal (clamped between 0 and servings); ignored on uncompleted meals.'
		),
	sample: z.boolean().optional()
});
const shopping = z.object({
	id,
	name: z.string().trim().min(1).max(200),
	quantity,
	unit: z.string().max(40),
	checked: z.boolean(),
	sourceKey: z.string().max(200).optional()
});
const preferences = z
	.object({
		diet: z.string().max(200),
		allergies: z.string().max(500),
		maxTime: cookingTime,
		complexity: z.string().max(80),
		cuisines: z.array(z.string().trim().min(1).max(80)).max(8),
		onboardingStatus: z.enum(['completed', 'skipped']),
		theme: z.string().max(80),
		dark: z.boolean(),
		ratings: z.record(id, z.number().min(0).max(5))
	})
	.partial()
	.strict();
export const ButlerCommandSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('recipe.upsert'), recipe }),
	z.object({ type: z.literal('recipe.delete'), id }),
	z.object({ type: z.literal('pantry.upsert'), item: pantry }),
	z.object({ type: z.literal('pantry.delete'), id }),
	z.object({ type: z.literal('meal.upsert'), meal }),
	z.object({ type: z.literal('meal.delete'), id }),
	z
		.object({
			type: z.literal('meal.complete'),
			id: id.describe('ID of the planned meal in kitchen.meals to mark cooked.'),
			leftoverServings: leftoverServings
				.optional()
				.describe('Portions saved as leftovers from 0 up to the meal servings; defaults to 0.'),
			deductPantry: z
				.boolean()
				.describe(
					'Required: true to automatically deduct recipe ingredients from pantry stock, or false to leave pantry stock unchanged.'
				)
		})
		.describe('Mark an uncompleted planned meal cooked and optionally deduct pantry stock.'),
	z.object({ type: z.literal('shopping.upsert'), item: shopping }),
	z.object({ type: z.literal('shopping.delete'), id }),
	z.object({ type: z.literal('shopping.generate'), weekStart: date.optional() }),
	z.object({ type: z.literal('preferences.update'), preferences }),
	z.object({
		type: z.literal('navigate'),
		page: z.enum(['discover', 'pantry', 'planner', 'shopping', 'saved'])
	}),
	z.object({
		type: z.literal('recipe.open'),
		id,
		mode: z.enum(['detail', 'edit', 'cook']).optional()
	}),
	z.object({
		type: z.literal('ui'),
		action: z.enum([
			'settings',
			'ai-settings',
			'voice-settings',
			'household',
			'onboarding',
			'import',
			'scan',
			'dictate',
			'generate',
			'search',
			'export-kitchen',
			'export-shopping',
			'export-pending',
			'sign-in',
			'sign-out',
			'delete-account',
			'invite',
			'join-household',
			'leave-household',
			'taste',
			'recipe-new',
			'pantry-add'
		])
	})
]);
export const ButlerResponseSchema = z.object({
	reply: z.string().trim().min(1).max(12000),
	commands: z.array(ButlerCommandSchema).max(50)
});
export type ButlerCommand = z.infer<typeof ButlerCommandSchema>;
export type ButlerResponse = z.infer<typeof ButlerResponseSchema>;
export type ButlerEffect = Extract<ButlerCommand, { type: 'navigate' | 'recipe.open' | 'ui' }>;

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
	return items.some((value) => value.id === item.id)
		? items.map((value) => (value.id === item.id ? item : value))
		: [...items, item];
}
function requireId(items: { id: string }[], target: string) {
	if (!items.some((item) => item.id === target))
		throw new Error(
			`The item ${target} no longer exists. Please ask again with the current kitchen.`
		);
}

/** Resolve the pantry row ID that a `pantry.upsert` command updates in place, merges into, or creates. */
export function resolvePantryUpsertTargetId(
	pantryItems: Ingredient[],
	item: Pick<Ingredient, 'id' | 'name' | 'unit' | 'expires'>
): string {
	if (pantryItems.some((existing) => existing.id === item.id)) return item.id;
	if (item.expires?.trim() || !item.unit.trim()) return item.id;
	return findPantryMergeDestination(pantryItems, item.name, item.unit)?.id ?? item.id;
}

function upsertPantryItem(pantryItems: Ingredient[], item: Ingredient): Ingredient[] {
	if (pantryItems.some((value) => value.id === item.id)) return upsert(pantryItems, item);
	if (item.expires?.trim() || !item.unit.trim()) return [...pantryItems, item];
	const destination = findPantryMergeDestination(pantryItems, item.name, item.unit);
	if (item.quantity === 0) {
		if (destination) return pantryItems;
		return [...pantryItems, item];
	}
	const createdItem = {
		id: item.id,
		name: item.name,
		quantity: item.quantity,
		unit: item.unit,
		checked: true,
		category: item.category
	};
	const withExplicitExpires = (items: Ingredient[]) =>
		item.expires !== undefined
			? items.map((entry) => (entry.id === item.id ? { ...entry, expires: item.expires } : entry))
			: items;
	if (destination) {
		const unit = unitInfo(item.unit);
		const baseline = Number.isFinite(destination.quantity) ? Math.max(0, destination.quantity) : 0;
		const merged =
			Math.round(
				(baseline + (item.quantity * unit.factor) / unitInfo(destination.unit).factor) * 1_000_000
			) / 1_000_000;
		if (merged > 1_000_000) {
			throw new Error('This proposal exceeds the kitchen storage limit. Please make room first.');
		}
		return transferPurchasedItemsToPantry(pantryItems, [createdItem], () => item.id);
	}
	if (pantryItems.length >= 1_000) {
		return [
			...pantryItems,
			...withExplicitExpires(transferPurchasedItemsToPantry([], [createdItem], () => item.id))
		];
	}
	return withExplicitExpires(
		transferPurchasedItemsToPantry(pantryItems, [createdItem], () => item.id)
	);
}

function recordGeneratedShoppingIds(items: ShoppingItem[], knownGeneratedIds: Set<string>) {
	for (const item of items) {
		if (item.sourceKey?.trim()) knownGeneratedIds.add(item.id);
	}
}

function orderBatchCommands(
	commands: ButlerCommand[],
	initialGeneratedIds: ReadonlySet<string>
): ButlerCommand[] {
	const hasNonShoppingKitchenMutation = commands.some(
		(command) =>
			(command.type.startsWith('recipe.') && command.type !== 'recipe.open') ||
			command.type.startsWith('meal.') ||
			command.type.startsWith('pantry.')
	);
	const upsertedShoppingIds = new Set<string>();
	const generatedIdsInBatch = new Set(initialGeneratedIds);
	for (const command of commands) {
		if (command.type === 'shopping.upsert') {
			upsertedShoppingIds.add(command.item.id);
			if (command.item.sourceKey?.trim()) generatedIdsInBatch.add(command.item.id);
		}
	}

	// Hoist recipe.upsert only when an earlier meal.upsert, meal.complete, or recipe.open
	// references that recipe ID without an intervening recipe.delete on the same ID.
	const deletedRecipeIds = new Set<string>();
	const referencedBeforeUpsert = new Set<string>();
	const seenRecipeUpserts = new Set<string>();
	for (const command of commands) {
		if (command.type === 'recipe.delete') {
			deletedRecipeIds.add(command.id);
		} else if (command.type === 'recipe.upsert') {
			seenRecipeUpserts.add(command.recipe.id);
		} else if (command.type === 'meal.upsert') {
			if (!seenRecipeUpserts.has(command.meal.recipeId)) {
				referencedBeforeUpsert.add(command.meal.recipeId);
			}
		} else if (command.type === 'recipe.open') {
			if (!seenRecipeUpserts.has(command.id)) {
				referencedBeforeUpsert.add(command.id);
			}
		} else if (command.type === 'meal.complete') {
			referencedBeforeUpsert.add('*');
		}
	}

	const hoistedRecipes: ButlerCommand[] = [];
	const mainCommands: ButlerCommand[] = [];
	const deferredShoppingDeletes: ButlerCommand[] = [];

	for (const command of commands) {
		if (
			command.type === 'recipe.upsert' &&
			!deletedRecipeIds.has(command.recipe.id) &&
			(referencedBeforeUpsert.has(command.recipe.id) || referencedBeforeUpsert.has('*'))
		) {
			hoistedRecipes.push(command);
			continue;
		}
		if (
			hasNonShoppingKitchenMutation &&
			command.type === 'shopping.delete' &&
			generatedIdsInBatch.has(command.id) &&
			!upsertedShoppingIds.has(command.id)
		) {
			deferredShoppingDeletes.push(command);
			continue;
		}
		mainCommands.push(command);
	}

	return [...hoistedRecipes, ...mainCommands, ...deferredShoppingDeletes];
}
function isUsablePantryExpiry(expires: string | undefined, now: Date): boolean {
	const status = expiryStatus(expires, now);
	return status !== 'expired' && (!expires?.trim() || status !== 'unknown');
}

function addedNonExpiredPantryItem(
	previous: Ingredient | undefined,
	next: Ingredient,
	now: Date
): Ingredient | undefined {
	if (!isUsablePantryExpiry(next.expires, now)) return undefined;
	if (!Number.isFinite(next.quantity) || !(next.quantity > 0) || !next.unit.trim())
		return undefined;
	if (!previous || !isUsablePantryExpiry(previous.expires, now)) return next;
	if (
		normalizeName(previous.name) !== normalizeName(next.name) ||
		unitInfo(previous.unit).dimension !== unitInfo(next.unit).dimension
	) {
		return next;
	}
	const previousInNextUnit =
		convertCompatibleQuantity(previous.quantity, previous.unit, next.unit) ?? 0;
	const delta = next.quantity - Math.max(0, previousInNextUnit);
	return delta > 0 ? { ...next, quantity: delta } : undefined;
}
type PantryMutation =
	| {
			kind: 'upsert';
			beforeCurrent?: AppState['pantry'][number];
			beforeStep?: AppState['pantry'][number];
			after: AppState['pantry'][number];
			afterDeduction: boolean;
	  }
	| {
			kind: 'delete';
			beforeCurrent?: AppState['pantry'][number];
			beforeStep?: AppState['pantry'][number];
	  };

function reducesIngredientStock(
	before: AppState['pantry'][number] | undefined,
	after: AppState['pantry'][number]
): boolean {
	if (!before || !(before.quantity > 0)) return false;
	if (normalizeName(after.name) !== normalizeName(before.name)) return true;
	const nextInBeforeUnit = convertCompatibleQuantity(after.quantity, after.unit, before.unit);
	if (nextInBeforeUnit === undefined) return true;
	return nextInBeforeUnit + 1e-9 < before.quantity;
}

/** Validate and apply a complete proposal without mutating the caller's kitchen. */
export function applyButlerCommands(
	current: AppState,
	input: unknown,
	now: Date = new Date()
): { state: AppState; effects: ButlerEffect[] } {
	const commands = z.array(ButlerCommandSchema).max(50).parse(input);
	const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
	let state = structuredClone(current);
	const knownGeneratedIds = new Set<string>();
	recordGeneratedShoppingIds(state.shopping, knownGeneratedIds);
	const orderedCommands = orderBatchCommands(commands, knownGeneratedIds);
	const effects: ButlerEffect[] = [];
	const touchedWeeks = new Set<string>(activeWeeklyScopes(state.shopping));
	const mutatedWeeks = new Set<string>();
	const touchedRecipes = new Set<string>();
	const mutatedRecipes = new Set<string>();
	const activeRecipeScopes = new Set<string>();
	let pantryChanged = false;
	const pantryMutations: PantryMutation[] = [];
	const deductedIngredientNames = new Set<string>();
	const deductedPantryIds = new Set<string>();

	const recordShoppingScopes = (nextState: AppState) => {
		recordGeneratedShoppingIds(nextState.shopping, knownGeneratedIds);
		for (const week of activeWeeklyScopes(nextState.shopping)) touchedWeeks.add(week);
		for (const item of nextState.shopping) {
			const recipeId = item.sourceKey?.match(/^recipe:(.+)$/)?.[1];
			if (recipeId && nextState.recipes.some((recipe) => recipe.id === recipeId)) {
				touchedRecipes.add(recipeId);
				if (!item.checked) activeRecipeScopes.add(recipeId);
			}
		}
	};
	recordShoppingScopes(state);

	for (const command of orderedCommands) {
		switch (command.type) {
			case 'recipe.upsert': {
				const previous = state.recipes.find((item) => item.id === command.recipe.id);
				const saved = command.recipe.saved ?? (previous ? previous.saved : true);
				for (const meal of state.meals) {
					if (!meal.completedAt && meal.recipeId === command.recipe.id) {
						const week = weekStartForDate(meal.date);
						touchedWeeks.add(week);
						mutatedWeeks.add(week);
					}
				}
				touchedRecipes.add(command.recipe.id);
				mutatedRecipes.add(command.recipe.id);
				state = upsertRecipe(
					state,
					{
						...command.recipe,
						...(saved !== undefined ? { saved } : {})
					},
					safeNow
				);
				recordShoppingScopes(state);
				break;
			}
			case 'recipe.delete':
				recordShoppingScopes(state);
				requireId(state.recipes, command.id);
				for (const meal of state.meals) {
					if (meal.recipeId === command.id) {
						const week = weekStartForDate(meal.date);
						touchedWeeks.add(week);
						mutatedWeeks.add(week);
					}
				}
				touchedRecipes.delete(command.id);
				mutatedRecipes.delete(command.id);
				activeRecipeScopes.delete(command.id);
				state = deleteRecipe(state, command.id, safeNow);
				recordShoppingScopes(state);
				break;
			case 'pantry.upsert': {
				recordShoppingScopes(state);
				const promoted = promoteSampleIngredient(command.item);
				const previousById = state.pantry.find((item) => item.id === promoted.id);
				const added = addedNonExpiredPantryItem(previousById, promoted, safeNow);
				const targetId = resolvePantryUpsertTargetId(state.pantry, promoted);
				const beforeCurrent = current.pantry.find((item) => item.id === targetId);
				const beforeStep = state.pantry.find((item) => item.id === targetId);
				const nextPantry = upsertPantryItem(state.pantry, promoted);
				const afterEntry = nextPantry.find((item) => item.id === targetId) ?? promoted;
				pantryMutations.push({
					kind: 'upsert',
					beforeCurrent,
					beforeStep,
					after: afterEntry,
					afterDeduction: deductedPantryIds.has(promoted.id) || deductedPantryIds.has(targetId)
				});
				const nextShopping = added
					? retireCheckedShoppingItems(state.shopping, [added], safeNow)
					: state.shopping;
				state = { ...state, pantry: nextPantry, shopping: nextShopping };
				pantryChanged = true;
				break;
			}
			case 'pantry.delete':
				recordShoppingScopes(state);
				requireId(state.pantry, command.id);
				pantryMutations.push({
					kind: 'delete',
					beforeCurrent: current.pantry.find((item) => item.id === command.id),
					beforeStep: state.pantry.find((item) => item.id === command.id)
				});
				state = { ...state, pantry: state.pantry.filter((item) => item.id !== command.id) };
				pantryChanged = true;
				break;
			case 'meal.upsert': {
				requireId(state.recipes, command.meal.recipeId);
				const previous = state.meals.find((item) => item.id === command.meal.id);
				if (!previous?.completedAt) {
					if (previous) {
						const previousWeek = weekStartForDate(previous.date);
						touchedWeeks.add(previousWeek);
						mutatedWeeks.add(previousWeek);
					}
					const targetWeek = weekStartForDate(command.meal.date);
					touchedWeeks.add(targetWeek);
					mutatedWeeks.add(targetWeek);
				}
				state = upsertMeal(state, command.meal, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'meal.delete': {
				requireId(state.meals, command.id);
				const removed = state.meals.find((item) => item.id === command.id);
				if (removed) {
					const week = weekStartForDate(removed.date);
					touchedWeeks.add(week);
					mutatedWeeks.add(week);
				}
				state = deleteMeal(state, command.id, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'meal.complete': {
				requireId(state.meals, command.id);
				recordShoppingScopes(state);
				const targetMeal = state.meals.find((item) => item.id === command.id);
				if (targetMeal) {
					const week = weekStartForDate(targetMeal.date);
					touchedWeeks.add(week);
					mutatedWeeks.add(week);
				}
				const beforePantry = state.pantry;
				if (command.deductPantry && targetMeal && !targetMeal.completedAt) {
					const recipe = state.recipes.find((item) => item.id === targetMeal.recipeId);
					for (const ingredient of recipe?.ingredients ?? []) {
						if (
							Number.isFinite(ingredient.quantity) &&
							ingredient.quantity > 0 &&
							ingredient.unit.trim()
						) {
							deductedIngredientNames.add(normalizeName(ingredient.name));
						}
					}
				}
				state = completeMeal(
					state,
					command.id,
					{
						deductPantry: command.deductPantry,
						leftoverServings: command.leftoverServings ?? 0
					},
					safeNow
				);
				if (state.pantry !== beforePantry) {
					for (const item of state.pantry) {
						const prev = beforePantry.find((entry) => entry.id === item.id);
						if (prev && item.quantity < prev.quantity) deductedPantryIds.add(item.id);
					}
				}
				recordShoppingScopes(state);
				break;
			}
			case 'shopping.upsert':
				state = { ...state, shopping: upsert(state.shopping, command.item) };
				recordShoppingScopes(state);
				break;
			case 'shopping.delete': {
				const removed = state.shopping.find((item) => item.id === command.id);
				if (removed) {
					const week = removed.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1];
					const recipeId = removed.sourceKey?.match(/^recipe:(.+)$/)?.[1];
					state = { ...state, shopping: state.shopping.filter((item) => item.id !== command.id) };
					if (week && (removed.checked || mutatedWeeks.has(week))) {
						touchedWeeks.add(week);
						state = refreshWeekShopping(state, week, safeNow);
						recordShoppingScopes(state);
					} else if (
						recipeId &&
						!removed.checked &&
						mutatedRecipes.has(recipeId) &&
						state.recipes.some((recipe) => recipe.id === recipeId)
					) {
						state = refreshRecipeShopping(state, recipeId, safeNow, { force: true });
						recordShoppingScopes(state);
					}
				} else if (!knownGeneratedIds.has(command.id)) {
					requireId(state.shopping, command.id);
				}
				break;
			}
			case 'shopping.generate': {
				const startKey = command.weekStart ?? weekStartForDate(safeNow);
				touchedWeeks.add(startKey);
				mutatedWeeks.add(startKey);
				state = refreshWeekShopping(state, startKey, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'preferences.update':
				state = {
					...state,
					preferences: {
						...state.preferences,
						...command.preferences,
						...(command.preferences.ratings !== undefined
							? { ratings: { ...state.preferences.ratings, ...command.preferences.ratings } }
							: {})
					}
				};
				break;
			case 'recipe.open':
				requireId(state.recipes, command.id);
				effects.push(command);
				break;
			case 'navigate':
			case 'ui':
				effects.push(command);
				break;
		}
	}
	if (deductedIngredientNames.size > 0) {
		for (const mutation of pantryMutations) {
			if (mutation.kind === 'delete') {
				const existing = mutation.beforeCurrent ?? mutation.beforeStep;
				if (
					existing &&
					existing.quantity > 0 &&
					deductedIngredientNames.has(normalizeName(existing.name))
				) {
					throw new Error(
						'Meal completion already deducts recipe ingredients from the pantry. Remove duplicate pantry reductions and try again.'
					);
				}
			} else {
				const matchesRecipe =
					(mutation.beforeCurrent &&
						deductedIngredientNames.has(normalizeName(mutation.beforeCurrent.name))) ||
					(mutation.beforeStep &&
						deductedIngredientNames.has(normalizeName(mutation.beforeStep.name))) ||
					deductedIngredientNames.has(normalizeName(mutation.after.name));
				if (
					matchesRecipe &&
					(mutation.afterDeduction ||
						reducesIngredientStock(mutation.beforeCurrent, mutation.after) ||
						reducesIngredientStock(mutation.beforeStep, mutation.after))
				) {
					throw new Error(
						'Meal completion already deducts recipe ingredients from the pantry. Remove duplicate pantry reductions and try again.'
					);
				}
			}
		}
	}
	if (pantryChanged) {
		recordShoppingScopes(state);
		for (const week of touchedWeeks) state = refreshWeekShopping(state, week, safeNow);
		for (const recipeId of touchedRecipes) {
			if (state.recipes.some((item) => item.id === recipeId)) {
				state = refreshRecipeShopping(state, recipeId, safeNow, {
					force: activeRecipeScopes.has(recipeId)
				});
			}
		}
	}
	if (
		state.recipes.length > MAX_RECIPES ||
		state.pantry.length > 1000 ||
		state.meals.length > 1000 ||
		state.shopping.length > 1000 ||
		state.pantry.some((item) => item.quantity > 1000000) ||
		state.shopping.some((item) => item.quantity > 1000000)
	)
		throw new Error('This proposal exceeds the kitchen storage limit. Please make room first.');
	return { state, effects };
}
