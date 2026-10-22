import type { EasingFunction, TransitionConfig } from 'svelte/transition';

type MotionOptions = {
	delay?: number;
	duration?: number;
	x?: number | string;
	y?: number | string;
	easing?: EasingFunction;
};

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Check the preference when a transition starts so changes made while the app is open take effect. */
function prefersReducedMotion() {
	return (
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

function timing(options: MotionOptions, fallbackDuration: number, reduced: boolean) {
	if (reduced) return { delay: 0, duration: 0 };
	return {
		delay: options.delay ?? 0,
		duration: options.duration ?? fallbackDuration
	};
}

function scaledOffset(value: number | string, remaining: number) {
	if (typeof value === 'number') return `${value * remaining}px`;
	const match = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i.exec(value.trim());
	if (!match) return value;
	return `${Number(match[1]) * remaining}${match[2]}`;
}

/** Apply a consistent duration to existing Svelte transitions, respecting reduced motion. */
export function motionDuration(milliseconds: number) {
	return prefersReducedMotion() ? 0 : milliseconds;
}

/** Softly reveals a full-screen modal backdrop. */
export function backdropMotion(_node: Element, options: MotionOptions = {}): TransitionConfig {
	const reduced = prefersReducedMotion();
	return {
		...timing(options, 190, reduced),
		easing: options.easing ?? easeOutCubic,
		css: (t) => (reduced ? 'opacity: 1' : `opacity: ${t}`)
	};
}

/** Gives dialogs a short lift and settle as they enter or leave. */
export function dialogMotion(_node: Element, options: MotionOptions = {}): TransitionConfig {
	const reduced = prefersReducedMotion();
	return {
		...timing(options, 300, reduced),
		easing: options.easing ?? easeOutCubic,
		css: (t) =>
			reduced
				? 'opacity: 1; transform: none'
				: `opacity: ${t}; transform: translate3d(0, ${(1 - t) * 22}px, 0) scale(${0.975 + t * 0.025})`
	};
}

/** Reveals panels and other nested content with a restrained vertical drift. */
export function revealMotion(_node: Element, options: MotionOptions = {}): TransitionConfig {
	const reduced = prefersReducedMotion();
	const x = options.x ?? 0;
	const y = options.y ?? 9;
	return {
		...timing(options, 240, reduced),
		easing: options.easing ?? easeOutCubic,
		css: (t) =>
			reduced
				? 'opacity: 1; transform: none'
				: `opacity: ${t}; transform: translate3d(${scaledOffset(x, 1 - t)}, ${scaledOffset(y, 1 - t)}, 0)`
	};
}

/** Fades small conditional elements, such as a completed-step checkmark. */
export function fadeMotion(_node: Element, options: MotionOptions = {}): TransitionConfig {
	const reduced = prefersReducedMotion();
	return {
		...timing(options, 150, reduced),
		css: (t) => (reduced ? 'opacity: 1' : `opacity: ${t}`)
	};
}
