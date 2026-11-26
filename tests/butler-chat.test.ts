import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState } from '../src/lib/data.ts';
import {
	BUTLER_HISTORY_LIMIT,
	BUTLER_TIMEOUT_MESSAGE,
	butlerRequestError,
	createButlerChat,
	formatButlerMessage,
	pairButlerHistory,
	shouldRestoreDraft,
	type ButlerChatMessage,
	type ButlerChatResult,
	type ButlerTurn
} from '../src/lib/butler-chat.ts';
import type { AppState, Recipe } from '../src/lib/types.ts';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function createHarness(options: {
	owner?: string;
	timeoutMs?: number;
	request: (
		prompt: string,
		history: ButlerTurn[],
		signal?: AbortSignal,
		recipeDrafts?: Recipe[]
	) => Promise<ButlerChatResult>;
}) {
	let kitchen: AppState = createInitialState();
	let owner = options.owner ?? 'user-1:house-1';
	let draft = '';
	let messages: ButlerChatMessage[] = [];
	let recipeDrafts: Recipe[] = [];
	let busy = false;
	let applying = '';
	let error = '';
	let failedPrompt = '';

	const chat = createButlerChat({
		getKitchen: () => kitchen,
		getOwner: () => owner,
		isWorking: () => busy || !!applying,
		getDraft: () => draft,
		setDraft: (value) => {
			draft = value;
		},
		getMessages: () => messages,
		setMessages: (value) => {
			messages = value;
		},
		getRecipeDrafts: () => recipeDrafts,
		setRecipeDrafts: (value) => {
			recipeDrafts = value;
		},
		setBusy: (value) => {
			busy = value;
		},
		setError: (value) => {
			error = value;
		},
		getFailedPrompt: () => failedPrompt,
		setFailedPrompt: (value) => {
			failedPrompt = value;
		},
		request: options.request,
		timeoutMs: options.timeoutMs
	});

	return {
		chat,
		get kitchen() {
			return kitchen;
		},
		set kitchen(value: AppState) {
			kitchen = value;
		},
		get owner() {
			return owner;
		},
		setOwner(next: string) {
			owner = next;
			chat.cancelRequest();
			messages = [];
			recipeDrafts = [];
			draft = '';
			error = '';
			failedPrompt = '';
			applying = '';
		},
		get draft() {
			return draft;
		},
		set draft(value: string) {
			draft = value;
		},
		get messages() {
			return messages;
		},
		get recipeDrafts() {
			return recipeDrafts;
		},
		get busy() {
			return busy;
		},
		get error() {
			return error;
		},
		get failedPrompt() {
			return failedPrompt;
		}
	};
}

test('stop removes the unanswered turn, restores draft, and preserves prior pending action cards', async () => {
	let turn = 0;
	const secondCall = deferred<ButlerChatResult>();
	let observedSignal: AbortSignal | undefined;
	const harness = createHarness({
		request: async (_prompt, _history, signal) => {
			turn += 1;
			if (turn === 1) {
				return {
					reply: 'Shall I add onions to the pantry?',
					commands: [
						{
							type: 'pantry.upsert',
							item: { id: 'onion-1', name: 'Onion', quantity: 2, unit: 'each', category: 'Produce' }
						}
					]
				};
			}
			observedSignal = signal;
			return secondCall.promise;
		}
	});

	harness.draft = 'Add onions please';
	await harness.chat.send();
	assert.equal(harness.messages.length, 2);
	assert.equal(harness.messages[1].actions?.[0]?.status, 'pending');

	harness.draft = 'Also plan Thursday dinner with spinach';
	const pendingSend = harness.chat.send();
	assert.equal(harness.busy, true);
	assert.equal(harness.draft, '');
	assert.equal(harness.messages.length, 3);
	assert.equal(harness.messages[1].actions?.[0]?.status, 'pending');

	harness.chat.stop();
	secondCall.reject(new DOMException('Aborted', 'AbortError'));
	await pendingSend;

	assert.equal(observedSignal?.aborted, true);
	assert.equal(harness.busy, false);
	assert.equal(harness.error, '');
	assert.equal(harness.failedPrompt, '');
	assert.equal(harness.draft, 'Also plan Thursday dinner with spinach');
	assert.equal(harness.messages.length, 2);
	assert.equal(harness.messages[1].actions?.[0]?.status, 'pending');
});

