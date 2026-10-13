import { describe, expect, it } from 'vitest';
import { decodePathname, gate, normalizeRouteId, type GateInput } from '#lib/server/gate';

const req = (over: Partial<GateInput>): GateInput => ({
	routeId: '/',
	rawPath: '/',
	method: 'GET',
	isRemote: false,
	role: null,
	hasName: false,
	...over
});
const family = { role: 'family' as const, hasName: true };
const admin = { role: 'admin' as const, hasName: true };

describe('gate()', () => {
	it('lets anyone reach the public routes only', () => {
		for (const [routeId, rawPath] of [
			['/login', '/login'],
			['/healthz', '/healthz'],
			['/admin/login', '/admin/login'],
			['/join/[token]', '/join/abc'],
			['/admin/login', '/admin/%6cogin']
		]) {
			expect(gate(req({ routeId, rawPath })), rawPath).toEqual({ action: 'allow' });
		}
		expect(gate(req({ routeId: '/', rawPath: '/' }))).toEqual({ action: 'login' });
		expect(gate(req({ routeId: '/album/[id]', rawPath: '/album/1' }))).toEqual({ action: 'login' });
		expect(gate(req({ routeId: '/album/[id]', rawPath: '/album/1/__data.json' }))).toEqual({ action: 'login' });
	});

	it('treats unmatched paths as protected (no prefix allow-list to trick)', () => {
		for (const rawPath of ['/_app/x', '/icons/..%2Falbum/1', '/robots.txt', '/favicon.ico', '/join', '/nope']) {
			expect(gate(req({ routeId: null, rawPath })), rawPath).toEqual({ action: 'login' });
		}
	});

	it('answers 401 for API-like requests without access', () => {
		const deny = { action: 'deny', status: 401, message: 'Please sign in first' };
		expect(gate(req({ routeId: '/api/status', rawPath: '/api/status' }))).toEqual(deny);
		expect(gate(req({ routeId: '/media/[id]/[variant]', rawPath: '/media/x/thumb' }))).toEqual(deny);
		expect(gate(req({ routeId: null, rawPath: '/%61pi/nothing' }))).toEqual(deny);
	});

	it('never treats remote function calls as public, whatever route their header claims', () => {
		const deny = { action: 'deny', status: 401, message: 'Please sign in first' };
		expect(gate(req({ isRemote: true, routeId: '/login', rawPath: '/_app/remote/abc/q' }))).toEqual(deny);
		expect(gate(req({ isRemote: true, routeId: null, rawPath: '/_app/remote/abc/q' }))).toEqual(deny);
		expect(gate(req({ ...family, hasName: false, isRemote: true, routeId: null, rawPath: '/_app/remote/abc/q', method: 'POST' }))).toEqual({
			action: 'allow'
		});
		// A family member claiming an admin page in x-sveltekit-pathname is refused.
		expect(gate(req({ ...family, isRemote: true, routeId: '/admin', rawPath: '/_app/remote/abc/q' }))).toMatchObject({ status: 403 });
	});

	it('gates the admin area on the routed id, so percent-encoding cannot bypass it', () => {
		const cases: [string | null, string][] = [
			['/admin', '/admin'],
			['/admin', '/%61dmin'],
			['/admin', '/adm%69n'],
			['/admin', '/%61%64%6D%69%6E'],
			['/admin/requests/[id]', '/%61dmin/requests/5'],
			[null, '/%61dmin/x'],
			[null, '/admin/x'],
			['/admin', '/admin/__data.json'],
			['/(app)/admin', '/admin']
		];
		for (const [routeId, rawPath] of cases) {
			expect(gate(req({ ...family, routeId, rawPath })), rawPath).toEqual({ action: 'admin-login' });
			expect(gate(req({ ...family, routeId, rawPath, method: 'POST' })), rawPath).toMatchObject({ action: 'deny', status: 403 });
			expect(gate(req({ ...admin, routeId, rawPath })), rawPath).toEqual({ action: 'allow' });
		}
		// look-alikes outside the admin area are not admin
		expect(gate(req({ ...family, routeId: null, rawPath: '/administrator' }))).toEqual({ action: 'allow' });
		expect(gate(req({ ...family, routeId: null, rawPath: '/admin%2Fx' }))).toEqual({ action: 'allow' });
	});

	it('admin pages redirect GETs to the admin login and refuse other methods with 403', () => {
		expect(gate(req({ ...family, routeId: '/admin/original/[id]', rawPath: '/admin/original/1' }))).toEqual({ action: 'admin-login' });
		expect(gate(req({ ...family, routeId: '/admin/logout', rawPath: '/admin/logout', method: 'POST' }))).toMatchObject({ status: 403 });
	});

	it('asks for a name before anything but the name page, admin logout and API calls', () => {
		const nameless = { role: 'family' as const, hasName: false };
		expect(gate(req({ ...nameless, routeId: '/', rawPath: '/' }))).toEqual({ action: 'name' });
		expect(gate(req({ ...nameless, routeId: '/name', rawPath: '/name' }))).toEqual({ action: 'allow' });
		expect(gate(req({ ...nameless, routeId: '/name', rawPath: '/n%61me' }))).toEqual({ action: 'allow' });
		expect(gate(req({ ...nameless, routeId: '/api/upload/[...path]', rawPath: '/api/upload/x', method: 'PATCH' }))).toEqual({
			action: 'allow'
		});
		expect(gate(req({ role: 'admin', hasName: false, routeId: '/admin/logout', rawPath: '/admin/logout', method: 'POST' }))).toEqual({
			action: 'allow'
		});
		expect(gate(req({ role: 'admin', hasName: false, routeId: '/admin', rawPath: '/admin' }))).toEqual({ action: 'name' });
	});

	it('copes with malformed escapes', () => {
		expect(gate(req({ routeId: null, rawPath: '/%E0%A4%A' }))).toEqual({ action: 'login' });
		expect(gate(req({ ...family, routeId: null, rawPath: '/%E0%A4%A' }))).toEqual({ action: 'allow' }); // Kit answers 400
	});
});

describe('helpers', () => {
	it('decodePathname matches SvelteKit (keeps %25 and reserved escapes)', () => {
		expect(decodePathname('/%61dmin')).toBe('/admin');
		expect(decodePathname('/a%2Fb')).toBe('/a%2Fb');
		expect(decodePathname('/100%25')).toBe('/100%25');
		expect(() => decodePathname('/%E0%A4%A')).toThrow();
	});

	it('normalizeRouteId drops layout groups', () => {
		expect(normalizeRouteId('/(app)/admin/(x)/trash')).toBe('/admin/trash');
		expect(normalizeRouteId('/(app)')).toBe('/');
		expect(normalizeRouteId('/join/[token]')).toBe('/join/[token]');
		expect(normalizeRouteId(null)).toBeNull();
	});
});
