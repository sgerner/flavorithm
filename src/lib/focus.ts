/** Keep keyboard focus in a modal and return it to its trigger on close. */
let activeTraps = 0;
let settling = false;
let settleToken = 0;
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
		if (node.isConnected) (controls()[0] || node).focus();
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
	if (activeTraps === 0 && !settling) {
		originalOverflow = document.body.style.overflow;
		originalFocus =
			previous && previous !== document.body && previous !== document.documentElement
				? previous
				: null;
	}
	settleToken += 1;
	settling = false;
	activeTraps += 1;
	document.body.style.overflow = 'hidden';
	return {
		destroy() {
			node.removeEventListener('keydown', keydown);
			activeTraps -= 1;
			if (activeTraps === 0) {
				const token = ++settleToken;
				settling = true;
				queueMicrotask(() => {
					if (token !== settleToken) return;
					settling = false;
					if (activeTraps === 0) {
						document.body.style.overflow = originalOverflow;
						const returnTarget = originalFocus;
						originalFocus = null;
						if (returnTarget?.isConnected && !returnTarget.closest('[inert]')) {
							returnTarget.focus({ preventScroll: true });
						}
					}
				});
			}
		}
	};
}