test('stop and request failures preserve text typed while a request is in flight', async () => {
	assert.equal(shouldRestoreDraft('', 'Plan pasta'), true);
	assert.equal(shouldRestoreDraft('   ', 'Plan pasta'), true);
	assert.equal(shouldRestoreDraft('Plan pasta', 'Plan pasta'), true);
	assert.equal(shouldRestoreDraft('  Plan pasta  ', 'Plan pasta'), true);
	assert.equal(shouldRestoreDraft('Actually make risotto', 'Plan pasta'), false);

	let inFlight = deferred<ButlerChatResult>();
	const harness = createHarness({
		request: () => inFlight.promise
	});

	// 1. Typing while in flight + stop() keeps the newly typed draft
	harness.draft = 'Plan pasta tonight';
	const stoppedTurn = harness.chat.send();
	assert.equal(harness.draft, '');
	harness.draft = 'Actually make mushroom risotto';
	harness.chat.stop();
	inFlight.reject(new DOMException('Aborted', 'AbortError'));
	await stoppedTurn;
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.draft, 'Actually make mushroom risotto');
	assert.equal(harness.error, '');
	assert.equal(harness.failedPrompt, '');

	// 2. Typing while in flight + request failure keeps the newly typed draft while recording failedPrompt
	inFlight = deferred<ButlerChatResult>();
	harness.draft = 'Plan soup tonight';
	const failedTurn = harness.chat.send();
	assert.equal(harness.draft, '');
	harness.draft = 'Hold the garlic in tomorrow’s soup';
	inFlight.reject(new Error('Provider temporarily unavailable.'));
	await failedTurn;
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.draft, 'Hold the garlic in tomorrow’s soup');
	assert.equal(harness.failedPrompt, 'Plan soup tonight');
	assert.equal(harness.error, 'Provider temporarily unavailable.');

	// 3. Clicking a starter prompt while unsent text is in draft preserves the unsent draft
	inFlight = deferred<ButlerChatResult>();
	harness.draft = 'My half-finished note';
	const starterTurn = harness.chat.send('Plan dinners for the week using my pantry.');
	assert.equal(harness.draft, 'My half-finished note');
	harness.chat.stop();
	inFlight.reject(new DOMException('Aborted', 'AbortError'));
	await starterTurn;
	assert.equal(harness.draft, 'My half-finished note');
});

test('90-second request timeout surfaces reason.message, rolls back the unanswered turn, and restores draft', async () => {
	const harness = createHarness({
		timeoutMs: 20,
		request: (_prompt, _history, signal) =>
			new Promise<ButlerChatResult>((_, reject) => {
				signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
					once: true
				});
			})
	});

	harness.draft = 'Build a three-course Sunday roast';
	await harness.chat.send();

	assert.equal(harness.busy, false);
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.error, BUTLER_TIMEOUT_MESSAGE);
	assert.equal(harness.draft, 'Build a three-course Sunday roast');
	assert.equal(harness.failedPrompt, 'Build a three-course Sunday roast');

	const bareController = new AbortController();
	bareController.abort();
	assert.equal(
		butlerRequestError(new DOMException('Aborted', 'AbortError'), bareController.signal),
		'The request was interrupted. Please try again.'
	);
});

test('retries send edited draft text or fall back to failedPrompt without leaving duplicate user turns', async () => {
	const calls: Array<{ prompt: string; history: ButlerTurn[] }> = [];
	let shouldFail = true;
	const harness = createHarness({
		request: async (prompt, history) => {
			calls.push({ prompt, history });
			if (shouldFail) throw new Error('Provider temporarily unavailable.');
			return { reply: `Handled: ${prompt}`, commands: [] };
		}
	});

	harness.draft = 'Plan pasta tonight';
	await harness.chat.send();
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.draft, 'Plan pasta tonight');
	assert.equal(harness.failedPrompt, 'Plan pasta tonight');
	assert.equal(harness.error, 'Provider temporarily unavailable.');

	// Edit the restored draft before clicking Try again
	harness.draft = 'Plan lemon caper pasta tonight';
	await harness.chat.retry();
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.draft, 'Plan lemon caper pasta tonight');
	assert.equal(harness.failedPrompt, 'Plan lemon caper pasta tonight');

	// Clear the textarea completely and verify retry falls back to failedPrompt
	harness.draft = '   ';
	shouldFail = false;
	await harness.chat.retry();

	assert.equal(harness.error, '');
	assert.equal(harness.failedPrompt, '');
	assert.equal(harness.draft, '');
	assert.deepEqual(
		harness.messages.map(({ role, content }) => ({ role, content })),
		[
			{ role: 'user', content: 'Plan lemon caper pasta tonight' },
			{ role: 'assistant', content: 'Handled: Plan lemon caper pasta tonight' }
		]
	);
	assert.deepEqual(calls, [
		{ prompt: 'Plan pasta tonight', history: [] },
		{ prompt: 'Plan lemon caper pasta tonight', history: [] },
		{ prompt: 'Plan lemon caper pasta tonight', history: [] }
	]);
});

