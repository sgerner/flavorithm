import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Transform } from 'node:stream';
import { test } from 'node:test';
import {
	brotliCompressSync,
	brotliDecompressSync,
	gunzipSync,
	gzipSync,
	inflateSync
} from 'node:zlib';
import {
	appendVaryAcceptEncoding,
	isCompressibleContentType,
	negotiateEncoding,
	suffixStrongEtag,
	withDynamicCompression
} from '../server.mjs';

process.env.FLAVORITHM_DB_PATH = ':memory:';
const backend = await import('../src/lib/server/db.ts');
const stateRoute = await import('../src/routes/api/state/+server.ts');

type RawResponse = {
	status: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
};

function rawRequest(
	port: number,
	path: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string | Buffer;
	} = {}
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: '127.0.0.1',
				port,
				path,
				method: options.method ?? 'GET',
				headers: options.headers
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks)
					})
				);
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

test('negotiateEncoding honors quality weights, tie-break priority (br > gzip > deflate), wildcards, and q=0 exclusions', () => {
	assert.equal(negotiateEncoding(undefined), null);
	assert.equal(negotiateEncoding(''), null);
	assert.equal(negotiateEncoding('   '), null);
	assert.equal(negotiateEncoding('identity'), null);
	assert.equal(negotiateEncoding('zstd'), null);

	// Tie-breaking prefers br, then gzip, then deflate regardless of header order.
	assert.equal(negotiateEncoding('gzip, deflate, br'), 'br');
	assert.equal(negotiateEncoding('deflate, gzip'), 'gzip');
	assert.equal(negotiateEncoding('deflate'), 'deflate');

	// Quality weights override default order.
	assert.equal(negotiateEncoding('br;q=0.7, gzip;q=0.9, deflate;q=1.0'), 'deflate');
	assert.equal(negotiateEncoding('br;q=0.8, gzip;q=0.9'), 'gzip');
	assert.equal(negotiateEncoding('br;q=0.9, gzip;q=0.9'), 'br');
	assert.equal(negotiateEncoding(['gzip;q=0.5', 'br;q=0.8']), 'br');

	// Explicit q=0 exclusions and wildcard fallbacks.
	assert.equal(negotiateEncoding('br;q=0, gzip, deflate'), 'gzip');
	assert.equal(negotiateEncoding('br;q=0, gzip;q=0, deflate;q=0'), null);
	assert.equal(negotiateEncoding('*;q=0.5, br;q=0'), 'gzip');
	assert.equal(negotiateEncoding('*;q=0.5, br;q=0, gzip;q=0'), 'deflate');
	assert.equal(negotiateEncoding('*;q=0'), null);
	assert.equal(negotiateEncoding('*'), 'br');

	// Malformed q weights are rejected safely rather than treated as 1.
	assert.equal(negotiateEncoding('br;q=invalid, gzip;q=0.5'), 'gzip');
	assert.equal(negotiateEncoding('br;q=1.5, gzip;q=-0.2'), null);
	assert.equal(negotiateEncoding('br;q=1.0000, gzip;q=0.250'), 'gzip');
});

test('isCompressibleContentType matches allowed text/json/js/xml/svg types and rejects binary or SSE streams', () => {
	for (const allowed of [
		'text/html',
		'text/html; charset=utf-8',
		'text/plain; charset=utf-8',
		'text/css',
		'text/javascript',
		'application/json',
		'application/json; charset=utf-8',
		'application/problem+json',
		'application/ld+json',
		'application/manifest+json',
		'application/javascript',
		'application/xml',
		'application/atom+xml',
		'application/rss+xml',
		'image/svg+xml'
	]) {
		assert.equal(
			isCompressibleContentType(allowed),
			true,
			`expected ${allowed} to be compressible`
		);
	}

	for (const rejected of [
		undefined,
		'',
		'text/event-stream',
		'text/event-stream; charset=utf-8',
		'image/jpeg',
		'image/png',
		'image/webp',
		'audio/wav',
		'audio/mpeg',
		'video/mp4',
		'application/wasm',
		'application/octet-stream',
		'application/pdf',
		'application/+json'
	]) {
		assert.equal(
			isCompressibleContentType(rejected),
			false,
			`expected ${String(rejected)} not to be compressible`
		);
	}
});

