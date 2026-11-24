/** Shared keyboard focus primitives: modal focus traps, busy guards, and unmount handoffs. */

export type FocusTarget =
	HTMLElement | string | (() => HTMLElement | null | undefined) | null | undefined;

export type FocusTrapOptions = {
	onEscape?: () => void;
	fallback?: FocusTarget;
};

export type FocusHandoffOptions = {
	/** Selector for the repeating row element when deleting list items. */
	row?: string;
	/** Ancestor selector used to scope paired toggle or fallback lookup. */
	within?: string;
	/** Target control within the paired container or neighbor row. */
	target?: FocusTarget;
	/** Fallback control when no neighbor row or primary target exists. */
	fallback?: FocusTarget;
};

export const FOCUSABLE_SELECTOR =
	'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),summary:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])';

const ITEM_SELECTOR =
	'article,li,[role="listitem"],.pantry-row,.shopping-row,.calendar-meal,.cooked-history-row,.member-row,.invite-row,.draft-ingredient,.draft-step';

type TriggerSnapshot = {
	item: HTMLElement | null;
	container: HTMLElement | null;
	itemMatcher: string;
	itemIndex: number;
	controlSelector: string;
	controlIndex: number;
};

type HandoffSnapshot = {
	scope: HTMLElement | null;
	withinEl: HTMLElement | null;
	rowContainer: HTMLElement | null;
	rowSelector: string;
	rowIndex: number;
	controlSelector: string;
	controlIndex: number;
	neighborAfter: HTMLElement | null;
	neighborBefore: HTMLElement | null;
};

let activeTraps = 0;
let originalOverflow = '';
let originalFocus: HTMLElement | null = null;
let originalSnapshot: TriggerSnapshot | null = null;
let lastOutsideFocus: HTMLElement | null = null;
let trackedDoc: Document | null = null;

function ensureFocusTracker() {
	if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
	if (trackedDoc === document) return;
	trackedDoc = document;
	document.addEventListener(
		'focusin',
		(event) => {
			if (activeTraps > 0) return;
			const target = event.target as HTMLElement | null;
			if (target && target !== document.body && target !== document.documentElement) {
				lastOutsideFocus = target;
			}
		},
		true
	);
}

function escapeIdentifier(value: string) {
	return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(value)
		: value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function isInert(el: Element | null | undefined): boolean {
	if (!el) return true;
	if ((el as HTMLElement & { inert?: boolean }).inert || el.hasAttribute?.('inert')) return true;
	return Boolean(el.closest?.('[inert]'));
}

function isHiddenInClosedDetails(el: Element): boolean {
	const closed = el.closest?.('details:not([open])');
	if (!closed) return false;
	const summary = closed.querySelector?.(':scope > summary');
	return summary !== el;
}

function isVisible(el: HTMLElement): boolean {
	if (el.isConnected === false) return false;
	if (el.hasAttribute?.('hidden')) return false;
	if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
		try {
			const style = window.getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden') return false;
		} catch {
			// Ignore synthetic test elements unsupported by getComputedStyle.
		}
	}
	if (el.offsetParent !== null && el.offsetParent !== undefined) return true;
	if (typeof el.getClientRects === 'function' && el.getClientRects().length > 0) return true;
	return false;
}

/** True when an element participates in keyboard Tab navigation. */
export function isFocusable(el: Element | null | undefined): el is HTMLElement {
	if (!el || typeof (el as HTMLElement).focus !== 'function') return false;
	const htmlEl = el as HTMLElement;
	if (htmlEl.isConnected === false) return false;
	if (htmlEl.hasAttribute?.('disabled') || isInert(htmlEl)) return false;
	if (typeof htmlEl.tabIndex === 'number' && htmlEl.tabIndex < 0) return false;
	if (isHiddenInClosedDetails(htmlEl)) return false;
	return isVisible(htmlEl);
}

