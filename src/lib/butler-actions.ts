import { z } from 'zod';
import { ButlerCommandSchema, type ButlerCommand, type ButlerEffect } from './butler.ts';
import type { AppState, Ingredient, Meal, Preferences, Recipe, ShoppingItem } from './types.ts';

export type ButlerAction = {
	id: string;
	label: string;
	title: string;
	summary: string;
	details: string[];
	commands: ButlerCommand[];
	destructive: boolean;
};

export type ButlerExportKind = 'kitchen' | 'shopping' | 'pending';

export type ButlerControlResolution =
	| { kind: 'confirm-sign-out' }
	| { kind: 'confirm-export'; exportKind: ButlerExportKind }
	| { kind: 'confirm-delete-account' }
	| { kind: 'confirm-leave-household' }
	| { kind: 'open'; target: Extract<ButlerCommand, { type: 'ui' }>['action'] };

export type ButlerOpenViewState = {
	selectedId?: string | null;
	editingRecipeId?: string | null;
	editingRecipeMode?: 'create' | 'edit';
	recipeToDeleteId?: string | null;
	modal?: string;
	cookingMealId?: string;
	editingMealId?: string;
	editingPantryId?: string | null;
	editingShoppingId?: string;
};

export type ButlerHistoryAction = {
	title: string;
	status: 'pending' | 'applied' | 'dismissed';
	commands: ButlerCommand[];
};

export type ButlerHistoryInputMessage = {
	role: 'user' | 'assistant';
	content: string;
	actions?: readonly ButlerHistoryAction[];
};

export type ButlerHistoryTurn = {
	role: 'user' | 'assistant';
	content: string;
};

export const MAX_COMMAND_DETAIL_LENGTH = 360;
const MAX_RECIPE_DETAIL_INGREDIENTS = 4;
const MAX_RECIPE_DETAIL_STEPS = 3;

export type ButlerUndoViewCleanup = {
	changedKitchen: boolean;
	revertedRecipeIds: string[];
	closeSelected: boolean;
	closeEditor: boolean;
	closeModal: boolean;
	clearCookingMeal: boolean;
	clearEditingMeal: boolean;
	clearRecipeToDelete: boolean;
	clearEditingPantry: boolean;
	clearEditingShopping: boolean;
};

type LookupState = {
	initialRecipes: Map<string, Recipe>;
	initialPantry: Map<string, Ingredient>;
	initialMeals: Map<string, Meal>;
	initialShopping: Map<string, ShoppingItem>;
	proposedRecipes: Map<string, Recipe>;
	proposedPantry: Map<string, Ingredient>;
	proposedMeals: Map<string, Meal>;
	proposedShopping: Map<string, ShoppingItem>;
	deletedRecipes: Set<string>;
	deletedPantry: Set<string>;
	deletedMeals: Set<string>;
	deletedShopping: Set<string>;
	initialMealCountByRecipe: Map<string, number>;
};

const DESTRUCTIVE_UI_ACTIONS = new Set<Extract<ButlerCommand, { type: 'ui' }>['action']>([
	'sign-out',
	'delete-account',
	'leave-household'
]);

function createLookupState(kitchen: AppState): LookupState {
	const initialMealCountByRecipe = new Map<string, number>();
	for (const meal of kitchen.meals) {
		initialMealCountByRecipe.set(
			meal.recipeId,
			(initialMealCountByRecipe.get(meal.recipeId) ?? 0) + 1
		);
	}
	return {
		initialRecipes: new Map(kitchen.recipes.map((item) => [item.id, item])),
		initialPantry: new Map(kitchen.pantry.map((item) => [item.id, item])),
		initialMeals: new Map(kitchen.meals.map((item) => [item.id, item])),
		initialShopping: new Map(kitchen.shopping.map((item) => [item.id, item])),
		proposedRecipes: new Map(),
		proposedPantry: new Map(),
		proposedMeals: new Map(),
		proposedShopping: new Map(),
		deletedRecipes: new Set(),
		deletedPantry: new Set(),
		deletedMeals: new Set(),
		deletedShopping: new Set(),
		initialMealCountByRecipe
	};
}

function recordCommandInLookup(command: ButlerCommand, lookup: LookupState) {
	switch (command.type) {
		case 'recipe.upsert':
			lookup.deletedRecipes.delete(command.recipe.id);
			lookup.proposedRecipes.set(command.recipe.id, command.recipe);
			break;
		case 'recipe.delete':
			lookup.deletedRecipes.add(command.id);
			break;
		case 'pantry.upsert':
			lookup.deletedPantry.delete(command.item.id);
			lookup.proposedPantry.set(command.item.id, command.item);
			break;
		case 'pantry.delete':
			lookup.deletedPantry.add(command.id);
			break;
		case 'meal.upsert':
			lookup.deletedMeals.delete(command.meal.id);
			lookup.proposedMeals.set(command.meal.id, command.meal);
			break;
		case 'meal.delete':
			lookup.deletedMeals.add(command.id);
			break;
		case 'shopping.upsert':
			lookup.deletedShopping.delete(command.item.id);
			lookup.proposedShopping.set(command.item.id, command.item);
			break;
		case 'shopping.delete':
			lookup.deletedShopping.add(command.id);
			break;
		default:
			break;
	}
}