test('suffixStrongEtag appends encoding suffixes only to strong ETags and matchesStateEtag validates If-Match variants', async () => {
	assert.equal(suffixStrongEtag('"abc123"', 'br'), '"abc123-br"');
	assert.equal(suffixStrongEtag('"abc123"', 'gzip'), '"abc123-gzip"');
	assert.equal(suffixStrongEtag('"abc123"', 'deflate'), '"abc123-deflate"');
	assert.equal(suffixStrongEtag('"abc123-br"', 'br'), '"abc123-br"');
	assert.equal(suffixStrongEtag('W/"abc123"', 'br'), 'W/"abc123"');

	const { user } = await backend.registerUser(
		'Compression Sync User',
		'compression-sync@example.test',
		'a very secure kitchen password'
	);
	const initialState = backend.getState(user)!;
	const baseTag = backend.getStateEtag(user);
	const inner = baseTag.slice(1, -1);

	for (const validIfMatch of [
		baseTag,
		`"${inner}-br"`,
		`"${inner}-gzip"`,
		`"${inner}-deflate"`,
		`W/${baseTag}`,
		`W/"${inner}-br"`,
		`W/"${inner}-gzip"`,
		`"stale-tag", "${inner}-br"`
	]) {
		assert.equal(
			backend.matchesStateEtag(validIfMatch, baseTag),
			true,
			`expected ${validIfMatch} to match ${baseTag}`
		);
	}

	for (const invalidIfMatch of [
		'',
		'*',
		inner,
		'"different"',
		'"different-br"',
		`"${inner}-unknown"`
	]) {
		assert.equal(
			backend.matchesStateEtag(invalidIfMatch, baseTag),
			false,
			`expected ${invalidIfMatch} not to match ${baseTag}`
		);
	}

	// Verify actual saveState round-trips with suffixed and weak tags, plus 412 and 428 errors.
	for (const suffix of ['-br', '-gzip', '-deflate']) {
		const current = backend.getStateEtag(user);
		const suffixed = `"${current.slice(1, -1)}${suffix}"`;
		backend.saveState(user, initialState, { ifMatch: suffixed, ifNoneMatch: null });
	}
	const weakCurrent = `W/${backend.getStateEtag(user)}`;
	backend.saveState(user, initialState, { ifMatch: weakCurrent, ifNoneMatch: null });

	assert.throws(
		() => backend.saveState(user, initialState, { ifMatch: '"stale-br"', ifNoneMatch: null }),
		{ status: 412 }
	);
	assert.throws(
		() => backend.saveState(user, initialState, { ifMatch: '   ', ifNoneMatch: null }),
		{
			status: 428
		}
	);

	// Route-level PUT /api/state check with a -br ETag.
	const routeTag = suffixStrongEtag(backend.getStateEtag(user), 'br');
	const putResponse = await stateRoute.PUT({
		locals: { user },
		request: new Request('https://flavorithm.example/api/state', {
			method: 'PUT',
			headers: {
				origin: 'https://flavorithm.example',
				'content-type': 'application/json',
				'if-match': routeTag
			},
			body: JSON.stringify({ state: initialState })
		})
	} as never);
	assert.equal(putResponse.status, 200);
});

