/** Keep keyboard focus inside an active modal or drawer and return it cleanly on close. */
export type FocusTrapOptions = {
	enabled?: boolean;
	key?: unknown;
	returnFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
	fallbackFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
};

type ResolvedOptions = {
	enabled: boolean;
	key: unknown;
	returnFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
	fallbackFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
};

type TrapEntry = {
	node: HTMLElement;
	deactivate: (exiting?: boolean) => void;
};

const FOCUSABLE_SELECTOR =
	'button:not([disabled]):not([tabindex="-1"]),a[href]:not([tabindex="-1"]),input:not([disabled]):not([tabindex="-1"]),select:not([disabled]):not([tabindex="-1"]),textarea:not([disabled]):not([tabindex="-1"]),details > summary:first-of-type:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"])';

const MAX_RESTORE_MICROTASK_RETRIES = 8;

const activeTraps: TrapEntry[] = [];
let originalOverflow = '';
let originalFocus: HTMLElement | null = null;
let handoffFocus: HTMLElement | null = null;
let handoffOverflow: string | null = null;
let restoreGeneration = 0;
let cancelPendingRestore: (() => void) | null = null;

function resolveOptions(param?: FocusTrapOptions | boolean): ResolvedOptions {
	if (typeof param === 'boolean') return { enabled: param, key: undefined };
	return {
		enabled: param?.enabled ?? true,
		key: param?.key,
		returnFocus: param?.returnFocus,
		fallbackFocus: param?.fallbackFocus
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
		if (parent && parent.tagName === 'DETAILS' && !(parent as HTMLDetailsElement).open) {
			let summary: Element | null = null;
			for (const child of Array.from(parent.children)) {
				if (child.tagName === 'SUMMARY') {
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

function isHiddenWithoutInert(el: HTMLElement): boolean {
	if (el.hidden || el.closest('[hidden]')) return true;
	if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
		const style = window.getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') return true;
		if (el.offsetParent === null && style.position !== 'fixed') return true;
		return false;
	}
	return el.offsetParent === null;
}

function isElementVisible(el: HTMLElement): boolean {
	return !el.closest('[inert]') && !isHiddenWithoutInert(el);
}

export function focusableControls(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => !isHiddenInClosedDetails(el, node) && isElementVisible(el)
	);
}

function isUsableFocusTarget(
	el: HTMLElement | null | undefined,
	closingNode: HTMLElement
): el is HTMLElement {
	if (!el) return false;
	const doc = closingNode.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
	if (doc && (el === doc.body || el === doc.documentElement)) return false;
	if (!el.isConnected || closingNode.contains(el)) return false;
	if ((el as { disabled?: boolean }).disabled) return false;
	return !isHiddenWithoutInert(el);
}

function resolveFallbackTarget(
	fallbackFocus: ResolvedOptions['fallbackFocus'],
	closingNode: HTMLElement
): HTMLElement | null {
	const explicit = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
	if (isUsableFocusTarget(explicit, closingNode)) return explicit;
	const doc = closingNode.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
	if (!doc || typeof doc.querySelector !== 'function') return null;
	const mainTarget = doc.querySelector<HTMLElement>('#kitchen-content, main, [role="main"]');
	return isUsableFocusTarget(mainTarget, closingNode) ? mainTarget : null;
}

function hasExternalActiveFocus(
	targets: Array<HTMLElement | null>,
	closingNode: HTMLElement
): boolean {
	const doc = closingNode.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
	const active = (doc?.activeElement ?? null) as HTMLElement | null;
	return Boolean(
		active &&
		active !== doc?.body &&
		active !== doc?.documentElement &&
		!targets.includes(active) &&
		active.isConnected &&
		!closingNode.contains(active) &&
		!active.closest('[inert], [hidden], [data-focus-backdrop]')
	);
}

function scheduleFocusRestore(
	returnTarget: HTMLElement | null,
	fallbackFocus: ResolvedOptions['fallbackFocus'],
	closingNode: HTMLElement
) {
	cancelPendingRestore?.();
	const token = ++restoreGeneration;
	const doc = closingNode.ownerDocument ?? (typeof document !== 'undefined' ? document : null);

	let restoreObserver: MutationObserver | null = null;
	let observedCandidate: HTMLElement | null = null;
	let rafId: number | null = null;
	let cleaned = false;
	let retries = 0;

	const clearClosingNodeFocus = () => {
		const active = (doc?.activeElement ?? null) as HTMLElement | null;
		if (
			active &&
			(closingNode.contains(active) || !active.isConnected || active.closest('[inert]'))
		) {
			active.blur?.();
		}
	};

	const onExternalFocusIn = () => {
		const fallback = resolveFallbackTarget(fallbackFocus, closingNode);
		if (hasExternalActiveFocus([returnTarget, fallback], closingNode)) cleanup();
	};

	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		restoreObserver?.disconnect();
		restoreObserver = null;
		observedCandidate = null;
		if (rafId !== null && typeof cancelAnimationFrame === 'function') {
			cancelAnimationFrame(rafId);
		}
		rafId = null;
		if (doc && typeof doc.removeEventListener === 'function') {
			doc.removeEventListener('focusin', onExternalFocusIn);
		}
		if (cancelPendingRestore === cleanup) cancelPendingRestore = null;
	};
	cancelPendingRestore = cleanup;

	const observeInertAncestors = (candidate: HTMLElement) => {
		if (typeof MutationObserver === 'undefined') return;
		if (restoreObserver && observedCandidate === candidate) return;
		restoreObserver?.disconnect();
		restoreObserver = new MutationObserver(() => {
			attempt();
		});
		observedCandidate = candidate;
		let current: HTMLElement | null = candidate;
		while (current) {
			restoreObserver.observe(current, { attributes: true, attributeFilter: ['inert'] });
			current = current.parentElement;
		}
		if (doc && typeof doc.addEventListener === 'function') {
			doc.addEventListener('focusin', onExternalFocusIn);
		}
	};

	const attempt = (): 'done' | 'inert' => {
		if (cleaned || token !== restoreGeneration || activeTraps.length !== 0) {
			cleanup();
			return 'done';
		}
		handoffFocus = null;
		handoffOverflow = null;

		const fallback = resolveFallbackTarget(fallbackFocus, closingNode);
		if (hasExternalActiveFocus([returnTarget, fallback], closingNode)) {
			cleanup();
			return 'done';
		}

		const primary = isUsableFocusTarget(returnTarget, closingNode) ? returnTarget : null;
		if (primary) {
			if (!primary.closest('[inert]')) {
				primary.focus({ preventScroll: true });
				cleanup();
				return 'done';
			}
			if (retries >= MAX_RESTORE_MICROTASK_RETRIES && fallback && !fallback.closest('[inert]')) {
				fallback.focus({ preventScroll: true });
				cleanup();
				return 'done';
			}
			clearClosingNodeFocus();
			observeInertAncestors(primary);
			return 'inert';
		}

		if (fallback) {
			if (!fallback.closest('[inert]')) {
				fallback.focus({ preventScroll: true });
				cleanup();
				return 'done';
			}
			clearClosingNodeFocus();
			observeInertAncestors(fallback);
			return 'inert';
		}

		clearClosingNodeFocus();
		cleanup();
		return 'done';
	};

	const pollMicrotask = () => {
		if (attempt() !== 'inert') return;
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

export function focusTrap(node: HTMLElement, param?: FocusTrapOptions | boolean) {
	let options = resolveOptions(param);
	let active = false;
	let focusGeneration = 0;
	let inertObserver: MutationObserver | null = null;

	function focusInitial() {
		const token = ++focusGeneration;
		const applyFocus = () => {
			if (!active || token !== focusGeneration || node.inert || !node.isConnected) return true;
			(focusableControls(node)[0] || node).focus({ preventScroll: true });
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

	const entry: TrapEntry = {
		node,
		deactivate
	};

	function deactivate(exiting = false) {
		if (!active) {
			if (exiting) node.removeAttribute('aria-modal');
			return;
		}
		active = false;
		focusGeneration += 1;
		node.removeEventListener('keydown', keydown);
		node.removeEventListener('outrostart', outrostart);
		inertObserver?.disconnect();
		inertObserver = null;
		if (exiting) node.removeAttribute('aria-modal');

		const index = activeTraps.indexOf(entry);
		if (index !== -1) activeTraps.splice(index, 1);

		if (activeTraps.length === 0) {
			document.body.style.overflow = originalOverflow;
			const returnTarget =
				!originalFocus ||
				originalFocus === document.body ||
				originalFocus === document.documentElement
					? resolveReturnElement(options.returnFocus, originalFocus)
					: originalFocus;
			handoffFocus = returnTarget;
			handoffOverflow = originalOverflow;
			originalFocus = null;
			scheduleFocusRestore(returnTarget, options.fallbackFocus, node);
		}
	}

	function activate() {
		if (active) return;
		const previous = document.activeElement as HTMLElement | null;
		const exitingTraps = activeTraps.filter((item) => item.node.inert);

		if (activeTraps.length === 0) {
			originalOverflow = handoffOverflow ?? document.body.style.overflow;
			originalFocus = handoffFocus ?? resolveReturnElement(options.returnFocus, previous);
			handoffFocus = null;
			handoffOverflow = null;
		}
		restoreGeneration += 1;
		cancelPendingRestore?.();

		active = true;
		activeTraps.push(entry);
		for (const stale of exitingTraps) stale.deactivate(true);

		document.body.style.overflow = 'hidden';
		node.addEventListener('keydown', keydown);
		node.addEventListener('outrostart', outrostart);

		if (typeof MutationObserver !== 'undefined') {
			inertObserver = new MutationObserver(() => {
				if (node.inert) deactivate(true);
			});
			inertObserver.observe(node, { attributes: true, attributeFilter: ['inert'] });
		}

		focusInitial();
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
				focusInitial();
			}
		},
		destroy() {
			deactivate(true);
		}
	};
}