export function isButlerKitchenMutation(command: ButlerCommand): boolean {
	return !['navigate', 'recipe.open', 'ui'].includes(command.type);
}

function isOpenOnlyButlerAction(action: Pick<ButlerHistoryAction, 'commands'>): boolean {
	return (
		action.commands.length > 0 &&
		action.commands.every((command) => !isButlerKitchenMutation(command))
	);
}

/** Append `[User applied: ...]` and/or `[User opened: ...]` notes for applied action cards on a turn. */
export function formatButlerHistoryContent(
	message: Pick<ButlerHistoryInputMessage, 'content' | 'actions'>
): string {
	const applied = message.actions
		?.filter((action) => action.status === 'applied' && !isOpenOnlyButlerAction(action))
		.map((action) => action.title);
	const opened = message.actions
		?.filter((action) => action.status === 'applied' && isOpenOnlyButlerAction(action))
		.map((action) => action.title);
	const notes = [
		applied?.length ? `[User applied: ${applied.join('; ')}]` : '',
		opened?.length ? `[User opened: ${opened.join('; ')}]` : ''
	].filter(Boolean);
	return notes.length ? `${message.content}\n\n${notes.join('\n')}` : message.content;
}

/** Build the prior 20-turn Basil conversation history with split `[User applied]`/`[User opened]` annotations. */
export function buildButlerHistory(
	messages: readonly ButlerHistoryInputMessage[],
	retry = false
): ButlerHistoryTurn[] {
	return messages.slice(retry ? -21 : -20, retry ? -1 : undefined).map((message) => ({
		role: message.role,
		content: formatButlerHistoryContent(message)
	}));
}

function isDestructiveCommand(command: ButlerCommand): boolean {
	return (
		command.type.endsWith('.delete') ||
		(command.type === 'ui' && DESTRUCTIVE_UI_ACTIONS.has(command.action))
	);
}

/** Classify how a `ui` command must be handled so risky/export actions always require confirmation. */
export function resolveButlerControlTarget(
	action: Extract<ButlerCommand, { type: 'ui' }>['action']
): ButlerControlResolution {
	switch (action) {
		case 'sign-out':
			return { kind: 'confirm-sign-out' };
		case 'export-kitchen':
			return { kind: 'confirm-export', exportKind: 'kitchen' };
		case 'export-shopping':
			return { kind: 'confirm-export', exportKind: 'shopping' };
		case 'export-pending':
			return { kind: 'confirm-export', exportKind: 'pending' };
		case 'delete-account':
			return { kind: 'confirm-delete-account' };
		case 'leave-household':
			return { kind: 'confirm-leave-household' };
		default:
			return { kind: 'open', target: action };
	}
}

