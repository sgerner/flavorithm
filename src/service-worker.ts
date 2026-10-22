import { version } from '$app/env';
import { assets as staticAssets, immutable, prerendered } from '$app/manifest';
import { asset, resolve } from '$app/paths';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cachePrefix = 'flavorithm-';
const cacheName = `${cachePrefix}${version}`;
const origin = worker.location.origin;
const offlineUrl = new URL(resolve('/'), origin).href;
const apiPath = new URL(resolve('/api'), origin).pathname.replace(/\/$/, '');

// Manifest paths are relative to SvelteKit's base path. Use resolve for build
// output and routes, and asset for files from the static assets directory.
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

function hasCredentialHeaders(request: Request): boolean {
	return (
		request.headers.has('authorization') ||
		request.headers.has('cookie') ||
		request.headers.has('x-api-key')
	);
}

function isPublicCacheableRequest(request: Request, url: URL): boolean {
	return (
		request.method === 'GET' &&
		url.origin === origin &&
		!isApiUrl(url) &&
		!url.search &&
		request.credentials === 'omit' &&
		!hasCredentialHeaders(request)
	);
}

worker.addEventListener('install', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(cacheName);
			const staticRequests = [...staticUrls].map(
				(url) => new Request(url, { credentials: 'omit' })
			);
			await cache.addAll(staticRequests);

			// Store only a credential-free app shell for offline navigation fallback.
			try {
				const response = await fetch(
					new Request(offlineUrl, { credentials: 'omit', cache: 'no-store' })
				);
				if (
					response.ok &&
					response.type !== 'opaque' &&
					response.headers.get('content-type')?.includes('text/html')
				) {
					await cache.put(offlineUrl, response);
				}
			} catch {
				// Static assets remain available if installation happens without a connection.
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
	if (request.method !== 'GET' || url.origin !== origin || isApiUrl(url)) return;

	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					const response = await fetch(request);
					if (response.ok && isPublicCacheableRequest(request, url) && response.type !== 'opaque') {
						const cache = await caches.open(cacheName);
						await cache.put(request, response.clone());
					}
					return response;
				} catch {
					const cache = await caches.open(cacheName);
					return (
						(await cache.match(request)) ??
						(await cache.match(offlineUrl)) ??
						new Response(
							'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flavorithm is offline</title><body style="font:16px system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:1.5rem;color:#253b31"><h1>You’re offline</h1><p>Reconnect to load this page. Your pantry and recipes saved on this device are still available when the app shell loads.</p></body></html>',
							{ headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
						)
					);
				}
			})()
		);
		return;
	}

	if (staticUrls.has(url.href)) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(cacheName);
				const cached = await cache.match(url.href);
				if (cached) return cached;
				const response = await fetch(new Request(request, { credentials: 'omit' }));
				if (response.ok && !hasCredentialHeaders(request) && response.type !== 'opaque') {
					await cache.put(url.href, response.clone());
				}
				return response;
			})()
		);
	}
});
