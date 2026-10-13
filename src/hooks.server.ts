import { redirect } from '@sveltejs/kit';
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
// Security headers (nosniff, Referrer-Policy, X-Frame-Options, X-Robots-Tag) are set by
// server.js on every response, including the ones Kit answers without calling this hook; the
// CSP comes from Kit (vite.config.ts).

function plain(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
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
	// Kit answers a redirect() thrown here with a 303, or in the JSON form its client expects for
	// data, remote and form-action requests.
	switch (decision.action) {
		case 'deny':
			return plain(decision.status, decision.message);
		case 'login':
			redirect(303, `/login?next=${nextParam(url)}`);
		case 'admin-login':
			redirect(303, `/admin/login?next=${nextParam(url)}`);
		case 'name':
			redirect(303, `/name?next=${nextParam(url)}`);
	}

	// Sliding renewal of the 400-day cookie (only on requests that go through to the app, so the
	// Set-Cookie isn't lost on a response this hook builds itself).
	if (access?.stale) issueAccess(cookies, url, access.role);

	return resolve(event);
};
