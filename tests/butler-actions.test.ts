import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/lib/data.ts';
import { applyButlerCommands } from '../src/lib/butler.ts';
import {
	buildButlerActions,
	reconcileButlerUndoViews,
	resolveButlerControlTarget
} from '../src/lib/butler-actions.ts';

test('independent recipe and pantry changes become readable individual cards', () => {
	const kitchen = createInitialState();
	const before = structuredClone(kitchen);
	const recipe = {
		...kitchen.recipes[0],
		id: 'new-recipe',
		title: 'Tomato Soup',
		time: 25,
		servings: 4
	};
	const actions = buildButlerActions(
		[
			{ type: 'recipe.upsert', recipe },
			{
				type: 'pantry.upsert',
				item: { id: 'new-onion', name: 'Onion', quantity: 3, unit: 'each', category: 'Produce' }
			}
		],
		kitchen
	);
	assert.equal(actions.length, 2);
	assert.equal(actions[0].label, 'Add recipe');
	assert.equal(actions[0].title, 'Tomato Soup');
	assert.equal(actions[0].summary, '25 min · 4 servings');
	assert.equal(actions[1].label, 'Add item');
	assert.equal(actions[1].title, 'Onion');
	assert.equal(actions[1].summary, 'Pantry · 3 each');
	assert.deepEqual(kitchen, before);
	let updated = kitchen;
	for (const action of actions) updated = applyButlerCommands(updated, action.commands).state;
	assert.ok(updated.recipes.some((item) => item.id === 'new-recipe'));
	assert.ok(updated.pantry.some((item) => item.id === 'new-onion'));
});

test('a new recipe, dependent meal and shopping refresh are one atomic plan card', () => {
	const kitchen = createInitialState();
	const recipe = { ...kitchen.recipes[0], id: 'new-recipe', title: 'Lentil Stew' };
	const meal = {
		id: 'new-meal',
		date: '2026-10-24',
		slot: 'Dinner',
		recipeId: recipe.id,
		servings: 2
	};
	const input = [
		{ type: 'recipe.upsert', recipe },
		{
			type: 'pantry.upsert',
			item: { id: 'lentils', name: 'Lentils', quantity: 2, unit: 'cups', category: 'Dry goods' }
		},
		{ type: 'meal.upsert', meal },
		{ type: 'shopping.generate', weekStart: '2026-10-19' }
	];
	const action = buildButlerActions(input, kitchen)[0];
	assert.equal(buildButlerActions(input, kitchen).length, 1);
	assert.equal(action.label, 'Apply plan');
	assert.equal(action.title, 'Lentil Stew and Lentils');
	assert.deepEqual(action.commands, input);
	assert.equal(action.destructive, false);
});

test('recipe deletion uses the existing recipe name and is marked destructive', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	const [action] = buildButlerActions([{ type: 'recipe.delete', id: recipe.id }], kitchen);
	assert.equal(action.label, 'Remove recipe');
	assert.equal(action.title, recipe.title);
	assert.equal(action.destructive, true);
});

test('commands targeting the same resource are grouped in their original order', () => {
	const kitchen = createInitialState();
	const item = { id: 'same-item', name: 'Oats', quantity: 1, unit: 'kg', category: 'Dry goods' };
	const input = [
		{ type: 'pantry.upsert', item },
		{ type: 'pantry.delete', id: item.id },
		{ type: 'recipe.delete', id: kitchen.recipes[0].id }
	];
	const actions = buildButlerActions(input, kitchen);
	assert.equal(actions.length, 2);
	assert.equal(actions[0].label, 'Apply 2 changes');
	assert.deepEqual(actions[0].commands, input.slice(0, 2));
	assert.equal(actions[1].label, 'Remove recipe');
});

test('recipe removal groups with a command touching a scheduled referencing meal', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	const meal = {
		id: 'planned-lunch',
		date: '2026-10-24',
		slot: 'Lunch',
		recipeId: recipe.id,
		servings: 2
	};
	kitchen.meals = [meal];
	const input = [
		{ type: 'meal.delete', id: meal.id },
		{ type: 'recipe.delete', id: recipe.id }
	];
	const [action] = buildButlerActions(input, kitchen);
	assert.deepEqual(action.commands, input);
	assert.equal(action.destructive, true);
});

