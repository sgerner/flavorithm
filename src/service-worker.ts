import { version } from '$app/env';
import { assets as staticAssets, immutable, prerendered } from '$app/manifest';
import { asset, resolve } from '$app/paths';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cachePrefix = 'flavorithm-';
const cacheName = `${cachePrefix}${version}`;
const origin = worker.location.origin;
const offlineUrl = new URL(resolve('/'), origin).href;
const apiPath = new URL(resolve('/api'), origin).pathname.replace(/\/$/, '');

// Navigation HTML can contain an authenticated identity, including when identity is supplied by a
// reverse proxy rather than a browser cookie. Keep only static assets in Cache Storage.
const staticUrls = new Set(
	[
		...immutable.map(({ path }) => toUrl(resolve(path.replace(/^\/+/, '')))),
		...staticAssets.map(({ path }) => toUrl(asset(path))),
		...prerendered.map(({ path }) => toUrl(resolve(path)))
	].filter((url) => !isApiUrl(new URL(url)))
);

function toUrl(path: string): string {
	return new URL(path, origin).href;
}

function isApiUrl(url: URL): boolean {
	const pathname = url.pathname.replace(/\/$/, '');
	return pathname === apiPath || pathname.startsWith(`${apiPath}/`);
}

function cacheKey(url: string): Request {
	// Network fetches may need the same-origin session for an authenticated reverse proxy. The
	// cache key itself never carries cookies, authorization, or other request credentials.
	return new Request(url, { credentials: 'omit' });
}

function authMode(response: Response): Promise<string | null> {
	return response
		.clone()
		.json()
		.then((body) => (typeof body?.authMode === 'string' ? body.authMode : null))
		.catch(() => null);
}

async function clearOfflineShell(): Promise<void> {
	const cache = await caches.open(cacheName);
	await cache.delete(cacheKey(offlineUrl));
}

function isCacheableStaticResponse(response: Response, expectedUrl: string): boolean {
	if (!response.ok || response.type === 'opaque' || response.redirected) return false;
	const responseUrl = response.url ? new URL(response.url) : new URL(expectedUrl);
	if (responseUrl.origin !== origin) return false;
	if (response.headers.has('set-cookie')) return false;
	const vary = response.headers.get('vary')?.toLowerCase() || '';
	if (vary.split(',').some((value) => ['cookie', 'authorization'].includes(value.trim())))
		return false;
	const cacheControl = response.headers.get('cache-control')?.toLowerCase() || '';
	if (/\b(private|no-store)\b/.test(cacheControl)) return false;
	const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	return Boolean(
		contentType &&
		(contentType === 'text/css' ||
			contentType === 'text/javascript' ||
			contentType === 'application/javascript' ||
			contentType === 'application/ecmascript' ||
			contentType === 'text/ecmascript' ||
			contentType === 'application/wasm' ||
			contentType.startsWith('image/') ||
			contentType.startsWith('font/') ||
			contentType.startsWith('application/font-') ||
			contentType === 'application/vnd.ms-fontobject')
	);
}

function isCacheableLocalShell(response: Response, expectedUrl: string): boolean {
	if (
		!response.ok ||
		response.type === 'opaque' ||
		response.redirected ||
		(response.url && new URL(response.url).origin !== origin) ||
		response.headers.get('x-flavorithm-auth-mode') !== 'local' ||
		!response.headers.get('content-type')?.includes('text/html') ||
		response.headers.has('set-cookie')
	) {
		return false;
	}
	const vary = response.headers.get('vary')?.toLowerCase() || '';
	if (vary.split(',').some((value) => ['cookie', 'authorization'].includes(value.trim())))
		return false;
	const cacheControl = response.headers.get('cache-control')?.toLowerCase() || '';
	return !/\b(private|no-store)\b/.test(cacheControl) && new URL(expectedUrl).origin === origin;
}

async function fetchAndCacheStatic(url: string): Promise<Response> {
	const response = await fetch(new Request(url, { credentials: 'same-origin', cache: 'no-store' }));
	if (isCacheableStaticResponse(response, url)) {
		const cache = await caches.open(cacheName);
		await cache.put(cacheKey(url), response.clone());
	}
	return response;
}

async function cacheLocalOfflineShell(): Promise<void> {
	const authResponse = await fetch(
		new Request(new URL(resolve('/api/auth'), origin).href, {
			credentials: 'same-origin',
			cache: 'no-store'
		})
	);
	if (!authResponse.ok || (await authMode(authResponse)) !== 'local') return;
	const response = await fetch(new Request(offlineUrl, { credentials: 'omit', cache: 'no-store' }));
	if (
		!response.ok ||
		response.type === 'opaque' ||
		response.redirected ||
		(response.url && new URL(response.url).origin !== origin) ||
		!isCacheableLocalShell(response, offlineUrl)
	) {
		return;
	}
	const cache = await caches.open(cacheName);
	await cache.put(cacheKey(offlineUrl), response);
}

function offlineResponse(): Response {
	return new Response(
		'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flavorithm is offline</title><body style="font:16px system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#253b31"><h1>You’re offline</h1><p>Reconnect to verify your session and load your kitchen.</p></body></html>',
		{
			headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
			status: 503
		}
	);
}

worker.addEventListener('install', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			await Promise.allSettled([...staticUrls].map((url) => fetchAndCacheStatic(url)));
			try {
				await cacheLocalOfflineShell();
			} catch {
				// The public shell is optional. Authenticated HTML is never cached as a fallback.
			}
			await worker.skipWaiting();
		})()
	);
});

worker.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names
					.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
					.map((name) => caches.delete(name))
			);
			await worker.clients.claim();
		})()
	);
});

worker.addEventListener('fetch', (event: FetchEvent) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== origin) return;
	if (url.pathname === `${apiPath}/auth`) {
		event.respondWith(
			(async () => {
				const response = await fetch(request);
				if ((await authMode(response)) !== 'local') await clearOfflineShell();
				return response;
			})()
		);
		return;
	}
	if (isApiUrl(url)) return;

	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					const mode = response.headers.get('x-flavorithm-auth-mode');
					if (mode && mode !== 'local') await clearOfflineShell();
					if (response.redirected || (response.url && new URL(response.url).origin !== origin)) {
						await clearOfflineShell();
					}
					if (
						mode === 'local' &&
						request.credentials === 'omit' &&
						!request.headers.has('authorization') &&
						isCacheableLocalShell(response, url.href)
					) {
						const cache = await caches.open(cacheName);
						await cache.put(cacheKey(request.url), response.clone());
					}
					return response;
				} catch {
					const cache = await caches.open(cacheName);
					const shell = await cache.match(cacheKey(offlineUrl));
					if (shell?.headers.get('x-flavorithm-auth-mode') === 'local') return shell;
					return offlineResponse();
				}
			})()
		);
		return;
	}

	if (!staticUrls.has(url.href)) return;
	event.respondWith(
		(async () => {
			try {
				return await fetchAndCacheStatic(url.href);
			} catch {
				const cache = await caches.open(cacheName);
				return (await cache.match(cacheKey(url.href))) ?? new Response(null, { status: 504 });
			}
		})()
	);
});
