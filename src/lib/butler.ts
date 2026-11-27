import { z } from 'zod';
import type { AppState, Ingredient } from './types.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import { MAX_SERVINGS } from './recipe-draft.ts';
import {
	activeWeeklyScopes,
	completeMeal,
	completeRecipe,
	convertCompatibleQuantity,
	deleteMeal,
	deleteRecipe,
	expiryStatus,
	normalizeName,
	promoteSampleIngredient,
	refreshRecipeShopping,
	refreshWeekShopping,
	retireCheckedShoppingItems,
	unitInfo,
	upsertMeal,
	upsertRecipe,
	weekStartForDate
} from './kitchen-workflows.ts';

const id = z.string().trim().min(1).max(100);
const text = z.string().max(10000);
const quantity = z.number().nonnegative().max(1000000);
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
	image: z
		.string()
		.max(4000)
		.refine(
			(value) =>
				!value ||
				value.startsWith('/recipe-covers/') ||
				value.startsWith('/api/recipe-covers/') ||
				/^https?:\/\//.test(value),
			'Use an HTTP image URL or a recipe cover.'
		),
	time: quantity,
	servings: z.number().min(1).max(10000),
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
	source: z.string().max(4000).optional(),
	provenance: z.enum(['web-import', 'ai-generated', 'manual']).optional(),
	importNotes: z.array(z.string().max(1000)).max(50).optional(),
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
	servings: z.number().finite().min(1).max(10000),
	completedAt: z.iso
		.datetime()
		.optional()
		.describe(
			'Read-only ISO completion timestamp preserved on already-cooked meals and ignored on uncompleted meals; use meal.complete to finish a planned meal.'
		),
	leftoverServings: quantity
		.finite()
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
		maxTime: z.number().nonnegative().max(100000),
		complexity: z.string().max(80),
		cuisines: z.array(z.string().max(80)).max(8),
		onboardingStatus: z.enum(['completed', 'skipped']),
		theme: z.string().max(80),
		dark: z.boolean(),
		provider: z.string().max(100),
		model: z.string().max(200),
		reasoning: z.object({
			effort: z.string().max(24).optional(),
			enabled: z.boolean().optional(),
			budgetTokens: z.number().int().min(0).max(32768).optional()
		}),
		ratings: z.record(id, z.number().min(0).max(5)),
		chatgptAccountId: z.string().max(100),
		usePersonalAI: z.boolean()
	})
	.partial()
	.strict();
