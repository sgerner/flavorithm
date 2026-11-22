import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
	constants as zlibConstants,
	createBrotliCompress,
	createDeflate,
	createGzip
} from 'node:zlib';

const MIN_COMPRESS_BYTES = 1024;
const SUPPORTED_ENCODINGS = /** @type {const} */ (['br', 'gzip', 'deflate']);
const QVALUE_PATTERN = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;

/**
 * @typedef {(typeof SUPPORTED_ENCODINGS)[number]} ContentCoding
 */

/**
 * Negotiates the preferred response content-coding from `Accept-Encoding`.
 * Prefers `br`, then `gzip`, then `deflate` when quality weights tie.
 *
 * @param {string | string[] | undefined} acceptEncodingHeader
 * @returns {ContentCoding | null}
 */
export function negotiateEncoding(acceptEncodingHeader) {
	if (!acceptEncodingHeader) return null;
	const raw = Array.isArray(acceptEncodingHeader)
		? acceptEncodingHeader.join(', ')
		: acceptEncodingHeader;
	if (!raw.trim()) return null;

	/** @type {Map<string, number>} */
	const weights = new Map();
	for (const part of raw.split(',')) {
		const [rawCoding, ...params] = part.split(';');
		const coding = rawCoding.trim().toLowerCase();
		if (!coding) continue;
		let weight = 1;
		for (const param of params) {
			const eqIndex = param.indexOf('=');
			const name = (eqIndex === -1 ? param : param.slice(0, eqIndex)).trim().toLowerCase();
			if (name === 'q') {
				const value = eqIndex === -1 ? '' : param.slice(eqIndex + 1).trim();
				weight = QVALUE_PATTERN.test(value) ? Number(value) : 0;
			}
		}
		weights.set(coding, weight);
	}

	/** @type {ContentCoding | null} */
	let bestEncoding = null;
	let bestWeight = 0;
	for (const encoding of SUPPORTED_ENCODINGS) {
		const weight = weights.get(encoding) ?? weights.get('*') ?? 0;
		if (weight > bestWeight) {
			bestWeight = weight;
			bestEncoding = encoding;
		}
	}
	return bestEncoding;
}

/**
 * Checks whether a `Content-Type` header represents a compressible media type.
 *
 * @param {string | number | readonly string[] | undefined} contentTypeHeader
 * @returns {boolean}
 */
export function isCompressibleContentType(contentTypeHeader) {
	if (contentTypeHeader === undefined) return false;
	const raw = Array.isArray(contentTypeHeader)
		? String(contentTypeHeader[0] ?? '')
		: String(contentTypeHeader);
	const essence = raw.split(';', 1)[0].trim().toLowerCase();
	if (!essence) return false;
	if (essence.startsWith('text/')) {
		return essence !== 'text/event-stream';
	}
	if (
		essence === 'application/json' ||
		essence === 'application/javascript' ||
		essence === 'application/xml' ||
		essence === 'application/manifest+json' ||
		essence === 'image/svg+xml'
	) {
		return true;
	}
	return /^application\/[^/]+\+(?:json|xml)$/.test(essence);
}

/**
 * @param {string | number | readonly string[] | undefined} cacheControlHeader
 * @returns {boolean}
 */
function hasNoTransform(cacheControlHeader) {
	if (cacheControlHeader === undefined) return false;
	const raw = Array.isArray(cacheControlHeader)
		? cacheControlHeader.join(',')
		: String(cacheControlHeader);
	return raw
		.split(',')
		.some((directive) => directive.trim().split('=', 1)[0].trim().toLowerCase() === 'no-transform');
}

/**
 * Appends `Accept-Encoding` to `Vary` without duplicating tokens.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function appendVaryAcceptEncoding(res) {
	const existing = res.getHeader('vary');
	if (existing === undefined) {
		res.setHeader('Vary', 'Accept-Encoding');
		return;
	}
	const tokens = (Array.isArray(existing) ? existing.join(',') : String(existing))
		.split(',')
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) {
		res.setHeader('Vary', 'Accept-Encoding');
		return;
	}
	if (tokens.some((token) => token === '*' || token.toLowerCase() === 'accept-encoding')) {
		return;
	}
	res.setHeader('Vary', `${tokens.join(', ')}, Accept-Encoding`);
}

/**
 * Appends `-${encoding}` inside strong quoted ETags, leaving weak `W/` tags untouched.
 *
 * @param {string} etagHeader
 * @param {ContentCoding} encoding
 * @returns {string}
 */