/** Determine whether applying commands mutated kitchen data and which open views must close on undo. */
export function reconcileButlerUndoViews(
	previous: AppState,
	applied: AppState,
	view: ButlerOpenViewState,
	effects: ButlerEffect[] = []
): ButlerUndoViewCleanup {
	const changedKitchen = JSON.stringify(previous) !== JSON.stringify(applied);
	const prevRecipes = new Map(previous.recipes.map((item) => [item.id, item]));
	const appliedRecipes = new Map(applied.recipes.map((item) => [item.id, item]));
	const prevMeals = new Map(previous.meals.map((item) => [item.id, item]));
	const appliedMeals = new Map(applied.meals.map((item) => [item.id, item]));
	const prevPantry = new Map(previous.pantry.map((item) => [item.id, item]));
	const appliedPantry = new Map(applied.pantry.map((item) => [item.id, item]));
	const prevShopping = new Map(previous.shopping.map((item) => [item.id, item]));
	const appliedShopping = new Map(applied.shopping.map((item) => [item.id, item]));

	const revertedRecipeIds = new Set<string>();
	for (const id of new Set([...prevRecipes.keys(), ...appliedRecipes.keys()])) {
		if (JSON.stringify(prevRecipes.get(id)) !== JSON.stringify(appliedRecipes.get(id)))
			revertedRecipeIds.add(id);
	}
	for (const effect of effects) {
		if (effect.type === 'recipe.open') revertedRecipeIds.add(effect.id);
	}

	const revertedMealIds = new Set<string>();
	for (const id of new Set([...prevMeals.keys(), ...appliedMeals.keys()])) {
		if (JSON.stringify(prevMeals.get(id)) !== JSON.stringify(appliedMeals.get(id)))
			revertedMealIds.add(id);
	}

	const revertedPantryIds = new Set<string>();
	for (const id of new Set([...prevPantry.keys(), ...appliedPantry.keys()])) {
		if (JSON.stringify(prevPantry.get(id)) !== JSON.stringify(appliedPantry.get(id)))
			revertedPantryIds.add(id);
	}

	const revertedShoppingIds = new Set<string>();
	for (const id of new Set([...prevShopping.keys(), ...appliedShopping.keys()])) {
		if (JSON.stringify(prevShopping.get(id)) !== JSON.stringify(appliedShopping.get(id)))
			revertedShoppingIds.add(id);
	}

	const isStaleId = <T>(
		id: string | null | undefined,
		prev: Map<string, T>,
		appliedMap: Map<string, T>,
		reverted: Set<string>
	): boolean => Boolean(id && ((!prev.has(id) && appliedMap.has(id)) || reverted.has(id)));

	const closeSelected = isStaleId(view.selectedId, prevRecipes, appliedRecipes, revertedRecipeIds);
	const closeEditor =
		view.editingRecipeMode === 'create'
			? false
			: isStaleId(view.editingRecipeId, prevRecipes, appliedRecipes, revertedRecipeIds);
	const clearRecipeToDelete = isStaleId(
		view.recipeToDeleteId,
		prevRecipes,
		appliedRecipes,
		revertedRecipeIds
	);
	const isMealStale = (mealId?: string) => {
		if (!mealId) return false;
		const prevMeal = prevMeals.get(mealId);
		const appliedMeal = appliedMeals.get(mealId);
		if (!prevMeal && appliedMeal) return true;
		if (revertedMealIds.has(mealId)) return true;
		if (prevMeal && revertedRecipeIds.has(prevMeal.recipeId)) return true;
		if (appliedMeal && revertedRecipeIds.has(appliedMeal.recipeId)) return true;
		return false;
	};
	const clearCookingMeal = isMealStale(view.cookingMealId);
	const clearEditingMeal = isMealStale(view.editingMealId);
	const clearEditingPantry = isStaleId(
		view.editingPantryId,
		prevPantry,
		appliedPantry,
		revertedPantryIds
	);
	const clearEditingShopping = isStaleId(
		view.editingShoppingId,
		prevShopping,
		appliedShopping,
		revertedShoppingIds
	);
	const closeModal = Boolean(
		(view.modal === 'plan' && closeSelected) ||
		(view.modal === 'deleteRecipe' && (clearRecipeToDelete || !view.recipeToDeleteId)) ||
		(view.modal === 'cookMeal' && (clearCookingMeal || !view.cookingMealId)) ||
		(view.modal === 'editMeal' && (clearEditingMeal || !view.editingMealId))
	);

	return {
		changedKitchen,
		revertedRecipeIds: [...revertedRecipeIds],
		closeSelected,
		closeEditor,
		closeModal,
		clearCookingMeal,
		clearEditingMeal,
		clearRecipeToDelete,
		clearEditingPantry,
		clearEditingShopping
	};
}

/** Turn validated Butler commands into stable, readable action cards. */
export function buildButlerActions(input: unknown[], kitchen: AppState): ButlerAction[] {
	const commands = z.array(ButlerCommandSchema).max(50).parse(input);
	const parents = commands.map((_, index) => index);
	const find = (index: number): number => {
		if (parents[index] !== index) parents[index] = find(parents[index]);
		return parents[index];
	};
	const join = (left: number, right: number) => {
		const a = find(left);
		const b = find(right);
		if (a !== b) parents[b] = a;
	};
	const firstByResource = new Map<string, number>();
	const share = (index: number, resource: string) => {
		const previous = firstByResource.get(resource);
		if (previous === undefined) firstByResource.set(resource, index);
		else join(index, previous);
	};
	const mealCommands: { index: number; recipeId: string }[] = [];
	const recipeChanges = new Map<string, number[]>();
	let planIndex: number | undefined;

	commands.forEach((command, index) => {
		switch (command.type) {
			case 'recipe.upsert':
				share(index, `recipe:${command.recipe.id}`);
				recipeChanges.set(command.recipe.id, [
					...(recipeChanges.get(command.recipe.id) ?? []),
					index
				]);
				break;
			case 'recipe.delete':
				share(index, `recipe:${command.id}`);
				recipeChanges.set(command.id, [...(recipeChanges.get(command.id) ?? []), index]);
				break;
			case 'recipe.open':
				share(index, `recipe:${command.id}`);
				break;
			case 'pantry.upsert':
				share(index, `pantry:${command.item.id}`);
				break;
			case 'pantry.delete':
				share(index, `pantry:${command.id}`);
				break;
			case 'meal.upsert':
				share(index, `meal:${command.meal.id}`);
				mealCommands.push({ index, recipeId: command.meal.recipeId });
				break;
			case 'meal.delete':
			case 'meal.complete':
				share(index, `meal:${command.id}`);
				if (command.type === 'meal.complete' && command.deductPantry) {
					commands.forEach((candidate, candidateIndex) => {
						if (candidate.type === 'pantry.upsert' || candidate.type === 'pantry.delete')
							join(index, candidateIndex);
					});
				}
				break;
			case 'shopping.upsert':
				share(index, `shopping:${command.item.id}`);
				break;
			case 'shopping.delete':
				share(index, `shopping:${command.id}`);
				break;
			case 'shopping.generate':
				if (planIndex === undefined) planIndex = index;
				else join(index, planIndex);
				break;
			case 'preferences.update':
				share(index, 'preferences');
				break;
			default:
				break;
		}
	});

	// A plan refresh is the result of the whole proposed kitchen plan.
	if (planIndex !== undefined)
		commands.forEach((command, index) => {
			if (index !== planIndex && isButlerKitchenMutation(command)) join(index, planIndex!);
		});
	for (const { index, recipeId } of mealCommands) {
		for (const recipeIndex of recipeChanges.get(recipeId) ?? []) join(index, recipeIndex);
	}
	commands.forEach((command, index) => {
		if (command.type === 'preferences.update') {
			for (const recipeId of Object.keys(command.preferences.ratings ?? {})) {
				for (const recipeIndex of recipeChanges.get(recipeId) ?? []) join(index, recipeIndex);
			}
		}
	});
	// Meal edits and completion refer to the recipe attached to the current meal.
	for (const meal of kitchen.meals) {
		const touching = commands
			.map((command, index) => ({ command, index }))
			.filter(
				({ command }) =>
					(command.type === 'meal.upsert' ||
						command.type === 'meal.delete' ||
						command.type === 'meal.complete') &&
					(command.type === 'meal.upsert' ? command.meal.id : command.id) === meal.id
			);
		for (const { index } of touching) {
			for (const recipeIndex of recipeChanges.get(meal.recipeId) ?? []) join(index, recipeIndex);
		}
	}

	const groups = new Map<number, { index: number; command: ButlerCommand }[]>();
	commands.forEach((command, index) => {
		const root = find(index);
		const group = groups.get(root) ?? [];
		group.push({ index, command });
		groups.set(root, group);
	});
	return [...groups.values()]
		.map((group) => group.sort((a, b) => a.index - b.index))
		.sort((a, b) => a[0].index - b[0].index)
		.map((group) =>
			makeAction(
				group.map(({ command }) => command),
				group[0].index,
				kitchen
			)
		);
}

