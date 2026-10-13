/** settings(key, value): secret, access_gen, default_album_id, plus free-form keys. */
import { stmt, tx } from '#lib/server/db';

export function getSetting(key: string): string | undefined {
	const row = stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
	return row?.value;
}

export function setSetting(key: string, value: string): void {
	stmt(
		'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
	).run(key, value);
}

export function deleteSetting(key: string): void {
	stmt('DELETE FROM settings WHERE key = ?').run(key);
}

/** HMAC secret for cookies and join tokens (seeded on first boot). */
export function getSecret(): string {
	const s = getSetting('secret');
	if (!s) throw new Error('settings.secret is missing; the database was not seeded');
	return s;
}

/** Access generation: bumping it invalidates every cookie and printed QR code. */
export function getAccessGen(): number {
	const n = Number(getSetting('access_gen') ?? '1');
	return Number.isInteger(n) && n > 0 ? n : 1;
}

/** "Reset access": access_gen++ (atomic). Returns the new generation. */
export function bumpAccessGen(): number {
	return tx(() => {
		const next = getAccessGen() + 1;
		setSetting('access_gen', String(next));
		return next;
	});
}

/** The seeded "Everyday Photos" album id. */
export function getDefaultAlbumId(): number | null {
	const v = getSetting('default_album_id');
	const n = v === undefined ? NaN : Number(v);
	return Number.isInteger(n) ? n : null;
}

export function getNumber(key: string): number | undefined {
	const v = getSetting(key);
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

export function setNumber(key: string, value: number): void {
	setSetting(key, String(value));
}