export function suffixStrongEtag(etagHeader, encoding) {
	const trimmed = etagHeader.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		const inner = trimmed.slice(1, -1);
		const suffix = `-${encoding}`;
		if (!inner.endsWith(suffix)) {
			return `"${inner}${suffix}"`;
		}
	}
	return etagHeader;
}

/**
 * @param {ContentCoding} encoding
 * @returns {import('node:stream').Transform}
 */
function createCompressor(encoding) {
	if (encoding === 'br') {
		return createBrotliCompress({
			params: {
				[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
				[zlibConstants.BROTLI_PARAM_QUALITY]: 4
			}
		});
	}
	return encoding === 'gzip' ? createGzip() : createDeflate();
}

/**
 * Instruments an `http.ServerResponse` to dynamically compress eligible responses.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ onCompressor?: (stream: import('node:stream').Transform) => void }} [options]
 */
export function withDynamicCompression(req, res, options) {
	const rawWriteHead = res.writeHead.bind(res);
	const rawFlushHeaders = res.flushHeaders.bind(res);
	const rawWrite = res.write.bind(res);
	const rawEnd = res.end.bind(res);

	/** @type {import('node:stream').Transform | null} */
	let compressor = null;
	let prepared = false;
	let ended = false;

	/**
	 * @param {number} [implicitByteLength]
	 */
	function prepareHeaders(implicitByteLength) {
		if (prepared || res.headersSent) return;
		prepared = true;

		const status = res.statusCode;
		if (
			(status >= 100 && status < 200) ||
			status === 204 ||
			status === 205 ||
			status === 206 ||
			status === 304
		) {
			return;
		}

		if (hasNoTransform(res.getHeader('cache-control'))) return;

		const existingEncoding = res.getHeader('content-encoding');
		if (existingEncoding !== undefined && String(existingEncoding).trim() !== '') return;
		if (res.hasHeader('content-range')) return;

		if (!isCompressibleContentType(res.getHeader('content-type'))) return;

		appendVaryAcceptEncoding(res);

		if (req.method === 'HEAD') return;

		const rawLength = res.getHeader('content-length');
		if (rawLength !== undefined) {
			const parsedLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
			if (Number.isFinite(parsedLength) && parsedLength < MIN_COMPRESS_BYTES) return;
		} else if (implicitByteLength !== undefined && implicitByteLength < MIN_COMPRESS_BYTES) {
			return;
		}

		const encoding = negotiateEncoding(req.headers['accept-encoding']);
		if (!encoding) return;

		res.setHeader('Content-Encoding', encoding);
		res.removeHeader('Content-Length');
		res.removeHeader('Accept-Ranges');

		const etag = res.getHeader('etag');
		if (typeof etag === 'string') {
			res.setHeader('ETag', suffixStrongEtag(etag, encoding));
		}

		const stream = createCompressor(encoding);
		compressor = stream;
		options?.onCompressor?.(stream);

		const onResDrain = () => {
			if (!stream.destroyed) stream.resume();
		};
		const cleanupListeners = () => {
			res.off('drain', onResDrain);
			res.off('close', onResClose);
		};
		const onResClose = () => {
			cleanupListeners();
			if (!stream.destroyed) stream.destroy();
		};

		res.on('drain', onResDrain);
		res.once('close', onResClose);

		stream.on('data', (chunk) => {
			if (!res.destroyed && !rawWrite(chunk)) {
				stream.pause();
			}
		});

		stream.on('drain', () => {
			if (!res.destroyed && !res.writableNeedDrain) {
				res.emit('drain');
			}
		});

		stream.on('error', (err) => {
			cleanupListeners();
			if (!res.destroyed) res.destroy(err);
		});

		stream.once('end', cleanupListeners);

		if (res.destroyed) {
			onResClose();
		}
	}

	/**
	 * @param {number} statusCode
	 * @param {string | import('node:http').OutgoingHttpHeaders | import('node:http').OutgoingHttpHeader[]} [statusMessageOrHeaders]
	 * @param {import('node:http').OutgoingHttpHeaders | import('node:http').OutgoingHttpHeader[]} [maybeHeaders]
	 */
	res.writeHead = function writeHead(statusCode, statusMessageOrHeaders, maybeHeaders) {
		/** @type {string | undefined} */
		let statusMessage;
		/** @type {import('node:http').OutgoingHttpHeaders | import('node:http').OutgoingHttpHeader[] | undefined} */
		let headers;
		if (typeof statusMessageOrHeaders === 'string') {
			statusMessage = statusMessageOrHeaders;
			headers = maybeHeaders;
		} else {
			headers = statusMessageOrHeaders;
		}
		res.statusCode = statusCode;
		if (headers) {
			if (Array.isArray(headers)) {
				if (Array.isArray(headers[0])) {
					for (const pair of /** @type {Array<[string, import('node:http').OutgoingHttpHeader]>} */ (
						headers
					)) {
						const val = pair[1];
						if (val !== undefined) {
							res.appendHeader(pair[0], typeof val === 'number' ? String(val) : val);
						}
					}
				} else {
					const flat = /** @type {import('node:http').OutgoingHttpHeader[]} */ (headers);
					for (let i = 0; i + 1 < flat.length; i += 2) {
						const key = String(flat[i]);
						const val = flat[i + 1];
						if (val !== undefined) {
							res.appendHeader(key, typeof val === 'number' ? String(val) : val);
						}
					}
				}
			} else {
				for (const [key, value] of Object.entries(headers)) {
					if (value !== undefined) res.setHeader(key, value);
				}
			}
		}
		prepareHeaders();
		return statusMessage !== undefined
			? rawWriteHead(statusCode, statusMessage)
			: rawWriteHead(statusCode);
	};

	res.flushHeaders = function flushHeaders() {
		prepareHeaders();
		rawFlushHeaders();
	};

	res.write = /** @type {typeof res.write} */ (
		/**
		 * @param {unknown} chunk
		 * @param {BufferEncoding | ((error: Error | null | undefined) => void)} [encodingOrCb]
		 * @param {(error: Error | null | undefined) => void} [maybeCb]
		 */
		function write(chunk, encodingOrCb, maybeCb) {
			if (!prepared && !res.headersSent) {
				prepareHeaders();
			}
			if (!compressor) {
				if (typeof encodingOrCb === 'function') {
					return rawWrite(chunk, encodingOrCb);
				}
				if (encodingOrCb !== undefined) {
					return maybeCb ? rawWrite(chunk, encodingOrCb, maybeCb) : rawWrite(chunk, encodingOrCb);
				}
				return maybeCb ? rawWrite(chunk, maybeCb) : rawWrite(chunk);
			}
			if (ended || compressor.destroyed || res.destroyed) {
				return false;
			}
			/** @type {boolean} */
			let ok;
			if (typeof encodingOrCb === 'function') {
				ok = compressor.write(chunk, encodingOrCb);
			} else if (encodingOrCb !== undefined) {
				ok = maybeCb
					? compressor.write(chunk, encodingOrCb, maybeCb)
					: compressor.write(chunk, encodingOrCb);
			} else {
				ok = maybeCb ? compressor.write(chunk, maybeCb) : compressor.write(chunk);
			}
			return ok && !res.writableNeedDrain;
		}
	);

	res.end = /** @type {typeof res.end} */ (
		/**
		 * @param {unknown} [chunkOrCb]
		 * @param {BufferEncoding | (() => void)} [encodingOrCb]
		 * @param {() => void} [maybeCb]
		 */
		function end(chunkOrCb, encodingOrCb, maybeCb) {
			let chunk = chunkOrCb;
			/** @type {BufferEncoding | undefined} */
			let encoding;
			/** @type {(() => void) | undefined} */
			let callback = maybeCb;
			if (typeof chunk === 'function') {
				callback = /** @type {() => void} */ (chunk);
				chunk = undefined;
			} else if (typeof encodingOrCb === 'function') {
				callback = encodingOrCb;
			} else {
				encoding = encodingOrCb;
			}

			if (!prepared && !res.headersSent) {
				/** @type {number | undefined} */
				let implicitLength;
				if (chunk === undefined || chunk === null) {
					implicitLength = 0;
				} else if (typeof chunk === 'string') {
					implicitLength = Buffer.byteLength(chunk, encoding);
				} else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
					implicitLength = chunk.byteLength;
				}
				prepareHeaders(implicitLength);
			}

			if (!compressor) {
				if (chunk === undefined) return callback ? rawEnd(callback) : rawEnd();
				if (encoding === undefined) return callback ? rawEnd(chunk, callback) : rawEnd(chunk);
				return callback ? rawEnd(chunk, encoding, callback) : rawEnd(chunk, encoding);
			}

			if (ended) {
				if (callback) callback();
				return res;
			}
			ended = true;
			if (compressor.destroyed || res.destroyed) {
				return res;
			}
			const activeStream = compressor;
			activeStream.once('end', () => {
				if (!res.destroyed) {
					if (callback) rawEnd(callback);
					else rawEnd();
				}
			});
			if (chunk !== undefined && chunk !== null) {
				if (encoding !== undefined) activeStream.end(chunk, encoding);
				else activeStream.end(chunk);
			} else {
				activeStream.end();
			}
			return res;
		}
	);
}