function makeAction(
	commands: ButlerCommand[],
	firstIndex: number,
	kitchen: AppState
): ButlerAction {
	const destructive = commands.some(isDestructiveCommand);
	const lookup = createLookupState(kitchen);
	const evaluated = commands.map((command) => {
		const description = describe(command, lookup);
		const detail = formatCommandDetail(command, lookup, description);
		recordCommandInLookup(command, lookup);
		return { command, description, detail };
	});
	const details = evaluated.map((entry) => entry.detail);

	if (commands.length === 1) {
		const { description } = evaluated[0];
		return {
			id: `butler-action-${firstIndex}`,
			label: description.label,
			title: description.title,
			summary: description.summary,
			details,
			commands,
			destructive
		};
	}
	const plan =
		commands.some((command) => command.type === 'shopping.generate') ||
		(commands.some((command) => command.type === 'meal.upsert') &&
			commands.some((command) => command.type === 'recipe.upsert'));
	const descriptions = evaluated.map((entry) => entry.description);
	const subjects = [...new Set(descriptions.map(({ title }) => title).filter(Boolean))];
	const context = [...new Set(descriptions.map(({ summary }) => summary).filter(Boolean))].slice(
		0,
		3
	);
	for (const { command, description } of evaluated) {
		if (
			command.type === 'meal.complete' &&
			description.summary &&
			!context.includes(description.summary)
		) {
			context.push(description.summary);
		}
	}
	return {
		id: `butler-action-${firstIndex}`,
		label: plan ? 'Apply plan' : `Apply ${commands.length} changes`,
		title: subjects.slice(0, 2).join(' and ') || 'Kitchen updates',
		summary: `${commands.length} related changes: ${context.join('; ')}${destructive ? '; includes a removal' : ''}.`,
		details,
		commands,
		destructive
	};
}

function cleanInline(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function truncateInline(value: string, maxLength: number): string {
	const cleaned = cleanInline(value);
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength <= 1) return cleaned.slice(0, Math.max(0, maxLength));
	return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function clampLeftovers(value: number | undefined, servings?: number): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	const upper = servings !== undefined && Number.isFinite(servings) ? Math.max(0, servings) : value;
	const rounded = Math.round(Math.min(upper, Math.max(0, value)) * 100) / 100;
	return Object.is(rounded, -0) ? 0 : rounded;
}

function formatLeftovers(count: number): string {
	return `${count} leftover${count === 1 ? '' : 's'}`;
}

function words(value: string): string {
	return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ');
}

