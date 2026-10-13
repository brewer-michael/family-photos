import { redirect, type RequestEvent } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { boot } from '#lib/server/boot';
import { issueAccess, readAccess, readDevice } from '#lib/server/auth';
import { gate } from '#lib/server/gate';

export const init: ServerInit = () => {
	if (!building) boot();
};

// Access rules live in #lib/server/gate (pure + unit-tested). It gates on event.route.id, i.e.
// what Kit actually routed to, so percent-encoded paths (/%61dmin) can't slip past it. Static
// files (build/client, static/) are served by adapter-node before this hook ever runs.

const SECURITY_HEADERS: Record<string, string> = {
	'x-robots-tag': 'noindex, nofollow',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin',
	'x-frame-options': 'DENY'
};

function withSecurityHeaders(response: Response): Response {
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
		if (!response.headers.has(k)) {
			try {
				response.headers.set(k, v);
			} catch {
				// immutable headers (e.g. a proxied fetch Response) — leave as is
			}
		}
	}
	return response;
}

function plain(status: number, message: string): Response {
	return withSecurityHeaders(
		new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
	);
}

/**
 * 303 to an auth page. Plain page navigations get a Response carrying the security headers;
 * data, remote and form-action requests get Kit's redirect() so Kit can answer in the JSON
 * form its client expects.
 */
function seeOther(event: RequestEvent, location: string): Response {
	const method = event.request.method;
	if ((method === 'GET' || method === 'HEAD') && !event.isDataRequest && !event.isRemoteRequest) {
		return withSecurityHeaders(new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } }));
	}
	redirect(303, location);
}

function nextParam(url: URL): string {
	return encodeURIComponent(url.pathname + url.search);
}

export const handle: Handle = async ({ event, resolve }) => {
	const { url, cookies, request } = event;

	// Defence in depth: never let a proxy/client tunnel another method through POST.
	if (request.headers.has('x-http-method-override')) {
		return plain(400, 'Method override is not allowed');
	}

	const access = readAccess(cookies);
	const device = readDevice(cookies);
	event.locals.role = access?.role ?? null;
	event.locals.deviceId = device?.d ?? null;
	event.locals.name = device?.n ?? null;

	const decision = gate({
		routeId: event.route.id,
		// event.url is rewritten by Kit for data and remote requests (for remote calls from a
		// client-controlled header), so gate on the path that was really requested.
		rawPath: new URL(request.url).pathname,
		method: request.method,
		isRemote: event.isRemoteRequest,
		role: event.locals.role,
		hasName: !!event.locals.name
	});
	switch (decision.action) {
		case 'deny':
			return plain(decision.status, decision.message);
		case 'login':
			return seeOther(event, `/login?next=${nextParam(url)}`);
		case 'admin-login':
			return seeOther(event, `/admin/login?next=${nextParam(url)}`);
		case 'name':
			return seeOther(event, `/name?next=${nextParam(url)}`);
	}

	// Sliding renewal of the 400-day cookie (only on requests that go through to the app, so the
	// Set-Cookie isn't lost on a response this hook builds itself).
	if (access?.stale) issueAccess(cookies, url, access.role);

	return withSecurityHeaders(await resolve(event));
};
