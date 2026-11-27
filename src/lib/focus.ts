/** Keep keyboard focus in a modal and return it to its trigger on close. */
let activeTraps = 0;
let originalOverflow = '';
let originalFocus: HTMLElement | null = null;

export function focusTrap(node: HTMLElement) {
	const previous = document.activeElement as HTMLElement | null;
	const controls = () =>
		Array.from(
			node.querySelectorAll<HTMLElement>(
				'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])'
			)
		).filter((el) => el.offsetParent !== null);
	queueMicrotask(() => {
		(controls()[0] || node).focus();
	});
	function keydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const elements = controls();
		if (!elements.length) {
			event.preventDefault();
			node.focus();
			return;
		}
		const first = elements[0],
			last = elements[elements.length - 1];
		if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
	node.addEventListener('keydown', keydown);
	if (activeTraps === 0) {
		originalOverflow = document.body.style.overflow;
		originalFocus = previous;
	}
	activeTraps += 1;
	document.body.style.overflow = 'hidden';
	return {
		destroy() {
			node.removeEventListener('keydown', keydown);
			activeTraps -= 1;
			if (activeTraps === 0) {
				document.body.style.overflow = originalOverflow;
				const returnTarget = originalFocus;
				queueMicrotask(() => {
					if (activeTraps === 0 && returnTarget?.isConnected && !returnTarget.closest('[inert]'))
						returnTarget.focus({ preventScroll: true });
				});
			}
		}
	};
}

export type FocusTarget =
	HTMLElement | string | (() => HTMLElement | null | undefined) | null | undefined;

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

export const HANDOFF_FOCUSABLE_SELECTOR =
	'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),details > summary:first-of-type:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])';

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

