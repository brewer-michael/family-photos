/**
 * Pure crypto helpers for access cookies and join (QR) tokens.
 *
 * This module only imports node:crypto so that tests (including Playwright e2e
 * helpers, which import it by relative path) can derive the exact same values.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Forgiving family-code normalisation: NFKC, trimmed, lower-cased, runs of
 * whitespace collapsed to a single space. "  Blue  LAKE\tCabin " → "blue lake cabin".
 */
export function norm(code: string): string {
	return code.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function b64url(buf: Buffer | Uint8Array): string {
	return Buffer.from(buf).toString('base64url');
}

export function hmac(secret: string, data: string): Buffer {
	return createHmac('sha256', secret).update(data, 'utf8').digest();
}

/** Constant-time string comparison that is safe for inputs of different length. */
export function safeEqual(a: string, b: string): boolean {
	const ha = createHash('sha256').update(a, 'utf8').digest();
	const hb = createHash('sha256').update(b, 'utf8').digest();
	return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Random URL-safe id (default 128 bits → 22 chars). */
export function randomToken(bytes = 16): string {
	return b64url(randomBytes(bytes));
}

/** Tag stored in fp_access for the family role: HMAC(secret, 'fam:'+norm(code)+':'+gen). */
export function familyTag(secret: string, familyCode: string, gen: number): string {
	return b64url(hmac(secret, `fam:${norm(familyCode)}:${gen}`)).slice(0, 22);
}

/**
 * Tag stored in fp_access for the admin role:
 * HMAC(secret, 'adm:' + JSON([ADMIN_PASSWORD, norm(code)]) + ':' + gen). Changes with ADMIN_PASSWORD,
 * the family code and access_gen, so a new family code logs everyone out, admins included.
 * (JSON keeps the two secrets unambiguous even when they contain ':'.)
 */
export function adminTag(secret: string, adminPassword: string, familyCode: string, gen: number): string {
	return b64url(hmac(secret, `adm:${JSON.stringify([adminPassword.trim(), norm(familyCode)])}:${gen}`)).slice(0, 22);
}

/** QR/join token: HMAC(secret,'join:'+norm(code)+':'+gen) truncated to 128 bits (22 chars). */
export function joinToken(secret: string, familyCode: string, gen: number): string {
	return b64url(hmac(secret, `join:${norm(familyCode)}:${gen}`)).slice(0, 22);
}

/**
 * Signed cookie value: base64url(JSON(payload)) + '.' + base64url(HMAC(secret, name + '.' + body)).
 * The cookie name is part of the MAC so a value can't be replayed under another name.
 */
export function signValue(secret: string, name: string, payload: unknown): string {
	const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
	const mac = b64url(hmac(secret, `${name}.${body}`));
	return `${body}.${mac}`;
}

/** Returns the parsed payload, or null if the value is malformed or the MAC doesn't match. */
export function verifyValue<T = unknown>(secret: string, name: string, value: string | undefined | null): T | null {
	if (!value || value.length > 4096) return null;
	const dot = value.indexOf('.');
	if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
	const body = value.slice(0, dot);
	const mac = value.slice(dot + 1);
	const expected = b64url(hmac(secret, `${name}.${body}`));
	if (!safeEqual(mac, expected)) return null;
	try {
		return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
	} catch {
		return null;
	}
}
