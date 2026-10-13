/**
 * Access without accounts (docs/PLAN.md "Access, QR codes and names").
 *
 * fp_access {r, v, iat}: role, tag, issued-at (epoch seconds). HMAC-signed with settings.secret.
 *   family tag = HMAC(secret, 'fam:' + norm(FAMILY_PASSWORD) + ':' + access_gen)
 *   admin tag  = HMAC(secret, 'adm:' + JSON([ADMIN_PASSWORD, norm(FAMILY_PASSWORD)]) + ':' + access_gen)
 *   → changing FAMILY_PASSWORD or Reset access (gen++) invalidates every cookie, admin ones included
 *     (docs/PLAN.md "Revoking access"); changing ADMIN_PASSWORD invalidates admin cookies only.
 *     Admin implies family access.
 * fp_device {d, n}: random device id + first name. Signed, survives access resets.
 * Join (QR) token = HMAC(secret, 'join:' + norm(code) + ':' + gen), 128 bits, compared in constant time.
 *
 * Cookies: HttpOnly, SameSite=Lax, Path=/, Max-Age 400 days, Secure iff the request is https.
 */
import type { Cookies } from '@sveltejs/kit';
import { getConfig } from './config';
import {
	adminTag,
	familyTag,
	joinToken as deriveJoinToken,
	norm,
	randomToken,
	safeEqual,
	signValue,
	verifyValue
} from './crypto';
import { bumpAccessGen, getAccessGen, getSecret } from './repo/settings';
import { ValidationError } from '#lib/shared/errors';
import { decodePathname } from './gate';

export { norm };

export const ACCESS_COOKIE = 'fp_access';
export const DEVICE_COOKIE = 'fp_device';
/** 400 days, the maximum browsers honour. */
export const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
/** Re-issue fp_access when it is older than this. */
export const RENEW_AFTER_S = 7 * 24 * 3600;
export const NAME_MAX_CHARS = 40;

export type Role = 'family' | 'admin';

export interface AccessPayload {
	r: Role;
	v: string;
	iat: number;
}

export interface DevicePayload {
	d: string;
	n: string;
}

export interface AccessState {
	role: Role;
	iat: number;
	/** True when the cookie should be re-issued (sliding renewal). */
	stale: boolean;
}

const nowS = (nowMs: number) => Math.floor(nowMs / 1000);

/** The tag a valid cookie for `role` must carry right now. */
export function currentTag(role: Role): string {
	const c = getConfig();
	const secret = getSecret();
	const gen = getAccessGen();
	return role === 'admin'
		? adminTag(secret, c.adminPassword, c.familyPassword, gen)
		: familyTag(secret, c.familyPassword, gen);
}

export function cookieOptions(url: URL, maxAge: number = COOKIE_MAX_AGE_S) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: url.protocol === 'https:',
		maxAge
	};
}

/** Checks a typed family code (forgiving: case, spacing, Unicode width). */
export function checkFamilyCode(input: string): boolean {
	if (typeof input !== 'string' || input.length > 500) return false;
	return safeEqual(norm(input), norm(getConfig().familyPassword));
}

/** Checks the admin password (exact apart from surrounding whitespace). */
export function checkAdminPassword(input: string): boolean {
	if (typeof input !== 'string' || input.length > 500) return false;
	return safeEqual(input.trim(), getConfig().adminPassword.trim());
}

/** Builds the signed fp_access value for a role. */
export function accessValue(role: Role, nowMs: number = Date.now()): string {
	const payload: AccessPayload = { r: role, v: currentTag(role), iat: nowS(nowMs) };
	return signValue(getSecret(), ACCESS_COOKIE, payload);
}

/** Parses + verifies an fp_access value against the current secret, codes and generation. */
export function verifyAccess(value: string | undefined | null, nowMs: number = Date.now()): AccessState | null {
	const p = verifyValue<AccessPayload>(getSecret(), ACCESS_COOKIE, value);
	if (!p || (p.r !== 'family' && p.r !== 'admin') || typeof p.v !== 'string' || typeof p.iat !== 'number') {
		return null;
	}
	const now = nowS(nowMs);
	if (p.iat > now + 300 || now - p.iat > COOKIE_MAX_AGE_S) return null;
	if (!safeEqual(p.v, currentTag(p.r))) return null;
	return { role: p.r, iat: p.iat, stale: now - p.iat > RENEW_AFTER_S };
}

export function readAccess(cookies: Cookies, nowMs: number = Date.now()): AccessState | null {
	return verifyAccess(cookies.get(ACCESS_COOKIE), nowMs);
}