function escapeCssIdent(value: string) {
	return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(value)
		: value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function isInertElement(el: Element | null | undefined): boolean {
	if (!el) return true;
	if ((el as HTMLElement & { inert?: boolean }).inert || el.hasAttribute?.('inert')) return true;
	return Boolean(el.closest?.('[inert]'));
}

function isDetailsElementOpen(details: Element): boolean {
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

function isClosedDetailsDescendant(el: Element, boundary?: ParentNode | null): boolean {
	let current: Element | null = el;
	while (current && current !== boundary) {
		const parent: HTMLElement | null = current.parentElement;
		if (parent && parent.tagName === 'DETAILS' && !isDetailsElementOpen(parent)) {
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

function isVisibleElement(el: HTMLElement): boolean {
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
	if (htmlEl.hasAttribute?.('disabled') || isInertElement(htmlEl)) return false;
	if (typeof htmlEl.tabIndex === 'number' && htmlEl.tabIndex < 0) return false;
	if (htmlEl.tagName === 'SUMMARY' && !htmlEl.hasAttribute?.('tabindex')) {
		if (!isFirstSummaryOfDetails(htmlEl)) return false;
	}
	if (isClosedDetailsDescendant(htmlEl)) return false;
	return isVisibleElement(htmlEl);
}

/** True when an element can safely receive programmatic focus(), including tabindex="-1" landmarks. */
function isProgrammaticallyFocusable(el: Element | null | undefined): el is HTMLElement {
	if (!el || typeof (el as HTMLElement).focus !== 'function') return false;
	const htmlEl = el as HTMLElement;
	if (typeof document !== 'undefined') {
		if (htmlEl === document.body || htmlEl === document.documentElement) return false;
	}
	if (htmlEl.isConnected === false) return false;
	if (htmlEl.hasAttribute?.('disabled') || isInertElement(htmlEl)) return false;
	if (htmlEl.tagName === 'SUMMARY' && !htmlEl.hasAttribute?.('tabindex')) {
		if (!isFirstSummaryOfDetails(htmlEl)) return false;
	}
	if (isClosedDetailsDescendant(htmlEl)) return false;
	return isVisibleElement(htmlEl);
}

/** Return ordered Tab-focusable descendants within root. */
export function getFocusableControls(root: ParentNode): HTMLElement[] {
	if (!root || typeof root.querySelectorAll !== 'function') return [];
	return Array.from(root.querySelectorAll<HTMLElement>(HANDOFF_FOCUSABLE_SELECTOR)).filter(
		(el) => !isClosedDetailsDescendant(el, root) && isFocusable(el)
	);
}

function selectorForElement(el: HTMLElement): string {
	const firstClass = el.classList?.[0];
	if (firstClass) return `${el.tagName.toLowerCase()}.${escapeCssIdent(firstClass)}`;
	return el.tagName.toLowerCase();
}

function resolveHandoffOptionTarget(
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

function focusControlInRow(
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
		!isInertElement(el) &&
		isVisibleElement(el as HTMLElement)
	);
}

function resolveLazyNeighborRow(snapshot: HandoffSnapshot): HTMLElement | null {
	const { rowContainer, rowSelector, rowEl, rowNextSibling, rowPrevSibling, rowRawIndex } =
		snapshot;
	if (
		!rowContainer ||
		!rowSelector ||
		rowContainer.isConnected === false ||
		isInertElement(rowContainer)
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
	if (isInertElement(el) || (el as HTMLElement).hasAttribute?.('hidden')) return null;
	if (
		typeof el.matches === 'function' &&
		el.matches(HANDOFF_FOCUSABLE_SELECTOR) &&
		isFocusable(el)
	) {
		return el;
	}
	return getFocusableControls(el)[0] ?? null;
}

function lastFocusableInSubtree(el: Element): HTMLElement | null {
	if (isInertElement(el) || (el as HTMLElement).hasAttribute?.('hidden')) return null;
	const descendants = getFocusableControls(el);
	if (descendants.length > 0) return descendants[descendants.length - 1];
	if (
		typeof el.matches === 'function' &&
		el.matches(HANDOFF_FOCUSABLE_SELECTOR) &&
		isFocusable(el)
	) {
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
		if (el.isConnected === false || isInertElement(el) || !isVisibleElement(el)) {
			anchorIndex = i;
			break;
		}
	}

	for (let level = anchorIndex; level < ancestors.length; level++) {
		const link = ancestors[level];
		if (link.parent.isConnected === false || isInertElement(link.parent)) continue;
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
		if (link.parent.isConnected === false || isInertElement(link.parent)) continue;
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
			link.parent.matches(HANDOFF_FOCUSABLE_SELECTOR) &&
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
		if (node.isConnected === false || isInertElement(node)) return;
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
		if (active.isConnected === false || isInertElement(active) || !isVisibleElement(active)) {
			return true;
		}
		return false;
	}

	function resolveHandoffTarget(): HTMLElement | null {
		if (!snapshot) return null;
		const { scope, withinEl, rowSelector, controlSelector } = snapshot;

		if (
			scope &&
			typeof document !== 'undefined' &&
			scope !== document.body &&
			(scope.isConnected === false || isInertElement(scope) || !isVisibleElement(scope))
		) {
			return null;
		}

		const activeWithin =
			withinEl &&
			withinEl.isConnected !== false &&
			!isInertElement(withinEl) &&
			isVisibleElement(withinEl)
				? withinEl
				: null;
		const docRoot = typeof document !== 'undefined' ? document : null;
		const fallbackScopes = [activeWithin, scope, docRoot];

		if (rowSelector) {
			const neighborRow = resolveLazyNeighborRow(snapshot);
			if (neighborRow) {
				if (currentOptions.target) {
					const targeted = resolveHandoffOptionTarget(currentOptions.target, [neighborRow]);
					if (targeted) return targeted;
				}
				const rowMatch = focusControlInRow(neighborRow, controlSelector);
				if (rowMatch) return rowMatch;
			}
			const fallbackFromRow = resolveHandoffOptionTarget(currentOptions.fallback, fallbackScopes);
			if (fallbackFromRow) return fallbackFromRow;
		} else {
			const targetScopes = currentOptions.within ? [activeWithin] : [scope, docRoot];
			const primary = resolveHandoffOptionTarget(currentOptions.target, targetScopes);
			if (primary) return primary;
			const fallback = resolveHandoffOptionTarget(currentOptions.fallback, fallbackScopes);
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
		const nodeUnavailable =
			node.isConnected === false || isInertElement(node) || !isVisibleElement(node);
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
			!isInertElement(related) &&
			!node.contains?.(related)
		) {
			hadFocus = false;
			return;
		}
		// Blink/Chromium dispatches focusout(relatedTarget: null) synchronously inside
		// WillRemoveChild BEFORE node.isConnected becomes false; defer clearing hadFocus.
		queueMicrotask(() => {
			if (destroyed) return;
			const nodeUnavailable =
				node.isConnected === false || isInertElement(node) || !isVisibleElement(node);
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