/** Format a single Butler command into a human-readable read-only Details preview. */
export function previewButlerCommand(
	command: unknown,
	kitchen: AppState,
	batch: unknown[] = []
): string {
	function findBatchRecipe(id: string | undefined) {
		if (!id) return undefined;
		for (let i = batch.length - 1; i >= 0; i--) {
			const entry = batch[i] as Record<string, unknown> | undefined;
			const recipe =
				entry?.type === 'recipe.upsert' ? (entry.recipe as AppState['recipes'][number]) : undefined;
			if (recipe?.id === id) return recipe;
		}
		return kitchen.recipes.find((item) => item.id === id);
	}

	function findBatchMeal(id: string | undefined) {
		if (!id) return undefined;
		for (let i = batch.length - 1; i >= 0; i--) {
			const entry = batch[i] as Record<string, unknown> | undefined;
			const meal =
				entry?.type === 'meal.upsert' ? (entry.meal as AppState['meals'][number]) : undefined;
			if (meal?.id === id) return meal;
		}
		return kitchen.meals.find((item) => item.id === id);
	}

	function format(value: unknown, depth = 0): string {
		if (Array.isArray(value))
			return value.map((item, i) => `${i + 1}. ${format(item, depth)}`).join('\n');
		if (value && typeof value === 'object')
			return Object.entries(value)
				.filter(([key]) => key !== 'type' && key !== 'id' && key !== 'image')
				.map(([key, item]) => {
					if (key === 'recipeId')
						return `Recipe: ${findBatchRecipe(String(item))?.title ?? String(item)}`;
					return `${words(key)}: ${typeof item === 'object' ? '\n' : ''}${format(item, depth + 1)}`;
				})
				.join('\n');
		return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value ?? '');
	}

	const record = command as Record<string, unknown> | undefined;
	const type = record?.type;
	if (type === 'meal.complete') {
		const mealId = typeof record?.id === 'string' ? record.id : undefined;
		const meal = findBatchMeal(mealId);
		const title = findBatchRecipe(meal?.recipeId)?.title ?? 'Meal';
		const deductPantry = record?.deductPantry === true;
		const leftovers =
			clampLeftovers(
				typeof record?.leftoverServings === 'number' ? record.leftoverServings : 0,
				meal?.servings
			) ?? 0;
		return [
			title,
			meal ? `Meal: ${meal.slot} · ${meal.date} · ${meal.servings} servings` : '',
			`Pantry deduction: ${deductPantry ? 'Deducts pantry stock' : 'Pantry stock unchanged'}`,
			`Leftover servings: ${leftovers}`
		]
			.filter(Boolean)
			.join('\n');
	}
	if (type === 'meal.upsert' && record?.meal && typeof record.meal === 'object') {
		const mealData = record.meal as Record<string, unknown>;
		const existing =
			typeof mealData.id === 'string'
				? kitchen.meals.find((item) => item.id === mealData.id)
				: undefined;
		const recipeId = typeof mealData.recipeId === 'string' ? mealData.recipeId : undefined;
		const title = findBatchRecipe(recipeId)?.title ?? 'Meal';
		const servings = typeof mealData.servings === 'number' ? mealData.servings : undefined;
		const requestedLeftovers =
			typeof mealData.leftoverServings === 'number' ? mealData.leftoverServings : undefined;
		const leftovers = existing?.completedAt
			? clampLeftovers(requestedLeftovers ?? existing.leftoverServings, servings)
			: undefined;
		return [
			title,
			`Meal: ${String(mealData.slot ?? '')} · ${String(mealData.date ?? '')}${servings !== undefined ? ` · ${servings} servings` : ''}`,
			leftovers !== undefined ? `Leftover servings: ${leftovers}` : ''
		]
			.filter(Boolean)
			.join('\n');
	}
	if (type === 'meal.delete') {
		const mealId = typeof record?.id === 'string' ? record.id : undefined;
		const meal = findBatchMeal(mealId);
		const title = findBatchRecipe(meal?.recipeId)?.title ?? 'Meal';
		return [title, meal ? `Meal: ${meal.slot} · ${meal.date}` : 'Remove from meal plan']
			.filter(Boolean)
			.join('\n');
	}

	const target = typeof record?.id === 'string' ? record.id : undefined;
	const mealTarget = findBatchMeal(target);
	const name =
		findBatchRecipe(target)?.title ??
		(mealTarget ? findBatchRecipe(mealTarget.recipeId)?.title : undefined) ??
		kitchen.pantry.find((item) => item.id === target)?.name ??
		kitchen.shopping.find((item) => item.id === target)?.name;
	return [name, format(command)].filter(Boolean).join('\n') || 'Kitchen update';
}

function hasExistingRecord<T>(
	id: string,
	initial: Map<string, T>,
	proposed: Map<string, T>,
	deleted: Set<string>
): boolean {
	if (deleted.has(id)) return false;
	return initial.has(id) || proposed.has(id);
}

function findRecipe(id: string, lookup: LookupState): Recipe | undefined {
	return lookup.proposedRecipes.get(id) ?? lookup.initialRecipes.get(id);
}

function findPantryItem(id: string, lookup: LookupState): Ingredient | undefined {
	return lookup.proposedPantry.get(id) ?? lookup.initialPantry.get(id);
}

function findMeal(id: string, lookup: LookupState): Meal | undefined {
	return lookup.proposedMeals.get(id) ?? lookup.initialMeals.get(id);
}

function findShoppingItem(id: string, lookup: LookupState): ShoppingItem | undefined {
	return lookup.proposedShopping.get(id) ?? lookup.initialShopping.get(id);
}

function formatMealCompletionNotes(
	command: Extract<ButlerCommand, { type: 'meal.complete' }>,
	servings?: number
): {
	deductNote: string;
	leftoverSummary: string;
	leftoverDetail: string;
} {
	const deductNote = command.deductPantry ? 'Deducts pantry stock' : 'Pantry stock unchanged';
	const leftovers = clampLeftovers(command.leftoverServings ?? 0, servings) ?? 0;
	return {
		deductNote,
		leftoverSummary: formatLeftovers(leftovers),
		leftoverDetail: `${leftovers} leftover serving${leftovers === 1 ? '' : 's'}`
	};
}

