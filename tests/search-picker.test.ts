import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	PICKER_VISIBLE_LIMIT,
	activeOptionId,
	escapePickerState,
	filterPickerOptions,
	focusPickerState,
	inputPickerState,
	resolvePickerValue,
	stepPickerActive,
	type PickerOption
} from '../src/lib/search-picker.ts';

const options: PickerOption[] = [
	{
		id: 'chatgpt',
		label: 'ChatGPT subscription',
		detail: 'Authorize your ChatGPT plan · no API key'
	},
	{
		id: 'openai',
		label: 'OpenAI',
		detail: '4 models · API key',
		searchText: 'openai gpt-5 o3'
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		detail: '3 models · API key',
		searchText: 'anthropic claude sonnet'
	},
	{
		id: 'azure',
		label: 'Azure',
		detail: 'Integration not yet supported',
		searchText: 'azure gpt-5',
		disabled: true,
		searchOnly: true
	}
];

test('focus retains selected combobox value while listing all non-searchOnly options until typing begins', () => {
	const focused = focusPickerState();
	assert.equal(focused.open, true);
	assert.equal(focused.filtering, false);
	assert.equal(
		resolvePickerValue({
			options,
			value: 'openai',
			fallback: 'openai',
			query: focused.query,
			filtering: focused.filtering
		}),
		'OpenAI'
	);
	assert.equal(
		resolvePickerValue({
			options,
			value: 'custom-model',
			fallback: 'custom-model',
			query: focused.query,
			filtering: focused.filtering
		}),
		'custom-model'
	);
	assert.deepEqual(
		filterPickerOptions(options, 'OpenAI', focused.filtering).map((option) => option.id),
		['chatgpt', 'openai', 'anthropic']
	);

	const typing = inputPickerState('claude');
	assert.equal(typing.filtering, true);
	assert.equal(
		resolvePickerValue({
			options,
			value: 'openai',
			fallback: 'openai',
			query: typing.query,
			filtering: typing.filtering
		}),
		'claude'
	);
	assert.deepEqual(
		filterPickerOptions(options, typing.query, typing.filtering).map((option) => option.id),
		['anthropic']
	);

	const cleared = inputPickerState('');
	assert.equal(
		resolvePickerValue({
			options,
			value: 'openai',
			fallback: 'openai',
			query: cleared.query,
			filtering: cleared.filtering
		}),
		''
	);
	assert.equal(PICKER_VISIBLE_LIMIT, 80);
});

test('ArrowDown and ArrowUp start at list boundaries, wrap cleanly, and skip disabled options', () => {
	const list: PickerOption[] = [
		{ id: 'first', label: 'First' },
		{ id: 'disabled-mid', label: 'Disabled middle', disabled: true },
		{ id: 'last', label: 'Last' }
	];

	let active = -1;
	active = stepPickerActive(list, active, 'ArrowUp');
	assert.equal(active, 2);
	active = stepPickerActive(list, active, 'ArrowUp');
	assert.equal(active, 0);
	active = stepPickerActive(list, active, 'ArrowUp');
	assert.equal(active, 2);

	active = -1;
	active = stepPickerActive(list, active, 'ArrowDown');
	assert.equal(active, 0);
	active = stepPickerActive(list, active, 'ArrowDown');
	assert.equal(active, 2);
	active = stepPickerActive(list, active, 'ArrowDown');
	assert.equal(active, 0);

	const edgeDisabled: PickerOption[] = [
		{ id: 'd0', label: 'Disabled 0', disabled: true },
		{ id: 'enabled', label: 'Enabled' },
		{ id: 'd2', label: 'Disabled 2', disabled: true }
	];
	assert.equal(stepPickerActive(edgeDisabled, -1, 'ArrowDown'), 1);
	assert.equal(stepPickerActive(edgeDisabled, -1, 'ArrowUp'), 1);
	assert.equal(stepPickerActive(edgeDisabled, 1, 'ArrowDown'), 1);
	assert.equal(stepPickerActive(edgeDisabled, 1, 'ArrowUp'), 1);
});

test('disabled-only and empty queries keep active at -1 and omit aria-activedescendant', () => {
	const azureMatches = filterPickerOptions(options, 'azure', true);
	assert.deepEqual(
		azureMatches.map((option) => option.id),
		['azure']
	);
	assert.equal(azureMatches[0].disabled, true);

	const downActive = stepPickerActive(azureMatches, -1, 'ArrowDown');
	const upActive = stepPickerActive(azureMatches, -1, 'ArrowUp');
	assert.equal(downActive, -1);
	assert.equal(upActive, -1);
	assert.equal(activeOptionId('picker', true, false, azureMatches, downActive), undefined);
	assert.equal(activeOptionId('picker', true, false, azureMatches, 0), undefined);
	assert.equal(activeOptionId('picker', false, false, options, 0), undefined);
	assert.equal(activeOptionId('picker', true, true, options, 0), undefined);
	assert.equal(activeOptionId('picker', true, false, options, 1), 'picker-option-1');

	const noMatches = filterPickerOptions(options, 'nonexistent-provider', true);
	assert.deepEqual(noMatches, []);
	assert.equal(stepPickerActive(noMatches, -1, 'ArrowDown'), -1);
	assert.equal(stepPickerActive(noMatches, -1, 'ArrowUp'), -1);
});

test('Escape resets open and filtering state when active, and leaves collapsed state unhandled to bubble', () => {
	const filteringState = { ...inputPickerState('open'), active: 1 };
	const dismissed = escapePickerState(filteringState);
	assert.equal(dismissed.handled, true);
	assert.deepEqual(dismissed.state, {
		open: false,
		filtering: false,
		query: '',
		active: -1
	});
	assert.equal(
		resolvePickerValue({
			options,
			value: 'openai',
			fallback: 'openai',
			query: dismissed.state.query,
			filtering: dismissed.state.filtering
		}),
		'OpenAI'
	);

	const openUnfiltered = focusPickerState();
	const closedFromFocus = escapePickerState(openUnfiltered);
	assert.equal(closedFromFocus.handled, true);
	assert.equal(closedFromFocus.state.open, false);

	const collapsedAgain = escapePickerState(closedFromFocus.state);
	assert.equal(collapsedAgain.handled, false);

	const closedButFiltering = escapePickerState({ open: false, filtering: true });
	assert.equal(closedButFiltering.handled, true);
	assert.equal(closedButFiltering.state.filtering, false);
});
