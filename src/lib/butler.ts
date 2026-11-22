import { z } from 'zod';
import type { AppState, Ingredient, ShoppingItem } from './types.ts';
import { COVER_PATH } from './cover-upload.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import { buildShoppingList, normalizeName, unitInfo } from './domain.ts';
import {
	completeMeal,
	reconcileShoppingList,
	transferPurchasedItemsToPantry
} from './kitchen-workflows.ts';

const id = z.string().trim().min(1).max(100);
const text = z.string().max(10000);
const quantity = z.number().nonnegative().max(1000000);
const cookingTime = z.number().nonnegative().max(100000);
const servings = z.number().int().min(1).max(24);
const leftoverServings = z.number().nonnegative().max(10000);
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
	provenance: z.enum(['web-import', 'ai-generated']).optional(),
	importNotes: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
	nutritionStale: z.boolean().optional(),
	rating: z.number().min(0).max(5).optional(),
	saved: z.boolean().optional(),
	hidden: z.boolean().optional()
});
const pantry = z.object({
	id,
	name: z.string().trim().min(1).max(200),
	quantity,
	unit: z.string().max(40),
	category: z.string().max(80),
	expires: z.string().max(40).optional()
});
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const d = new Date(value + 'T12:00:00Z');
		return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
	}, 'Use a real calendar date.');
