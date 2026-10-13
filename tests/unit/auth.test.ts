import { beforeEach, describe, expect, it } from 'vitest';
import {
	ACCESS_COOKIE,
	COOKIE_MAX_AGE_S,
	DEVICE_COOKIE,
	accessValue,
	checkAdminPassword,
	checkFamilyCode,
	cleanName,
	cookieOptions,
	currentJoinToken,
	issueAccess,
	issueDevice,
	joinUrl,
	newDeviceId,
	readAccess,
	readDevice,
	rotateAccess,
	safeNext,
	verifyAccess,
	verifyJoinToken
} from '#lib/server/auth';
import { b64url, hmac, joinToken, norm, signValue, verifyValue } from '#lib/server/crypto';
import { getSecret, getAccessGen } from '#lib/server/repo/settings';
import { freshDb, setEnv, TEST_ADMIN_PASSWORD, TEST_FAMILY_PASSWORD } from '../helpers/env';
import { FakeCookies } from '../helpers/cookies';

const http = new URL('http://photos.lan:3000/');
const https = new URL('https://photos.example.com/');

beforeEach(() => {
	setEnv({ FAMILY_PASSWORD: TEST_FAMILY_PASSWORD, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD });
	freshDb();
});

describe('norm()', () => {
	it('is forgiving about case, spacing and Unicode width', () => {
		expect(norm('  Blue  LAKE\tCabin \n')).toBe('blue lake cabin');
		expect(norm('ＢＬＵＥ　lake cabin')).toBe('blue lake cabin'); // full-width letters + ideographic space
		expect(norm('blue lake cabin')).toBe('blue lake cabin');
	});

	it('does not remove spaces between words', () => {
		expect(norm('bluelakecabin')).not.toBe(norm('blue lake cabin'));
	});

	it('checkFamilyCode accepts odd casing/spacing and rejects wrong codes', () => {
		expect(checkFamilyCode('  BLUE lake   Cabin')).toBe(true);
		expect(checkFamilyCode('blue lake')).toBe(false);
		expect(checkFamilyCode('')).toBe(false);
		expect(checkFamilyCode('x'.repeat(10_000))).toBe(false);
	});

	it('checkAdminPassword is exact apart from surrounding whitespace', () => {
		expect(checkAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
		expect(checkAdminPassword(` ${TEST_ADMIN_PASSWORD} `)).toBe(true);
		expect(checkAdminPassword(TEST_ADMIN_PASSWORD.toUpperCase())).toBe(false);
		expect(checkAdminPassword(TEST_FAMILY_PASSWORD)).toBe(false);
	});
});

describe('signed values', () => {
	const secret = 'a'.repeat(64);

	it('round-trips', () => {
		const v = signValue(secret, 'fp_test', { a: 1, b: 'x' });
		expect(verifyValue(secret, 'fp_test', v)).toEqual({ a: 1, b: 'x' });
	});

	it('rejects tampering with the body, the MAC, the name or the secret', () => {
		const v = signValue(secret, 'fp_test', { r: 'family' });
		const [body, mac] = v.split('.');
		const forged = b64url(Buffer.from(JSON.stringify({ r: 'admin' })));
		expect(verifyValue(secret, 'fp_test', `${forged}.${mac}`)).toBeNull();
		expect(verifyValue(secret, 'fp_test', `${body}.${mac.slice(0, -2)}AA`)).toBeNull();
		expect(verifyValue(secret, 'fp_other', v)).toBeNull();
		expect(verifyValue('b'.repeat(64), 'fp_test', v)).toBeNull();
	});

	it('rejects garbage', () => {
		for (const bad of [undefined, null, '', '.', 'abc', 'a.b.c', '%%%.%%%', 'x'.repeat(5000)]) {
			expect(verifyValue(secret, 'fp_test', bad)).toBeNull();
		}
	});
});

describe('fp_access', () => {
	it('issues HttpOnly, SameSite=Lax, 400-day cookies; Secure only over https', () => {
		const c = new FakeCookies();
		issueAccess(c.asCookies(), http, 'family');
		expect(c.options.get(ACCESS_COOKIE)).toMatchObject({
			httpOnly: true,
			sameSite: 'lax',
			path: '/',
			secure: false,
			maxAge: COOKIE_MAX_AGE_S
		});
		issueAccess(c.asCookies(), https, 'family');
		expect(c.options.get(ACCESS_COOKIE)).toMatchObject({ secure: true });
		expect(cookieOptions(https).secure).toBe(true);
		expect(COOKIE_MAX_AGE_S).toBe(400 * 86400);
	});

	it('accepts a valid family cookie and an admin cookie', () => {
		const c = new FakeCookies();
		issueAccess(c.asCookies(), http, 'family');
		expect(readAccess(c.asCookies())).toMatchObject({ role: 'family', stale: false });
		issueAccess(c.asCookies(), http, 'admin');
		expect(readAccess(c.asCookies())).toMatchObject({ role: 'admin' });
	});

	it('rejects a correctly signed cookie whose role does not match its tag', () => {
		const fam = verifyValue<{ r: string; v: string; iat: number }>(getSecret(), ACCESS_COOKIE, accessValue('family'))!;
		const promoted = signValue(getSecret(), ACCESS_COOKIE, { ...fam, r: 'admin' });
		expect(verifyAccess(promoted)).toBeNull();
	});

	it('rejects tampered cookies', () => {
		const v = accessValue('family');
		const [body, mac] = v.split('.');
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
		const forged = b64url(Buffer.from(JSON.stringify({ ...payload, r: 'admin' })));
		expect(verifyAccess(`${forged}.${mac}`)).toBeNull();
		expect(verifyAccess(v + 'x')).toBeNull();
	});

	it('marks cookies older than 7 days stale (sliding renewal) and expires them after 400 days', () => {
		const t0 = Date.now();
		const v = accessValue('family', t0);
		expect(verifyAccess(v, t0 + 6 * 86400_000)?.stale).toBe(false);
		expect(verifyAccess(v, t0 + 8 * 86400_000)?.stale).toBe(true);
		expect(verifyAccess(v, t0 + 401 * 86400_000)).toBeNull();
		expect(verifyAccess(accessValue('family', t0 + 3600_000), t0)).toBeNull(); // issued in the future
	});

	it('Reset access (gen++) invalidates family and admin cookies', () => {
		const fam = accessValue('family');
		const adm = accessValue('admin');
		const gen = getAccessGen();
		expect(rotateAccess()).toBe(gen + 1);
		expect(verifyAccess(fam)).toBeNull();
		expect(verifyAccess(adm)).toBeNull();
		expect(verifyAccess(accessValue('family'))).not.toBeNull();
	});

	it('changing FAMILY_PASSWORD invalidates every cookie, admin ones included (plan: "Revoking access")', () => {
		const fam = accessValue('family');
		const adm = accessValue('admin');
		setEnv({ FAMILY_PASSWORD: 'green forest lodge' });
		expect(verifyAccess(fam)).toBeNull();
		expect(verifyAccess(adm)).toBeNull();
		expect(verifyAccess(accessValue('admin'))).toMatchObject({ role: 'admin' });
	});

	it('changing only the spacing/case of FAMILY_PASSWORD keeps cookies valid', () => {
		const fam = accessValue('family');
		const adm = accessValue('admin');
		setEnv({ FAMILY_PASSWORD: '  Blue Lake  CABIN' });
		expect(verifyAccess(fam)).toMatchObject({ role: 'family' });
		expect(verifyAccess(adm)).toMatchObject({ role: 'admin' });
	});

	it('rotateAccess({cookies, url}) signs the admin who pressed Reset straight back in', () => {
		const c = new FakeCookies();
		issueAccess(c.asCookies(), http, 'admin');
		const before = c.jar.get(ACCESS_COOKIE)!;
		rotateAccess({ cookies: c.asCookies(), url: http });
		expect(verifyAccess(before)).toBeNull();
		expect(readAccess(c.asCookies())).toMatchObject({ role: 'admin' });
		expect(c.options.get(ACCESS_COOKIE)).toMatchObject({ httpOnly: true, maxAge: COOKIE_MAX_AGE_S });
	});

	it('changing ADMIN_PASSWORD invalidates admin cookies but not family cookies', () => {
		const fam = accessValue('family');
		const adm = accessValue('admin');
		setEnv({ ADMIN_PASSWORD: 'a-new-admin-password' });
		expect(verifyAccess(adm)).toBeNull();
		expect(verifyAccess(fam)).toMatchObject({ role: 'family' });
	});

	it('a cookie signed with another install’s secret is rejected', () => {
		const v = accessValue('family');
		freshDb(); // new secret
		expect(verifyAccess(v)).toBeNull();
	});
});

describe('join tokens', () => {
	it('derive as HMAC(secret, "join:" + norm(code) + ":" + gen), 22 chars', () => {
		const t = currentJoinToken();
		expect(t).toHaveLength(22);
		const expected = b64url(hmac(getSecret(), `join:${norm(TEST_FAMILY_PASSWORD)}:${getAccessGen()}`)).slice(0, 22);
		expect(t).toBe(expected);
		expect(t).toBe(joinToken(getSecret(), TEST_FAMILY_PASSWORD, getAccessGen()));
	});

	it('verify in constant time and reject near misses', () => {
		const t = currentJoinToken();
		expect(verifyJoinToken(t)).toBe(true);
		expect(verifyJoinToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).toBe(false);
		expect(verifyJoinToken(t.slice(0, 21))).toBe(false);
		expect(verifyJoinToken('')).toBe(false);
	});

	it('are invalidated by gen++ and by a new family code', () => {
		const t = currentJoinToken();
		rotateAccess();
		expect(verifyJoinToken(t)).toBe(false);
		const t2 = currentJoinToken();
		setEnv({ FAMILY_PASSWORD: 'green forest lodge' });
		expect(verifyJoinToken(t2)).toBe(false);
	});

	it('joinUrl builds /join/<token>?album=<id>', () => {
		const u = new URL(joinUrl('https://photos.example.com', 7));
		expect(u.pathname).toBe(`/join/${currentJoinToken()}`);
		expect(u.searchParams.get('album')).toBe('7');
		expect(new URL(joinUrl('https://photos.example.com')).search).toBe('');
	});
});

describe('fp_device', () => {
	it('round-trips and survives Reset access', () => {
		const c = new FakeCookies();
		const d = newDeviceId();
		issueDevice(c.asCookies(), http, { d, n: 'Grandma Jo' });
		expect(c.options.get(DEVICE_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'lax' });
		rotateAccess();
		expect(readDevice(c.asCookies())).toEqual({ d, n: 'Grandma Jo' });
	});

	it('rejects tampering', () => {
		const c = new FakeCookies();
		issueDevice(c.asCookies(), http, { d: newDeviceId(), n: 'Bob' });
		const [body, mac] = c.jar.get(DEVICE_COOKIE)!.split('.');
		const forged = b64url(Buffer.from(JSON.stringify({ d: 'someone-elses-device-id', n: 'Bob' })));
		c.jar.set(DEVICE_COOKIE, `${forged}.${mac}`);
		expect(readDevice(c.asCookies())).toBeNull();
		c.jar.set(DEVICE_COOKIE, `${body}.${mac}`);
		expect(readDevice(c.asCookies())).not.toBeNull();
	});

	it('cleanName trims, collapses spaces, strips control chars and limits length', () => {
		expect(cleanName('  Uncle   Bob ')).toBe('Uncle Bob');
		expect(cleanName('Jo\u0000<script>')).toBe('Joscript');
		expect(() => cleanName('   ')).toThrow(/type your name/);
		expect(() => cleanName('x'.repeat(41))).toThrow(/40/);
	});
});

describe('safeNext()', () => {
	it('allows same-origin paths', () => {
		expect(safeNext('/album/3?x=1#top')).toBe('/album/3?x=1#top');
		expect(safeNext('/')).toBe('/');
	});

	it('rejects open redirects and auth pages', () => {
		for (const bad of [
			'//evil.example',
			'https://evil.example/',
			'/\\evil.example',
			'\\\\evil',
			'javascript:alert(1)',
			'evil',
			'/login',
			'/join/abc',
			'/name',
			'/admin/login',
			'/%0d%0aSet-Cookie',
			null,
			undefined,
			''
		]) {
			const r = safeNext(bad as string);
			expect(r === '/' || r.startsWith('/%0d'), `input ${String(bad)} → ${r}`).toBe(true);
		}
		expect(safeNext('//evil.example', '/admin')).toBe('/admin');
	});

	it('rejects dot segments that normalize into a protocol-relative URL', () => {
		for (const bad of [
			'/.//evil.com',
			'/a/..//evil.com',
			'/%2e//evil.com',
			'/%2E%2E//evil.com',
			'/..//evil.com',
			'/././/evil.com',
			'/a/b/../..//evil.com/x?y#z',
			'/\t/evil.com'
		]) {
			expect(safeNext(bad), `input ${JSON.stringify(bad)}`).toBe('/');
			expect(safeNext(bad, '/admin')).toBe('/admin');
		}
	});

	it('rejects percent-encoded auth pages and keeps harmless normalizations', () => {
		expect(safeNext('/%6cogin')).toBe('/');
		expect(safeNext('/j%6fin/abc')).toBe('/');
		expect(safeNext('/admin/%6cogin', '/admin')).toBe('/admin');
		expect(safeNext('/a/../album/3')).toBe('/album/3');
		expect(safeNext('/%2F%2Fevil.com')).toBe('/%2F%2Fevil.com'); // stays a same-origin path
		expect(safeNext('/%E0%A4%A')).toBe('/'); // malformed escape
	});
});