/** True when an element can safely receive programmatic focus(), including tabindex="-1" landmarks. */
function isProgrammaticallyFocusable(el: Element | null | undefined): el is HTMLElement {
	if (!el || typeof (el as HTMLElement).focus !== 'function') return false;
	const htmlEl = el as HTMLElement;
	if (typeof document !== 'undefined') {
		if (htmlEl === document.body || htmlEl === document.documentElement) return false;
	}
	if (htmlEl.isConnected === false) return false;
	if (htmlEl.hasAttribute?.('disabled') || isInert(htmlEl)) return false;
	if (isHiddenInClosedDetails(htmlEl)) return false;
	return isVisible(htmlEl);
}

/** Return ordered Tab-focusable descendants within root. */
export function getFocusableControls(root: ParentNode): HTMLElement[] {
	if (!root || typeof root.querySelectorAll !== 'function') return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

function selectorForElement(el: HTMLElement): string {
	const firstClass = el.classList?.[0];
	if (firstClass) return `${el.tagName.toLowerCase()}.${escapeIdentifier(firstClass)}`;
	return el.tagName.toLowerCase();
}

function matchingChildren(container: HTMLElement | null, selector: string): HTMLElement[] {
	if (!container || !selector || container.isConnected === false || isInert(container)) return [];
	return Array.from(container.children).filter(
		(child): child is HTMLElement =>
			typeof (child as HTMLElement).matches === 'function' &&
			child.matches(selector) &&
			!isInert(child) &&
			isVisible(child as HTMLElement)
	);
}

function resolveTarget(
	target: FocusTarget,
	scopes?: Array<ParentNode | null | undefined>
): HTMLElement | null {
	if (!target) return null;
	if (typeof target === 'function') {
		const resolved = target();
		return isProgrammaticallyFocusable(resolved) ? resolved : null;
	}
	if (typeof target === 'string') {
		const rawScopes = scopes ?? [typeof document !== 'undefined' ? document : null];
		for (const scope of rawScopes) {
			if (!scope || typeof scope.querySelectorAll !== 'function') continue;
			const maybeElement = scope as Partial<Element>;
			if (
				typeof maybeElement.matches === 'function' &&
				maybeElement.matches(target) &&
				isProgrammaticallyFocusable(scope as Element)
			) {
				return scope as HTMLElement;
			}
			const matches = Array.from(scope.querySelectorAll<HTMLElement>(target));
			const found = matches.find(isProgrammaticallyFocusable);
			if (found) return found;
		}
		return null;
	}
	return isProgrammaticallyFocusable(target) ? target : null;
}

function focusControlInItem(
	item: HTMLElement,
	controlSelector: string,
	controlIndex: number
): HTMLElement | null {
	if (controlSelector) {
		const matched = Array.from(item.querySelectorAll<HTMLElement>(controlSelector)).find(
			isFocusable
		);
		if (matched) return matched;
	}
	const itemControls = getFocusableControls(item);
	if (!itemControls.length) return null;
	return itemControls[Math.min(Math.max(0, controlIndex), itemControls.length - 1)];
}

function captureTriggerSnapshot(trigger: HTMLElement | null): TriggerSnapshot | null {
	if (!trigger || typeof trigger.focus !== 'function') return null;
	if (
		typeof document !== 'undefined' &&
		(trigger === document.body || trigger === document.documentElement)
	) {
		return null;
	}
	if (trigger.isConnected === false || trigger.hasAttribute?.('disabled') || !isVisible(trigger)) {
		return null;
	}
	const item = (trigger.closest?.(ITEM_SELECTOR) as HTMLElement | null) ?? null;
	if (!item) return null;
	const container = item.parentElement;
	const itemMatcher = selectorForElement(item);
	// Ignore ancestor [inert] here because Svelte applies inert on .app-shell in render_effect
	// before use:focusTrap mounts in user effect.
	const siblings = container
		? Array.from(container.children).filter(
				(child): child is HTMLElement =>
					typeof (child as HTMLElement).matches === 'function' &&
					child.matches(itemMatcher) &&
					isVisible(child as HTMLElement)
			)
		: [];
	const itemIndex = siblings.indexOf(item);
	const itemControls = Array.from(item.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) =>
			el.isConnected !== false &&
			!el.hasAttribute?.('disabled') &&
			!(typeof el.tabIndex === 'number' && el.tabIndex < 0) &&
			!isHiddenInClosedDetails(el) &&
			isVisible(el)
	);
	return {
		item,
		container,
		itemMatcher,
		itemIndex: Math.max(0, itemIndex),
		controlSelector: selectorForElement(trigger),
		controlIndex: Math.max(0, itemControls.indexOf(trigger))
	};
}

