/**
 * Maintenance (main process; docs/PLAN.md "Storage layout" and "Removal requests").
 *
 * Daily (first run one minute after start):
 *   - items in the trash for more than 30 days are deleted for good (files, then rows)
 *   - `duplicate` rows older than 24 h are deleted, with any upload/original they still have
 *   - db.backup() → PHOTOS_DIR/.backups/app-YYYY-MM-DD.sqlite; the newest 7 are kept
 *   - .incoming sweep: tus files untouched for 48 h whose token no item uses
 *   - cache dirs of items that no longer exist (untouched for an hour)
 * Hourly (also one minute after start):
 *   - one email to ADMIN_EMAIL listing the items that failed since the last one; none when nothing
 *     new, and at most one an hour (the time of the last one is kept in settings across restarts)
 *   - removal-request emails a restart left unsent
 *
 * Timers are unref'd. Each step logs its own failure and never stops the others.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, publicOrigin } from './config';
import { getDb } from './db';
import { backupPath, backupsDir, cacheRoot, incomingDir } from './paths';
import { sendMail, type MailMessage, type MailResult } from './mail';
import { sendStuckRemovalEmails } from './removal';
import { ERROR_CODE_LABELS, TRASH_KEEP_MS, deleteItemFiles, purgeTrash, removeInside } from './admin';
import * as media from './repo/media';
import { albumTitles, existingMediaIds } from './repo/admin';
import { getNumber, setNumber } from './repo/settings';
import { ULID_RE } from '#lib/shared/media-types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const FIRST_RUN_DELAY_MS = MINUTE_MS;
export const DUPLICATE_KEEP_MS = DAY_MS;
export const INCOMING_KEEP_MS = 48 * HOUR_MS;
/** Orphaned cache dirs younger than this are left alone (a job may still be writing them). */
export const CACHE_ORPHAN_MIN_AGE_MS = HOUR_MS;
export const BACKUPS_KEPT = 7;
/** Removal-request emails still `pending` after this long were lost to a restart. */
const STUCK_EMAIL_MS = 10 * MINUTE_MS;
const DIGEST_SETTING = 'failure_digest_at';

const BACKUP_NAME = /^app-\d{4}-\d{2}-\d{2}\.sqlite$/;
/** A tus upload (<token>) or its FileStore metadata (<token>.json); see paths.incomingPath(). */
const INCOMING_NAME = /^([A-Za-z0-9_-]{16,64})(\.json)?$/;
const SHARD_NAME = /^[0-9A-HJKMNP-TV-Z]{2}$/;

/** Directory entries, or none when the directory doesn't exist yet. */
async function list(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw e;
	}
}

