import { buildButlerActions, type ButlerAction } from './butler-actions.ts';
import type { AppState, Recipe } from './types.ts';

export type ButlerTurn = { role: 'user' | 'assistant'; content: string };
export type ButlerChatAction = ButlerAction & { status: 'pending' | 'applied' | 'dismissed' };
export type ButlerChatMessage = ButlerTurn & {
	id: number;
	actions?: ButlerChatAction[];
	snapshot?: string;
	warning?: string;
};
export type ButlerChatResult = {
	reply: string;
	commands: unknown[];
	droppedCommands?: number;
};

export const BUTLER_TIMEOUT_MS = 90_000;
export const BUTLER_TIMEOUT_MESSAGE = 'Basil took too long to respond. Please try again.';

export function formatButlerMessage(
	message: Pick<ButlerChatMessage, 'content' | 'actions'>
): string {
	const applied = message.actions
		?.filter((action) => action.status === 'applied')
		.map((action) => action.title);
	return applied?.length
		? `${message.content}\n\n[User applied: ${applied.join('; ')}]`
		: message.content;
}

/** Build chat history strictly from completed user -> assistant turn pairs. */
export function pairButlerHistory<T extends ButlerTurn>(
	turns: readonly T[],
	format?: (turn: T) => string,
	maxTurns = 20
): ButlerTurn[] {
	const paired: ButlerTurn[] = [];
	for (let index = 0; index < turns.length - 1; index += 1) {
		const current = turns[index];
		const next = turns[index + 1];
		if (current?.role === 'user' && next?.role === 'assistant') {
			const userContent = format ? format(current) : current.content;
			const assistantContent = format ? format(next) : next.content;
			if (userContent.trim() && assistantContent.trim()) {
				paired.push(
					{ role: 'user', content: userContent },
					{ role: 'assistant', content: assistantContent }
				);
			}
			index += 1;
		}
	}
	return maxTurns > 0 ? paired.slice(-maxTurns) : paired;
}

export function butlerRequestError(error: unknown, signal?: AbortSignal): string {
	if (signal?.aborted) {
		const reason = signal.reason;
		if (reason instanceof Error && reason.name !== 'AbortError' && reason.message.trim()) {
			return reason.message;
		}
		if (typeof reason === 'string' && reason.trim()) {
			return reason;
		}
		return 'The request was interrupted. Please try again.';
	}
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}
	return 'Basil could not connect. Please try again.';
}

export function droppedCommandsWarning(droppedCommands?: number): string | undefined {
	if (!droppedCommands || droppedCommands <= 0) return undefined;
	return droppedCommands === 1
		? '1 invalid action was omitted from this reply.'
		: `${droppedCommands} invalid actions were omitted from this reply.`;
}

export function createButlerChat(options: {
	getKitchen: () => AppState;
	getOwner: () => string;
	isWorking: () => boolean;
	getDraft: () => string;
	setDraft: (value: string) => void;
	getMessages: () => ButlerChatMessage[];
	setMessages: (value: ButlerChatMessage[]) => void;
	getRecipeDrafts: () => Recipe[];
	setRecipeDrafts: (value: Recipe[]) => void;
	setBusy: (value: boolean) => void;
	setError: (value: string) => void;
	getFailedPrompt: () => string;
	setFailedPrompt: (value: string) => void;
	request: (
		prompt: string,
		history: ButlerTurn[],
		signal?: AbortSignal,
		recipeDrafts?: Recipe[]
	) => Promise<ButlerChatResult>;
	timeoutMs?: number;
	onSpeak?: (duration: number) => void;
	onResetReaction?: () => void;
	onScroll?: () => void;
}) {
	let sequence = 0;
	let generation = 0;
	let alive = true;
	let controller: AbortController | undefined;
	let requestTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingTurn: { id: number; prompt: string } | undefined;

	function cancelRequest() {
		pendingTurn = undefined;
		controller?.abort();
		clearTimeout(requestTimer);
		controller = undefined;
		generation += 1;
		options.setBusy(false);
		options.onResetReaction?.();
	}

	async function send(prompt = options.getDraft().trim()) {
		if (!prompt || options.isWorking() || !options.getOwner()) return;
		options.onResetReaction?.();
		const token = ++generation;
		const currentMessages = options.getMessages();
		const history = pairButlerHistory(currentMessages, formatButlerMessage, 20);
		const turnId = ++sequence;
		pendingTurn = { id: turnId, prompt };
		options.setMessages([...currentMessages, { id: turnId, role: 'user', content: prompt }]);
		options.setDraft('');
		options.setError('');
		options.setFailedPrompt('');
		options.setBusy(true);
		const snapshot = JSON.stringify(options.getKitchen());
		const currentController = new AbortController();
		controller = currentController;
		requestTimer = setTimeout(
			() => currentController.abort(new Error(BUTLER_TIMEOUT_MESSAGE)),
			options.timeoutMs ?? BUTLER_TIMEOUT_MS
		);
		options.onScroll?.();
		try {
			const result = await options.request(
				prompt,
				history,
				currentController.signal,
				options.getRecipeDrafts()
			);
			currentController.signal.throwIfAborted();
			if (!alive || token !== generation) return;
			pendingTurn = undefined;
			const messages = options.getMessages();
			for (const message of messages) {
				for (const action of message.actions ?? []) {
					if (action.status === 'pending') action.status = 'dismissed';
				}
			}
			const actions = buildButlerActions(result.commands, JSON.parse(snapshot)).map(
				(action): ButlerChatAction => ({ ...action, status: 'pending' })
			);
			const drafts = new Map(options.getRecipeDrafts().map((recipe) => [recipe.id, recipe]));
			for (const action of actions) {
				for (const command of action.commands) {
					if (command.type === 'recipe.upsert') drafts.set(command.recipe.id, command.recipe);
				}
			}
			options.setRecipeDrafts([...drafts.values()].slice(-10));
			options.onSpeak?.(Math.min(12000, Math.max(2400, result.reply.length * 28)));
			const warning = droppedCommandsWarning(result.droppedCommands);
			options.setMessages([
				...messages,
				{
					id: ++sequence,
					role: 'assistant',
					content: result.reply,
					actions,
					snapshot,
					...(warning ? { warning } : {})
				}
			]);
		} catch (error) {
			if (!alive || token !== generation) return;
			pendingTurn = undefined;
			options.setMessages(options.getMessages().filter((message) => message.id !== turnId));
			options.setDraft(prompt);
			options.setError(butlerRequestError(error, currentController.signal));
			options.setFailedPrompt(prompt);
		} finally {
			if (alive && token === generation) {
				clearTimeout(requestTimer);
				controller = undefined;
				options.setBusy(false);
				options.onScroll?.();
			}
		}
	}

	function stop() {
		const pending = pendingTurn;
		cancelRequest();
		if (pending) {
			options.setMessages(options.getMessages().filter((message) => message.id !== pending.id));
			options.setDraft(pending.prompt);
		}
		options.setError('');
		options.setFailedPrompt('');
	}

	function retry() {
		const nextPrompt = options.getDraft().trim() || options.getFailedPrompt();
		return send(nextPrompt);
	}

	function clear() {
		cancelRequest();
		options.setMessages([]);
		options.setRecipeDrafts([]);
		options.setError('');
		options.setFailedPrompt('');
	}

	function destroy() {
		alive = false;
		cancelRequest();
	}

	return {
		get generation() {
			return generation;
		},
		get alive() {
			return alive;
		},
		cancelRequest,
		send,
		stop,
		retry,
		clear,
		destroy
	};
}
