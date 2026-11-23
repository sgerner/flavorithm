export type ToastItem = {
	id: number;
	message: string;
	undo: (() => void) | null;
};

export type StatusSnapshot = {
	buffers: [string, string];
	activeSlot: 0 | 1;
	version: number;
	freshInCurrentTurn: boolean;
	toast: ToastItem | null;
	activeScope: string;
	modalScopes: string[];
};

export type AnnounceOptions = {
	debounce?: number;
};

const DEFAULT_TOAST_DURATION_MS = 4200;
const DEFAULT_SEARCH_DEBOUNCE_MS = 300;

export function formatUndoAnnouncement(message: string): string {
	const trimmed = message.trim();
	if (!trimmed) return '';
	const punctuated = /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	return `${punctuated} Undo available.`;
}

export function formatRecipeStatus(
	count: number,
	view: string,
	hasSavedRecipes: boolean,
	hasFilterOrQuery: boolean
): string {
	if (view === 'saved') {
		if (count === 0) {
			return hasSavedRecipes || hasFilterOrQuery
				? 'No saved recipes found. Try another search or filter.'
				: 'No saved recipes yet. Tap the bookmark on any recipe to keep it close.';
		}
		return `${count} saved recipe${count === 1 ? '' : 's'} shown.`;
	}
	if (count === 0) {
		return 'No recipes found. Try another search or generate recipes.';
	}
	return `${count} recipe${count === 1 ? '' : 's'} shown.`;
}

export function formatPantryStatus(
	visibleCount: number,
	totalCount: number,
	filter: string,
	hasSearchOrCategory = false
): string {
	if (totalCount === 0) {
		return 'No ingredients yet. Add a few things from your fridge to get started.';
	}
	if (visibleCount === 0) {
		return hasSearchOrCategory
			? 'No matching ingredients. Try another search, category, or expiry filter.'
			: 'No matching ingredients. Try another expiry filter or update a best-before date.';
	}
	if (filter === 'soon') {
		return `${visibleCount} ingredient${visibleCount === 1 ? '' : 's'} expiring soon.`;
	}
	if (filter === 'expired') {
		return `${visibleCount} expired ingredient${visibleCount === 1 ? '' : 's'}.`;
	}
	if (hasSearchOrCategory) {
		return `${visibleCount} matching ingredient${visibleCount === 1 ? '' : 's'} shown.`;
	}
	return `${visibleCount} ingredient${visibleCount === 1 ? '' : 's'} in your pantry.`;
}

export function formatShoppingStatus(
	visibleCount: number,
	totalCount: number,
	checkedCount: number,
	filter: string
): string {
	if (totalCount === 0) {
		return 'Your shopping list is empty.';
	}
	if (visibleCount === 0) {
		return `All ${checkedCount} ${checkedCount === 1 ? 'item' : 'items'} purchased.`;
	}
	if (filter === 'unpurchased') {
		return `${visibleCount} unpurchased ${visibleCount === 1 ? 'item' : 'items'} shown.`;
	}
	return `${visibleCount} shopping ${visibleCount === 1 ? 'item' : 'items'} shown.`;
}

export function formatWebSearchStatus(count: number): string {
	if (count === 0) {
		return 'No online recipes found. Try another search or import a link.';
	}
	return `${count} online recipe${count === 1 ? '' : 's'} found.`;
}