function formatPreferencesSummary(preferences: Partial<Preferences>, lookup: LookupState): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(preferences)) {
		if (value === undefined) continue;
		if (key === 'cuisines' && Array.isArray(value)) {
			parts.push(`cuisines: ${value.length ? value.join(', ') : 'any'}`);
		} else if (key === 'maxTime' && typeof value === 'number') {
			parts.push(`max time: ${value} min`);
		} else if (key === 'dark' && typeof value === 'boolean') {
			parts.push(`appearance: ${value ? 'dark mode' : 'light mode'}`);
		} else if (key === 'ratings' && value && typeof value === 'object') {
			const entries = Object.entries(value as Record<string, number>).map(([recipeId, rating]) => {
				const title = findRecipe(recipeId, lookup)?.title ?? recipeId;
				return `${cleanInline(title)} (${rating}/5)`;
			});
			if (entries.length) parts.push(`ratings: ${entries.join(', ')}`);
		} else if (key === 'reasoning' && value && typeof value === 'object') {
			const settings = value as NonNullable<Preferences['reasoning']>;
			const details = [
				settings.effort ? `effort ${settings.effort}` : '',
				settings.enabled !== undefined ? (settings.enabled ? 'enabled' : 'disabled') : '',
				settings.budgetTokens !== undefined ? `${settings.budgetTokens} tokens` : ''
			].filter(Boolean);
			parts.push(`reasoning: ${details.join(', ') || 'updated'}`);
		} else {
			const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
			parts.push(`${label}: ${cleanInline(String(value)) || 'none'}`);
		}
	}
	return parts.join(' · ') || 'Kitchen preferences';
}

