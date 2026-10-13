import { describe, expect, it } from 'vitest';
import { DEVICE_COOKIE, accessValue, deviceValue } from '#lib/server/auth';
import {
	adminLimiter,
	clientIp,
	clientKeys,
	createRateLimiter,
	ipKey,
	isProxyHop,
	isTrustedProxy,
	loginLimiter,
	normalizeIp,
	signInSubject,
	type RateLimitSubject
} from '#lib/server/ratelimit';
import { FakeCookies } from '../helpers/cookies';

describe('rate limiter', () => {
	it('allows 10 failures per 15 minutes; the 11th attempt is limited', () => {
		const rl = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
		const t0 = 1_000_000;
		for (let i = 0; i < 10; i++) {
			expect(rl.check('1.2.3.4', t0 + i).limited).toBe(false);
			rl.fail('1.2.3.4', t0 + i);
		}
		const c = rl.check('1.2.3.4', t0 + 10);
		expect(c.limited).toBe(true);
		expect(c.retryAfterS).toBeGreaterThan(14 * 60);
		expect(c.retryAfterS).toBeLessThanOrEqual(15 * 60);
	});

	it('is per key', () => {
		const rl = createRateLimiter({ max: 2, windowMs: 1000 });
		rl.fail('a', 0);
		rl.fail('a', 0);
		expect(rl.check('a', 1).limited).toBe(true);
		expect(rl.check('b', 1).limited).toBe(false);
	});

	it('slides: old failures fall out of the window', () => {
		const rl = createRateLimiter({ max: 10, windowMs: 15 * 60_000 });
		for (let i = 0; i < 10; i++) rl.fail('k', i * 60_000); // one per minute, minutes 0..9
		expect(rl.check('k', 9 * 60_000 + 1).limited).toBe(true);
		expect(rl.check('k', 15 * 60_000 - 1).limited).toBe(true);
		expect(rl.check('k', 15 * 60_000 + 1).limited).toBe(false); // the minute-0 failure expired
		expect(rl.check('k', 25 * 60_000).failures).toBe(0);
	});

	it('clear() forgets a key (successful login)', () => {
		const rl = createRateLimiter({ max: 1, windowMs: 1000 });
		rl.fail('k', 0);
		expect(rl.check('k', 1).limited).toBe(true);
		rl.clear('k');
		expect(rl.check('k', 1).limited).toBe(false);
	});

	it('with several keys: limited when any key is, and a failure counts against all of them', () => {
		const rl = createRateLimiter({ max: 3, windowMs: 1000, globalMax: 1000 });
		// The real client IP stays the same while a spoofed header changes on every try.
		for (let i = 0; i < 3; i++) rl.fail([`spoof-${i}`, 'real'], 0);
		expect(rl.check(['spoof-99', 'real'], 1).limited).toBe(true);
		expect(rl.check(['spoof-0'], 1)).toMatchObject({ limited: false, failures: 1 });
		expect(rl.check(['real'], 1).failures).toBe(3);
		rl.fail(['x', 'x'], 0); // duplicate keys count once
		expect(rl.check('x', 1).failures).toBe(1);
	});

	it('has a global ceiling across all keys', () => {
		const rl = createRateLimiter({ max: 10, windowMs: 60_000, globalMax: 5 });
		for (let i = 0; i < 5; i++) rl.fail(`ip-${i}`, i);
		const c = rl.check('a-brand-new-ip', 10);
		expect(c.limited).toBe(true);
		expect(c.retryAfterS).toBe(60);
		rl.clear('ip-0'); // a success clears the client's own count, not the global one
		expect(rl.check('another', 10).limited).toBe(true);
		expect(rl.check('a-brand-new-ip', 60_001).limited).toBe(false); // the first global failures expired
	});

	it('known devices have a global pool of their own: strangers cannot lock them out', () => {
		const rl = createRateLimiter({ max: 10, windowMs: 60_000, globalMax: 5 });
		const known = (ip: string, device: string): RateLimitSubject => ({ keys: [ip, `device:${device}`], knownDevice: true });
		for (let i = 0; i < 5; i++) rl.fail(`stranger-${i}`, i);
		expect(rl.check('another-stranger', 10).limited).toBe(true);
		expect(rl.check(known('ip-a', 'a'), 10)).toEqual({ limited: false, retryAfterS: 0, failures: 0 });
		// A known device's failures don't count against strangers' pool, and vice versa…
		rl.reset();
		for (let i = 0; i < 4; i++) rl.fail(known(`ip-${i}`, `d${i}`), i);
		expect(rl.check('stranger', 10).limited).toBe(false);
		expect(rl.check(known('ip-x', 'x'), 10).limited).toBe(false);
		// …but known devices together still have a ceiling (fresh device ids can be minted by anyone
		// with the family code), and the per-key limits still apply.
		rl.fail(known('ip-4', 'd4'), 4);
		expect(rl.check(known('ip-x', 'x'), 10)).toMatchObject({ limited: true, retryAfterS: 60 });
		expect(rl.check('stranger', 10).limited).toBe(false);
		const solo = createRateLimiter({ max: 3, windowMs: 60_000, globalMax: 1000 });
		for (let i = 0; i < 3; i++) solo.fail(known(`rotating-${i}`, 'same-device'), i);
		expect(solo.check(known('rotating-99', 'same-device'), 10)).toMatchObject({ limited: true, failures: 3 });
		solo.clear(known('rotating-99', 'same-device')); // a success clears the device key too
		expect(solo.check(known('rotating-99', 'same-device'), 10).limited).toBe(false);
	});

	it('bounds memory: per-key history and the number of keys', () => {
		const rl = createRateLimiter({ max: 3, windowMs: 60_000, globalMax: 1_000_000, maxKeys: 100 });
		for (let i = 0; i < 1000; i++) rl.fail(`k-${i}`, 1000 + i);
		expect(rl.size).toBeLessThanOrEqual(100);
		expect(rl.check('k-999', 3000).failures).toBe(1); // the most recent keys survive
		for (let i = 0; i < 50; i++) rl.fail('busy', 5000 + i);
		expect(rl.check('busy', 6000)).toMatchObject({ limited: true, failures: 3 });
		// expired keys are dropped on the next failure
		rl.fail('late', 10 * 60_000);
		expect(rl.size).toBe(1);
	});

	it('exports a 10-per-15-minutes login limiter with a global ceiling of 100 (admin: 50)', () => {
		loginLimiter.reset();
		for (let i = 0; i < 10; i++) loginLimiter.fail('x');
		expect(loginLimiter.check('x').limited).toBe(true);
		loginLimiter.reset();
		for (let i = 0; i < 99; i++) loginLimiter.fail(`ip-${i}`);
		expect(loginLimiter.check('fresh').limited).toBe(false);
		loginLimiter.fail('one-more');
		expect(loginLimiter.check('fresh').limited).toBe(true);
		loginLimiter.reset();
		adminLimiter.reset();
		for (let i = 0; i < 50; i++) adminLimiter.fail(`ip-${i}`);
		expect(adminLimiter.check('fresh').limited).toBe(true);
		adminLimiter.reset();
	});
});