test('clear and owner changes discard pending prompts without restoring draft', async () => {
	let currentDeferred = deferred<ButlerChatResult>();
	const harness = createHarness({
		request: () => currentDeferred.promise
	});

	harness.draft = 'Discard me on clear';
	const firstSend = harness.chat.send();
	harness.chat.clear();
	currentDeferred.reject(new Error('late failure'));
	await firstSend;
	assert.equal(harness.draft, '');
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.error, '');

	currentDeferred = deferred<ButlerChatResult>();
	harness.draft = 'Discard me on account switch';
	const secondSend = harness.chat.send();
	harness.setOwner('user-2:house-2');
	currentDeferred.resolve({ reply: 'Late reply', commands: [] });
	await secondSend;
	assert.equal(harness.draft, '');
	assert.equal(harness.messages.length, 0);
});

test('pairButlerHistory keeps only completed user and assistant pairs and preserves applied action notes', () => {
	const raw: ButlerChatMessage[] = [
		{ id: 1, role: 'assistant', content: 'Orphan assistant greeting' },
		{ id: 2, role: 'user', content: 'Unanswered first question' },
		{ id: 3, role: 'user', content: 'Add garlic' },
		{
			id: 4,
			role: 'assistant',
			content: 'Ready for review.',
			actions: [
				{
					id: 'butler-action-0',
					label: 'Add item',
					title: 'Garlic',
					summary: 'Pantry · 3 cloves',
					commands: [],
					destructive: false,
					status: 'applied'
				}
			]
		},
		{ id: 5, role: 'user', content: 'Unanswered trailing question' }
	];

	const paired = pairButlerHistory(raw, formatButlerMessage, 20);
	assert.deepEqual(paired, [
		{ role: 'user', content: 'Add garlic' },
		{ role: 'assistant', content: 'Ready for review.\n\n[User applied: Garlic]' }
	]);

	const manyTurns: ButlerTurn[] = Array.from({ length: 24 }, (_, index) => ({
		role: index % 2 === 0 ? 'user' : 'assistant',
		content: `turn-${index}`
	}));
	manyTurns.push({ role: 'user', content: 'unanswered-tail' });
	assert.equal(BUTLER_HISTORY_LIMIT, 20);
	const window = pairButlerHistory(manyTurns, (turn) => turn.content.slice(0, 8000));
	assert.equal(window.length, BUTLER_HISTORY_LIMIT);
	assert.equal(window[0].role, 'user');
	assert.equal(window[0].content, 'turn-4');
	assert.equal(window.at(-1)?.role, 'assistant');
	assert.equal(window.at(-1)?.content, 'turn-23');
});

test('assistant messages record droppedCommands warnings while keeping valid action cards', async () => {
	const harness = createHarness({
		request: async () => ({
			reply: 'I added the carrots; one malformed card was skipped.',
			commands: [
				{
					type: 'pantry.upsert',
					item: { id: 'carrot-1', name: 'Carrot', quantity: 5, unit: 'each', category: 'Produce' }
				}
			],
			droppedCommands: 2
		})
	});

	harness.draft = 'Add carrots and build a stew';
	await harness.chat.send();

	assert.equal(harness.messages.length, 2);
	assert.equal(harness.messages[1].actions?.length, 1);
	assert.equal(harness.messages[1].warning, '2 invalid actions were omitted from this reply.');
});
