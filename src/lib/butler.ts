import { z } from 'zod';
import type { AppState } from './types.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import {
	completeMeal,
	deleteMeal,
	deleteRecipe,
	refreshRecipeShopping,
	refreshWeekShopping,
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
	provenance: z.enum(['web-import', 'ai-generated']).optional(),
	importNotes: z.array(z.string().max(1000)).max(50).optional(),
	nutritionStale: z.boolean().optional(),
	rating: z.number().min(0).max(5).optional(),
	saved: z.boolean().optional(),
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
	expires: z.union([date, z.literal('')]).optional()
});
const meal = z.object({
	id,
	date,
	slot: z.enum(['Breakfast', 'Lunch', 'Dinner']),
	recipeId: id,
	servings: z.number().min(1).max(10000),
	completedAt: z.iso.datetime().optional(),
	leftoverServings: quantity.optional()
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
		chatgptAccountId: z.string().max(100)
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
	z.object({
		type: z.literal('meal.complete'),
		id,
		leftoverServings: quantity.optional(),
		deductPantry: z.boolean().optional()
	}),
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

/** Validate and apply a complete proposal without mutating the caller's kitchen. */
export function applyButlerCommands(
	current: AppState,
	input: unknown,
	now: Date = new Date()
): { state: AppState; effects: ButlerEffect[] } {
	const commands = z.array(ButlerCommandSchema).max(50).parse(input);
	let state = structuredClone(current);
	const effects: ButlerEffect[] = [];
	const touchedWeeks = new Set<string>();
	const touchedRecipes = new Set<string>();
	let pantryChangedAfterShoppingRefresh = false;

	const recordShoppingWeeks = (nextState: AppState) => {
		for (const item of nextState.shopping) {
			const week = item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1];
			if (week) touchedWeeks.add(week);
		}
	};

	for (const command of commands) {
		switch (command.type) {
			case 'recipe.upsert': {
				for (const meal of state.meals) {
					if (!meal.completedAt && meal.recipeId === command.recipe.id) {
						touchedWeeks.add(weekStartForDate(meal.date));
					}
				}
				touchedRecipes.add(command.recipe.id);
				state = upsertRecipe(state, command.recipe, now);
				recordShoppingWeeks(state);
				break;
			}
			case 'recipe.delete':
				requireId(state.recipes, command.id);
				for (const meal of state.meals) {
					if (meal.recipeId === command.id) touchedWeeks.add(weekStartForDate(meal.date));
				}
				touchedRecipes.delete(command.id);
				state = deleteRecipe(state, command.id, now);
				recordShoppingWeeks(state);
				break;
			case 'pantry.upsert':
				state = { ...state, pantry: upsert(state.pantry, command.item) };
				if (touchedWeeks.size > 0 || touchedRecipes.size > 0)
					pantryChangedAfterShoppingRefresh = true;
				break;
			case 'pantry.delete':
				requireId(state.pantry, command.id);
				state = { ...state, pantry: state.pantry.filter((item) => item.id !== command.id) };
				if (touchedWeeks.size > 0 || touchedRecipes.size > 0)
					pantryChangedAfterShoppingRefresh = true;
				break;
			case 'meal.upsert': {
				requireId(state.recipes, command.meal.recipeId);
				const previous = state.meals.find((item) => item.id === command.meal.id);
				if (previous) touchedWeeks.add(weekStartForDate(previous.date));
				touchedWeeks.add(weekStartForDate(command.meal.date));
				state = upsertMeal(state, command.meal, now);
				recordShoppingWeeks(state);
				break;
			}
			case 'meal.delete': {
				requireId(state.meals, command.id);
				const removed = state.meals.find((item) => item.id === command.id);
				if (removed) touchedWeeks.add(weekStartForDate(removed.date));
				state = deleteMeal(state, command.id, now);
				recordShoppingWeeks(state);
				break;
			}
			case 'meal.complete': {
				requireId(state.meals, command.id);
				const target = state.meals.find((item) => item.id === command.id);
				if (target) touchedWeeks.add(weekStartForDate(target.date));
				state = completeMeal(
					state,
					command.id,
					{
						deductPantry: command.deductPantry ?? false,
						leftoverServings: command.leftoverServings ?? 0
					},
					now
				);
				recordShoppingWeeks(state);
				break;
			}
			case 'shopping.upsert':
				state = { ...state, shopping: upsert(state.shopping, command.item) };
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
					state = refreshWeekShopping(state, week, now);
				}
				break;
			}
			case 'shopping.generate': {
				const startKey = command.weekStart ?? weekStartForDate(now);
				touchedWeeks.add(startKey);
				state = refreshWeekShopping(state, startKey, now);
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
	if (pantryChangedAfterShoppingRefresh) {
		for (const week of touchedWeeks) state = refreshWeekShopping(state, week, now);
		for (const recipeId of touchedRecipes) state = refreshRecipeShopping(state, recipeId, now);
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
