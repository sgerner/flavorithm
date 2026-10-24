import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../src/lib/data.ts';
import { applyButlerCommands } from '../src/lib/butler.ts';
import { buildButlerActions } from '../src/lib/butler-actions.ts';

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