const meal = z.object({
	id,
	date,
	slot: z.enum(['Breakfast', 'Lunch', 'Dinner']),
	recipeId: id,
	servings,
	completedAt: z.iso.datetime().max(50).optional(),
	leftoverServings: leftoverServings.optional()
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
	z.object({
		type: z.literal('meal.complete'),
		id,
		leftoverServings: leftoverServings.optional(),
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

function upsertPantryItem(pantryItems: Ingredient[], item: Ingredient): Ingredient[] {
	if (pantryItems.some((value) => value.id === item.id)) return upsert(pantryItems, item);
	if (item.expires?.trim() || !item.unit.trim()) return [...pantryItems, item];
	if (item.quantity === 0) {
		const normalized = normalizeName(item.name);
		const dimension = unitInfo(item.unit).dimension;
		const hasUnexpiredMatch = pantryItems.some(
			(existing) =>
				normalizeName(existing.name) === normalized &&
				unitInfo(existing.unit).dimension === dimension &&
				!existing.expires?.trim()
		);
		if (hasUnexpiredMatch) return pantryItems;
		const { expires: _unused, ...withoutExpires } = item;
		return [...pantryItems, withoutExpires];
	}
	return transferPurchasedItemsToPantry(
		pantryItems,
		[
			{
				id: item.id,
				name: item.name,
				quantity: item.quantity,
				unit: item.unit,
				checked: true,
				category: item.category
			}
		],
		() => item.id
	);
}

function recordShoppingMetadata(
	items: ShoppingItem[],
	activeWeeks: Set<string>,
	knownGeneratedIds: Set<string>
) {
	for (const item of items) {
		const sourceKey = item.sourceKey?.trim();
		if (!sourceKey) continue;
		knownGeneratedIds.add(item.id);
		const week = sourceKey.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1];
		if (week) activeWeeks.add(week);
	}
}

function calendarKey(day: Date) {
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
function refreshShoppingWeek(state: AppState, startKey: string, now: Date) {
	const start = new Date(startKey + 'T12:00:00');
	if (!Number.isFinite(start.getTime()) || calendarKey(start) !== startKey) return;
	const end = new Date(startKey + 'T12:00:00');
	end.setDate(end.getDate() + 6);
	const endKey = calendarKey(end);
	const meals = state.meals.filter(
		(item) => !item.completedAt && item.date >= startKey && item.date <= endKey
	);
	state.shopping = reconcileShoppingList(
		state.shopping,
		buildShoppingList(state.recipes, state.pantry, meals, now),
		`week:${startKey}`
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
	const activeWeeks = new Set<string>();
	const knownGeneratedIds = new Set<string>();
	recordShoppingMetadata(state.shopping, activeWeeks, knownGeneratedIds);
	const effects: ButlerEffect[] = [];
	const deletedCheckedWeeks = new Set<string>();
	for (const command of commands) {
		switch (command.type) {
			case 'recipe.upsert': {
				const previous = state.recipes.find((item) => item.id === command.recipe.id);
				const saved = command.recipe.saved ?? (previous ? previous.saved : true);
				const updated = {
					...command.recipe,
					...(saved !== undefined ? { saved } : {})
				};
				if (
					previous &&
					(previous.servings !== updated.servings ||
						JSON.stringify(previous.ingredients) !== JSON.stringify(updated.ingredients))
				)
					updated.nutritionStale = true;
				else if (previous?.nutritionStale) updated.nutritionStale = true;
				state.recipes = upsert(state.recipes, updated);
				if (updated.rating !== undefined)
					state.preferences.ratings = {
						...state.preferences.ratings,
						[updated.id]: updated.rating
					};
				break;
			}
			case 'recipe.delete':
				requireId(state.recipes, command.id);
				state.recipes = state.recipes.filter((item) => item.id !== command.id);
				state.meals = state.meals.filter((item) => item.recipeId !== command.id);
				state.shopping = state.shopping.filter(
					(item) => item.sourceKey !== `recipe:${command.id}` || item.checked
				);
				if (state.preferences.ratings) delete state.preferences.ratings[command.id];
				break;
			case 'pantry.upsert':
				state.pantry = upsertPantryItem(state.pantry, command.item);
				break;
			case 'pantry.delete':
				requireId(state.pantry, command.id);
				state.pantry = state.pantry.filter((item) => item.id !== command.id);
				break;
			case 'meal.upsert': {
				requireId(state.recipes, command.meal.recipeId);
				const previous = state.meals.find((item) => item.id === command.meal.id);
				const meal = previous?.completedAt
					? {
							...command.meal,
							completedAt: previous.completedAt,
							leftoverServings: previous.leftoverServings
						}
					: command.meal;
				state.meals = upsert(state.meals, meal);
				break;
			}
			case 'meal.delete':
				requireId(state.meals, command.id);
				state.meals = state.meals.filter((item) => item.id !== command.id);
				break;
			case 'meal.complete':
				requireId(state.meals, command.id);
				state = completeMeal(
					state,
					command.id,
					{
						deductPantry: command.deductPantry ?? false,
						leftoverServings: command.leftoverServings ?? 0
					},
					now
				);
				break;
			case 'shopping.upsert':
				state.shopping = upsert(state.shopping, command.item);
				recordShoppingMetadata(state.shopping, activeWeeks, knownGeneratedIds);
				break;
			case 'shopping.delete': {
				const removed = state.shopping.find((item) => item.id === command.id);
				if (removed) {
					const week = removed.checked
						? removed.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1]
						: undefined;
					if (week) deletedCheckedWeeks.add(week);
					state.shopping = state.shopping.filter((item) => item.id !== command.id);
				} else if (!knownGeneratedIds.has(command.id)) {
					requireId(state.shopping, command.id);
				}
				break;
			}
			case 'shopping.generate': {
				const start = new Date(command.weekStart ? command.weekStart + 'T12:00:00' : now);
				if (!command.weekStart) start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
				refreshShoppingWeek(state, calendarKey(start), now);
				recordShoppingMetadata(state.shopping, activeWeeks, knownGeneratedIds);
				break;
			}
			case 'preferences.update':
				state.preferences = {
					...state.preferences,
					...command.preferences,
					...(command.preferences.ratings !== undefined
						? { ratings: { ...state.preferences.ratings, ...command.preferences.ratings } }
						: {})
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
	const weeks = new Set(deletedCheckedWeeks);
	if (
		commands.some(
			(command) =>
				(command.type.startsWith('recipe.') && command.type !== 'recipe.open') ||
				command.type.startsWith('meal.') ||
				command.type.startsWith('pantry.')
		)
	) {
		recordShoppingMetadata(state.shopping, activeWeeks, knownGeneratedIds);
		for (const week of activeWeeks) weeks.add(week);
	}
	for (const week of weeks) refreshShoppingWeek(state, week, now);
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
