export type NetworkInformationLike = {
	saveData?: boolean;
	effectiveType?: string;
};

export type NavigatorConnectionLike = {
	onLine?: boolean;
	connection?: NetworkInformationLike;
	mozConnection?: NetworkInformationLike;
	webkitConnection?: NetworkInformationLike;
};

const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g']);

/** Deduplicated async module preloader with failure eviction for retries. */
export function createModalPreloader<M extends Record<string, () => Promise<any>>>(loaders: M) {
	type Key = keyof M & string;
	const cache = new Map<Key, Promise<unknown>>();

	function load<K extends Key>(key: K): ReturnType<M[K]> {
		const existing = cache.get(key);
		if (existing) return existing as ReturnType<M[K]>;
		const pending = Promise.resolve()
			.then(() => loaders[key]())
			.catch((error) => {
				cache.delete(key);
				throw error;
			});
		cache.set(key, pending);
		return pending as ReturnType<M[K]>;
	}

	function preload<K extends Key>(key: K): void {
		void load(key).catch(() => {});
	}

	function warm<K extends Key>(key: K, ...args: [nav?: NavigatorConnectionLike | null]): boolean {
		if (!canIdlePrefetch(...args)) return false;
		preload(key);
		return true;
	}

	function has<K extends Key>(key: K): boolean {
		return cache.has(key);
	}

	return { load, preload, warm, has };
}

/** Speculative idle and hover/focus warming runs only when online, Data Saver is off, and not on slow-2g/2g. */
export function canIdlePrefetch(...args: [nav?: NavigatorConnectionLike | null]): boolean {
	const nav =
		args.length > 0
			? args[0]
			: typeof navigator !== 'undefined'
				? (navigator as NavigatorConnectionLike)
				: null;
	if (!nav || nav.onLine === false) return false;
	const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
	if (connection?.saveData) return false;
	if (connection?.effectiveType && SLOW_EFFECTIVE_TYPES.has(connection.effectiveType)) {
		return false;
	}
	return true;
}

export type IdleSchedulerOptions = {
	nav?: NavigatorConnectionLike;
	requestIdle?: (callback: () => void, options?: { timeout: number }) => number;
	cancelIdle?: (handle: number) => void;
	timeout?: number;
	fallbackDelay?: number;
};

/** Schedule sequential idle chunk warming and return a teardown cancellation callback. */
export function scheduleIdleWarmup<K extends string>(
	keys: readonly K[],
	warm: (key: K) => Promise<unknown> | void,
	options: IdleSchedulerOptions = {}
): () => void {
	const getNav = () =>
		options.nav ??
		(typeof navigator !== 'undefined' ? (navigator as NavigatorConnectionLike) : undefined);
	if (!canIdlePrefetch(getNav()) || keys.length === 0) return () => {};

	type IdleHandle = number | ReturnType<typeof setTimeout>;
	const timeout = options.timeout ?? 2500;
	const fallbackDelay = options.fallbackDelay ?? 200;
	const host = globalThis as unknown as {
		requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		cancelIdleCallback?: (id: number) => void;
	};
	const useIdleCallback = Boolean(
		options.requestIdle || typeof host.requestIdleCallback === 'function'
	);
	const request: (cb: () => void, opts?: { timeout: number }) => IdleHandle = options.requestIdle
		? (cb, opts) => options.requestIdle!(cb, opts)
		: useIdleCallback
			? (cb, opts) => host.requestIdleCallback!(cb, opts)
			: (cb) => setTimeout(cb, fallbackDelay);
	const cancelHandle: (id: IdleHandle) => void = options.cancelIdle
		? (id) => options.cancelIdle!(id as number)
		: useIdleCallback
			? (id) => host.cancelIdleCallback?.(id as number)
			: (id) => clearTimeout(id as ReturnType<typeof setTimeout>);

	let cancelled = false;
	let handle: IdleHandle | undefined;
	let index = 0;

	const scheduleNext = () => {
		if (cancelled || index >= keys.length || !canIdlePrefetch(getNav())) return;
		handle = request(
			() => {
				handle = undefined;
				if (cancelled || index >= keys.length || !canIdlePrefetch(getNav())) return;
				const key = keys[index++];
				Promise.resolve()
					.then(() => warm(key))
					.catch(() => {})
					.finally(() => {
						scheduleNext();
					});
			},
			{ timeout }
		);
	};

	scheduleNext();

	return () => {
		cancelled = true;
		if (handle !== undefined) {
			cancelHandle(handle);
			handle = undefined;
		}
	};
}
