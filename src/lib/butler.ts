import { z } from 'zod';
import type { AppState } from './types.ts';
import { MAX_RECIPES } from './recipe-collection.ts';
import { buildShoppingList } from './domain.ts';
import { completeMeal, reconcileShoppingList, expiryStatus } from './kitchen-workflows.ts';

const id = z.string().trim().min(1).max(100);
const text = z.string().max(10000);
const quantity = z.number().finite().nonnegative().max(1000000);
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
	servings: z.number().finite().min(1).max(10000),
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
	servings: z.number().finite().min(1).max(10000),
	completedAt: z.string().datetime().optional(),
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
		maxTime: z.number().finite().nonnegative().max(100000),
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

function calendarKey(day: Date) {
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
function refreshShoppingWeek(state: AppState, startKey: string, now: Date) {
	const end = new Date(startKey + 'T12:00:00');
	end.setDate(end.getDate() + 6);
	const endKey = calendarKey(end);
	const meals = state.meals.filter(
		(item) => !item.completedAt && item.date >= startKey && item.date <= endKey
	);
	state.shopping = reconcileShoppingList(
		state.shopping,
		buildShoppingList(
			state.recipes,
			state.pantry.filter((item) => expiryStatus(item.expires, now) !== 'expired'),
			meals
		),
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
	const effects: ButlerEffect[] = [];
	for (const command of commands) {
		switch (command.type) {
			case 'recipe.upsert': {
				const previous = state.recipes.find((item) => item.id === command.recipe.id);
				const updated = { ...command.recipe };
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
				state.shopping = state.shopping.filter((item) => item.sourceKey !== `recipe:${command.id}`);
				if (state.preferences.ratings) delete state.preferences.ratings[command.id];
				break;
			case 'pantry.upsert':
				state.pantry = upsert(state.pantry, command.item);
				break;
			case 'pantry.delete':
				requireId(state.pantry, command.id);
				state.pantry = state.pantry.filter((item) => item.id !== command.id);
				break;
			case 'meal.upsert':
				requireId(state.recipes, command.meal.recipeId);
				state.meals = upsert(state.meals, command.meal);
				break;
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
				break;
			case 'shopping.delete':
				requireId(state.shopping, command.id);
				state.shopping = state.shopping.filter((item) => item.id !== command.id);
				break;
			case 'shopping.generate': {
				const start = new Date(command.weekStart ? command.weekStart + 'T12:00:00' : now);
				if (!command.weekStart) start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
				refreshShoppingWeek(state, calendarKey(start), now);
				break;
			}
			case 'preferences.update':
				state.preferences = { ...state.preferences, ...command.preferences };
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
	if (
		commands.some(
			(command) =>
				(command.type.startsWith('recipe.') && command.type !== 'recipe.open') ||
				command.type.startsWith('meal.')
		)
	) {
		const weeks = new Set(
			state.shopping.flatMap(
				(item) => item.sourceKey?.match(/^week:(\d{4}-\d{2}-\d{2})$/)?.[1] ?? []
			)
		);
		for (const week of weeks) refreshShoppingWeek(state, week, now);
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
