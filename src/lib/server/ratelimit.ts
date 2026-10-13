/**
 * In-memory failure counters for the family code and the admin password.
 *
 * - Per client: at most `max` failures per key in a sliding window (default 10 per 15 minutes).
 * - Globally: at most `globalMax` failures across all keys per window, so rotating IPs (an IPv6
 *   range, a botnet, or headers spoofed through a misconfigured proxy) can't brute-force the code.
 *   Known devices (a valid signed fp_device cookie, see signInSubject()) have a pool of their own,
 *   so a flood of wrong guesses from strangers makes only strangers wait: phones that have signed
 *   in here before can still type the code, and QR links and existing cookies keep working.
 * - Memory is bounded: per-key lists keep only the last `max` failures and at most `maxKeys`
 *   keys are tracked (least recently failed evicted first).
 *
 * A request may carry several keys (see clientKeys()); it is limited when any of them is, and a
 * failure is recorded against all of them.
 */
import { BlockList, isIP } from 'node:net';
import type { Cookies } from '@sveltejs/kit';
import { readDevice } from './auth';
import { getConfig } from './config';

export interface RateLimitCheck {
	limited: boolean;
	/** Seconds until another attempt is allowed (0 when not limited). */
	retryAfterS: number;
	/** Recent failures of the busiest key. */
	failures: number;
}

/** A sign-in attempt: its keys, and whether it counts in the known-device global pool. */
export interface RateLimitSubject {
	keys: readonly string[];
	knownDevice: boolean;
}

/** One key, several keys (see clientKeys()), or a sign-in attempt (see signInSubject()). */
export type RateLimitKey = string | readonly string[] | RateLimitSubject;

export interface RateLimiter {
	check(key: RateLimitKey, now?: number): RateLimitCheck;
	fail(key: RateLimitKey, now?: number): void;
	/** Forgets the per-client failures of these keys (successful sign-in). The global count stays. */
	clear(key: RateLimitKey): void;
	reset(): void;
	/** Number of keys currently tracked. */
	readonly size: number;
}

export interface RateLimiterOptions {
	max?: number;
	windowMs?: number;
	/** Failures across all keys per window before everyone in the same pool waits. Default 10 × max. */
	globalMax?: number;
	/** Most keys tracked at once. Default 10 000. */
	maxKeys?: number;
}

function subjectOf(key: RateLimitKey): RateLimitSubject {
	if (typeof key === 'string') return { keys: [key], knownDevice: false };
	return 'knownDevice' in key ? key : { keys: key, knownDevice: false };
}

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
	const max = opts.max ?? 10;
	const windowMs = opts.windowMs ?? 15 * 60_000;
	const globalMax = opts.globalMax ?? max * 10;
	const maxKeys = opts.maxKeys ?? 10_000;
	/** key → failure times, oldest first. Map order = least recently failed first. */
	const failures = new Map<string, number[]>();
	/** Failure times across all keys, per pool (known devices / everyone else). */
	const global = { known: [] as number[], other: [] as number[] };
	const poolOf = (s: RateLimitSubject) => (s.knownDevice ? 'known' : 'other');

	const live = (list: number[], now: number) => list.filter((t) => now - t < windowMs);

	const recent = (key: string, now: number): number[] => {
		const list = failures.get(key);
		if (!list) return [];
		const kept = live(list, now);
		if (kept.length === 0) failures.delete(key);
		else if (kept.length !== list.length) failures.set(key, kept);
		return kept;
	};

	/** Drops expired keys from the least-recently-failed end, then evicts down to maxKeys. */
	const prune = (now: number) => {
		for (const [key, list] of failures) {
			if (list.length > 0 && now - list[list.length - 1] < windowMs) break;
			failures.delete(key);
		}
		while (failures.size >= maxKeys) {
			const oldest = failures.keys().next().value;
			if (oldest === undefined) break;
			failures.delete(oldest);
		}
	};

	const retryAfter = (list: number[], limit: number, now: number) =>
		Math.max(1, Math.ceil((list[list.length - limit] + windowMs - now) / 1000));

	return {
		check(key, now = Date.now()) {
			const subject = subjectOf(key);
			let limited = false;
			let retryAfterS = 0;
			let worst = 0;
			for (const k of subject.keys) {
				const list = recent(k, now);
				worst = Math.max(worst, list.length);
				if (list.length >= max) {
					limited = true;
					retryAfterS = Math.max(retryAfterS, retryAfter(list, max, now));
				}
			}
			const pool = poolOf(subject);
			global[pool] = live(global[pool], now);
			if (global[pool].length >= globalMax) {
				limited = true;
				retryAfterS = Math.max(retryAfterS, retryAfter(global[pool], globalMax, now));
			}
			return { limited, retryAfterS, failures: worst };
		},
		fail(key, now = Date.now()) {
			const subject = subjectOf(key);
			prune(now);
			for (const k of new Set(subject.keys)) {
				const list = recent(k, now);
				list.push(now);
				failures.delete(k); // re-insert: most recently failed goes to the end
				failures.set(k, list.slice(-max));
			}
			const pool = poolOf(subject);
			const list = live(global[pool], now);
			list.push(now);
			global[pool] = list.length > globalMax ? list.slice(-globalMax) : list;
		},
		clear(key) {
			for (const k of subjectOf(key).keys) failures.delete(k);
		},
		reset() {
			failures.clear();
			global.known = [];
			global.other = [];
		},
		get size() {
			return failures.size;
		}
	};
}