test('recipe edits group with completion of existing meals that reference them', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	kitchen.meals = [
		{ id: 'tonight', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];
	const updatedRecipe = { ...recipe, title: 'Updated chicken dinner' };
	const [action] = buildButlerActions(
		[
			{ type: 'recipe.upsert', recipe: updatedRecipe },
			{ type: 'meal.complete', id: 'tonight', deductPantry: true }
		],
		kitchen
	);
	assert.equal(action.commands.length, 2);
	const result = applyButlerCommands(kitchen, action.commands).state;
	assert.equal(result.recipes[0].title, 'Updated chicken dinner');
	assert.ok(result.meals[0].completedAt);
});

test('pantry changes group atomically with meal completion that deducts pantry', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	kitchen.meals = [
		{ id: 'tonight', date: '2026-10-23', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];
	const pantryItem = {
		id: 'garlic-pantry',
		name: 'garlic',
		quantity: 8,
		unit: 'cloves',
		category: 'Produce'
	};
	const [action] = buildButlerActions(
		[
			{ type: 'pantry.upsert', item: pantryItem },
			{ type: 'meal.complete', id: 'tonight', deductPantry: true }
		],
		kitchen
	);
	assert.equal(action.commands.length, 2);
	const result = applyButlerCommands(kitchen, action.commands).state;
	assert.equal(result.pantry.find((item) => item.id === pantryItem.id)?.quantity, 5);
	assert.ok(result.meals[0].completedAt);
});

test('meal upsert preserves completion so a later completion cannot deduct pantry twice', () => {
	const kitchen = createInitialState();
	const originalRecipe = kitchen.recipes[0];
	kitchen.recipes = [
		{
			...originalRecipe,
			servings: 1,
			ingredients: [{ name: 'tomato', quantity: 1, unit: 'each' }]
		}
	];
	const meal = {
		id: 'completed-dinner',
		date: '2026-10-22',
		slot: 'Dinner',
		recipeId: originalRecipe.id,
		servings: 1
	};
	kitchen.meals = [meal];
	kitchen.pantry = [
		{ id: 'tomato', name: 'tomato', quantity: 2, unit: 'each', category: 'Produce' }
	];
	const now = new Date('2026-10-22T18:30:00.000Z');
	const completed = applyButlerCommands(
		kitchen,
		[{ type: 'meal.complete', id: meal.id, deductPantry: true }],
		now
	).state;
	assert.equal(completed.pantry[0].quantity, 1);
	const upserted = applyButlerCommands(
		completed,
		[{ type: 'meal.upsert', meal: { ...meal, date: '2026-10-23' } }],
		now
	).state;
	assert.equal(upserted.meals[0].completedAt, completed.meals[0].completedAt);
	assert.equal(upserted.meals[0].leftoverServings, completed.meals[0].leftoverServings);
	const repeated = applyButlerCommands(
		upserted,
		[{ type: 'meal.complete', id: meal.id, deductPantry: true }],
		now
	).state;
	assert.equal(repeated.pantry[0].quantity, 1);
});

test('moving an existing meal groups with removal of its previous recipe', () => {
	const kitchen = createInitialState();
	const oldRecipe = kitchen.recipes[0];
	const newRecipe = kitchen.recipes[1];
	kitchen.meals = [
		{ id: 'move-meal', date: '2026-10-24', slot: 'Lunch', recipeId: oldRecipe.id, servings: 2 }
	];
	const input = [
		{ type: 'recipe.delete', id: oldRecipe.id },
		{ type: 'meal.upsert', meal: { ...kitchen.meals[0], recipeId: newRecipe.id } }
	];
	const [action] = buildButlerActions(input, kitchen);
	assert.equal(action.commands.length, 2);
	const result = applyButlerCommands(kitchen, action.commands).state;
	assert.equal(
		result.recipes.some((recipe) => recipe.id === oldRecipe.id),
		false
	);
	assert.equal(result.meals[0].recipeId, newRecipe.id);
});

test('rating updates are grouped with changes to their recipe', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	const actions = buildButlerActions(
		[
			{ type: 'preferences.update', preferences: { ratings: { [recipe.id]: 5 } } },
			{ type: 'recipe.upsert', recipe: { ...recipe, title: 'Five star recipe' } }
		],
		kitchen
	);
	assert.equal(actions.length, 1);
	assert.equal(actions[0].commands.length, 2);
});

