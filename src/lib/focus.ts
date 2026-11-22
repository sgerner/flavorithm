/** Keep keyboard focus in a modal and return it to its trigger on close. */
type TrapEntry = {
	node: HTMLElement;
	returnFocus: HTMLElement | null;
};

const FOCUSABLE_SELECTOR =
	'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const trapStack: TrapEntry[] = [];
let originalOverflow = '';
let pendingReturnFocus: HTMLElement | null = null;
let hasPendingReturn = false;
let restoreGeneration = 0;

function focusableControls(node: HTMLElement) {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => el.offsetParent !== null && !el.closest('[inert]')
	);
}

function focusFirstControl(node: HTMLElement) {
	if (!node.isConnected || node.closest('[inert]')) return;
	(focusableControls(node)[0] || node).focus();
}

export function focusTrap(node: HTMLElement) {
	const returnFocus = hasPendingReturn
		? pendingReturnFocus
		: (document.activeElement as HTMLElement | null);
	hasPendingReturn = false;
	pendingReturnFocus = null;
	restoreGeneration += 1;

	const entry: TrapEntry = { node, returnFocus };
	if (trapStack.length === 0) {
		originalOverflow = document.body.style.overflow;
	}
	trapStack.push(entry);
	document.body.style.overflow = 'hidden';

	queueMicrotask(() => {
		if (trapStack[trapStack.length - 1] !== entry) return;
		focusFirstControl(node);
	});

	function keydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		if (trapStack[trapStack.length - 1]?.node !== node) return;
		const elements = focusableControls(node);
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

	return {
		destroy() {
			node.removeEventListener('keydown', keydown);
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
			const generation = ++restoreGeneration;
			queueMicrotask(() => {
				if (generation !== restoreGeneration) return;
				hasPendingReturn = false;
				pendingReturnFocus = null;
				const top = trapStack[trapStack.length - 1];
				if (
					target?.isConnected &&
					!target.closest('[inert]') &&
					(!top || top.node.contains(target))
				) {
					target.focus();
					return;
				}
				if (top) {
					focusFirstControl(top.node);
				}
			});
		}
	};
}