function resolveTrapReturnTarget(fallbackOption?: FocusTarget): HTMLElement | null {
	if (isProgrammaticallyFocusable(originalFocus)) return originalFocus;
	if (originalSnapshot) {
		const { item, container, itemMatcher, itemIndex, controlSelector, controlIndex } =
			originalSnapshot;
		if (item && item.isConnected !== false && !isInert(item) && isVisible(item)) {
			const withinSameItem = focusControlInItem(item, controlSelector, controlIndex);
			if (withinSameItem) return withinSameItem;
		}
		const remaining = matchingChildren(container, itemMatcher);
		if (remaining.length > 0) {
			const neighbor = remaining[Math.min(itemIndex, remaining.length - 1)];
			const neighborControl = focusControlInItem(neighbor, controlSelector, controlIndex);
			if (neighborControl) return neighborControl;
		}
	}
	const explicit = resolveTarget(fallbackOption);
	if (explicit) return explicit;
	if (typeof document !== 'undefined') {
		const landmark = document.getElementById('kitchen-content');
		if (isProgrammaticallyFocusable(landmark)) return landmark;
	}
	return null;
}

/** Keep keyboard focus in a modal, route Escape, and restore focus to its trigger or fallback. */
export function focusTrap(node: HTMLElement, options: FocusTrapOptions = {}) {
	let currentOptions = options;
	let destroyed = false;
	ensureFocusTracker();
	const currentActive = (
		typeof document !== 'undefined' ? document.activeElement : null
	) as HTMLElement | null;
	const previous =
		currentActive &&
		(typeof document === 'undefined' ||
			(currentActive !== document.body && currentActive !== document.documentElement))
			? currentActive
			: lastOutsideFocus;
	const controls = () => getFocusableControls(node);

	if (activeTraps === 0) {
		originalOverflow = typeof document !== 'undefined' ? document.body.style.overflow : '';
		originalFocus = previous;
		originalSnapshot = captureTriggerSnapshot(previous);
	}
	activeTraps += 1;
	if (typeof document !== 'undefined') {
		document.body.style.overflow = 'hidden';
	}

	queueMicrotask(() => {
		if (destroyed || node.isConnected === false) return;
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		if (active && active !== node && node.contains?.(active)) return;
		(controls()[0] || node).focus();
	});

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !event.defaultPrevented && currentOptions.onEscape) {
			event.stopPropagation();
			event.preventDefault();
			currentOptions.onEscape();
			return;
		}
		if (event.key !== 'Tab') return;
		const elements = controls();
		if (!elements.length) {
			event.preventDefault();
			node.focus();
			return;
		}
		const first = elements[0];
		const last = elements[elements.length - 1];
		const active = (
			typeof document !== 'undefined' ? document.activeElement : null
		) as HTMLElement | null;
		const outside = !active || !node.contains?.(active);
		if (event.shiftKey && (active === first || active === node || outside)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || outside)) {
			event.preventDefault();
			first.focus();
		}
	}

	node.addEventListener('keydown', keydown);

	return {
		update(nextOptions: FocusTrapOptions = {}) {
			currentOptions = nextOptions;
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			node.removeEventListener('keydown', keydown);
			const fallbackOption = currentOptions.fallback;
			queueMicrotask(() => {
				activeTraps = Math.max(0, activeTraps - 1);
				if (activeTraps === 0) {
					if (typeof document !== 'undefined') {
						document.body.style.overflow = originalOverflow;
					}
					const returnTarget = resolveTrapReturnTarget(fallbackOption);
					originalFocus = null;
					originalSnapshot = null;
					returnTarget?.focus({ preventScroll: true });
				}
			});
		}
	};
}

