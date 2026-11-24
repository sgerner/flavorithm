/** Keep keyboard focus inside an active modal or drawer and return it cleanly on close. */
export type FocusTrapOptions = {
	enabled?: boolean;
	key?: unknown;
	returnFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
};

type ResolvedOptions = {
	enabled: boolean;
	key: unknown;
	returnFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
};

type TrapEntry = {
	node: HTMLElement;
	returnFocus: HTMLElement | null;
	deactivate: (exiting?: boolean) => void;
};

const FOCUSABLE_SELECTOR =
	'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),details > summary:first-of-type:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])';

const trapStack: TrapEntry[] = [];
let originalOverflow = '';
let pendingReturnFocus: HTMLElement | null = null;
let pendingClosingNode: HTMLElement | null = null;
let hasPendingReturn = false;
let restoreGeneration = 0;

export function activeFocusedElement(): HTMLElement | null {
	if (typeof document === 'undefined') return null;
	const active = document.activeElement as HTMLElement | null;
	if (!active || active === document.body || active === document.documentElement) return null;
	return active;
}

function resolveOptions(param?: FocusTrapOptions | boolean): ResolvedOptions {
	if (typeof param === 'boolean') return { enabled: param, key: undefined };
	return {
		enabled: param?.enabled ?? true,
		key: param?.key,
		returnFocus: param?.returnFocus
	};
}

function resolveReturnElement(
	target: ResolvedOptions['returnFocus'],
	fallback: HTMLElement | null
): HTMLElement | null {
	const explicit = typeof target === 'function' ? target() : target;
	return explicit ?? fallback;
}

function isHiddenInClosedDetails(el: HTMLElement, container: HTMLElement): boolean {
	let current: HTMLElement | null = el;
	while (current && current !== container) {
		const parent: HTMLElement | null = current.parentElement;
		if (
			parent &&
			parent.tagName.toUpperCase() === 'DETAILS' &&
			!(parent as HTMLDetailsElement).open
		) {
			let summary: Element | null = null;
			for (const child of Array.from(parent.children)) {
				if (child.tagName.toUpperCase() === 'SUMMARY') {
					summary = child;
					break;
				}
			}
			if (current !== summary) return true;
		}
		current = parent;
	}
	return false;
}

function isElementVisible(el: HTMLElement): boolean {
	if (el.hidden || el.closest('[hidden], [inert]')) return false;
	if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
		const style = window.getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') return false;
		if (el.offsetParent === null && style.position !== 'fixed') return false;
		return true;
	}
	return el.offsetParent !== null;
}

export function focusableControls(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !isHiddenInClosedDetails(el, node) && isElementVisible(el)
	);
}

function focusFirstControl(node: HTMLElement) {
	if (!node.isConnected || node.hidden || node.inert || node.closest('[hidden], [inert]')) return;
	(focusableControls(node)[0] || node).focus();
}

function hasExternalActiveFocus(closingNode: HTMLElement, target: HTMLElement | null): boolean {
	const active = document.activeElement as HTMLElement | null;
	if (!active || active === document.body || active === document.documentElement) return false;
	if (active === target || closingNode.contains(active)) return false;
	return active.isConnected && isElementVisible(active);
}

