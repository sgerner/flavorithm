import { z } from 'zod';
import { ButlerCommandSchema, type ButlerCommand } from './butler.ts';
import { normalizeName, unitInfo } from './domain.ts';
import type { AppState } from './types.ts';

export type ButlerAction = {
	id: string;
	label: string;
	title: string;
	summary: string;
	commands: ButlerCommand[];
	destructive: boolean;
};

function dateInWeek(date: string | undefined, weekStart: string): boolean {
	if (!date) return false;
	const end = new Date(`${weekStart}T12:00:00`);
	if (Number.isNaN(end.getTime())) return false;
	end.setDate(end.getDate() + 6);
	const endKey = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
	return date >= weekStart && date <= endKey;
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
			case 'pantry.upsert': {
				const existingById = kitchen.pantry.some((value) => value.id === command.item.id);
				const mergeTarget =
					!existingById && !command.item.expires?.trim() && command.item.unit.trim()
						? kitchen.pantry.find(
								(value) =>
									normalizeName(value.name) === normalizeName(command.item.name) &&
									unitInfo(value.unit).dimension === unitInfo(command.item.unit).dimension &&
									!value.expires?.trim()
							)
						: undefined;
				share(index, `pantry:${mergeTarget?.id ?? command.item.id}`);
				break;
			}
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
			if (index !== planIndex && isKitchenMutation(command)) join(index, planIndex!);
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

	// Removals of generated shopping items stay with related meal, recipe, or pantry mutations.
	commands.forEach((command, index) => {
		if (command.type !== 'shopping.delete') return;
		const shoppingItem = kitchen.shopping.find((item) => item.id === command.id);
		const sourceKey = shoppingItem?.sourceKey?.trim();
		if (!shoppingItem || !sourceKey) return;
		const normalizedTarget = normalizeName(shoppingItem.name);

		if (sourceKey.startsWith('recipe:')) {
			const recipeId = sourceKey.slice('recipe:'.length);
			for (const recipeIndex of recipeChanges.get(recipeId) ?? []) join(index, recipeIndex);
			commands.forEach((candidate, candidateIndex) => {
				if (candidate.type === 'meal.upsert' && candidate.meal.recipeId === recipeId) {
					join(index, candidateIndex);
				} else if (
					candidate.type === 'meal.upsert' ||
					candidate.type === 'meal.delete' ||
					candidate.type === 'meal.complete'
				) {
					const mealId = candidate.type === 'meal.upsert' ? candidate.meal.id : candidate.id;
					if (kitchen.meals.find((meal) => meal.id === mealId)?.recipeId === recipeId)
						join(index, candidateIndex);
				}
			});
		} else if (sourceKey.startsWith('week:')) {
			const weekStart = sourceKey.slice('week:'.length);
			const weekRecipeIds = new Set<string>();
			for (const meal of kitchen.meals) {
				if (dateInWeek(meal.date, weekStart)) weekRecipeIds.add(meal.recipeId);
			}
			commands.forEach((candidate, candidateIndex) => {
				if (candidate.type === 'meal.upsert') {
					const existing = kitchen.meals.find((meal) => meal.id === candidate.meal.id);
					if (dateInWeek(candidate.meal.date, weekStart) || dateInWeek(existing?.date, weekStart)) {
						join(index, candidateIndex);
						weekRecipeIds.add(candidate.meal.recipeId);
						if (existing) weekRecipeIds.add(existing.recipeId);
					}
				} else if (candidate.type === 'meal.delete' || candidate.type === 'meal.complete') {
					const existing = kitchen.meals.find((meal) => meal.id === candidate.id);
					if (dateInWeek(existing?.date, weekStart)) {
						join(index, candidateIndex);
						if (existing) weekRecipeIds.add(existing.recipeId);
					}
				}
			});
			for (const [recipeId, indices] of recipeChanges) {
				const existingRecipe = kitchen.recipes.find((recipe) => recipe.id === recipeId);
				const upsertedRecipe = commands.find(
					(c): c is Extract<ButlerCommand, { type: 'recipe.upsert' }> =>
						c.type === 'recipe.upsert' && c.recipe.id === recipeId
				)?.recipe;
				const touchesIngredient = [
					...(existingRecipe?.ingredients ?? []),
					...(upsertedRecipe?.ingredients ?? [])
				].some((ingredient) => normalizeName(ingredient.name) === normalizedTarget);
				if (weekRecipeIds.has(recipeId) || touchesIngredient) {
					for (const recipeIndex of indices) join(index, recipeIndex);
				}
			}
		} else if (sourceKey.startsWith('meal:')) {
			const mealId = sourceKey.split(':')[1] ?? '';
			const existingMeal = kitchen.meals.find((meal) => meal.id === mealId);
			if (existingMeal) {
				for (const recipeIndex of recipeChanges.get(existingMeal.recipeId) ?? [])
					join(index, recipeIndex);
			}
			commands.forEach((candidate, candidateIndex) => {
				if (
					(candidate.type === 'meal.upsert' && candidate.meal.id === mealId) ||
					((candidate.type === 'meal.delete' || candidate.type === 'meal.complete') &&
						candidate.id === mealId)
				) {
					join(index, candidateIndex);
				}
			});
		}

		commands.forEach((candidate, candidateIndex) => {
			if (candidate.type === 'pantry.upsert') {
				const existingPantry = kitchen.pantry.find((item) => item.id === candidate.item.id);
				if (
					normalizeName(candidate.item.name) === normalizedTarget ||
					(existingPantry && normalizeName(existingPantry.name) === normalizedTarget)
				) {
					join(index, candidateIndex);
				}
			} else if (candidate.type === 'pantry.delete') {
				const existingPantry = kitchen.pantry.find((item) => item.id === candidate.id);
				if (existingPantry && normalizeName(existingPantry.name) === normalizedTarget) {
					join(index, candidateIndex);
				}
			}
		});
	});

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

function isKitchenMutation(command: ButlerCommand): boolean {
	return !['navigate', 'recipe.open', 'ui'].includes(command.type);
}

function makeAction(
	commands: ButlerCommand[],
	firstIndex: number,
	kitchen: AppState
): ButlerAction {
	const destructive = commands.some((command) => command.type.endsWith('.delete'));
	if (commands.length === 1) {
		const command = commands[0];
		const details = describe(command, kitchen);
		return {
			id: `butler-action-${firstIndex}`,
			label: details.label,
			title: details.title,
			summary: details.summary,
			commands,
			destructive
		};
	}
	const plan =
		commands.some((command) => command.type === 'shopping.generate') ||
		(commands.some((command) => command.type === 'meal.upsert') &&
			commands.some((command) => command.type === 'recipe.upsert'));
	const descriptions = commands.map((command) => describe(command, kitchen));
	const subjects = [...new Set(descriptions.map(({ title }) => title).filter(Boolean))];
	const context = [...new Set(descriptions.map(({ summary }) => summary).filter(Boolean))].slice(
		0,
		3
	);
	return {
		id: `butler-action-${firstIndex}`,
		label: plan ? 'Apply plan' : `Apply ${commands.length} changes`,
		title: subjects.slice(0, 2).join(' and ') || 'Kitchen updates',
		summary: `${commands.length} related changes: ${context.join('; ')}${destructive ? '; includes a removal' : ''}.`,
		commands,
		destructive
	};
}

function describe(
	command: ButlerCommand,
	kitchen: AppState
): Omit<ButlerAction, 'id' | 'commands' | 'destructive'> {
	switch (command.type) {
		case 'recipe.upsert': {
			const recipe = command.recipe;
			const exists = kitchen.recipes.some((item) => item.id === recipe.id);
			return {
				label: exists ? 'Save recipe' : 'Add recipe',
				title: recipe.title,
				summary: `${recipe.time} min · ${recipe.servings} servings`
			};
		}
		case 'recipe.delete': {
			const title = kitchen.recipes.find((item) => item.id === command.id)?.title ?? 'Recipe';
			return {
				label: 'Remove recipe',
				title,
				summary: 'Remove this recipe and its scheduled meals.'
			};
		}
		case 'pantry.upsert': {
			const item = command.item;
			const exists = kitchen.pantry.some((value) => value.id === item.id);
			return {
				label: exists ? 'Update item' : 'Add item',
				title: item.name,
				summary: `Pantry · ${item.quantity} ${item.unit}${item.expires ? ` · expires ${item.expires}` : ''}`
			};
		}
		case 'pantry.delete': {
			const name = kitchen.pantry.find((item) => item.id === command.id)?.name ?? 'Pantry item';
			return { label: 'Remove item', title: name, summary: 'Remove from pantry.' };
		}
		case 'meal.upsert': {
			const recipe = kitchen.recipes.find((item) => item.id === command.meal.recipeId);
			return {
				label: kitchen.meals.some((item) => item.id === command.meal.id)
					? 'Update meal'
					: 'Schedule meal',
				title: recipe?.title ?? 'Meal',
				summary: `${command.meal.slot} · ${command.meal.date} · ${command.meal.servings} servings`
			};
		}
		case 'meal.delete': {
			const meal = kitchen.meals.find((item) => item.id === command.id);
			const title = kitchen.recipes.find((item) => item.id === meal?.recipeId)?.title ?? 'Meal';
			return {
				label: 'Remove meal',
				title,
				summary: meal ? `${meal.slot} · ${meal.date}` : 'Remove from meal plan.'
			};
		}
		case 'meal.complete': {
			const meal = kitchen.meals.find((item) => item.id === command.id);
			const title = kitchen.recipes.find((item) => item.id === meal?.recipeId)?.title ?? 'Meal';
			return {
				label: 'Complete meal',
				title,
				summary: meal ? `${meal.slot} · ${meal.date}` : 'Mark this meal complete.'
			};
		}
		case 'shopping.upsert': {
			const item = command.item;
			return {
				label: kitchen.shopping.some((value) => value.id === item.id) ? 'Update item' : 'Add item',
				title: item.name,
				summary: `Shopping list · ${item.quantity} ${item.unit}`
			};
		}
		case 'shopping.delete': {
			const name = kitchen.shopping.find((item) => item.id === command.id)?.name ?? 'Shopping item';
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
				title: kitchen.recipes.find((item) => item.id === command.id)?.title ?? 'Recipe',
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
			if (command.action === 'recipe-new') {
				return {
					label: 'Open new recipe',
					title: 'New recipe',
					summary: 'Open a blank recipe form.'
				};
			}
			const title = command.action
				.split('-')
				.map((part) => (part === 'ai' ? 'AI' : part.charAt(0).toUpperCase() + part.slice(1)))
				.join(' ');
			return { label: `Open ${title}`, title, summary: 'Open this kitchen action.' };
		}
	}
}
