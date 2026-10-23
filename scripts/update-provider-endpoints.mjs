import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';

// Refresh the reviewed credential-destination snapshot; runtime catalog data never changes hosts.
const response = await fetch('https://models.dev/api.json', {
	headers: { 'User-Agent': 'Flavorithm/1.0', Accept: 'application/json' },
	redirect: 'error',
	signal: AbortSignal.timeout(15_000)
});
if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
const catalog = await response.json();
const endpoints = Object.entries(catalog)
	.flatMap(([id, provider]) => {
		if (
			!/^[a-z0-9-]{1,100}$/.test(id) ||
			Object.hasOwn(Object.prototype, id) ||
			provider?.npm !== '@ai-sdk/openai-compatible' ||
			typeof provider.api !== 'string' ||
			!Array.isArray(provider.env) ||
			!provider.env.length ||
			!provider.env.every((key) => typeof key === 'string' && /API_KEY|TOKEN|KEY$/.test(key))
		)
			return [];
		try {
			const url = new URL(provider.api);
			if (
				url.protocol !== 'https:' ||
				url.username ||
				url.password ||
				url.port ||
				url.search ||
				url.hash ||
				/[{}$]/.test(url.href) ||
				isIP(url.hostname) ||
				!url.hostname.includes('.') ||
				/\.(local|localhost|internal|test|invalid)\.?$/i.test(url.hostname) ||
				url.hostname.endsWith('.') ||
				url.pathname.endsWith('/chat/completions')
			)
				return [];
			return [[id, url.href.replace(/\/$/, '')]];
		} catch {
			return [];
		}
	})
	.sort(([a], [b]) => a.localeCompare(b));
if (endpoints.length < 10)
	throw new Error(
		'Catalog returned too few compatible endpoints; refusing to overwrite the snapshot.'
	);
const source =
	'// Generated from models.dev by npm run catalog:update. Review credential destinations before committing.\n' +
	'export const COMPATIBLE_PROVIDER_ENDPOINTS: Record<string, string> = ' +
	JSON.stringify(Object.fromEntries(endpoints), null, '\t') +
	';\n';
await writeFile(
	new URL('../src/lib/server/compatible-provider-endpoints.ts', import.meta.url),
	source
);
console.log(`Updated ${endpoints.length} compatible provider endpoints.`);