function formatCommandDetail(
	command: ButlerCommand,
	lookup: LookupState,
	description: Omit<ButlerAction, 'id' | 'details' | 'commands' | 'destructive'>
): string {
	const raw = (() => {
		switch (command.type) {
			case 'recipe.upsert': {
				const recipe = command.recipe;
				const exists = hasExistingRecord(
					recipe.id,
					lookup.initialRecipes,
					lookup.proposedRecipes,
					lookup.deletedRecipes
				);
				const verb = exists ? 'Update recipe' : 'Add recipe';
				const meta = [
					`${recipe.time} min`,
					`${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`,
					truncateInline(recipe.difficulty, 24),
					truncateInline(recipe.cuisine, 32)
				].filter(Boolean);
				const visibleIngredients = recipe.ingredients
					.slice(0, MAX_RECIPE_DETAIL_INGREDIENTS)
					.map((item) => truncateInline(`${item.quantity} ${item.unit} ${item.name}`, 32));
				const extraIngredients = recipe.ingredients.length - visibleIngredients.length;
				const ingredients = visibleIngredients.length
					? `Ingredients: ${truncateInline(visibleIngredients.join(', '), 84)}${
							extraIngredients > 0 ? ` (+${extraIngredients} more)` : ''
						}`
					: '';
				const visibleSteps = recipe.steps
					.slice(0, MAX_RECIPE_DETAIL_STEPS)
					.map((step, index) => `${index + 1}. ${truncateInline(step, 48)}`);
				const extraSteps = recipe.steps.length - visibleSteps.length;
				const steps = visibleSteps.length
					? `Steps: ${truncateInline(visibleSteps.join(' '), 92)}${
							extraSteps > 0 ? ` (+${extraSteps} more)` : ''
						}`
					: '';
				return [
					`${verb}: ${truncateInline(recipe.title, 64)}`,
					...meta,
					...(ingredients ? [ingredients] : []),
					...(steps ? [steps] : [])
				].join(' · ');
			}
			case 'recipe.delete': {
				const recipe = findRecipe(command.id, lookup);
				const title = cleanInline(recipe?.title ?? command.id);
				const mealCount = lookup.initialMealCountByRecipe.get(command.id) ?? 0;
				const mealNote = mealCount
					? ` · removes ${mealCount} scheduled meal${mealCount === 1 ? '' : 's'}`
					: '';
				return `Remove recipe: ${title}${mealNote}`;
			}
			case 'pantry.upsert': {
				const item = command.item;
				const exists = hasExistingRecord(
					item.id,
					lookup.initialPantry,
					lookup.proposedPantry,
					lookup.deletedPantry
				);
				const verb = exists ? 'Update pantry item' : 'Add pantry item';
				const parts = [
					`${verb}: ${cleanInline(item.name)}`,
					cleanInline(`${item.quantity} ${item.unit}`),
					cleanInline(item.category),
					item.expires ? `expires ${cleanInline(item.expires)}` : ''
				].filter(Boolean);
				return parts.join(' · ');
			}
			case 'pantry.delete': {
				const item = findPantryItem(command.id, lookup);
				if (!item) return `Remove pantry item: ${cleanInline(command.id)}`;
				return `Remove pantry item: ${cleanInline(item.name)} · ${cleanInline(`${item.quantity} ${item.unit}`)}`;
			}
			case 'meal.upsert': {
				const exists = hasExistingRecord(
					command.meal.id,
					lookup.initialMeals,
					lookup.proposedMeals,
					lookup.deletedMeals
				);
				const existing = exists ? findMeal(command.meal.id, lookup) : undefined;
				const verb = exists ? 'Update meal' : 'Schedule meal';
				const recipeTitle = cleanInline(
					findRecipe(command.meal.recipeId, lookup)?.title ?? command.meal.recipeId
				);
				const leftovers = existing?.completedAt
					? clampLeftovers(
							command.meal.leftoverServings ?? existing.leftoverServings,
							command.meal.servings
						)
					: undefined;
				const leftoverSuffix =
					leftovers !== undefined
						? ` · ${leftovers} leftover serving${leftovers === 1 ? '' : 's'}`
						: '';
				return `${verb}: ${recipeTitle} · ${command.meal.slot} · ${command.meal.date} · ${command.meal.servings} serving${command.meal.servings === 1 ? '' : 's'}${leftoverSuffix}`;
			}
			case 'meal.delete': {
				const meal = findMeal(command.id, lookup);
				if (!meal) return `Remove meal: ${cleanInline(command.id)}`;
				const recipeTitle = cleanInline(findRecipe(meal.recipeId, lookup)?.title ?? meal.recipeId);
				return `Remove meal: ${recipeTitle} · ${meal.slot} · ${meal.date} · ${meal.servings} serving${meal.servings === 1 ? '' : 's'}`;
			}
			case 'meal.complete': {
				const meal = findMeal(command.id, lookup);
				const { deductNote, leftoverDetail } = formatMealCompletionNotes(command, meal?.servings);
				if (!meal) {
					return `Complete meal: ${cleanInline(command.id)} · ${deductNote} · ${leftoverDetail}`;
				}
				const recipeTitle = cleanInline(findRecipe(meal.recipeId, lookup)?.title ?? meal.recipeId);
				return `Complete meal: ${recipeTitle} · ${meal.slot} · ${meal.date} · ${meal.servings} serving${meal.servings === 1 ? '' : 's'} · ${deductNote} · ${leftoverDetail}`;
			}
			case 'shopping.upsert': {
				const item = command.item;
				const exists = hasExistingRecord(
					item.id,
					lookup.initialShopping,
					lookup.proposedShopping,
					lookup.deletedShopping
				);
				const verb = exists ? 'Update shopping item' : 'Add shopping item';
				return [
					`${verb}: ${cleanInline(item.name)}`,
					cleanInline(`${item.quantity} ${item.unit}`),
					item.checked ? 'purchased' : ''
				]
					.filter(Boolean)
					.join(' · ');
			}
			case 'shopping.delete': {
				const item = findShoppingItem(command.id, lookup);
				if (!item) return `Remove shopping item: ${cleanInline(command.id)}`;
				return `Remove shopping item: ${cleanInline(item.name)} · ${cleanInline(`${item.quantity} ${item.unit}`)}`;
			}
			case 'shopping.generate': {
				const weekLabel = command.weekStart ? `Week of ${command.weekStart}` : 'Current week';
				return `Update shopping list: ${weekLabel} · refresh from meal plan and pantry`;
			}
			case 'preferences.update':
				return `Update preferences: ${formatPreferencesSummary(command.preferences, lookup)}`;
			case 'recipe.open': {
				const recipeTitle = cleanInline(findRecipe(command.id, lookup)?.title ?? command.id);
				return `Open recipe: ${recipeTitle} · ${command.mode ?? 'detail'} view`;
			}
			case 'navigate':
				return `${description.label}: Navigate to ${description.title}`;
			case 'ui':
				return `${description.label}: ${description.summary}`;
		}
	})();
	return truncateInline(raw, MAX_COMMAND_DETAIL_LENGTH);
}