test('shopping item cards identify the shopping list and navigation labels are human readable', () => {
	const kitchen = createInitialState();
	const actions = buildButlerActions(
		[
			{
				type: 'shopping.upsert',
				item: { id: 'milk', name: 'Milk', quantity: 2, unit: 'L', checked: false }
			},
			{ type: 'navigate', page: 'saved' },
			{ type: 'ui', action: 'ai-settings' }
		],
		kitchen
	);
	assert.equal(actions[0].summary, 'Shopping list · 2 L');
	assert.equal(actions[1].title, 'Recipe collection');
	assert.equal(actions[1].label, 'Open recipe collection');
	assert.equal(actions[2].label, 'Open AI Settings');
});

test('invalid command payloads fail validation', () => {
	const kitchen = createInitialState();
	assert.throws(() =>
		buildButlerActions([{ type: 'recipe.upsert', recipe: { id: 'bad' } }], kitchen)
	);
	assert.throws(() => buildButlerActions([{ type: 'ui', action: 'execute' }], kitchen));
});

test('frozen details keep target names and explicit verbs for meal, pantry, recipe, and shopping deletions before and after apply', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	const pantryItem = kitchen.pantry[0];
	kitchen.meals = [
		{ id: 'meal-1', date: '2026-10-25', slot: 'Dinner', recipeId: recipe.id, servings: 3 }
	];
	kitchen.shopping = [
		{ id: 'shop-1', name: 'Olive Oil', quantity: 500, unit: 'ml', checked: false }
	];

	const actions = buildButlerActions(
		[
			{ type: 'meal.delete', id: 'meal-1' },
			{ type: 'pantry.delete', id: pantryItem.id },
			{ type: 'shopping.delete', id: 'shop-1' },
			{ type: 'shopping.generate' },
			{ type: 'recipe.delete', id: kitchen.recipes[1].id }
		],
		structuredClone(kitchen)
	);
	assert.equal(actions.length, 1);
	const [planCard] = actions;
	assert.equal(planCard.details.length, 5);
	for (const line of planCard.details) {
		assert.doesNotMatch(line, /Kitchen update/);
	}
	assert.match(
		planCard.details[0],
		new RegExp(`^Remove meal: .*${recipe.title}.*Dinner.*2026-10-25`)
	);
	assert.match(planCard.details[1], new RegExp(`^Remove pantry item: ${pantryItem.name}`));
	assert.match(planCard.details[2], /^Remove shopping item: Olive Oil · 500 ml$/);
	assert.match(planCard.details[3], /^Update shopping list: Current week/);
	assert.match(planCard.details[4], new RegExp(`^Remove recipe: ${kitchen.recipes[1].title}`));

	// Mutate live kitchen state by applying the deletions; frozen details remain intact.
	const applied = applyButlerCommands(kitchen, planCard.commands, new Date('2026-10-23T12:00:00Z'));
	assert.equal(applied.state.meals.length, 0);
	assert.equal(
		applied.state.pantry.some((item) => item.id === pantryItem.id),
		false
	);
	assert.equal(
		applied.state.shopping.some((item) => item.id === 'shop-1'),
		false
	);
	assert.match(
		planCard.details[0],
		new RegExp(`^Remove meal: .*${recipe.title}.*Dinner.*2026-10-25`)
	);
	assert.match(planCard.details[1], new RegExp(`^Remove pantry item: ${pantryItem.name}`));
	assert.match(planCard.details[2], /^Remove shopping item: Olive Oil/);
	assert.match(planCard.details[4], new RegExp(`^Remove recipe: ${kitchen.recipes[1].title}`));
});