async function startServer() {
	// Database and OAuth key files are private to the service account by default.
	process.umask(0o077);

	const port = Number(process.env.PORT || 3000);
	const host = process.env.HOST || '0.0.0.0';
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('PORT must be between 1 and 65535.');
	const configuredOrigin = new URL(process.env.ORIGIN || `http://localhost:${port}`);
	if (
		!['https:', 'http:'].includes(configuredOrigin.protocol) ||
		configuredOrigin.username ||
		configuredOrigin.password ||
		configuredOrigin.pathname !== '/' ||
		configuredOrigin.search ||
		configuredOrigin.hash
	) {
		throw new Error('ORIGIN must be an HTTP(S) origin, without a path or credentials.');
	}
	// Adapter-node 6 reads the origin from headers. Pin internal headers to our
	// runtime configuration instead of trusting arbitrary forwarded client values.
	process.env.ORIGIN = configuredOrigin.origin;
	process.env.PROTOCOL_HEADER = 'x-flavorithm-protocol';
	process.env.HOST_HEADER = 'x-flavorithm-host';
	process.env.PORT_HEADER = '';
	process.env.BODY_SIZE_LIMIT ||= '10M';
	const handlerModulePath = './build/handler.js';
	const { handler } = await import(handlerModulePath);
	const server = createServer((req, res) => {
		req.headers['x-flavorithm-protocol'] = configuredOrigin.protocol.slice(0, -1);
		req.headers['x-flavorithm-host'] = configuredOrigin.host;
		// Do not let an untrusted forwarded-proto header affect cookie/security logic.
		req.headers['x-forwarded-proto'] = configuredOrigin.protocol.slice(0, -1);
		withDynamicCompression(req, res);
		Promise.resolve(handler(req, res)).catch(() => {
			if (!res.headersSent) {
				const message = 'The kitchen is temporarily unavailable.';
				res.writeHead(500, {
					'Content-Type': 'text/plain',
					'Content-Length': Buffer.byteLength(message)
				});
				res.end(message);
			} else res.destroy();
		});
	});
	server.headersTimeout = 20_000;
	server.requestTimeout = 60_000;
	server.listen(port, host, () =>
		console.log(`Flavorithm listening at ${configuredOrigin.origin}`)
	);
	function shutdown() {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 10_000).unref();
	}
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

function isEntrypoint() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntrypoint()) {
	await startServer();
}