export function createStatusStore(options?: { toastDurationMs?: number }) {
	const toastDurationMs = options?.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS;
	const subscribers = new Set<(value: StatusSnapshot) => void>();

	let buffers: [string, string] = ['', ''];
	let activeSlot: 0 | 1 = 1;
	let version = 0;
	let freshInCurrentTurn = false;
	let freshTurnToken = 0;
	let toastId = 0;
	let toast: ToastItem | null = null;
	let modalScopes: string[] = [];
	let toastHovered = false;
	let toastFocused = false;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function snapshot(): StatusSnapshot {
		return {
			buffers: [buffers[0], buffers[1]],
			activeSlot,
			version,
			freshInCurrentTurn,
			toast,
			activeScope: modalScopes.length ? modalScopes[modalScopes.length - 1] : 'root',
			modalScopes: [...modalScopes]
		};
	}

	function emit() {
		const current = snapshot();
		for (const listener of subscribers) listener(current);
	}

	function clearDebounce() {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	}

	function clearToastTimer() {
		if (toastTimer !== undefined) {
			clearTimeout(toastTimer);
			toastTimer = undefined;
		}
	}

	function scheduleToastAutoHide() {
		clearToastTimer();
		if (!toast || toast.undo || toastHovered || toastFocused) return;
		const expectedId = toast.id;
		toastTimer = setTimeout(() => {
			toastTimer = undefined;
			if (toast && toast.id === expectedId && !toast.undo && !toastHovered && !toastFocused) {
				toast = null;
				emit();
			}
		}, toastDurationMs);
	}

	function commitAnnouncement(rawMessage: string) {
		const message = rawMessage.trim();
		if (!message) return;
		activeSlot = activeSlot === 0 ? 1 : 0;
		buffers = activeSlot === 0 ? [message, ''] : ['', message];
		version += 1;
		freshInCurrentTurn = true;
		const turn = ++freshTurnToken;
		queueMicrotask(() => {
			if (freshTurnToken === turn && freshInCurrentTurn) {
				freshInCurrentTurn = false;
				emit();
			}
		});
		emit();
	}

	function announce(message: string, announceOptions?: AnnounceOptions) {
		const trimmed = message.trim();
		if (!trimmed) return;
		const delay = announceOptions?.debounce ?? 0;
		clearDebounce();
		if (delay > 0) {
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				commitAnnouncement(trimmed);
			}, delay);
			return;
		}
		commitAnnouncement(trimmed);
	}

	function announceDeferred(resolveMessage: () => string, delayMs = DEFAULT_SEARCH_DEBOUNCE_MS) {
		clearDebounce();
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			commitAnnouncement(resolveMessage());
		}, delayMs);
	}

	function dismissToast() {
		clearToastTimer();
		toastHovered = false;
		toastFocused = false;
		if (!toast) return;
		toast = null;
		emit();
	}

	function notify(message: string, undo?: () => void) {
		const trimmed = message.trim();
		if (!trimmed) return;
		clearDebounce();
		clearToastTimer();
		toastHovered = false;
		toastFocused = false;
		const id = ++toastId;
		toast = {
			id,
			message: trimmed,
			undo: undo ?? null
		};
		commitAnnouncement(undo ? formatUndoAnnouncement(trimmed) : trimmed);
		if (!undo) {
			scheduleToastAutoHide();
		}
	}

	function runToastUndo() {
		if (!toast?.undo) return;
		const callback = toast.undo;
		clearToastTimer();
		toastHovered = false;
		toastFocused = false;
		toast = null;
		emit();
		callback();
	}

	function setToastHovered(hovered: boolean) {
		if (toastHovered === hovered) return;
		toastHovered = hovered;
		if (!toast || toast.undo) return;
		if (toastHovered || toastFocused) clearToastTimer();
		else scheduleToastAutoHide();
	}

	function setToastFocused(focused: boolean) {
		if (toastFocused === focused) return;
		toastFocused = focused;
		if (!toast || toast.undo) return;
		if (toastHovered || toastFocused) clearToastTimer();
		else scheduleToastAutoHide();
	}

	function registerModal(scopeId: string): () => void {
		if (!modalScopes.includes(scopeId)) {
			modalScopes = [...modalScopes, scopeId];
			emit();
		}
		return () => {
			if (modalScopes.includes(scopeId)) {
				modalScopes = modalScopes.filter((id) => id !== scopeId);
				emit();
			}
		};
	}

	function reset() {
		clearDebounce();
		clearToastTimer();
		buffers = ['', ''];
		activeSlot = 1;
		version = 0;
		freshInCurrentTurn = false;
		freshTurnToken += 1;
		toast = null;
		modalScopes = [];
		toastHovered = false;
		toastFocused = false;
		emit();
	}

	return {
		subscribe(listener: (value: StatusSnapshot) => void) {
			subscribers.add(listener);
			listener(snapshot());
			return () => {
				subscribers.delete(listener);
			};
		},
		get state() {
			return snapshot();
		},
		announce,
		announceDeferred,
		notify,
		dismissToast,
		runToastUndo,
		setToastHovered,
		setToastFocused,
		registerModal,
		reset
	};
}

export const statusStore = createStatusStore();
export const announce = statusStore.announce;
export const announceDeferred = statusStore.announceDeferred;
export const notifyStatus = statusStore.notify;
export const dismissToast = statusStore.dismissToast;
export const runToastUndo = statusStore.runToastUndo;
export const setToastHovered = statusStore.setToastHovered;
export const setToastFocused = statusStore.setToastFocused;