test('multi-action cards prefix every line with explicit verbs separating removals, additions, and updates', () => {
	const kitchen = createInitialState();
	const existingPantry = kitchen.pantry[0];
	const existingRecipe = kitchen.recipes[0];
	const newRecipe = { ...existingRecipe, id: 'herb-pasta', title: 'Herb Pasta' };
	kitchen.meals = [
		{
			id: 'old-dinner',
			date: '2026-10-24',
			slot: 'Dinner',
			recipeId: existingRecipe.id,
			servings: 2
		}
	];
	const [card] = buildButlerActions(
		[
			{ type: 'recipe.upsert', recipe: newRecipe },
			{ type: 'pantry.upsert', item: { ...existingPantry, quantity: existingPantry.quantity + 1 } },
			{
				type: 'pantry.upsert',
				item: { id: 'capers', name: 'Capers', quantity: 1, unit: 'jar', category: 'Pantry' }
			},
			{ type: 'pantry.delete', id: kitchen.pantry[1].id },
			{ type: 'meal.delete', id: 'old-dinner' },
			{
				type: 'meal.upsert',
				meal: {
					id: 'new-dinner',
					date: '2026-10-26',
					slot: 'Dinner',
					recipeId: 'herb-pasta',
					servings: 4
				}
			},
			{ type: 'shopping.generate', weekStart: '2026-10-26' }
		],
		kitchen
	);

	assert.match(card.details[0], /^Add recipe: Herb Pasta/);
	assert.match(card.details[1], new RegExp(`^Update pantry item: ${existingPantry.name}`));
	assert.match(card.details[2], /^Add pantry item: Capers/);
	assert.match(card.details[3], new RegExp(`^Remove pantry item: ${kitchen.pantry[1].name}`));
	assert.match(
		card.details[4],
		new RegExp(`^Remove meal: ${existingRecipe.title} · Dinner · 2026-10-24`)
	);
	assert.match(card.details[5], /^Schedule meal: Herb Pasta · Dinner · 2026-10-26 · 4 servings$/);
	assert.match(card.details[6], /^Update shopping list: Week of 2026-10-26/);
	for (const detail of card.details) {
		assert.equal(detail.includes('\n'), false);
		assert.doesNotMatch(detail, /Kitchen update/);
	}
});

test('meal completion cards show pantry deductions and leftover counts in summary and details', () => {
	const kitchen = createInitialState();
	const recipe = kitchen.recipes[0];
	kitchen.meals = [
		{ id: 'lunch-1', date: '2026-10-24', slot: 'Lunch', recipeId: recipe.id, servings: 4 },
		{ id: 'dinner-1', date: '2026-10-24', slot: 'Dinner', recipeId: recipe.id, servings: 2 }
	];

	const [withDeduction, withoutDeduction] = buildButlerActions(
		[
			{ type: 'meal.complete', id: 'lunch-1', deductPantry: true, leftoverServings: 2 },
			{ type: 'meal.complete', id: 'dinner-1', deductPantry: false }
		],
		kitchen
	);

	assert.equal(withDeduction.label, 'Complete meal');
	assert.equal(withDeduction.title, recipe.title);
	assert.match(withDeduction.summary, /Lunch · 2026-10-24/);
	assert.match(withDeduction.summary, /deducts pantry stock/);
	assert.match(withDeduction.summary, /2 leftover servings/);
	assert.match(
		withDeduction.details[0],
		new RegExp(
			`^Complete meal: ${recipe.title} · Lunch · 2026-10-24 · 4 servings · deducts pantry stock · 2 leftover servings$`
		)
	);

	assert.match(withoutDeduction.summary, /Dinner · 2026-10-24/);
	assert.match(withoutDeduction.summary, /no pantry deduction/);
	assert.match(withoutDeduction.summary, /no leftovers/);
	assert.match(
		withoutDeduction.details[0],
		new RegExp(
			`^Complete meal: ${recipe.title} · Dinner · 2026-10-24 · 2 servings · no pantry deduction · 0 leftover servings$`
		)
	);
});

