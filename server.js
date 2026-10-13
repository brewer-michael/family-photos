// Production entry: `node server.js` (Docker CMD). Wraps adapter-node's build/handler.js.
//
// Why not build/index.js: adapter-node derives the request origin from PROTOCOL_HEADER
// and otherwise assumes https. On plain HTTP (LAN access, e2e tests) that breaks
// SvelteKit's CSRF origin check for form actions and tus POSTs. So we:
//   1. default PROTOCOL_HEADER=x-forwarded-proto (before the handler module reads env),
//   2. fill x-forwarded-proto from the socket when a proxy didn't set it,
//   3. keep connections alive longer than common proxies (65 s) and shut down gracefully,
//      letting the app stop its worker lanes (globalThis[Symbol.for('family-photos.shutdown')]).
// It also sets the security headers on every response (see SECURITY_HEADERS).
import http from 'node:http';
import process from 'node:process';

process.env.PROTOCOL_HEADER ||= 'x-forwarded-proto';
process.env.BODY_SIZE_LIMIT ||= '64M';

const protocolHeader = process.env.PROTOCOL_HEADER.toLowerCase();
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT || 30) * 1000;

// Set before the handler runs, so they are on every response: pages and endpoints, static files,
// and the ones SvelteKit answers before the app's `handle` hook runs or outside it (trailing-slash
// 308s, CSRF 403s, redirects thrown from the hook, 404s). Kit's CSP adds frame-ancestors 'none'
// to pages (vite.config.ts); X-Frame-Options covers everything else.
const SECURITY_HEADERS = {
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'x-frame-options': 'DENY',
	'x-robots-tag': 'noindex, nofollow'
};

/** @type {(req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void} */
let handler;
try {
	// Top-level await in handler.js runs the app's `init` hook (config validation, migrations,
	// worker lanes). A ConfigError prints a readable list of what to fix.
	// Not a string literal on purpose: the file only exists after `npm run build`, and type
	// checkers must not pull the generated bundle into the program.
	const handlerUrl = new URL('./build/handler.js', import.meta.url).href;
	({ handler } = await import(handlerUrl));
} catch (err) {
	const e = /** @type {any} */ (err);
	if (e && e.name === 'ConfigError') {
		if (!e.logged) console.error(`\n${e.message}\n`);
	} else {
		console.error('Family Photos failed to start:', e);
	}
	process.exit(1);
}

const server = http.createServer((req, res) => {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
	const raw = req.headers[protocolHeader];
	const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim().toLowerCase();
	if (first === 'http' || first === 'https') {
		req.headers[protocolHeader] = first;
	} else {
		// No (or a malformed) header: we were reached directly, so the socket tells the truth.
		req.headers[protocolHeader] = /** @type {import('node:tls').TLSSocket} */ (req.socket).encrypted ? 'https' : 'http';
	}
	handler(req, res, () => {
		res.statusCode = 404;
		res.end('Not found');
	});
});

// Longer than Cloudflare/NPM upstream keep-alive so proxies never reuse a closed socket.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
// A 50 MiB tus chunk on a slow uplink can take many minutes; tus resumes anyway.
server.requestTimeout = 60 * 60_000;

server.listen({ host, port }, () => {
	const addr = server.address();
	const shown = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
	console.log(`Family Photos listening on http://${shown}`);
});

let stopping = false;
/** @param {string} signal */
async function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	console.log(`${signal} received, shutting down…`);
	const force = setTimeout(() => {
		server.closeAllConnections();
	}, shutdownTimeoutMs);
	force.unref();
	server.closeIdleConnections();
	await new Promise((resolve) => server.close(() => resolve(undefined)));
	// adapter-node's own entry emits this; the app listens for it (and so may other code).
	/** @type {any} */ (process).emit('sveltekit:shutdown', signal);
	const appShutdown = /** @type {any} */ (globalThis)[Symbol.for('family-photos.shutdown')];
	try {
		if (typeof appShutdown === 'function') await appShutdown();
	} catch (e) {
		console.error('Error during shutdown:', e);
	}
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