export const ButlerCommandSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('recipe.upsert'), recipe }),
	z.object({ type: z.literal('recipe.delete'), id }),
	z
		.object({
			type: z.literal('recipe.complete'),
			id: id.describe('ID of the recipe in kitchen.recipes to mark cooked.'),
			servings: z
				.number()
				.int()
				.min(1)
				.max(MAX_SERVINGS)
				.optional()
				.describe('Cooked whole servings; defaults to the recipe servings.'),
			leftoverServings: z
				.number()
				.int()
				.nonnegative()
				.max(MAX_SERVINGS)
				.optional()
				.describe('Portions saved as leftovers from 0 up to cooked servings; defaults to 0.'),
			deductPantry: z
				.boolean()
				.describe(
					'Required: true to automatically deduct recipe ingredients from pantry stock, or false to leave pantry stock unchanged.'
				)
		})
		.describe('Record an unscheduled cooked recipe and optionally deduct pantry stock.'),
	z.object({ type: z.literal('pantry.upsert'), item: pantry }),
	z.object({ type: z.literal('pantry.delete'), id }),
	z.object({ type: z.literal('meal.upsert'), meal }),
	z.object({ type: z.literal('meal.delete'), id }),
	z
		.object({
			type: z.literal('meal.complete'),
			id: id.describe('ID of the planned meal in kitchen.meals to mark cooked.'),
			leftoverServings: quantity
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
	const effects: ButlerEffect[] = [];
	const touchedWeeks = new Set<string>(activeWeeklyScopes(state.shopping));
	const touchedRecipes = new Set<string>();
	const activeRecipeScopes = new Set<string>();
	let pantryChanged = false;
	const pantryMutations: PantryMutation[] = [];
	const deductedIngredientNames = new Set<string>();
	const deductedPantryIds = new Set<string>();

	const recordShoppingScopes = (nextState: AppState) => {
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

	for (const command of commands) {
		switch (command.type) {
			case 'recipe.upsert': {
				for (const meal of state.meals) {
					if (!meal.completedAt && meal.recipeId === command.recipe.id) {
						touchedWeeks.add(weekStartForDate(meal.date));
					}
				}
				touchedRecipes.add(command.recipe.id);
				state = upsertRecipe(state, command.recipe, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'recipe.delete':
				recordShoppingScopes(state);
				requireId(state.recipes, command.id);
				for (const meal of state.meals) {
					if (meal.recipeId === command.id) touchedWeeks.add(weekStartForDate(meal.date));
				}
				touchedRecipes.delete(command.id);
				activeRecipeScopes.delete(command.id);
				state = deleteRecipe(state, command.id, safeNow);
				recordShoppingScopes(state);
				break;
			case 'recipe.complete': {
				requireId(state.recipes, command.id);
				recordShoppingScopes(state);
				const beforePantry = state.pantry;
				if (command.deductPantry) {
					const recipe = state.recipes.find((item) => item.id === command.id);
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
				state = completeRecipe(
					state,
					command.id,
					{
						servings: command.servings,
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
					for (const week of touchedWeeks) state = refreshWeekShopping(state, week, safeNow);
				}
				recordShoppingScopes(state);
				break;
			}
			case 'pantry.upsert': {
				recordShoppingScopes(state);
				const promoted = promoteSampleIngredient(command.item);
				const previous = state.pantry.find((item) => item.id === promoted.id);
				const added = addedNonExpiredPantryItem(previous, promoted, safeNow);
				pantryMutations.push({
					kind: 'upsert',
					beforeCurrent: current.pantry.find((item) => item.id === promoted.id),
					beforeStep: previous,
					after: promoted,
					afterDeduction: deductedPantryIds.has(promoted.id)
				});
				const nextPantry = upsert(state.pantry, promoted);
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
					if (previous) touchedWeeks.add(weekStartForDate(previous.date));
					touchedWeeks.add(weekStartForDate(command.meal.date));
				}
				state = upsertMeal(state, command.meal, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'meal.delete': {
				requireId(state.meals, command.id);
				const removed = state.meals.find((item) => item.id === command.id);
				if (removed) touchedWeeks.add(weekStartForDate(removed.date));
				state = deleteMeal(state, command.id, safeNow);
				recordShoppingScopes(state);
				break;
			}
			case 'meal.complete': {
				requireId(state.meals, command.id);
				recordShoppingScopes(state);
				const targetMeal = state.meals.find((item) => item.id === command.id);
				if (targetMeal) touchedWeeks.add(weekStartForDate(targetMeal.date));
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
					for (const week of touchedWeeks) state = refreshWeekShopping(state, week, safeNow);
				}
				recordShoppingScopes(state);
				break;
			}
			case 'shopping.upsert':
				state = { ...state, shopping: upsert(state.shopping, command.item) };
				recordShoppingScopes(state);
				break;
			case 'shopping.delete': {
				requireId(state.shopping, command.id);
				const removed = state.shopping.find((item) => item.id === command.id);
				const week = removed?.checked
					? removed.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1]
					: undefined;
				state = { ...state, shopping: state.shopping.filter((item) => item.id !== command.id) };
				if (week) {
					touchedWeeks.add(week);
					state = refreshWeekShopping(state, week, safeNow);
				}
				break;
			}
			case 'shopping.generate': {
				const startKey = command.weekStart ?? weekStartForDate(safeNow);
				touchedWeeks.add(startKey);
				state = refreshWeekShopping(state, startKey, safeNow);
				break;
			}
			case 'preferences.update':
				state = { ...state, preferences: { ...state.preferences, ...command.preferences } };
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
		state.shopping.length > 1000
	)
		throw new Error('This proposal exceeds the kitchen storage limit. Please make room first.');
	return { state, effects };
}