/** Keep an active control focusable via aria-disabled="true" while blocking repeat activations. */
export function busyAction(node: HTMLElement, busy = false) {
	let isBusy = Boolean(busy);
	const form =
		node.tagName === 'FORM'
			? (node as HTMLFormElement)
			: ((node.closest?.('form') as HTMLFormElement | null) ?? null);
	const isSubmitControl =
		node.tagName === 'BUTTON' &&
		((node as HTMLButtonElement).type === 'submit' || !node.getAttribute('type'));

	function sync(next: boolean) {
		isBusy = Boolean(next);
		if (isBusy) node.setAttribute('aria-disabled', 'true');
		else node.removeAttribute('aria-disabled');
	}

	function onClick(event: MouseEvent) {
		if (!isBusy) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	function onKeyDown(event: KeyboardEvent) {
		if (!isBusy) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	function onSubmit(event: SubmitEvent) {
		if (!isBusy) return;
		if (node.tagName === 'FORM' || !event.submitter || event.submitter === node) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}

	sync(isBusy);
	node.addEventListener('click', onClick, true);
	node.addEventListener('keydown', onKeyDown, true);
	if (form && (node.tagName === 'FORM' || isSubmitControl)) {
		form.addEventListener('submit', onSubmit, true);
	}

	return {
		update(nextBusy = false) {
			sync(nextBusy);
		},
		destroy() {
			node.removeEventListener('click', onClick, true);
			node.removeEventListener('keydown', onKeyDown, true);
			if (form && (node.tagName === 'FORM' || isSubmitControl)) {
				form.removeEventListener('submit', onSubmit, true);
			}
		}
	};
}

/** Hand off keyboard focus when a toggle, list row button, or conditional control unmounts. */
export function focusHandoff(node: HTMLElement, options: FocusHandoffOptions = {}) {
	let currentOptions = options;
	let hadFocus = false;
	let destroyed = false;
	let snapshot: HandoffSnapshot | null = null;

	function captureSnapshot() {
		if (node.isConnected === false || isInert(node)) return;
		const scope =
			(node.closest?.('[role="dialog"], main') as HTMLElement | null) ??
			(typeof document !== 'undefined' ? document.body : null);
		const withinEl = currentOptions.within
			? ((node.closest?.(currentOptions.within) as HTMLElement | null) ?? null)
			: null;
		const rowSelector = currentOptions.row ?? '';
		const rowEl = rowSelector
			? ((node.closest?.(rowSelector) as HTMLElement | null) ?? null)
			: null;
		const rowContainer = rowEl?.parentElement ?? null;
		const rows = rowSelector ? matchingChildren(rowContainer, rowSelector) : [];
		const rowIndex = rowEl ? Math.max(0, rows.indexOf(rowEl)) : 0;
		const rowControls = rowEl ? getFocusableControls(rowEl) : [];

		let neighborAfter: HTMLElement | null = null;
		let neighborBefore: HTMLElement | null = null;
		const neighborRoot = withinEl ?? scope;
		if (neighborRoot) {
			const all = getFocusableControls(neighborRoot);
			const excluded = rowEl ?? node;
			const nodePos = all.indexOf(node);
			if (nodePos !== -1) {
				for (let i = nodePos + 1; i < all.length; i++) {
					if (!excluded.contains?.(all[i]) && all[i] !== excluded) {
						neighborAfter = all[i];
						break;
					}
				}
				for (let i = nodePos - 1; i >= 0; i--) {
					if (!excluded.contains?.(all[i]) && all[i] !== excluded) {
						neighborBefore = all[i];
						break;
					}
				}
			}
		}

		snapshot = {
			scope,
			withinEl,
			rowContainer,
			rowSelector,
			rowIndex,
			controlSelector: selectorForElement(node),
			controlIndex: Math.max(0, rowControls.indexOf(node)),
			neighborAfter,
			neighborBefore
		};
	}

	function isFocusDropped(): boolean {
		if (typeof document === 'undefined') return false;
		const active = document.activeElement as HTMLElement | null;
		if (!active || active === document.body || active === document.documentElement) return true;
		if (active === node) return true;
		if (active.isConnected === false || isInert(active) || !isVisible(active)) return true;
		return false;
	}

	function resolveHandoffTarget(): HTMLElement | null {
		if (!snapshot) return null;
		const {
			scope,
			withinEl,
			rowContainer,
			rowSelector,
			rowIndex,
			controlSelector,
			controlIndex,
			neighborAfter,
			neighborBefore
		} = snapshot;

		if (
			scope &&
			typeof document !== 'undefined' &&
			scope !== document.body &&
			(scope.isConnected === false || isInert(scope) || !isVisible(scope))
		) {
			return null;
		}

		const activeWithin =
			withinEl && withinEl.isConnected !== false && !isInert(withinEl) && isVisible(withinEl)
				? withinEl
				: null;
		const docRoot = typeof document !== 'undefined' ? document : null;
		const fallbackScopes = [activeWithin, scope, docRoot];

		if (rowSelector) {
			const remaining = matchingChildren(rowContainer, rowSelector);
			if (remaining.length > 0) {
				const neighborRow = remaining[Math.min(rowIndex, remaining.length - 1)];
				if (currentOptions.target) {
					const targeted = resolveTarget(currentOptions.target, [neighborRow]);
					if (targeted) return targeted;
				}
				const rowMatch = focusControlInItem(neighborRow, controlSelector, controlIndex);
				if (rowMatch) return rowMatch;
			}
			const fallbackFromRow = resolveTarget(currentOptions.fallback, fallbackScopes);
			if (fallbackFromRow) return fallbackFromRow;
		} else {
			const targetScopes = currentOptions.within ? [activeWithin] : [scope, docRoot];
			const primary = resolveTarget(currentOptions.target, targetScopes);
			if (primary) return primary;
			const fallback = resolveTarget(currentOptions.fallback, fallbackScopes);
			if (fallback) return fallback;
		}

		if (isFocusable(neighborAfter)) return neighborAfter;
		if (isFocusable(neighborBefore)) return neighborBefore;
		if (activeWithin) {
			const firstInWithin = getFocusableControls(activeWithin)[0];
			if (firstInWithin) return firstInWithin;
		}
		if (isProgrammaticallyFocusable(scope)) return scope;
		return null;
	}

	function recoverIfLost() {
		if (!hadFocus) return;
		const nodeUnavailable = node.isConnected === false || isInert(node) || !isVisible(node);
		if (!nodeUnavailable) return;
		hadFocus = false;
		if (!isFocusDropped()) return;
		const target = resolveHandoffTarget();
		target?.focus();
	}

	function onFocusIn() {
		hadFocus = true;
		captureSnapshot();
	}

	function onFocusOut(event: FocusEvent) {
		const related = event.relatedTarget as HTMLElement | null;
		if (related && isProgrammaticallyFocusable(related) && !node.contains?.(related)) {
			hadFocus = false;
			return;
		}
		// Blink/Chromium dispatches focusout(relatedTarget: null) synchronously inside
		// WillRemoveChild BEFORE node.isConnected becomes false; defer clearing hadFocus.
		queueMicrotask(() => {
			if (destroyed) return;
			const nodeUnavailable = node.isConnected === false || isInert(node) || !isVisible(node);
			if (nodeUnavailable) {
				recoverIfLost();
				return;
			}
			const active = typeof document !== 'undefined' ? document.activeElement : null;
			if (active !== node && !node.contains?.(active)) {
				hadFocus = false;
			}
		});
	}

	function onClickCapture() {
		hadFocus = true;
		captureSnapshot();
		queueMicrotask(() => {
			queueMicrotask(recoverIfLost);
		});
	}

	node.addEventListener('focusin', onFocusIn);
	node.addEventListener('focusout', onFocusOut);
	node.addEventListener('click', onClickCapture, true);

	return {
		update(nextOptions: FocusHandoffOptions = {}) {
			currentOptions = nextOptions;
		},
		destroy() {
			destroyed = true;
			node.removeEventListener('focusin', onFocusIn);
			node.removeEventListener('focusout', onFocusOut);
			node.removeEventListener('click', onClickCapture, true);
			if (hadFocus) {
				queueMicrotask(recoverIfLost);
			}
		}
	};
}
