/** settings(key, value): secret, access_gen, default_album_id, plus free-form keys. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stmt, tx } from '#lib/server/db';
import { backupsDir } from '#lib/server/paths';

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

/**
 * "Reset access": access_gen++ (atomic). Returns the new generation. It is also recorded on the
 * photos share (.backups/access-gen), so restoring an older copy of the database can't bring back
 * the cookies and QR cards this reset revoked (restoreAccessGen).
 */
export function bumpAccessGen(): number {
	const next = tx(() => {
		const n = getAccessGen() + 1;
		setSetting('access_gen', String(n));
		return n;
	});
	recordAccessGen(next);
	return next;
}

/** Last "Reset access" of this database, next to its nightly copies (they hold an older access_gen). */
const accessGenFile = (): string => path.join(backupsDir(), 'access-gen');

/** Which database a recorded generation belongs to: a hash of its secret (never the secret). */
const databaseId = (): string => createHash('sha256').update(`access-gen:${getSecret()}`).digest('hex').slice(0, 32);

function recordedAccessGen(): number {
	try {
		const r = JSON.parse(fs.readFileSync(accessGenFile(), 'utf8')) as { db?: unknown; gen?: unknown };
		return r.db === databaseId() && Number.isInteger(r.gen) && (r.gen as number) > 0 ? (r.gen as number) : 0;
	} catch {
		return 0; // none yet, unreadable, or not ours
	}
}

function recordAccessGen(gen: number): void {
	const file = accessGenFile();
	try {
		if (recordedAccessGen() >= gen) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ db: databaseId(), gen })}\n`);
		fs.renameSync(`${file}.tmp`, file);
	} catch (e) {
		console.error(`[settings] could not record access generation ${gen} in ${file}: ${(e as Error).message}`);
	}
}

/**
 * At startup. A database restored from an older copy has the access_gen of that day, so QR cards
 * and cookies revoked by a "Reset access" since then would work again. access_gen never goes below
 * the last reset recorded for this database. Returns the generation in use.
 */
export function restoreAccessGen(): number {
	const gen = getAccessGen();
	const recorded = recordedAccessGen();
	if (recorded <= gen) return gen;
	setSetting('access_gen', String(recorded));
	console.warn(
		`[settings] the database is from before the last "Reset access" (it was restored from a copy?); ` +
			`QR cards and sign-ins from before that reset stay revoked`
	);
	return recorded;
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