export function issueAccess(cookies: Cookies, url: URL, role: Role, nowMs: number = Date.now()): void {
	cookies.set(ACCESS_COOKIE, accessValue(role, nowMs), cookieOptions(url));
}

export function clearAccess(cookies: Cookies, url: URL): void {
	cookies.delete(ACCESS_COOKIE, cookieOptions(url, 0));
}

// --- device & name ------------------------------------------------------------

export function newDeviceId(): string {
	return randomToken(16);
}

/** Validates a first name: NFC, no control chars, collapsed spaces, 1–40 chars. Throws ValidationError. */
export function cleanName(input: string): string {
	const t = String(input ?? '')
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f<>]/g, '')
		.replace(/\s+/gu, ' ')
		.trim();
	if (t.length === 0) throw new ValidationError('Please type your name.', 'name');
	if (t.length > NAME_MAX_CHARS) throw new ValidationError(`Please keep it under ${NAME_MAX_CHARS} letters.`, 'name');
	return t;
}

export function deviceValue(device: DevicePayload): string {
	return signValue(getSecret(), DEVICE_COOKIE, { d: device.d, n: device.n });
}

export function verifyDevice(value: string | undefined | null): DevicePayload | null {
	const p = verifyValue<DevicePayload>(getSecret(), DEVICE_COOKIE, value);
	if (!p || typeof p.d !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.d) || typeof p.n !== 'string') return null;
	return { d: p.d, n: p.n };
}

export function readDevice(cookies: Cookies): DevicePayload | null {
	return verifyDevice(cookies.get(DEVICE_COOKIE));
}

export function issueDevice(cookies: Cookies, url: URL, device: DevicePayload): void {
	cookies.set(DEVICE_COOKIE, deviceValue(device), cookieOptions(url));
}

// --- join (QR) tokens ---------------------------------------------------------

/** The current join token (changes with FAMILY_PASSWORD and access_gen). */
export function currentJoinToken(): string {
	return deriveJoinToken(getSecret(), getConfig().familyPassword, getAccessGen());
}

export function verifyJoinToken(token: string): boolean {
	if (typeof token !== 'string' || token.length > 100) return false;
	return safeEqual(token, currentJoinToken());
}

/** Absolute QR URL: <origin>/join/<token>[?album=<id>] */
export function joinUrl(origin: string, albumId?: number | null): string {
	const u = new URL(`/join/${currentJoinToken()}`, origin);
	if (albumId !== undefined && albumId !== null) u.searchParams.set('album', String(albumId));
	return u.toString();
}

/**
 * "Reset access": access_gen++. Every cookie (admin ones too) and printed QR code stops working.
 * Pass the admin's own request as `reissueFor` to sign them straight back in as admin with a
 * fresh cookie; otherwise the admin who pressed the button is logged out as well.
 * Returns the new gen.
 */
export function rotateAccess(reissueFor?: { cookies: Cookies; url: URL }): number {
	const gen = bumpAccessGen();
	if (reissueFor) issueAccess(reissueFor.cookies, reissueFor.url, 'admin');
	return gen;
}

// --- redirects -----------------------------------------------------------------

/** Control characters and backslashes are never allowed in a redirect target. */
const UNSAFE_NEXT = /[\\\u0000-\u001f\u007f]/;
/** Pages that make no sense as a post-login target (and could loop). */
const AUTH_PAGES = new Set(['/login', '/name', '/admin/login']);

/**
 * Validates a `next` parameter as a same-origin path (no scheme, no //host, no backslashes),
 * returning pathname+search+hash, or `fallback`. Auth pages are never valid targets.
 *
 * The *normalized* result is checked as well as the input: dot segments can collapse into a
 * protocol-relative URL ('/.//evil.com', '/a/..//evil.com', '/%2e//evil.com' → '//evil.com').
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
	if (!next || typeof next !== 'string' || next.length > 2000) return fallback;
	if (!next.startsWith('/') || next.startsWith('//') || UNSAFE_NEXT.test(next)) return fallback;
	let u: URL;
	try {
		u = new URL(next, 'http://same.invalid');
	} catch {
		return fallback;
	}
	if (u.origin !== 'http://same.invalid') return fallback;
	const out = u.pathname + u.search + u.hash;
	if (!out.startsWith('/') || out.startsWith('//') || UNSAFE_NEXT.test(out)) return fallback;
	let path: string;
	try {
		path = decodePathname(u.pathname); // the path Kit would route, e.g. /%6cogin → /login
	} catch {
		return fallback;
	}
	if (AUTH_PAGES.has(path) || path.startsWith('/join/')) return fallback;
	return out;
}