export function focusTrap(node: HTMLElement, param?: FocusTrapOptions | boolean) {
	let options = resolveOptions(param);
	let active = false;
	let focusGeneration = 0;
	let inertObserver: MutationObserver | null = null;

	const entry: TrapEntry = {
		node,
		returnFocus: null,
		deactivate
	};

	function scheduleInitialFocus() {
		const token = ++focusGeneration;
		const applyFocus = () => {
			if (!active || token !== focusGeneration) return true;
			if (trapStack[trapStack.length - 1] !== entry) return true;
			if (!node.isConnected || node.hidden || node.inert || node.closest('[hidden], [inert]')) {
				return true;
			}
			(focusableControls(node)[0] || node).focus();
			return node.contains(document.activeElement);
		};
		queueMicrotask(() => {
			if (!applyFocus() && typeof requestAnimationFrame === 'function') {
				requestAnimationFrame(() => {
					if (!node.contains(document.activeElement)) applyFocus();
				});
			}
		});
	}

	function keydown(event: KeyboardEvent) {
		if (event.key !== 'Tab' || !active) return;
		if (trapStack[trapStack.length - 1]?.node !== node) return;
		const elements = focusableControls(node);
		if (!elements.length) {
			event.preventDefault();
			node.focus();
			return;
		}
		const first = elements[0];
		const last = elements[elements.length - 1];
		const current = document.activeElement as HTMLElement | null;
		if (!current || !node.contains(current)) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		} else if (event.shiftKey && (current === first || current === node)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (current === last || current === node)) {
			event.preventDefault();
			first.focus();
		}
	}

	function outrostart(event: Event) {
		if (event.target === node) deactivate(true);
	}

	function activate() {
		if (active) return;
		for (const stale of [...trapStack]) {
			if (stale.node.inert) stale.deactivate(true);
		}
		const explicitReturn = resolveReturnElement(options.returnFocus, null);
		const returnFocus = hasPendingReturn
			? !explicitReturn ||
				!explicitReturn.isConnected ||
				pendingClosingNode?.contains(explicitReturn)
				? pendingReturnFocus
				: explicitReturn
			: (explicitReturn ?? (document.activeElement as HTMLElement | null));
		hasPendingReturn = false;
		pendingReturnFocus = null;
		pendingClosingNode = null;
		restoreGeneration += 1;

		entry.returnFocus = returnFocus;
		if (trapStack.length === 0) {
			originalOverflow = document.body.style.overflow;
		}
		active = true;
		trapStack.push(entry);
		document.body.style.overflow = 'hidden';

		node.addEventListener('keydown', keydown);
		node.addEventListener('outrostart', outrostart);
		if (typeof MutationObserver !== 'undefined') {
			inertObserver = new MutationObserver(() => {
				if (node.inert) deactivate(true);
			});
			inertObserver.observe(node, { attributes: true, attributeFilter: ['inert'] });
		}
		scheduleInitialFocus();
	}

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

		const index = trapStack.indexOf(entry);
		if (index === -1) return;
		const wasTop = index === trapStack.length - 1;
		if (!wasTop) {
			const next = trapStack[index + 1];
			if (
				next &&
				(!next.returnFocus || !next.returnFocus.isConnected || node.contains(next.returnFocus))
			) {
				next.returnFocus = entry.returnFocus;
			}
			trapStack.splice(index, 1);
			return;
		}

		trapStack.splice(index, 1);
		if (trapStack.length === 0) {
			document.body.style.overflow = originalOverflow;
		}
		const target = entry.returnFocus;
		hasPendingReturn = true;
		pendingReturnFocus = target;
		pendingClosingNode = node;
		const generation = ++restoreGeneration;
		queueMicrotask(() => {
			if (generation !== restoreGeneration) return;
			hasPendingReturn = false;
			pendingReturnFocus = null;
			pendingClosingNode = null;
			const top = trapStack[trapStack.length - 1];
			if (!top && hasExternalActiveFocus(node, target)) return;
			if (target?.isConnected && isElementVisible(target) && (!top || top.node.contains(target))) {
				target.focus({ preventScroll: true });
				return;
			}
			if (
				!top &&
				target?.isConnected &&
				target.closest('[inert]') &&
				typeof requestAnimationFrame === 'function'
			) {
				requestAnimationFrame(() => {
					if (generation !== restoreGeneration || trapStack.length !== 0) return;
					if (hasExternalActiveFocus(node, target)) return;
					if (target.isConnected && isElementVisible(target)) {
						target.focus({ preventScroll: true });
					}
				});
				return;
			}
			if (top) {
				focusFirstControl(top.node);
			}
		});
	}

	if (options.enabled) activate();

	return {
		update(nextParam?: FocusTrapOptions | boolean) {
			const next = resolveOptions(nextParam);
			const keyChanged = next.key !== options.key;
			options = next;
			if (options.enabled && !active) {
				activate();
			} else if (!options.enabled && active) {
				deactivate(false);
			} else if (options.enabled && active && keyChanged) {
				node.scrollTop = 0;
				scheduleInitialFocus();
			}
		},
		destroy() {
			deactivate(true);
		}
	};
}
