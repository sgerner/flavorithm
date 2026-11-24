/** Shared keyboard focus primitives: modal focus traps, busy guards, and unmount handoffs. */

export type FocusTarget =
	HTMLElement | string | (() => HTMLElement | null | undefined) | null | undefined;

export type FocusTrapOptions = {
	enabled?: boolean;
	key?: unknown;
	returnFocus?: FocusTarget;
	fallback?: FocusTarget;
	onEscape?: () => void;
};

type ResolvedTrapOptions = {
	enabled: boolean;
	key: unknown;
	returnFocus?: FocusTarget;
	fallback?: FocusTarget;
	onEscape?: () => void;
};

type TrapEntry = {
	node: HTMLElement;
	deactivate: (exiting?: boolean) => void;
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
	'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),details > summary:first-of-type:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])';

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

type AncestorAnchor = {
	el: HTMLElement;
	parent: HTMLElement;
	childIndex: number;
	nextSibling: Element | null;
	prevSibling: Element | null;
};

type HandoffSnapshot = {
	scope: HTMLElement | null;
	withinEl: HTMLElement | null;
	rowEl: HTMLElement | null;
	rowContainer: HTMLElement | null;
	rowSelector: string;
	rowNextSibling: Element | null;
	rowPrevSibling: Element | null;
	rowRawIndex: number;
	controlSelector: string;
	ancestors: AncestorAnchor[];
};

const activeTraps: TrapEntry[] = [];
const MAX_RESTORE_MICROTASK_RETRIES = 8;
let originalOverflow = '';
let originalFocus: HTMLElement | null = null;
let originalSnapshot: TriggerSnapshot | null = null;
let handoffFocus: HTMLElement | null = null;
let handoffOverflow: string | null = null;
let handoffSnapshot: TriggerSnapshot | null = null;
let restoreGeneration = 0;
let cancelPendingRestore: (() => void) | null = null;
let lastOutsideFocus: HTMLElement | null = null;
let trackedDoc: Document | null = null;

function ensureFocusTracker() {
	if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
	if (trackedDoc === document) return;
	trackedDoc = document;
	document.addEventListener(
		'focusin',
		(event) => {
			if (activeTraps.length > 0) return;
			const target = event.target as HTMLElement | null;
			if (target && target !== document.body && target !== document.documentElement) {
				lastOutsideFocus = target;
			}
		},
		true
	);
}

function resolveTrapOptions(param?: FocusTrapOptions | boolean): ResolvedTrapOptions {
	if (typeof param === 'boolean') return { enabled: param, key: undefined };
	return {
		enabled: param?.enabled ?? true,
		key: param?.key,
		returnFocus: param?.returnFocus,
		fallback: param?.fallback,
		onEscape: param?.onEscape
	};
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

function isDetailsOpen(details: Element): boolean {
	return Boolean((details as HTMLDetailsElement).open || details.hasAttribute?.('open'));
}

function isFirstSummaryOfDetails(el: Element): boolean {
	const parent = el.parentElement;
	if (!parent || parent.tagName !== 'DETAILS') return false;
	for (const child of Array.from(parent.children)) {
		if (child.tagName === 'SUMMARY') return child === el;
	}
	return false;
}

function isHiddenInClosedDetails(el: Element, boundary?: ParentNode | null): boolean {
	let current: Element | null = el;
	while (current && current !== boundary) {
		const parent: HTMLElement | null = current.parentElement;
		if (parent && parent.tagName === 'DETAILS' && !isDetailsOpen(parent)) {
			let firstSummary: Element | null = null;
			for (const child of Array.from(parent.children)) {
				if (child.tagName === 'SUMMARY') {
					firstSummary = child;
					break;
				}
			}
			if (current !== firstSummary) return true;
		}
		current = parent;
	}
	return false;
}

function isVisible(el: HTMLElement): boolean {
	if (el.isConnected === false) return false;
	if ((el as HTMLElement & { hidden?: boolean }).hidden || el.hasAttribute?.('hidden')) {
		return false;
	}
	if (el.closest?.('[hidden]')) return false;
	if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
		try {
			const style = window.getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden') return false;
			if (el.offsetParent === null && style.position === 'fixed') return true;
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
	if (htmlEl.tagName === 'SUMMARY' && !htmlEl.hasAttribute?.('tabindex')) {
		if (!isFirstSummaryOfDetails(htmlEl)) return false;
	}
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
	if (htmlEl.tagName === 'SUMMARY' && !htmlEl.hasAttribute?.('tabindex')) {
		if (!isFirstSummaryOfDetails(htmlEl)) return false;
	}
	if (isHiddenInClosedDetails(htmlEl)) return false;
	return isVisible(htmlEl);
}

/** Return ordered Tab-focusable descendants within root. */
export function getFocusableControls(root: ParentNode): HTMLElement[] {
	if (!root || typeof root.querySelectorAll !== 'function') return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !isHiddenInClosedDetails(el, root) && isFocusable(el)
	);
}

export const focusableControls = getFocusableControls;

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

function resolveRawFocusElement(target: FocusTarget): HTMLElement | null {
	if (!target) return null;
	if (typeof target === 'function') return target() ?? null;
	if (typeof target === 'string') {
		if (typeof document === 'undefined') return null;
		return document.querySelector<HTMLElement>(target);
	}
	return target;
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
	controlIndex = 0
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
			!(
				el.tagName === 'SUMMARY' &&
				!el.hasAttribute?.('tabindex') &&
				!isFirstSummaryOfDetails(el)
			) &&
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

function resolveTrapReturnTarget(
	savedFocus: HTMLElement | null,
	savedSnapshot: TriggerSnapshot | null,
	returnFocusOption?: FocusTarget,
	fallbackOption?: FocusTarget
): HTMLElement | null {
	const explicitReturn = resolveTarget(returnFocusOption);
	if (explicitReturn) return explicitReturn;
	if (isProgrammaticallyFocusable(savedFocus)) return savedFocus;
	if (savedSnapshot) {
		const { item, container, itemMatcher, itemIndex, controlSelector, controlIndex } =
			savedSnapshot;
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
	const explicitFallback = resolveTarget(fallbackOption);
	if (explicitFallback) return explicitFallback;
	if (typeof document !== 'undefined') {
		const landmark = document.getElementById('kitchen-content');
		if (isProgrammaticallyFocusable(landmark)) return landmark;
	}
	return null;
}

function hasExternalActiveFocus(
	preferredTarget: HTMLElement | null,
	closingNode: HTMLElement
): boolean {
	if (typeof document === 'undefined') return false;
	const active = document.activeElement as HTMLElement | null;
	if (!active || active === document.body || active === document.documentElement) return false;
	if (active === preferredTarget || active === closingNode || closingNode.contains?.(active)) {
		return false;
	}
	if (active.closest?.('[inert], [hidden], [data-focus-backdrop]')) return false;
	return isProgrammaticallyFocusable(active);
}

function scheduleFocusRestore(
	closingNode: HTMLElement,
	savedFocus: HTMLElement | null,
	savedSnapshot: TriggerSnapshot | null,
	returnFocusOpt?: FocusTarget,
	fallbackOpt?: FocusTarget
) {
	cancelPendingRestore?.();
	const token = ++restoreGeneration;

	let restoreObserver: MutationObserver | null = null;
	let rafId: number | null = null;
	let cleaned = false;

	const currentPreferred = () => resolveRawFocusElement(returnFocusOpt) ?? savedFocus;

	const onExternalFocusIn = () => {
		if (hasExternalActiveFocus(currentPreferred(), closingNode)) cleanup();
	};

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		restoreObserver?.disconnect();
		restoreObserver = null;
		if (rafId !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(rafId);
		}
		rafId = null;
		if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
			document.removeEventListener('focusin', onExternalFocusIn);
		}
		if (cancelPendingRestore === cleanup) cancelPendingRestore = null;
	};
	cancelPendingRestore = cleanup;

	const attempt = (): 'done' | 'inert' => {
		if (cleaned || token !== restoreGeneration || activeTraps.length !== 0) {
			cleanup();
			return 'done';
		}
		handoffFocus = null;
		handoffOverflow = null;
		handoffSnapshot = null;

		const preferred = currentPreferred();
		if (hasExternalActiveFocus(preferred, closingNode)) {
			cleanup();
			return 'done';
		}
		if (
			preferred &&
			preferred.isConnected !== false &&
			isVisible(preferred) &&
			isInert(preferred)
		) {
			return 'inert';
		}
		const returnTarget = resolveTrapReturnTarget(
			savedFocus,
			savedSnapshot,
			returnFocusOpt,
			fallbackOpt
		);
		returnTarget?.focus({ preventScroll: true });
		cleanup();
		return 'done';
	};

	let retries = 0;
	const pollMicrotask = () => {
		if (attempt() !== 'inert') return;
		const preferred = currentPreferred();
		if (restoreObserver === null && preferred && typeof MutationObserver !== 'undefined') {
			restoreObserver = new MutationObserver(() => {
				attempt();
			});
			let current: HTMLElement | null = preferred;
			while (current) {
				restoreObserver.observe(current, { attributes: true, attributeFilter: ['inert'] });
				current = current.parentElement;
			}
			if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
				document.addEventListener('focusin', onExternalFocusIn);
			}
		}
		if (rafId === null && typeof requestAnimationFrame === 'function') {
			rafId = requestAnimationFrame(() => {
				rafId = null;
				if (attempt() === 'inert' && restoreObserver === null) cleanup();
			});
		}
		if (retries < MAX_RESTORE_MICROTASK_RETRIES) {
			retries += 1;
			queueMicrotask(pollMicrotask);
		} else if (restoreObserver === null && rafId === null) {
			cleanup();
		}
	};

	queueMicrotask(pollMicrotask);
}

/** Keep keyboard focus in an active modal or drawer, route Escape, and restore focus on close. */
export function focusTrap(node: HTMLElement, param?: FocusTrapOptions | boolean) {
	let currentOptions = resolveTrapOptions(param);
	let active = false;
	let focusGeneration = 0;
	let inertObserver: MutationObserver | null = null;
	const controls = () => getFocusableControls(node);

	function focusInitial(force = false) {
		const token = ++focusGeneration;
		const applyFocus = (): boolean => {
			if (!active || token !== focusGeneration || isInert(node) || node.isConnected === false) {
				return true;
			}
			const current = (
				typeof document !== 'undefined' ? document.activeElement : null
			) as HTMLElement | null;
			if (!force && current && current !== node && node.contains?.(current)) {
				return true;
			}
			(controls()[0] || node).focus({ preventScroll: true });
			const after = (
				typeof document !== 'undefined' ? document.activeElement : null
			) as HTMLElement | null;
			return Boolean(after && (after === node || node.contains?.(after)));
		};
		queueMicrotask(() => {
			if (!applyFocus() && typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => {
					if (active && token === focusGeneration) applyFocus();
				});
			}
		});
	}

	function keydown(event: KeyboardEvent) {
		if (!active) return;
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
			node.focus({ preventScroll: true });
			return;
		}
		const first = elements[0];
		const last = elements[elements.length - 1];
		const current = (
			typeof document !== 'undefined' ? document.activeElement : null
		) as HTMLElement | null;
		const outside = !current || !node.contains?.(current);
		if (outside) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus({ preventScroll: true });
		} else if (event.shiftKey && (current === first || current === node)) {
			event.preventDefault();
			last.focus({ preventScroll: true });
		} else if (!event.shiftKey && (current === last || current === node)) {
			event.preventDefault();
			first.focus({ preventScroll: true });
		}
	}

	function outrostart(event: Event) {
		if (event.target === node) deactivate(true);
	}

	const entry: TrapEntry = {
		node,
		deactivate
	};

	function deactivate(exiting = false) {
		if (!active) {
			if (exiting) node.removeAttribute?.('aria-modal');
			return;
		}
		active = false;
		focusGeneration += 1;
		node.removeEventListener('keydown', keydown);
		node.removeEventListener('outrostart', outrostart);
		inertObserver?.disconnect();
		inertObserver = null;
		if (exiting) node.removeAttribute?.('aria-modal');

		const index = activeTraps.indexOf(entry);
		if (index !== -1) activeTraps.splice(index, 1);

		if (activeTraps.length === 0) {
			if (typeof document !== 'undefined') {
				document.body.style.overflow = originalOverflow;
			}
			const savedFocus = originalFocus;
			const savedSnapshot = originalSnapshot;
			const savedOverflow = originalOverflow;
			const returnFocusOpt = currentOptions.returnFocus;
			const fallbackOpt = currentOptions.fallback;
			handoffFocus = savedFocus ?? resolveRawFocusElement(returnFocusOpt);
			handoffOverflow = savedOverflow;
			handoffSnapshot = savedSnapshot;
			originalFocus = null;
			originalSnapshot = null;

			scheduleFocusRestore(node, savedFocus, savedSnapshot, returnFocusOpt, fallbackOpt);
		}
	}

	function activate() {
		if (active || !currentOptions.enabled || node.isConnected === false || isInert(node)) return;
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
		const exitingTraps = activeTraps.filter(
			(item) => item.node.isConnected === false || isInert(item.node)
		);

		if (activeTraps.length === 0) {
			originalOverflow =
				handoffOverflow ?? (typeof document !== 'undefined' ? document.body.style.overflow : '');
			const explicitTrigger = resolveRawFocusElement(currentOptions.returnFocus);
			const trigger = handoffFocus ?? explicitTrigger ?? previous;
			originalFocus = trigger;
			originalSnapshot = handoffSnapshot ?? captureTriggerSnapshot(trigger);
			handoffFocus = null;
			handoffOverflow = null;
			handoffSnapshot = null;
		}
		restoreGeneration += 1;
		cancelPendingRestore?.();

		active = true;
		activeTraps.push(entry);
		for (const stale of exitingTraps) stale.deactivate(true);

		if (typeof document !== 'undefined') {
			document.body.style.overflow = 'hidden';
		}
		node.addEventListener('keydown', keydown);
		node.addEventListener('outrostart', outrostart);

		if (typeof MutationObserver !== 'undefined') {
			inertObserver?.disconnect();
			inertObserver = new MutationObserver(() => {
				if (isInert(node)) deactivate(true);
			});
			inertObserver.observe(node, { attributes: true, attributeFilter: ['inert'] });
		}

		focusInitial(false);
	}

	if (currentOptions.enabled) activate();

	return {
		update(nextParam?: FocusTrapOptions | boolean) {
			const next = resolveTrapOptions(nextParam);
			const keyChanged = next.key !== currentOptions.key;
			currentOptions = next;
			if (currentOptions.enabled && !active) {
				activate();
			} else if (!currentOptions.enabled && active) {
				deactivate(false);
			} else if (currentOptions.enabled && active && keyChanged) {
				node.scrollTop = 0;
				focusInitial(true);
			}
		},
		destroy() {
			deactivate(true);
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

function isMatchingActiveRow(
	el: Element | null | undefined,
	container: HTMLElement,
	selector: string
): el is HTMLElement {
	return Boolean(
		el &&
		el.parentElement === container &&
		typeof (el as HTMLElement).matches === 'function' &&
		el.matches(selector) &&
		!isInert(el) &&
		isVisible(el as HTMLElement)
	);
}

function resolveLazyNeighborRow(snapshot: HandoffSnapshot): HTMLElement | null {
	const { rowContainer, rowSelector, rowEl, rowNextSibling, rowPrevSibling, rowRawIndex } =
		snapshot;
	if (
		!rowContainer ||
		!rowSelector ||
		rowContainer.isConnected === false ||
		isInert(rowContainer)
	) {
		return null;
	}
	const siblings = rowContainer.children;
	let split = Math.min(rowRawIndex, siblings.length);
	if (rowEl && rowEl.parentElement === rowContainer) {
		const idx = Array.prototype.indexOf.call(siblings, rowEl);
		for (let i = idx + 1; i < siblings.length; i++) {
			if (isMatchingActiveRow(siblings[i], rowContainer, rowSelector)) {
				return siblings[i] as HTMLElement;
			}
		}
		for (let i = idx - 1; i >= 0; i--) {
			if (isMatchingActiveRow(siblings[i], rowContainer, rowSelector)) {
				return siblings[i] as HTMLElement;
			}
		}
		return null;
	}
	if (rowNextSibling && rowNextSibling.parentElement === rowContainer) {
		split = Array.prototype.indexOf.call(siblings, rowNextSibling);
	} else if (rowPrevSibling && rowPrevSibling.parentElement === rowContainer) {
		split = Array.prototype.indexOf.call(siblings, rowPrevSibling) + 1;
	}
	for (let i = split; i < siblings.length; i++) {
		if (isMatchingActiveRow(siblings[i], rowContainer, rowSelector)) {
			return siblings[i] as HTMLElement;
		}
	}
	for (let i = split - 1; i >= 0; i--) {
		if (isMatchingActiveRow(siblings[i], rowContainer, rowSelector)) {
			return siblings[i] as HTMLElement;
		}
	}
	return null;
}

function firstFocusableInSubtree(el: Element): HTMLElement | null {
	if (isInert(el) || (el as HTMLElement).hasAttribute?.('hidden')) return null;
	if (typeof el.matches === 'function' && el.matches(FOCUSABLE_SELECTOR) && isFocusable(el)) {
		return el;
	}
	return getFocusableControls(el)[0] ?? null;
}

function lastFocusableInSubtree(el: Element): HTMLElement | null {
	if (isInert(el) || (el as HTMLElement).hasAttribute?.('hidden')) return null;
	const descendants = getFocusableControls(el);
	if (descendants.length > 0) return descendants[descendants.length - 1];
	if (typeof el.matches === 'function' && el.matches(FOCUSABLE_SELECTOR) && isFocusable(el)) {
		return el;
	}
	return null;
}

function resolveLazyDomNeighbor(snapshot: HandoffSnapshot): HTMLElement | null {
	const { ancestors, withinEl, scope } = snapshot;
	if (!ancestors.length) return null;
	const neighborRoot = withinEl ?? scope;

	let anchorIndex = 0;
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const el = ancestors[i].el;
		if (el.isConnected === false || isInert(el) || !isVisible(el)) {
			anchorIndex = i;
			break;
		}
	}

	for (let level = anchorIndex; level < ancestors.length; level++) {
		const link = ancestors[level];
		if (link.parent.isConnected === false || isInert(link.parent)) continue;
		const siblings = link.parent.children;
		let startIdx: number;
		if (link.el.parentElement === link.parent) {
			startIdx = Array.prototype.indexOf.call(siblings, link.el) + 1;
		} else if (link.nextSibling && link.nextSibling.parentElement === link.parent) {
			startIdx = Array.prototype.indexOf.call(siblings, link.nextSibling);
		} else if (link.prevSibling && link.prevSibling.parentElement === link.parent) {
			startIdx = Array.prototype.indexOf.call(siblings, link.prevSibling) + 1;
		} else {
			startIdx = Math.min(link.childIndex, siblings.length);
		}
		for (let i = startIdx; i < siblings.length; i++) {
			const found = firstFocusableInSubtree(siblings[i]);
			if (found) return found;
		}
	}

	for (let level = anchorIndex; level < ancestors.length; level++) {
		const link = ancestors[level];
		if (link.parent.isConnected === false || isInert(link.parent)) continue;
		const siblings = link.parent.children;
		let endIdx: number;
		if (link.el.parentElement === link.parent) {
			endIdx = Array.prototype.indexOf.call(siblings, link.el) - 1;
		} else if (link.prevSibling && link.prevSibling.parentElement === link.parent) {
			endIdx = Array.prototype.indexOf.call(siblings, link.prevSibling);
		} else if (link.nextSibling && link.nextSibling.parentElement === link.parent) {
			endIdx = Array.prototype.indexOf.call(siblings, link.nextSibling) - 1;
		} else {
			endIdx = Math.min(link.childIndex, siblings.length) - 1;
		}
		for (let i = endIdx; i >= 0; i--) {
			const found = lastFocusableInSubtree(siblings[i]);
			if (found) return found;
		}
		if (
			link.parent !== neighborRoot &&
			typeof link.parent.matches === 'function' &&
			link.parent.matches(FOCUSABLE_SELECTOR) &&
			isFocusable(link.parent)
		) {
			return link.parent;
		}
	}

	return null;
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
		const rowSiblings = rowContainer?.children;
		const rowRawIndex =
			rowEl && rowSiblings ? Array.prototype.indexOf.call(rowSiblings, rowEl) : -1;

		const neighborRoot = withinEl ?? scope;
		const ancestors: AncestorAnchor[] = [];
		let cur: HTMLElement | null = rowEl ?? node;
		while (cur && cur !== neighborRoot) {
			const parent: HTMLElement | null = cur.parentElement;
			if (!parent) break;
			const siblings = parent.children;
			const idx = Array.prototype.indexOf.call(siblings, cur);
			ancestors.push({
				el: cur,
				parent,
				childIndex: Math.max(0, idx),
				nextSibling: idx !== -1 && idx + 1 < siblings.length ? siblings[idx + 1] : null,
				prevSibling: idx > 0 ? siblings[idx - 1] : null
			});
			cur = parent;
		}

		snapshot = {
			scope,
			withinEl,
			rowEl,
			rowContainer,
			rowSelector,
			rowNextSibling:
				rowSiblings && rowRawIndex !== -1 && rowRawIndex + 1 < rowSiblings.length
					? rowSiblings[rowRawIndex + 1]
					: null,
			rowPrevSibling: rowSiblings && rowRawIndex > 0 ? rowSiblings[rowRawIndex - 1] : null,
			rowRawIndex: Math.max(0, rowRawIndex),
			controlSelector: selectorForElement(node),
			ancestors
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
		const { scope, withinEl, rowSelector, controlSelector } = snapshot;

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
			const neighborRow = resolveLazyNeighborRow(snapshot);
			if (neighborRow) {
				if (currentOptions.target) {
					const targeted = resolveTarget(currentOptions.target, [neighborRow]);
					if (targeted) return targeted;
				}
				const rowMatch = focusControlInItem(neighborRow, controlSelector);
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

		const lazyNeighbor = resolveLazyDomNeighbor(snapshot);
		if (lazyNeighbor) return lazyNeighbor;
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
		target?.focus({ preventScroll: true });
	}

	function onFocusIn() {
		hadFocus = true;
		captureSnapshot();
	}

	function onFocusOut(event: FocusEvent) {
		const related = event.relatedTarget as HTMLElement | null;
		if (
			related &&
			(typeof document === 'undefined' ||
				(related !== document.body && related !== document.documentElement)) &&
			related.isConnected !== false &&
			!related.hasAttribute?.('disabled') &&
			!isInert(related) &&
			!node.contains?.(related)
		) {
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
