import { describe, expect, it } from 'vitest';
import {
	adminLimiter,
	clientIp,
	clientKeys,
	createRateLimiter,
	ipKey,
	isTrustedProxy,
	loginLimiter,
	normalizeIp
} from '#lib/server/ratelimit';

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

	it('ignores spoofed headers from a public peer (direct exposure)', () => {
		const pub = (h: Record<string, string>) => ev(h, '198.51.100.23');
		expect(clientKeys(pub({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toEqual(['198.51.100.23']);
		expect(clientIp(pub({ 'cf-connecting-ip': '1.1.1.1' }))).toBe('198.51.100.23');
		expect(clientKeys(ev({ 'x-real-ip': '2.2.2.2' }, '::ffff:198.51.100.23'))).toEqual(['198.51.100.23']);
		expect(clientKeys(ev({}, '2001:db8:aa:bb:1:2:3:4'))).toEqual(['2001:db8:aa:bb::/64']);
		// and with TRUSTED_PROXIES=none even a LAN peer's headers are ignored
		expect(clientKeys(ev({ 'x-real-ip': '2.2.2.2' }), ['none'])).toEqual(['10.0.0.9']);
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

	it('rotating spoofed headers never escapes the limit (end to end through the limiter)', () => {
		// Exposed directly: a public client rotating both headers.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': `1.1.1.${i}`, 'x-real-ip': `2.2.2.${i}` }, '198.51.100.23'))).toBe(10);
		// Behind Nginx Proxy Manager (LAN peer): NPM sets X-Real-IP, the client fakes CF-Connecting-IP.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': `1.1.1.${i}`, 'x-real-ip': '203.0.113.50' }, '172.17.0.5'))).toBe(10);
		// Behind Cloudflare Tunnel: cloudflared sets CF-Connecting-IP, the client fakes X-Real-IP.
		expect(attemptsUntilLimited((i) => ev({ 'cf-connecting-ip': '203.0.113.50', 'x-real-ip': `2.2.2.${i}` }, '172.17.0.6'))).toBe(10);
		// IPv6 client hopping addresses inside its /64.
		expect(attemptsUntilLimited((i) => ev({}, `2001:db8:1:2::${(i + 1).toString(16)}`))).toBe(10);
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
