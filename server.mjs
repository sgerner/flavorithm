import { createServer } from 'node:http';

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
const { handler } = await import('./build/handler.js');
const server = createServer((req, res) => {
	req.headers['x-flavorithm-protocol'] = configuredOrigin.protocol.slice(0, -1);
	req.headers['x-flavorithm-host'] = configuredOrigin.host;
	// Do not let an untrusted forwarded-proto header affect cookie/security logic.
	req.headers['x-forwarded-proto'] = configuredOrigin.protocol.slice(0, -1);
	Promise.resolve(handler(req, res)).catch(() => {
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'text/plain' });
			res.end('The kitchen is temporarily unavailable.');
		} else res.destroy();
	});
});
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;
server.listen(port, host, () => console.log(`Flavorithm listening at ${configuredOrigin.origin}`));
function shutdown() {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
