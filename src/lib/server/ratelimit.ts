/**
 * In-memory failure counters for the family code and the admin password.
 *
 * - Per client: at most `max` failures per key in a sliding window (default 10 per 15 minutes).
 * - Globally: at most `globalMax` failures across all keys per window, so rotating IPs (an IPv6
 *   range, a botnet, or headers spoofed through a misconfigured proxy) can't brute-force the code.
 *   During such an attack typed sign-ins wait for everyone; QR links and existing cookies still work.
 * - Memory is bounded: per-key lists keep only the last `max` failures and at most `maxKeys`
 *   keys are tracked (least recently failed evicted first).
 *
 * A request may carry several keys (see clientKeys()); it is limited when any of them is, and a
 * failure is recorded against all of them.
 */
import { BlockList, isIP } from 'node:net';
import { getConfig } from './config';

export interface RateLimitCheck {
	limited: boolean;
	/** Seconds until another attempt is allowed (0 when not limited). */
	retryAfterS: number;
	/** Recent failures of the busiest key. */
	failures: number;
}

export type RateLimitKey = string | readonly string[];

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
	/** Failures across all keys per window before everyone waits. Default 10 × max. */
	globalMax?: number;
	/** Most keys tracked at once. Default 10 000. */
	maxKeys?: number;
}

const keysOf = (key: RateLimitKey): readonly string[] => (typeof key === 'string' ? [key] : key);

export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
	const max = opts.max ?? 10;
	const windowMs = opts.windowMs ?? 15 * 60_000;
	const globalMax = opts.globalMax ?? max * 10;
	const maxKeys = opts.maxKeys ?? 10_000;
	/** key → failure times, oldest first. Map order = least recently failed first. */
	const failures = new Map<string, number[]>();
	let global: number[] = [];

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
			let limited = false;
			let retryAfterS = 0;
			let worst = 0;
			for (const k of keysOf(key)) {
				const list = recent(k, now);
				worst = Math.max(worst, list.length);
				if (list.length >= max) {
					limited = true;
					retryAfterS = Math.max(retryAfterS, retryAfter(list, max, now));
				}
			}
			global = live(global, now);
			if (global.length >= globalMax) {
				limited = true;
				retryAfterS = Math.max(retryAfterS, retryAfter(global, globalMax, now));
			}
			return { limited, retryAfterS, failures: worst };
		},
		fail(key, now = Date.now()) {
			prune(now);
			for (const k of new Set(keysOf(key))) {
				const list = recent(k, now);
				list.push(now);
				failures.delete(k); // re-insert: most recently failed goes to the end
				failures.set(k, list.slice(-max));
			}
			global = live(global, now);
			global.push(now);
			if (global.length > globalMax) global = global.slice(-globalMax);
		},
		clear(key) {
			for (const k of keysOf(key)) failures.delete(k);
		},
		reset() {
			failures.clear();
			global = [];
		},
		get size() {
			return failures.size;
		}
	};
}

/** Family code attempts on /login: 10 per client, 100 overall, per 15 minutes. */
export const loginLimiter = createRateLimiter({ max: 10, windowMs: 15 * 60_000, globalMax: 100 });
/** Admin password attempts on /admin/login: 10 per client, 50 overall, per 15 minutes. */
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
		if (e === 'private') {
			privateRanges(list);
			continue;
		}
		const [addr, bits] = e.split('/');
		const type = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
		if (bits === undefined) list.addAddress(addr, type);
		else list.addSubnet(addr, Number(bits), type);
	}
	trustCache = { spec, list };
	return list;
}

/** Whether a socket peer may tell us the client's IP via cf-connecting-ip / x-real-ip. */
export function isTrustedProxy(peer: string, entries: readonly string[] = getConfig().trustedProxies): boolean {
	const ip = normalizeIp(peer);
	const list = trustedList(entries);
	if (!ip || !list) return false;
	return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
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
 */
function clientIps(event: ClientEvent, entries?: readonly string[]): string[] {
	const peer = socketAddress(event);
	if (!peer || !isTrustedProxy(peer, entries)) return [peer ?? 'unknown'];
	const h = event.request.headers;
	const ips = [headerIp(h, 'cf-connecting-ip'), headerIp(h, 'x-real-ip')].filter((x): x is string => x !== null);
	return ips.length > 0 ? ips : [peer];
}

/**
 * Rate-limit keys for a request: every trusted client IP (IPv6 by /64). Both headers count
 * because which one a proxy overwrites depends on the setup: Cloudflare sets cf-connecting-ip but
 * passes a client's x-real-ip through, Nginx Proxy Manager does the opposite. Keying on both means
 * a spoofed header can't escape the limit set on the real one.
 */
export function clientKeys(event: ClientEvent, trustedProxies?: readonly string[]): string[] {
	return [...new Set(clientIps(event, trustedProxies).map(ipKey))];
}

/** Best guess at the client's IP for logs: cf-connecting-ip ?? x-real-ip ?? the socket (headers only from trusted proxies). */
export function clientIp(event: ClientEvent, trustedProxies?: readonly string[]): string {
	return clientIps(event, trustedProxies)[0];
}