/** Family code attempts on /login: 10 per client, 100 overall (per pool), per 15 minutes. */
export const loginLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 100 });
/** Admin password attempts on /admin/login: 10 per client, 50 overall (per pool), per 15 minutes. */
export const adminLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 50 });

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

type ClientEvent = { request: Request; getClientAddress: () => string };

/** '::ffff:1.2.3.4' → '1.2.3.4'; strips an IPv6 zone and brackets; null when not an IP. */
export function normalizeIp(raw: string | null | undefined): string | null {
	if (!raw) return null;
	let ip = raw.trim();
	if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
	ip = ip.replace(/%.*$/, '');
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	if (mapped) ip = mapped[1];
	return isIP(ip) ? ip.toLowerCase() : null;
}

/** The 8 hextets of a valid IPv6 address (no embedded IPv4 support needed after normalizeIp). */
function ipv6Hextets(ip: string): string[] {
	let s = ip;
	const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number);
		s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
	}
	const [head, tail] = s.split('::');
	const h = head ? head.split(':') : [];
	const t = tail === undefined ? [] : tail ? tail.split(':') : [];
	const fill = tail === undefined ? 0 : 8 - h.length - t.length;
	return [...h, ...Array<string>(fill).fill('0'), ...t].map((x) => parseInt(x, 16).toString(16));
}

/** Rate-limit key for an IP: IPv4 as is, IPv6 by its /64 (one household or one VPS). */
export function ipKey(ip: string): string {
	if (isIP(ip) !== 6) return ip;
	return `${ipv6Hextets(ip).slice(0, 4).join(':')}::/64`;
}

let trustCache: { spec: string; list: BlockList | null } | null = null;

const familyOf = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** Adds an IP or CIDR range ('203.0.113.0/24', '2001:db8::/32'). */
function addRange(list: BlockList, entry: string): void {
	const [addr, bits] = entry.split('/');
	if (bits === undefined) list.addAddress(addr, familyOf(addr));
	else list.addSubnet(addr, Number(bits), familyOf(addr));
}

function privateRanges(list: BlockList): void {
	list.addSubnet('127.0.0.0', 8, 'ipv4');
	list.addSubnet('10.0.0.0', 8, 'ipv4');
	list.addSubnet('172.16.0.0', 12, 'ipv4');
	list.addSubnet('192.168.0.0', 16, 'ipv4');
	list.addSubnet('169.254.0.0', 16, 'ipv4');
	list.addAddress('::1', 'ipv6');
	list.addSubnet('fc00::', 7, 'ipv6');
	list.addSubnet('fe80::', 10, 'ipv6');
}

/** BlockList of trusted proxy peers built from config TRUSTED_PROXIES (null = trust nobody). */
function trustedList(entries: readonly string[]): BlockList | null {
	const spec = entries.join(',');
	if (trustCache?.spec === spec) return trustCache.list;
	let list: BlockList | null = new BlockList();
	for (const e of entries) {
		if (e === 'none') {
			list = null;
			break;
		}
		if (e === 'private') privateRanges(list);
		else if (e === 'cloudflare') for (const r of CLOUDFLARE_RANGES) addRange(list, r);
		else addRange(list, e);
	}
	trustCache = { spec, list };
	return list;
}

/** Whether a socket peer may tell us the client's IP via cf-connecting-ip / x-real-ip. */
export function isTrustedProxy(peer: string, entries: readonly string[] = getConfig().trustedProxies): boolean {
	const ip = normalizeIp(peer);
	const list = trustedList(entries);
	if (!ip || !list) return false;
	return list.check(ip, familyOf(ip));
}

/**
 * Cloudflare's edge ranges: the lists Cloudflare publishes at https://www.cloudflare.com/ips-v4
 * and /ips-v6, copied on 2026-10-13 from the daily mirror at github.com/lord-alfred/ipranges
 * (cloudflare.com itself wasn't reachable from where this was written). Cloudflare rarely
 * changes them, but compare with the published lists now and then.
 *
 * Used twice: TRUSTED_PROXIES=cloudflare trusts them as socket peers (Cloudflare connecting to
 * this port directly), and an X-Real-IP naming one of them is a proxy hop (see clientIps()).
 */
