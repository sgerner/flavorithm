export type NetworkInformationLike = {
	saveData?: boolean;
};

export type NavigatorConnectionLike = {
	onLine?: boolean;
	connection?: NetworkInformationLike;
	mozConnection?: NetworkInformationLike;
	webkitConnection?: NetworkInformationLike;
};

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

	function has<K extends Key>(key: K): boolean {
		return cache.has(key);
	}

	return { load, preload, has };
}

/** Background idle warming runs only when online and Data Saver is not enabled. */
export function canIdlePrefetch(...args: [nav?: NavigatorConnectionLike | null]): boolean {
	const nav =
		args.length > 0
			? args[0]
			: typeof navigator !== 'undefined'
				? (navigator as NavigatorConnectionLike)
				: null;
	if (!nav || nav.onLine === false) return false;
	const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
	return !connection?.saveData;
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

	const timeout = options.timeout ?? 2500;
	const fallbackDelay = options.fallbackDelay ?? 200;
	const host = globalThis as unknown as {
		requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
		cancelIdleCallback?: (id: number) => void;
	};
	const useIdleCallback = Boolean(
		options.requestIdle || typeof host.requestIdleCallback === 'function'
	);
	const request =
		options.requestIdle ??
		(useIdleCallback
			? (cb: () => void, opts?: { timeout: number }) => host.requestIdleCallback!(cb, opts)
			: (cb: () => void) => Number(setTimeout(cb, fallbackDelay)));
	const cancelHandle =
		options.cancelIdle ??
		(useIdleCallback
			? (id: number) => host.cancelIdleCallback?.(id)
			: (id: number) => clearTimeout(id));

	let cancelled = false;
	let handle: number | undefined;
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