function describe(
	command: ButlerCommand,
	lookup: LookupState
): Omit<ButlerAction, 'id' | 'details' | 'commands' | 'destructive'> {
	switch (command.type) {
		case 'recipe.upsert': {
			const recipe = command.recipe;
			const exists = hasExistingRecord(
				recipe.id,
				lookup.initialRecipes,
				lookup.proposedRecipes,
				lookup.deletedRecipes
			);
			return {
				label: exists ? 'Save recipe' : 'Add recipe',
				title: recipe.title,
				summary: `${recipe.time} min · ${recipe.servings} servings`
			};
		}
		case 'recipe.delete': {
			const title = findRecipe(command.id, lookup)?.title ?? 'Recipe';
			return {
				label: 'Remove recipe',
				title,
				summary: 'Remove this recipe and its scheduled meals.'
			};
		}
		case 'pantry.upsert': {
			const item = command.item;
			const exists = hasExistingRecord(
				item.id,
				lookup.initialPantry,
				lookup.proposedPantry,
				lookup.deletedPantry
			);
			return {
				label: exists ? 'Update item' : 'Add item',
				title: item.name,
				summary: `Pantry · ${item.quantity} ${item.unit}${item.expires ? ` · expires ${item.expires}` : ''}`
			};
		}
		case 'pantry.delete': {
			const name = findPantryItem(command.id, lookup)?.name ?? 'Pantry item';
			return { label: 'Remove item', title: name, summary: 'Remove from pantry.' };
		}
		case 'meal.upsert': {
			const recipe = findRecipe(command.meal.recipeId, lookup);
			const exists = hasExistingRecord(
				command.meal.id,
				lookup.initialMeals,
				lookup.proposedMeals,
				lookup.deletedMeals
			);
			const existing = exists ? findMeal(command.meal.id, lookup) : undefined;
			const leftovers = existing?.completedAt
				? clampLeftovers(
						command.meal.leftoverServings ?? existing.leftoverServings,
						command.meal.servings
					)
				: undefined;
			return {
				label: exists ? 'Update meal' : 'Schedule meal',
				title: recipe?.title ?? 'Meal',
				summary: `${command.meal.slot} · ${command.meal.date} · ${command.meal.servings} servings${
					leftovers !== undefined ? ` · ${formatLeftovers(leftovers)}` : ''
				}`
			};
		}
		case 'meal.delete': {
			const meal = findMeal(command.id, lookup);
			const title = (meal ? findRecipe(meal.recipeId, lookup)?.title : undefined) ?? 'Meal';
			return {
				label: 'Remove meal',
				title,
				summary: meal ? `${meal.slot} · ${meal.date}` : 'Remove from meal plan.'
			};
		}
		case 'meal.complete': {
			const meal = findMeal(command.id, lookup);
			const title = (meal ? findRecipe(meal.recipeId, lookup)?.title : undefined) ?? 'Meal';
			const { deductNote, leftoverSummary } = formatMealCompletionNotes(command, meal?.servings);
			return {
				label: 'Complete meal',
				title,
				summary: `${meal ? `${meal.slot} · ${meal.date}` : 'Mark this meal complete'} · ${deductNote} · ${leftoverSummary}`
			};
		}
		case 'shopping.upsert': {
			const item = command.item;
			const exists = hasExistingRecord(
				item.id,
				lookup.initialShopping,
				lookup.proposedShopping,
				lookup.deletedShopping
			);
			return {
				label: exists ? 'Update item' : 'Add item',
				title: item.name,
				summary: `Shopping list · ${item.quantity} ${item.unit}`
			};
		}
		case 'shopping.delete': {
			const name = findShoppingItem(command.id, lookup)?.name ?? 'Shopping item';
			return { label: 'Remove item', title: name, summary: 'Remove from shopping list.' };
		}
		case 'shopping.generate':
			return {
				label: 'Update shopping list',
				title: 'Shopping list',
				summary: command.weekStart
					? `Week of ${command.weekStart}`
					: 'Refresh from your meal plan and pantry.'
			};
		case 'preferences.update':
			return {
				label: 'Update preferences',
				title: 'Kitchen preferences',
				summary: `${Object.keys(command.preferences).length} preference${Object.keys(command.preferences).length === 1 ? '' : 's'} changed`
			};
		case 'recipe.open':
			return {
				label: 'Open recipe',
				title: findRecipe(command.id, lookup)?.title ?? 'Recipe',
				summary: `${command.mode ?? 'detail'} view`
			};
		case 'navigate': {
			const title = (
				{
					discover: 'Discover',
					pantry: 'Pantry',
					planner: 'Meal planner',
					shopping: 'Shopping list',
					saved: 'Recipe collection'
				} satisfies Record<Extract<ButlerCommand, { type: 'navigate' }>['page'], string>
			)[command.page];
			return { label: `Open ${title.toLowerCase()}`, title, summary: 'Navigate to this section.' };
		}
		case 'ui': {
			switch (command.action) {
				case 'recipe-new':
					return {
						label: 'Open new recipe',
						title: 'New recipe',
						summary: 'Open a blank recipe form.'
					};
				case 'sign-out':
					return {
						label: 'Sign out',
						title: 'Sign out',
						summary: 'Confirm before ending your session.'
					};
				case 'delete-account':
					return {
						label: 'Delete account',
						title: 'Delete account',
						summary: 'Confirm with your password before deleting your account.'
					};
				case 'leave-household':
					return {
						label: 'Leave household',
						title: 'Leave household',
						summary: 'Confirm before leaving this shared kitchen.'
					};
				case 'export-kitchen':
					return {
						label: 'Export kitchen data',
						title: 'Export kitchen data',
						summary: 'Confirm before downloading your kitchen backup.'
					};
				case 'export-shopping':
					return {
						label: 'Export shopping list',
						title: 'Export shopping list',
						summary: 'Confirm before downloading your shopping list.'
					};
				case 'export-pending':
					return {
						label: 'Export pending changes',
						title: 'Export pending changes',
						summary: 'Confirm before downloading unsynced local edits.'
					};
				default: {
					const title = command.action
						.split('-')
						.map((part) => (part === 'ai' ? 'AI' : part.charAt(0).toUpperCase() + part.slice(1)))
						.join(' ');
					return { label: `Open ${title}`, title, summary: 'Open this kitchen action.' };
				}
			}
		}
	}
}
