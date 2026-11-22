import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences } from '../src/lib/data.ts';
import type { User } from '../src/lib/types.ts';
import {
	applyGenerateGuestFilters,
	captureGenerateGuestFilters,
	hasAIConnection,
	resolvePostSetupAction,
	transitionButlerOwner,
	type PendingAIContinuation
} from '../src/lib/ai-continuation.ts';

const userA: User = {
	id: 'user-a',
	householdId: 'house-a',
	name: 'Ada Lovelace',
	email: 'ada@example.test'
};

test('hasAIConnection enforces sign-in, model selection, and active key or ChatGPT plan', () => {
	assert.equal(
		hasAIConnection({
			user: null,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: 'sk-test'
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: ''
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: '' },
			apiKey: 'sk-test'
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'openai', model: 'gpt-4o-mini' },
			apiKey: 'sk-test'
		}),
		true
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'chatgpt', model: 'gpt-5-codex' },
			apiKey: '',
			activeChatGPTAccount: { connected: true, planEnabled: false }
		}),
		false
	);
	assert.equal(
		hasAIConnection({
			user: userA,
			preferences: { provider: 'chatgpt', model: 'gpt-5-codex' },
			apiKey: '',
			activeChatGPTAccount: { connected: true, planEnabled: true }
		}),
		true
	);
});

test('resolvePostSetupAction chains Settings when AI is unready and resumes all five workflows when ready', () => {
	assert.equal(resolvePostSetupAction(null, false), 'none');
	assert.equal(resolvePostSetupAction(null, true), 'none');

	const continuations: PendingAIContinuation[] = [
		{ kind: 'import' },
		{ kind: 'generate', prompt: 'Spicy tofu stir-fry', guestFilters: { diet: 'Vegan' } },
		{ kind: 'butler', prompt: 'Plan dinners for the week using my pantry.' },
		{ kind: 'scan' },
		{ kind: 'nutrition', recipeId: 'lemon-herb-chicken', servings: 4 }
	];

	for (const continuation of continuations) {
		assert.equal(resolvePostSetupAction(continuation, false), 'settings');
		assert.equal(resolvePostSetupAction(continuation, true), 'resume');
	}
});

test('guest dietary filter overrides in Generate recipes preserve customized fields without clobbering saved account preferences', () => {
	assert.equal(captureGenerateGuestFilters(defaultPreferences, defaultPreferences), undefined);

	const guestEdited = {
		maxTime: 30,
		diet: 'Vegan',
		allergies: defaultPreferences.allergies
	};
	const captured = captureGenerateGuestFilters(guestEdited, defaultPreferences);
	assert.deepEqual(captured, { maxTime: 30, diet: 'Vegan' });

	const savedAccountPreferences = {
		maxTime: 60,
		diet: 'none',
		allergies: 'shellfish, peanuts'
	};
	applyGenerateGuestFilters(savedAccountPreferences, captured);
	assert.deepEqual(savedAccountPreferences, {
		maxTime: 30,
		diet: 'Vegan',
		allergies: 'shellfish, peanuts'
	});
});

test('transitionButlerOwner preserves only pending prompt from guest to signed-in owner and clears transcripts', () => {
	const fromDraft = transitionButlerOwner('guest:', 'user-a:house-a', {
		messages: [{ id: 1, role: 'user', content: 'Old guest turn' }],
		recipeDrafts: [{ id: 'draft-1' }],
		draft: 'What can I cook with chickpeas tonight?',
		error: 'Sign in first',
		failedPrompt: 'Fallback prompt',
		applying: '1:a'
	});
	assert.deepEqual(fromDraft, {
		messages: [],
		recipeDrafts: [],
		draft: 'What can I cook with chickpeas tonight?',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const fromFailedPrompt = transitionButlerOwner('guest:', 'user-a:house-a', {
		messages: [{ id: 1, role: 'user', content: 'Plan dinners for the week.' }],
		recipeDrafts: [{ id: 'draft-1' }],
		draft: '',
		error: 'Sign in and connect a model in Settings to speak with Basil.',
		failedPrompt: 'Plan dinners for the week.',
		applying: ''
	});
	assert.deepEqual(fromFailedPrompt, {
		messages: [],
		recipeDrafts: [],
		draft: 'Plan dinners for the week.',
		error: '',
		failedPrompt: '',
		applying: ''
	});
});

test('transitionButlerOwner wipes messages, draft, failedPrompt, and recipeDrafts when switching between signed-in accounts or signing out', () => {
	const populated = {
		messages: [
			{ id: 1, role: 'user', content: 'Private recipe request' },
			{ id: 2, role: 'assistant', content: 'Private reply', actions: [{ id: 'act-1' }] }
		],
		recipeDrafts: [{ id: 'secret-recipe' }],
		draft: 'Unfinished private prompt',
		error: 'Temporary error',
		failedPrompt: 'Failed private prompt',
		applying: '2:act-1'
	};

	const switchedAccount = transitionButlerOwner('user-a:house-a', 'user-b:house-b', populated);
	assert.deepEqual(switchedAccount, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const switchedHousehold = transitionButlerOwner('user-a:house-a', 'user-a:house-b', populated);
	assert.deepEqual(switchedHousehold, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const signedOut = transitionButlerOwner('user-a:house-a', 'guest:', populated);
	assert.deepEqual(signedOut, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});

	const nextUserAfterSignOut = transitionButlerOwner('guest:', 'user-b:house-b', signedOut);
	assert.deepEqual(nextUserAfterSignOut, {
		messages: [],
		recipeDrafts: [],
		draft: '',
		error: '',
		failedPrompt: '',
		applying: ''
	});
});
