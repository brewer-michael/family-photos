/**
 * The access gate used by hooks.server.ts, as a pure function so it can be unit-tested.
 *
 * It decides on what SvelteKit actually routes to, not on the raw request path:
 *   - `routeId` is event.route.id, which Kit sets before `handle` runs from the *decoded*
 *     pathname. So /%61dmin, /adm%69n and /admin are all route '/admin'.
 *   - `rawPath` is the real request path from `new URL(event.request.url).pathname`. It is
 *     decoded with Kit's own rule and checked as well (defence in depth for unmatched paths
 *     such as /%61dmin/x).
 *
 * Remote functions (/_app/remote/…, `*.remote.ts`) are never public. Kit resolves their route
 * from the client-controlled `x-sveltekit-pathname` header, so the route id of a remote call
 * proves nothing: every remote call needs family access, and a remote function that does
 * admin-only work must check `getRequestEvent().locals.role === 'admin'` itself.
 */
import type { Role } from './auth';

/** Route ids reachable without the family code. Everything else (including no route) is protected. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/login', '/healthz', '/admin/login', '/join/[token]']);

/** Route ids reachable with access but before choosing a name (API-like routes are always allowed). */
export const NAMELESS_ROUTES: ReadonlySet<string> = new Set(['/name', '/admin/logout']);

export interface GateInput {
	/** event.route.id (null when no route matched). */
	routeId: string | null;
	/** Real request path, still percent-encoded: new URL(event.request.url).pathname. */
	rawPath: string;
	method: string;
	/** event.isRemoteRequest */
	isRemote: boolean;
	role: Role | null;
	hasName: boolean;
}

export type GateDecision =
	| { action: 'allow' }
	| { action: 'login' }
	| { action: 'admin-login' }
	| { action: 'name' }
	| { action: 'deny'; status: 401 | 403; message: string };

/** SvelteKit's own pathname decoding (decodeURI per '%25'-separated part). Throws on malformed input. */
export function decodePathname(pathname: string): string {
	return pathname.split('%25').map(decodeURI).join('%25');
}

/** Route id without layout groups: '/(app)/admin/(x)/trash' → '/admin/trash'. */
export function normalizeRouteId(id: string | null | undefined): string | null {
	if (id === null || id === undefined) return null;
	return id.replace(/\/\([^/)]+\)/g, '') || '/';
}

function isUnder(path: string | null, prefix: string): boolean {
	return path !== null && (path === prefix || path.startsWith(prefix + '/'));
}

export function gate(input: GateInput): GateDecision {
	const rid = normalizeRouteId(input.routeId);
	let decoded: string;
	try {
		decoded = decodePathname(input.rawPath);
	} catch {
		decoded = input.rawPath; // Kit answers 400 Malformed URI; still gate it like any other path
	}

	if (!input.isRemote && rid !== null && PUBLIC_ROUTES.has(rid)) return { action: 'allow' };

	const apiLike =
		input.isRemote ||
		isUnder(rid, '/api') ||
		isUnder(rid, '/media') ||
		isUnder(decoded, '/api') ||
		isUnder(decoded, '/media');

	if (!input.role) {
		return apiLike ? { action: 'deny', status: 401, message: 'Please sign in first' } : { action: 'login' };
	}

	const adminArea = isUnder(rid, '/admin') || isUnder(decoded, '/admin');
	if (adminArea && input.role !== 'admin') {
		const pageNavigation = (input.method === 'GET' || input.method === 'HEAD') && !apiLike;
		return pageNavigation ? { action: 'admin-login' } : { action: 'deny', status: 403, message: 'Admins only' };
	}

	if (!input.hasName && !apiLike && !(rid !== null && NAMELESS_ROUTES.has(rid))) {
		return { action: 'name' };
	}
	return { action: 'allow' };
}

// ---------------------------------------------------------------------------
// Request body size
// ---------------------------------------------------------------------------

/**
 * Largest request body anything but a tus upload may send. BODY_SIZE_LIMIT (64M) is only there for
 * 50 MiB upload chunks; every form here (a memory is at most 5000 characters) fits in far less.
 * Without this, anyone could make the sign-in pages buffer and parse 64 MB form posts, a few dozen
 * at once, before any check.
 */
export const SMALL_BODY_LIMIT = 256 * 1024;

/** Whether this request may send a body over SMALL_BODY_LIMIT: tus uploads only (never a remote call). */
export function allowsLargeBody(routeId: string | null, isRemote: boolean): boolean {
	return !isRemote && isUnder(normalizeRouteId(routeId), '/api/upload');
}

/**
 * Whether the request's body is over `limit` bytes, decided before anything reads it: by
 * Content-Length when sent (Node's parser holds the client to it), otherwise (chunked) by reading
 * a copy of the body up to the limit. The copy is a tee, so the original stays readable for the
 * action and at most `limit` plus one chunk is buffered.
 */
export async function bodyTooLarge(request: Request, limit: number = SMALL_BODY_LIMIT): Promise<boolean> {
	if (!request.body) return false;
	const declared = request.headers.get('content-length');
	if (declared !== null && declared.trim() !== '') {
		const n = Number(declared);
		return !Number.isSafeInteger(n) || n > limit;
	}
	const reader = request.clone().body!.getReader();
	let seen = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			seen += value.byteLength;
			if (seen > limit) return true;
		}
	} finally {
		reader.cancel().catch(() => undefined);
	}
}
