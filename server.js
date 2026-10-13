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
// Seconds requests in flight get to finish after SIGTERM before their connections are closed.
// Docker (and so Unraid) SIGKILLs a container 10 s after SIGTERM unless told otherwise, so the
// default leaves room to exit cleanly; tus uploads resume and players re-request ranges anyway.
const shutdownSeconds = Number(process.env.SHUTDOWN_TIMEOUT || 8);
const shutdownTimeoutMs = (Number.isFinite(shutdownSeconds) && shutdownSeconds >= 0 ? shutdownSeconds : 8) * 1000;

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

/** Time anything but a tus upload has to send its whole request (headers and body). */
const REQUEST_BODY_TIMEOUT_MS = 30_000;

/**
 * The tus upload route (/api/upload/…), by the path as the router will see it (dot segments
 * resolved, like `new URL` does for SvelteKit). A percent-encoded variant isn't matched and so
 * only gets the shorter timeout.
 * @param {string | undefined} url
 */
function isUploadPath(url) {
	try {
		const p = new URL(url ?? '/', 'http://x').pathname;
		return p === '/api/upload' || p.startsWith('/api/upload/');
	} catch {
		return false;
	}
}

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

let stopping = false;

const server = http.createServer((req, res) => {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
	// Shutting down: don't keep this connection alive for another request.
	if (stopping) res.setHeader('connection', 'close');
	// Only tus PATCHes need the long requestTimeout below; anything else must have sent its whole
	// request within REQUEST_BODY_TIMEOUT_MS, so a slowly trickled body can't hold a socket for an hour.
	if (!isUploadPath(req.url)) {
		const timer = setTimeout(() => {
			if (!req.complete) req.socket.destroy();
		}, REQUEST_BODY_TIMEOUT_MS);
		timer.unref();
		res.once('close', () => clearTimeout(timer));
	}
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

/**
 * SIGTERM/SIGINT. The app's own shutdown (stop intake, stop the worker lanes so their jobs go
 * back in the queue, close the database) starts at once, alongside the HTTP drain: waiting for a
 * slow request first would let Docker's SIGKILL (10 s) hit the lanes mid-job. Requests in flight
 * get SHUTDOWN_TIMEOUT seconds; a keep-alive connection that goes idle meanwhile is closed straight
 * away (server.close() alone leaves one that was busy when it was called open until the timeout).
 * The database reopens by itself if a draining request still needs it.
 * @param {string} signal
 */
async function shutdown(signal) {
	if (stopping) return;
	stopping = true;
	console.log(`${signal} received, shutting down…`);
	const appShutdown = /** @type {any} */ (globalThis)[Symbol.for('family-photos.shutdown')];
	const app = Promise.resolve()
		.then(() => (typeof appShutdown === 'function' ? appShutdown() : undefined))
		.catch((e) => console.error('Error during shutdown:', e));
	const force = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
	force.unref();
	// Last resort, e.g. intake still hashing a huge upload (its row stays `received` and is picked up
	// again on the next start). The lanes are stopped well before this (≤ 5 s).
	const deadline = setTimeout(() => {
		console.warn('Shutdown is taking too long; exiting now.');
		process.exit(0);
	}, Math.max(shutdownTimeoutMs, 6_000) + 1_500);
	deadline.unref();
	const idle = setInterval(() => server.closeIdleConnections(), 500);
	idle.unref();
	server.closeIdleConnections();
	const drained = new Promise((resolve) => server.close(() => resolve(undefined)));
	await Promise.all([drained, app]);
	clearInterval(idle);
	// adapter-node's own entry emits this; the app listens for it (and so may other code). The
	// app's shutdown is idempotent, so this doesn't run it twice.
	/** @type {any} */ (process).emit('sveltekit:shutdown', signal);
	process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