describe('client identity', () => {
	const ev = (headers: Record<string, string>, addr = '10.0.0.9') => ({
		request: new Request('http://x/', { headers }),
		getClientAddress: () => addr
	});

	/** Number of attempts before the limiter refuses, for a sequence of requests. */
	function attemptsUntilLimited(make: (i: number) => ReturnType<typeof ev>): number {
		const rl = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 1000 });
		for (let i = 0; i < 50; i++) {
			const keys = clientKeys(make(i));
			if (rl.check(keys, i).limited) return i;
			rl.fail(keys, i);
		}
		return Infinity;
	}

	it('normalizes addresses', () => {
		expect(normalizeIp('::ffff:192.168.1.20')).toBe('192.168.1.20');
		expect(normalizeIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
		expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
		expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
		expect(normalizeIp('not-an-ip')).toBeNull();
		expect(normalizeIp('')).toBeNull();
	});

	it('keys IPv6 clients by /64', () => {
		expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
		expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
		expect(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
		expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
		expect(ipKey('::1')).toBe('0:0:0:0::/64');
		expect(ipKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
	});

	it('trusts loopback and private peers by default, and TRUSTED_PROXIES when set', () => {
		for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.17.0.2', '192.168.1.5', '::ffff:172.18.0.3', 'fd00::5', 'fe80::1']) {
			expect(isTrustedProxy(ip, ['private']), ip).toBe(true);
		}
		for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.64.0.1', 'garbage']) {
			expect(isTrustedProxy(ip, ['private']), ip).toBe(false);
		}
		expect(isTrustedProxy('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
		expect(isTrustedProxy('10.0.0.1', ['203.0.113.0/24'])).toBe(false);
		expect(isTrustedProxy('127.0.0.1', ['none'])).toBe(false);
		expect(isTrustedProxy('2001:db8::7', ['2001:db8::/32', 'private'])).toBe(true);
	});

	it('behind a trusted proxy: keys on both headers (a spoofed one cannot escape the real one)', () => {
		expect(clientKeys(ev({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toEqual(['1.1.1.1', '2.2.2.2']);
		expect(clientKeys(ev({ 'x-real-ip': '2.2.2.2' }))).toEqual(['2.2.2.2']);
		expect(clientKeys(ev({ 'cf-connecting-ip': '2001:db8:5:6::1, 9.9.9.9' }))).toEqual(['2001:db8:5:6::/64']);
		expect(clientKeys(ev({ 'cf-connecting-ip': '3.3.3.3', 'x-real-ip': '3.3.3.3' }))).toEqual(['3.3.3.3']);
		expect(clientKeys(ev({}))).toEqual(['10.0.0.9']);
		expect(clientKeys(ev({ 'x-forwarded-for': '3.3.3.3' }))).toEqual(['10.0.0.9']);
		expect(clientKeys(ev({ 'cf-connecting-ip': 'garbage', 'x-real-ip': '<script>' }))).toEqual(['10.0.0.9']);
		expect(clientIp(ev({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toBe('1.1.1.1');
		expect(clientIp(ev({ 'x-real-ip': '2.2.2.2' }))).toBe('2.2.2.2');
	});

	it('skips an X-Real-IP that is a proxy hop next to CF-Connecting-IP (Cloudflare → NPM, cloudflared → NPM)', () => {
		// Cloudflare (orange cloud) → Nginx Proxy Manager: X-Real-IP is the Cloudflare edge.
		const viaEdge = (visitor: string, edge = '162.158.10.20') =>
			ev({ 'cf-connecting-ip': visitor, 'x-real-ip': edge }, '172.17.0.5');
		expect(clientKeys(viaEdge('203.0.113.7'))).toEqual(['203.0.113.7']);
		expect(clientKeys(viaEdge('2001:db8:1:2::9', '2400:cb00:2049:1::a29f:1a2b'))).toEqual(['2001:db8:1:2::/64']);
		expect(clientIp(viaEdge('203.0.113.7'))).toBe('203.0.113.7');
		// cloudflared → NPM on one Docker network: X-Real-IP is cloudflared's private address.
		expect(clientKeys(ev({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '172.18.0.3' }, '172.18.0.2'))).toEqual(['203.0.113.7']);
		// Proxies listed in TRUSTED_PROXIES count as hops too.
		expect(
			clientKeys(ev({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '198.51.100.1' }, '198.51.100.2'), ['198.51.100.0/24'])
		).toEqual(['203.0.113.7']);
		// CF-Connecting-IP always counts, whatever it names; only X-Real-IP is dropped as a hop.
		expect(clientKeys(ev({ 'cf-connecting-ip': '10.1.1.1', 'x-real-ip': '::1' }, '172.17.0.5'))).toEqual(['10.1.1.1']);
		// X-Real-IP on its own always counts, even when it looks like a hop.
		expect(clientKeys(ev({ 'x-real-ip': '104.16.0.1' }, '172.17.0.5'))).toEqual(['104.16.0.1']);
	});

	it('a Cloudflare Worker keeps a key of its own (CF-Connecting-IP is a Cloudflare address)', () => {
		// Worker → Cloudflare → NPM: CF-Connecting-IP is the Worker's address, X-Real-IP the edge.
		const worker = '2a06:98c0:3600::103';
		expect(clientKeys(ev({ 'cf-connecting-ip': worker, 'x-real-ip': '162.158.10.20' }, '172.17.0.5'))).toEqual(['2a06:98c0:3600:0::/64']);
		// Through cloudflared the Worker controls X-Real-IP, but rotating it doesn't escape the Worker's key.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': worker, 'x-real-ip': `104.16.0.${i}` }, '172.17.0.6'))).toBe(10);
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': worker, 'x-real-ip': `198.51.100.${i}` }, '172.17.0.6'))).toBe(10);
	});

	it('devices at home reaching NPM directly are limited separately (X-Real-IP alone counts, even when private)', () => {
		const lan = (ip: string) => ev({ 'x-real-ip': ip }, '172.17.0.5');
		expect(clientKeys(lan('192.168.1.50'))).toEqual(['192.168.1.50']);
		expect(clientIp(lan('192.168.1.50'))).toBe('192.168.1.50');
		const rl = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 1000 });
		for (let i = 0; i < 10; i++) rl.fail(clientKeys(lan('192.168.1.50')), i);
		expect(rl.check(clientKeys(lan('192.168.1.50')), 20).limited).toBe(true);
		expect(rl.check(clientKeys(lan('192.168.1.51')), 20)).toEqual({ limited: false, retryAfterS: 0, failures: 0 });
	});

	it('TRUSTED_PROXIES=cloudflare trusts Cloudflare\'s ranges as peers (Cloudflare → this app directly)', () => {
		for (const ip of ['162.158.10.20', '104.16.0.1', '2400:cb00::1', '::ffff:173.245.48.1']) {
			expect(isTrustedProxy(ip, ['cloudflare']), ip).toBe(true);
		}
		for (const ip of ['10.0.0.1', '127.0.0.1', '1.1.1.1', '2001:db8::1']) {
			expect(isTrustedProxy(ip, ['cloudflare']), ip).toBe(false);
		}
		expect(isTrustedProxy('10.0.0.1', ['private', 'cloudflare'])).toBe(true);
		expect(isTrustedProxy('162.158.10.20', ['private', 'cloudflare'])).toBe(true);
		const direct = ev({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '198.51.100.9' }, '162.158.10.20');
		expect(clientKeys(direct, ['cloudflare'])).toEqual(['203.0.113.7', '198.51.100.9']);
		expect(clientIp(direct, ['cloudflare'])).toBe('203.0.113.7');
		expect(clientKeys(direct, ['private'])).toEqual(['162.158.10.20']); // not trusted by default
	});

	it('knows Cloudflare\'s published ranges (edges of the embedded list)', () => {
		for (const ip of ['173.245.48.0', '173.245.63.255', '104.16.0.1', '104.27.255.255', '172.71.255.255', '131.0.75.255', '::ffff:162.159.0.1']) {
			expect(isProxyHop(ip, ['none']), ip).toBe(true);
		}
		for (const ip of ['2400:cb00::1', '2606:4700:10::6816:1', '2a06:98c7:ffff::1', '2c0f:f248:0:ffff::1']) {
			expect(isProxyHop(ip, ['none']), ip).toBe(true);
		}
		for (const ip of ['173.245.64.0', '104.28.0.1', '172.72.0.1', '1.1.1.1', '2a06:98d0::1', '2606:4701::1', 'garbage']) {
			expect(isProxyHop(ip, ['none']), ip).toBe(false);
		}
		expect(isProxyHop('192.168.1.2')).toBe(true); // default TRUSTED_PROXIES=private
		expect(isProxyHop('192.168.1.2', ['none'])).toBe(false);
	});

	it('ignores spoofed headers from a public peer (direct exposure)', () => {
		const pub = (h: Record<string, string>) => ev(h, '198.51.100.23');
		expect(clientKeys(pub({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toEqual(['198.51.100.23']);
		expect(clientIp(pub({ 'cf-connecting-ip': '1.1.1.1' }))).toBe('198.51.100.23');
		expect(clientKeys(ev({ 'x-real-ip': '2.2.2.2' }, '::ffff:198.51.100.23'))).toEqual(['198.51.100.23']);
		expect(clientKeys(ev({}, '2001:db8:aa:bb:1:2:3:4'))).toEqual(['2001:db8:aa:bb::/64']);
		// and with TRUSTED_PROXIES=none even a LAN peer's headers are ignored
		expect(clientKeys(ev({ 'x-real-ip': '2.2.2.2' }), ['none'])).toEqual(['10.0.0.9']);
	});

	it('rotating spoofed headers never escapes the limit (end to end through the limiter)', () => {
		// Exposed directly: a public client rotating both headers.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': `1.1.1.${i}`, 'x-real-ip': `2.2.2.${i}` }, '198.51.100.23'))).toBe(10);
		// Behind Nginx Proxy Manager (LAN peer): NPM sets X-Real-IP, the client fakes CF-Connecting-IP.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': `1.1.1.${i}`, 'x-real-ip': '203.0.113.50' }, '172.17.0.5'))).toBe(10);
		// Behind Cloudflare Tunnel: cloudflared sets CF-Connecting-IP, the client fakes X-Real-IP.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': '203.0.113.50', 'x-real-ip': `2.2.2.${i}` }, '172.17.0.6'))).toBe(10);
		// IPv6 client hopping addresses inside its /64.
		expect(attemptsUntilLimited((i) => ev({}, `2001:db8:1:2::${(i + 1).toString(16)}`))).toBe(10);
		// Cloudflare Tunnel: faking X-Real-IP as a Cloudflare or private address only drops that header.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': '203.0.113.50', 'x-real-ip': i % 2 ? `104.16.0.${i}` : `10.0.0.${i}` }, '172.17.0.6'))).toBe(10);
		// NPM reached directly (bypassing Cloudflare), the client fakes CF-Connecting-IP as a Cloudflare edge.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': `162.158.0.${i}`, 'x-real-ip': '203.0.113.51' }, '172.17.0.5'))).toBe(10);
	});

	it('visitors behind one Cloudflare edge (Cloudflare → NPM) are limited separately', () => {
		const rl = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 1000 });
		const visitor = (ip: string) => clientKeys(ev({ 'cf-connecting-ip': ip, 'x-real-ip': '172.70.1.1' }, '172.17.0.5'));
		for (let i = 0; i < 10; i++) rl.fail(visitor('203.0.113.60'), i);
		expect(rl.check(visitor('203.0.113.60'), 20).limited).toBe(true);
		expect(rl.check(visitor('203.0.113.61'), 20)).toEqual({ limited: false, retryAfterS: 0, failures: 0 });
	});

	it('signInSubject: a valid fp_device cookie adds the device as a key and uses the known-device pool', () => {
		const cookies = new FakeCookies();
		const e = { ...ev({ 'x-real-ip': '203.0.113.9' }), cookies: cookies.asCookies() };
		expect(signInSubject(e)).toEqual({ keys: ['203.0.113.9'], knownDevice: false });
		const d = 'devSAMAAAAAAAAAAAAAAAA';
		cookies.set(DEVICE_COOKIE, deviceValue({ d, n: 'Sam' }));
		expect(signInSubject(e)).toEqual({ keys: ['203.0.113.9', `device:${d}`], knownDevice: true });
		expect(signInSubject({ ...e, getClientAddress: () => '198.51.100.23' })).toEqual({
			keys: ['198.51.100.23', `device:${d}`],
			knownDevice: true
		});
		// Forged, tampered or wrong-cookie values don't count.
		for (const bad of [deviceValue({ d, n: 'Sam' }).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), accessValue('family'), 'x.y']) {
			cookies.set(DEVICE_COOKIE, bad);
			expect(signInSubject(e), bad).toEqual({ keys: ['203.0.113.9'], knownDevice: false });
		}
	});

	it('a stranger flood fills the global ceiling, and a known device can still try (login limiter)', () => {
		loginLimiter.reset();
		const cookies = new FakeCookies();
		const stranger = (i: number) => signInSubject({ ...ev({}, `2001:db8:${i.toString(16)}::1`), cookies: new FakeCookies().asCookies() });
		for (let i = 0; i < 100; i++) loginLimiter.fail(stranger(i));
		expect(loginLimiter.check(stranger(1000)).limited).toBe(true);
		cookies.set(DEVICE_COOKIE, deviceValue({ d: 'devKIMAAAAAAAAAAAAAAAA', n: 'Kim' }));
		const known = signInSubject({ ...ev({}, '203.0.113.80'), cookies: cookies.asCookies() });
		expect(loginLimiter.check(known).limited).toBe(false);
		loginLimiter.reset();
	});

	it('survives getClientAddress throwing', () => {
		const e = {
			request: new Request('http://x/', { headers: { 'x-real-ip': '2.2.2.2' } }),
			getClientAddress: () => {
				throw new Error('no address');
			}
		};
		expect(clientIp(e)).toBe('unknown');
		expect(clientKeys(e)).toEqual(['unknown']);
	});
});