test('withDynamicCompression compresses eligible payloads, preserves headers, handles Vary/ETag/skip rules, HEAD, backpressure, and early socket close', async () => {
	const htmlPayload = `<!doctype html><html><body>${'<p>Flavorithm kitchen companion</p>'.repeat(120)}</body></html>`;
	const smallJson = JSON.stringify({ ok: true, mode: 'local' });
	const largeJson = JSON.stringify({
		models: Array.from({ length: 4000 }, (_, index) => ({
			id: `provider/model-${index}`,
			name: `Kitchen Model ${index}`,
			description: 'Structured culinary reasoning and pantry planning assistant.'
		}))
	});
	const jpegBytes = Buffer.alloc(4096, 0xff);
	const precompressedBr = brotliCompressSync(Buffer.from('console.log("immutable");'.repeat(100)));
	const precompressedGz = gzipSync(Buffer.from('console.log("immutable");'.repeat(100)));

	let capturedAbortCompressor: Transform | undefined;
	let startAbortStream: (() => void) | undefined;

	const server = createServer((req, res) => {
		withDynamicCompression(req, res, {
			onCompressor: (stream) => {
				if (req.url === '/abort-stream') capturedAbortCompressor = stream;
			}
		});

		if (req.url === '/html') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Content-Length', Buffer.byteLength(htmlPayload));
			res.setHeader('Accept-Ranges', 'bytes');
			res.setHeader('Cache-Control', 'no-store, max-age=0');
			res.setHeader('Vary', 'Origin');
			if (req.method === 'HEAD') {
				res.removeHeader('Content-Length');
				res.writeHead(200);
				res.end();
				return;
			}
			res.writeHead(200);
			res.end(htmlPayload);
			return;
		}

		if (req.url === '/vary-existing') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(largeJson),
				Vary: 'Origin, accept-encoding'
			});
			res.end(largeJson);
			return;
		}

		if (req.url === '/small') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(smallJson),
				ETag: '"small-tag"'
			});
			res.end(smallJson);
			return;
		}

		if (req.url === '/no-transform') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(largeJson),
				'Cache-Control': 'private, no-transform',
				ETag: '"raw-tag"'
			});
			res.end(largeJson);
			return;
		}

		if (req.url === '/sse') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write(`data: ${'event-payload-'.repeat(200)}\n\n`);
			res.end();
			return;
		}

		if (req.url === '/cover.jpg') {
			res.writeHead(200, {
				'Content-Type': 'image/jpeg',
				'Content-Length': jpegBytes.byteLength,
				'Cache-Control': 'private, no-store'
			});
			res.end(jpegBytes);
			return;
		}

		if (req.url === '/static.js.br') {
			res.writeHead(200, {
				'Content-Type': 'text/javascript',
				'Content-Encoding': 'br',
				'Content-Length': precompressedBr.byteLength,
				'Accept-Ranges': 'bytes',
				Vary: 'Accept-Encoding',
				ETag: '"asset.br"'
			});
			res.end(precompressedBr);
			return;
		}

		if (req.url === '/static.js.gz') {
			res.writeHead(200, {
				'Content-Type': 'text/javascript',
				'Content-Encoding': 'gzip',
				'Content-Length': precompressedGz.byteLength,
				'Accept-Ranges': 'bytes',
				Vary: 'Accept-Encoding',
				ETag: '"asset.gz"'
			});
			res.end(precompressedGz);
			return;
		}

		if (req.url === '/partial') {
			const slice = Buffer.from(htmlPayload).subarray(0, 2048);
			res.writeHead(206, {
				'Content-Type': 'text/html',
				'Content-Range': `bytes 0-2047/${Buffer.byteLength(htmlPayload)}`,
				'Content-Length': slice.byteLength
			});
			res.end(slice);
			return;
		}

		if (req.url === '/not-modified') {
			res.writeHead(304, { ETag: '"cached-br"', Vary: 'Accept-Encoding' });
			res.end();
			return;
		}

		if (req.url === '/no-content') {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.url === '/state') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(largeJson),
				'Cache-Control': 'no-store, max-age=0',
				Pragma: 'no-cache',
				ETag: '"version1"'
			});
			res.end(largeJson);
			return;
		}

		if (req.url === '/large-drain') {
			// Simulate @sveltejs/kit/node setResponse drain loop across many large chunks (>1.5 MB).
			res.writeHead(200, { 'Content-Type': 'application/json' });
			let index = 0;
			const totalChunks = 24;
			const chunk = Buffer.from(largeJson);
			const pump = () => {
				while (index < totalChunks) {
					const piece =
						index === 0
							? Buffer.concat([Buffer.from('['), chunk])
							: Buffer.concat([Buffer.from(','), chunk]);
					index += 1;
					if (!res.write(piece)) {
						res.once('drain', pump);
						return;
					}
				}
				res.end(']');
			};
			pump();
			return;
		}

		if (req.url === '/abort-stream') {
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.flushHeaders();
			res.write('x'.repeat(65_536));
			startAbortStream?.();
			return;
		}

		res.writeHead(404).end();
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	try {
		// 1. Brotli compression on HTML, Vary merging, Content-Length & Accept-Ranges removal.
		const brHtml = await rawRequest(port, '/html', {
			headers: { 'Accept-Encoding': 'gzip, deflate, br' }
		});
		assert.equal(brHtml.status, 200);
		assert.equal(brHtml.headers['content-encoding'], 'br');
		assert.equal(brHtml.headers['vary'], 'Origin, Accept-Encoding');
		assert.equal(brHtml.headers['content-length'], undefined);
		assert.equal(brHtml.headers['accept-ranges'], undefined);
		assert.equal(brHtml.headers['cache-control'], 'no-store, max-age=0');
		assert.ok(brHtml.body.byteLength < Buffer.byteLength(htmlPayload) / 4);
		assert.equal(brotliDecompressSync(brHtml.body).toString('utf8'), htmlPayload);

		// 2. Gzip and deflate negotiation + ETag suffixing.
		const gzipState = await rawRequest(port, '/state', {
			headers: { 'Accept-Encoding': 'gzip;q=1.0, br;q=0.5' }
		});
		assert.equal(gzipState.headers['content-encoding'], 'gzip');
		assert.equal(gzipState.headers['etag'], '"version1-gzip"');
		assert.equal(gzipState.headers['cache-control'], 'no-store, max-age=0');
		assert.equal(gzipState.headers['pragma'], 'no-cache');
		assert.equal(gunzipSync(gzipState.body).toString('utf8'), largeJson);

		const deflateState = await rawRequest(port, '/state', {
			headers: { 'Accept-Encoding': 'deflate, br;q=0' }
		});
		assert.equal(deflateState.headers['content-encoding'], 'deflate');
		assert.equal(deflateState.headers['etag'], '"version1-deflate"');
		assert.equal(inflateSync(deflateState.body).toString('utf8'), largeJson);

		// 3. Vary token deduplication (case-insensitive).
		const varyDedup = await rawRequest(port, '/vary-existing', {
			headers: { 'Accept-Encoding': 'br' }
		});
		assert.equal(varyDedup.headers['vary'], 'Origin, accept-encoding');

		// 4. Identity / q=0 skips encoding while keeping Vary: Accept-Encoding.
		const identityState = await rawRequest(port, '/state', {
			headers: { 'Accept-Encoding': 'identity' }
		});
		assert.equal(identityState.headers['content-encoding'], undefined);
		assert.equal(identityState.headers['vary'], 'Accept-Encoding');
		assert.equal(identityState.headers['etag'], '"version1"');
		assert.equal(identityState.body.toString('utf8'), largeJson);

		// 5. Responses below 1,024 bytes omit Content-Encoding and preserve ETag/Content-Length.
		const small = await rawRequest(port, '/small', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(small.headers['content-encoding'], undefined);
		assert.equal(small.headers['etag'], '"small-tag"');
		assert.equal(Number(small.headers['content-length']), Buffer.byteLength(smallJson));
		assert.equal(small.body.toString('utf8'), smallJson);

		// 6. Cache-Control: no-transform, SSE, JPEG covers, precompressed static assets, 206, 304, 204.
		const noTransform = await rawRequest(port, '/no-transform', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(noTransform.headers['content-encoding'], undefined);
		assert.equal(noTransform.headers['etag'], '"raw-tag"');
		assert.equal(noTransform.body.toString('utf8'), largeJson);

		const sse = await rawRequest(port, '/sse', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(sse.headers['content-encoding'], undefined);
		assert.match(sse.body.toString('utf8'), /^data: event-payload-/);

		const cover = await rawRequest(port, '/cover.jpg', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(cover.headers['content-encoding'], undefined);
		assert.equal(cover.headers['cache-control'], 'private, no-store');
		assert.equal(cover.headers['vary'], undefined);
		assert.deepEqual(cover.body, jpegBytes);

		const staticBr = await rawRequest(port, '/static.js.br', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(staticBr.headers['content-encoding'], 'br');
		assert.equal(staticBr.headers['etag'], '"asset.br"');
		assert.equal(Number(staticBr.headers['content-length']), precompressedBr.byteLength);
		assert.deepEqual(staticBr.body, precompressedBr);

		const staticGz = await rawRequest(port, '/static.js.gz', {
			headers: { 'Accept-Encoding': 'gzip' }
		});
		assert.equal(staticGz.headers['content-encoding'], 'gzip');
		assert.deepEqual(staticGz.body, precompressedGz);

		const partial = await rawRequest(port, '/partial', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(partial.status, 206);
		assert.equal(partial.headers['content-encoding'], undefined);

		const notModified = await rawRequest(port, '/not-modified', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(notModified.status, 304);
		assert.equal(notModified.headers['content-encoding'], undefined);
		assert.equal(notModified.body.byteLength, 0);

		const noContent = await rawRequest(port, '/no-content', {
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(noContent.status, 204);
		assert.equal(noContent.headers['content-encoding'], undefined);
		assert.equal(noContent.body.byteLength, 0);

		// 7. HEAD request returns 200 with zero body bytes and does not hang.
		const headHtml = await rawRequest(port, '/html', {
			method: 'HEAD',
			headers: { 'Accept-Encoding': 'br, gzip' }
		});
		assert.equal(headHtml.status, 200);
		assert.equal(headHtml.headers['content-encoding'], undefined);
		assert.equal(headHtml.headers['vary'], 'Origin, Accept-Encoding');
		assert.equal(headHtml.body.byteLength, 0);

		// 8. Multi-megabyte streaming response forwards drain events without stalling.
		const drained = await rawRequest(port, '/large-drain', {
			headers: { 'Accept-Encoding': 'br' }
		});
		assert.equal(drained.status, 200);
		assert.equal(drained.headers['content-encoding'], 'br');
		const parsedDrained = JSON.parse(
			brotliDecompressSync(drained.body).toString('utf8')
		) as unknown[];
		assert.equal(parsedDrained.length, 24);

		// 9. Early client socket close destroys the active zlib compressor stream.
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			startAbortStream = () => {
				// Wait until client receives headers/first chunk, or destroy from client side.
			};
			const req = httpRequest(
				{
					hostname: '127.0.0.1',
					port,
					path: '/abort-stream',
					headers: { 'Accept-Encoding': 'br' }
				},
				(res) => {
					res.once('readable', () => {
						req.destroy();
					});
					req.destroy();
				}
			);
			req.on('error', () => {
				// Expected socket reset after client destroy.
			});
			req.on('close', () => {
				setTimeout(() => {
					if (settled) return;
					settled = true;
					try {
						assert.ok(capturedAbortCompressor, 'compressor stream was created');
						assert.equal(capturedAbortCompressor.destroyed, true);
						resolve();
					} catch (error) {
						reject(error);
					}
				}, 50);
			});
			req.end();
		});

		// Unit check for appendVaryAcceptEncoding with Vary: *.
		const fakeHeaders = new Map<string, string>([['vary', '*']]);
		appendVaryAcceptEncoding({
			getHeader: (name: string) => fakeHeaders.get(name.toLowerCase()),
			setHeader: (name: string, value: string) => {
				fakeHeaders.set(name.toLowerCase(), value);
			}
		} as never);
		assert.equal(fakeHeaders.get('vary'), '*');
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