/** mtime in ms, or null when the file vanished meanwhile. */
async function mtime(p: string): Promise<number | null> {
	try {
		return (await fs.promises.stat(p)).mtimeMs;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Daily steps
// ---------------------------------------------------------------------------

/** Deletes old `duplicate` rows and whatever files they still have. Returns how many. */
export async function purgeDuplicates(now: number = Date.now()): Promise<number> {
	const rows = media.purgeDuplicatesOlderThan(DUPLICATE_KEEP_MS, now);
	for (const row of rows) await deleteItemFiles(row);
	return rows.length;
}

/**
 * Backs the database up to .backups/app-<UTC date>.sqlite (written as .partial, then renamed) and
 * keeps the newest BACKUPS_KEPT. Returns the backup's path.
 */
export async function backupDatabase(now: number = Date.now()): Promise<string> {
	const dir = backupsDir();
	await fs.promises.mkdir(dir, { recursive: true });
	const file = backupPath(new Date(now));
	const partial = `${file}.partial`;
	await fs.promises.rm(partial, { force: true });
	await getDb().backup(partial);
	await fs.promises.rename(partial, file);

	const entries = await list(dir);
	const backups = entries
		.filter((e) => e.isFile() && BACKUP_NAME.test(e.name))
		.map((e) => e.name)
		.sort()
		.reverse();
	const stale = entries.filter((e) => e.isFile() && e.name.endsWith('.sqlite.partial')).map((e) => e.name);
	for (const name of [...backups.slice(BACKUPS_KEPT), ...stale]) await removeInside(dir, path.join(dir, name));
	return file;
}

/** Deletes tus uploads (and their .json) untouched for 48 h whose token no item uses. Returns how many uploads. */
export async function sweepIncoming(now: number = Date.now()): Promise<number> {
	const dir = incomingDir();
	const inUse = media.tokensInUse();
	const groups = new Map<string, string[]>();
	for (const e of await list(dir)) {
		const m = e.isFile() ? INCOMING_NAME.exec(e.name) : null;
		if (!m || inUse.has(m[1])) continue;
		groups.set(m[1], [...(groups.get(m[1]) ?? []), path.join(dir, e.name)]);
	}
	let removed = 0;
	for (const files of groups.values()) {
		const times = await Promise.all(files.map(mtime));
		if (times.some((t) => t !== null && t > now - INCOMING_KEEP_MS)) continue;
		for (const f of files) await removeInside(dir, f);
		removed++;
	}
	return removed;
}

/** Deletes cache/<sh>/<id>/ dirs of items that no longer exist. Returns how many. */
export async function sweepCache(now: number = Date.now()): Promise<number> {
	const root = cacheRoot();
	let removed = 0;
	for (const shard of await list(root)) {
		if (!shard.isDirectory() || !SHARD_NAME.test(shard.name)) continue;
		const shardDir = path.join(root, shard.name);
		const ids = (await list(shardDir))
			.filter((e) => e.isDirectory() && ULID_RE.test(e.name) && e.name.endsWith(shard.name))
			.map((e) => e.name);
		const existing = existingMediaIds(ids);
		for (const id of ids) {
			if (existing.has(id)) continue;
			const dir = path.join(shardDir, id);
			const t = await mtime(dir);
			if (t === null || t > now - CACHE_ORPHAN_MIN_AGE_MS) continue;
			await removeInside(root, dir);
			removed++;
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Hourly: failure digest
// ---------------------------------------------------------------------------

/** The admin email listing failed items (pure). */
export function failureDigestEmail(to: string, rows: readonly media.MediaRow[], origin: string): MailMessage {
	const titles = albumTitles();
	const n = rows.length;
	const lines = rows.map((r) => {
		const album = titles.get(r.album_id) ?? 'an album';
		const why = r.error_code ? ERROR_CODE_LABELS[r.error_code] : 'It did not work';
		const detail = (r.error_detail ?? '').split('\n')[0].slice(0, 300);
		return `- ${r.source_name}, added by ${r.uploaded_by_name} to "${album}": ${why}.${detail ? `\n  Details: ${detail}` : ''}`;
	});
	return {
		to,
		subject: `${n} ${n === 1 ? "upload didn't" : "uploads didn't"} work`,
		text: [
			`${n === 1 ? 'This upload' : `These ${n} uploads`} could not be added:`,
			'',
			...lines,
			'',
			`You can try them again or remove them on the admin page: ${origin}/admin`,
			''
		].join('\n')
	};
}

/**
 * Emails the admin the items that failed since the last digest. 'skipped' when the last one was
 * under an hour ago, 'nothing' when there is nothing new (or no ADMIN_EMAIL). A failed send keeps
 * the cursor, so the next hour tries again with everything since.
 */
export async function sendFailureDigest(now: number = Date.now()): Promise<MailResult | 'skipped' | 'nothing'> {
	const last = getNumber(DIGEST_SETTING);
	if (last !== undefined && now - last < HOUR_MS) return 'skipped';
	const rows = media.listFailed({ sinceMs: last ?? now - HOUR_MS, limit: 500 }).filter((r) => r.updated_at < now);
	const to = getConfig().adminEmail;
	if (rows.length === 0 || !to) {
		setNumber(DIGEST_SETTING, now);
		return 'nothing';
	}
	const result = await sendMail(failureDigestEmail(to, rows, publicOrigin()));
	setNumber(DIGEST_SETTING, now);
	return result;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		const result = await fn();
		if (typeof result === 'number' ? result > 0 : result !== 'nothing' && result !== 'skipped') {
			console.log(`[maintenance] ${name}: ${result}`);
		}
	} catch (e) {
		console.error(`[maintenance] ${name} failed:`, e instanceof Error ? e.message : e);
	}
}

/** Every daily step, one after another. */
export async function runDaily(now: number = Date.now()): Promise<void> {
	await step('items deleted from the trash for good', () => purgeTrash(TRASH_KEEP_MS, now));
	await step('old duplicates deleted', () => purgeDuplicates(now));
	await step('database backup', () => backupDatabase(now));
	await step('abandoned uploads deleted', () => sweepIncoming(now));
	await step('orphaned previews deleted', () => sweepCache(now));
}

/** Every hourly step. */
export async function runHourly(now: number = Date.now()): Promise<void> {
	await step('failure email', () => sendFailureDigest(now));
	await step('unsent removal-request emails retried', () => sendStuckRemovalEmails(STUCK_EMAIL_MS, now));
}

let timers: NodeJS.Timeout[] = [];
const busy = new Set<string>();

/** Runs a job unless its previous run is still going. */
function once(name: string, job: () => Promise<void>): () => void {
	return () => {
		if (busy.has(name)) return;
		busy.add(name);
		void job().finally(() => busy.delete(name));
	};
}

export function startMaintenance(): void {
	if (timers.length > 0) return;
	const daily = once('daily', () => runDaily());
	const hourly = once('hourly', () => runHourly());
	const first = setTimeout(() => {
		hourly();
		daily();
	}, FIRST_RUN_DELAY_MS);
	timers = [first, setInterval(hourly, HOUR_MS), setInterval(daily, DAY_MS)];
	for (const t of timers) t.unref();
}

export function stopMaintenance(): void {
	for (const t of timers) clearTimeout(t);
	timers = [];
}