const CLOUDFLARE_RANGES = [
	'173.245.48.0/20',
	'103.21.244.0/22',
	'103.22.200.0/22',
	'103.31.4.0/22',
	'141.101.64.0/18',
	'108.162.192.0/18',
	'190.93.240.0/20',
	'188.114.96.0/20',
	'197.234.240.0/22',
	'198.41.128.0/17',
	'162.158.0.0/15',
	'104.16.0.0/13',
	'104.24.0.0/14',
	'172.64.0.0/13',
	'131.0.72.0/22',
	'2400:cb00::/32',
	'2606:4700::/32',
	'2803:f800::/32',
	'2405:b500::/32',
	'2405:8100::/32',
	'2a06:98c0::/29',
	'2c0f:f248::/32'
];

const cloudflare = new BlockList();
for (const r of CLOUDFLARE_RANGES) addRange(cloudflare, r);

/** Whether a forwarded "client" IP is really a proxy hop: a Cloudflare edge or a TRUSTED_PROXIES address. */
export function isProxyHop(ip: string, entries?: readonly string[]): boolean {
	const n = normalizeIp(ip);
	return n !== null && (cloudflare.check(n, familyOf(n)) || isTrustedProxy(n, entries));
}

function socketAddress(event: ClientEvent): string | null {
	try {
		return normalizeIp(event.getClientAddress());
	} catch {
		return null;
	}
}

/** First IP of a forwarding header, or null when absent or not an IP. */
function headerIp(h: Headers, name: string): string | null {
	return normalizeIp(h.get(name)?.split(',')[0]?.slice(0, 100));
}

/**
 * The client's IPs as far as we can trust them, in priority order. Headers count only when the
 * socket peer is a trusted proxy (Cloudflare Tunnel / Nginx Proxy Manager on the LAN or Docker
 * network, see TRUSTED_PROXIES); a client reaching us directly is identified by its socket.
 *
 * CF-Connecting-IP always counts when present: Cloudflare and cloudflared set it themselves, and
 * a Cloudflare address in it means a Cloudflare Worker, which keeps a key of its own.
 * X-Real-IP is what NPM fills in from the address that connected to it. Next to CF-Connecting-IP
 * it is skipped when it names a proxy hop (a Cloudflare edge, or a TRUSTED_PROXIES address such
 * as cloudflared on the same Docker network), because then every visitor who came through that
 * hop would share one limit. On its own it always counts, so each device at home reaching NPM
 * directly keeps its own key. (The flip side: someone who reaches NPM from a trusted address can
 * choose their CF-Connecting-IP. The global ceiling still applies to them.)
 */
function clientIps(event: ClientEvent, entries?: readonly string[]): string[] {
	const peer = socketAddress(event);
	if (!peer || !isTrustedProxy(peer, entries)) return [peer ?? 'unknown'];
	const h = event.request.headers;
	const cf = headerIp(h, 'cf-connecting-ip');
	let real = headerIp(h, 'x-real-ip');
	if (cf !== null && real !== null && isProxyHop(real, entries)) real = null;
	const ips = [cf, real].filter((x): x is string => x !== null);
	return ips.length > 0 ? ips : [peer];
}

/**
 * Rate-limit keys for a request: every trusted client IP (IPv6 by /64). Both headers count
 * because which one a proxy overwrites depends on the setup: Cloudflare sets cf-connecting-ip but
 * passes a client's x-real-ip through, Nginx Proxy Manager does the opposite. Keying on both means
 * a spoofed header can't escape the limit set on the real one. An x-real-ip naming a proxy hop
 * next to a cf-connecting-ip is ignored (Cloudflare → NPM, or cloudflared → NPM on one Docker
 * network): keying on it would make everyone behind that hop share one limit.
 */
export function clientKeys(event: ClientEvent, trustedProxies?: readonly string[]): string[] {
	return [...new Set(clientIps(event, trustedProxies).map(ipKey))];
}

/** Best guess at the client's IP for logs: cf-connecting-ip ?? x-real-ip ?? the socket (headers only from trusted proxies). */
export function clientIp(event: ClientEvent, trustedProxies?: readonly string[]): string {
	return clientIps(event, trustedProxies)[0];
}

/**
 * What a sign-in attempt is limited by: the client's IP keys plus, when the request carries a
 * valid signed fp_device cookie (auth.readDevice), the device itself, which also moves the attempt
 * into the known-device global pool. Device cookies can't be forged and are only issued after
 * someone got in (on /name), so strangers flooding wrong guesses can't lock out the family's
 * phones. Known devices still share a global ceiling of their own: anyone with the family code
 * can mint new device ids, and that must not open an unlimited guess at the admin password.
 */
export function signInSubject(
	event: ClientEvent & { cookies: Cookies },
	trustedProxies?: readonly string[]
): RateLimitSubject {
	const keys = clientKeys(event, trustedProxies);
	const device = readDevice(event.cookies);
	return device ? { keys: [...keys, `device:${device.d}`], knownDevice: true } : { keys, knownDevice: false };
}