test('account departure and sign-out cards are destructive while export cards use explicit export verbs and confirmation routing', () => {
	const kitchen = createInitialState();
	const actions = buildButlerActions(
		[
			{ type: 'ui', action: 'sign-out' },
			{ type: 'ui', action: 'delete-account' },
			{ type: 'ui', action: 'leave-household' },
			{ type: 'ui', action: 'export-kitchen' },
			{ type: 'ui', action: 'export-shopping' },
			{ type: 'ui', action: 'export-pending' }
		],
		kitchen
	);

	assert.equal(actions[0].label, 'Sign out');
	assert.equal(actions[0].destructive, true);
	assert.match(actions[0].details[0], /^Sign out:/);

	assert.equal(actions[1].label, 'Delete account');
	assert.equal(actions[1].destructive, true);
	assert.match(actions[1].details[0], /^Delete account:/);

	assert.equal(actions[2].label, 'Leave household');
	assert.equal(actions[2].destructive, true);
	assert.match(actions[2].details[0], /^Leave household:/);

	assert.equal(actions[3].label, 'Export kitchen data');
	assert.equal(actions[3].destructive, false);
	assert.doesNotMatch(actions[3].label, /^Open /);
	assert.match(actions[3].details[0], /^Export kitchen data:/);

	assert.equal(actions[4].label, 'Export shopping list');
	assert.equal(actions[4].destructive, false);
	assert.doesNotMatch(actions[4].label, /^Open /);
	assert.match(actions[4].details[0], /^Export shopping list:/);

	assert.equal(actions[5].label, 'Export pending changes');
	assert.equal(actions[5].destructive, false);
	assert.doesNotMatch(actions[5].label, /^Open /);
	assert.match(actions[5].details[0], /^Export pending changes:/);

	assert.deepEqual(resolveButlerControlTarget('sign-out'), { kind: 'confirm-sign-out' });
	assert.deepEqual(resolveButlerControlTarget('export-kitchen'), {
		kind: 'confirm-export',
		exportKind: 'kitchen'
	});
	assert.deepEqual(resolveButlerControlTarget('export-shopping'), {
		kind: 'confirm-export',
		exportKind: 'shopping'
	});
	assert.deepEqual(resolveButlerControlTarget('export-pending'), {
		kind: 'confirm-export',
		exportKind: 'pending'
	});
	assert.deepEqual(resolveButlerControlTarget('delete-account'), {
		kind: 'confirm-delete-account'
	});
	assert.deepEqual(resolveButlerControlTarget('leave-household'), {
		kind: 'confirm-leave-household'
	});
	assert.deepEqual(resolveButlerControlTarget('settings'), { kind: 'open', target: 'settings' });
});

test('undo reconciliation omits undo for navigation/dialog actions and closes stale recipe, editor, and cooking prompts', () => {
	const previous = createInitialState();
	const navResult = applyButlerCommands(previous, [{ type: 'navigate', page: 'planner' }]);
	const navCleanup = reconcileButlerUndoViews(
		previous,
		navResult.state,
		{ selectedId: previous.recipes[0].id },
		navResult.effects
	);
	assert.equal(navCleanup.changedKitchen, false);
	assert.equal(navCleanup.closeSelected, false);

	// Compound recipe upsert + open closes open RecipeDetail on undo while sparing unrelated recipes.
	const newRecipe = {
		...previous.recipes[0],
		id: 'basil-risotto',
		title: 'Mushroom Risotto',
		saved: true
	};
	const compoundResult = applyButlerCommands(previous, [
		{ type: 'recipe.upsert', recipe: newRecipe },
		{
			type: 'meal.upsert',
			meal: {
				id: 'risotto-dinner',
				date: '2026-10-27',
				slot: 'Dinner',
				recipeId: 'basil-risotto',
				servings: 2
			}
		},
		{ type: 'recipe.open', id: 'basil-risotto', mode: 'detail' }
	]);

	const detailCleanup = reconcileButlerUndoViews(
		previous,
		compoundResult.state,
		{ selectedId: 'basil-risotto' },
		compoundResult.effects
	);
	assert.equal(detailCleanup.changedKitchen, true);
	assert.equal(detailCleanup.closeSelected, true);

	const editorCleanup = reconcileButlerUndoViews(
		previous,
		compoundResult.state,
		{ editingRecipeId: 'basil-risotto' },
		compoundResult.effects
	);
	assert.equal(editorCleanup.closeEditor, true);

	const cookCleanup = reconcileButlerUndoViews(
		previous,
		compoundResult.state,
		{ modal: 'cookMeal', cookingMealId: 'risotto-dinner' },
		compoundResult.effects
	);
	assert.equal(cookCleanup.clearCookingMeal, true);
	assert.equal(cookCleanup.closeModal, true);

	const unrelatedCleanup = reconcileButlerUndoViews(
		previous,
		compoundResult.state,
		{ selectedId: previous.recipes[1].id },
		[]
	);
	assert.equal(unrelatedCleanup.closeSelected, false);
});
