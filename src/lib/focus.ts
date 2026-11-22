/** Keep keyboard focus in a modal and return it to its trigger on close. */
let activeTraps = 0;
let originalOverflow = '';
let originalFocus: HTMLElement | null = null;

export function focusFirstInvalid(container: ParentNode | null | undefined): HTMLElement | null {
	if (!container) return null;
	const target = container.querySelector<HTMLElement>(
		'input[aria-invalid="true"]:not([disabled]),select[aria-invalid="true"]:not([disabled]),textarea[aria-invalid="true"]:not([disabled]),[aria-invalid="true"][tabindex]:not([disabled])'
	);
	if (!target) return null;
	let details = target.closest?.('details') ?? null;
	while (details) {
		(details as HTMLDetailsElement).open = true;
		details = details.parentElement?.closest?.('details') ?? null;
	}
	target.scrollIntoView?.({ block: 'nearest' });
	target.focus();
	return target;
}

export function focusTrap(node: HTMLElement) {
	const previous = document.activeElement as HTMLElement | null;
	const controls = () =>
		Array.from(
			node.querySelectorAll<HTMLElement>(
				'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
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
						returnTarget.focus();
				});
			}
		}
	};
}
