/**
 * Maintenance (main process; docs/PLAN.md "Storage layout" and "Removal requests").
 *
 * Daily (first run one minute after start):
 *   - items in the trash for more than 30 days are deleted for good (rows, then files; files that
 *     could not be deleted are tried again)
 *   - `duplicate` rows older than 24 h are deleted, with any upload/original they still have
 *   - db.backup() → PHOTOS_DIR/.backups/app-YYYY-MM-DD.sqlite; the newest 7 are kept. Skipped
 *     (with the reason on the admin page) while the newest copy there is of a different database:
 *     app.sqlite was lost or replaced, and copying the new one would push the real copies out.
 *   - .incoming sweep: tus files untouched for 48 h whose token no item uses, and FileStore
 *     <token>.json files the lanes leave behind for items that are done (their token is cleared)
 *   - cache dirs of items that no longer exist (untouched for an hour)
 *   - saved emails (outbox/*.eml) older than 90 days
 * Hourly (also one minute after start):
 *   - one email to ADMIN_EMAIL listing the items that failed since the last one; none when nothing
 *     new, and about one an hour at most (the time of the last one is kept in settings across
 *     restarts; a few minutes' slack keeps timer and clock drift from skipping a whole hour)
 *   - removal-request emails a restart left unsent
 *
 * Timers are unref'd. Each step logs its own failure and never stops the others.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getConfig, publicOrigin } from './config';
import { getDb, tx } from './db';
import { backupPath, backupsDir, cacheRoot, incomingDir } from './paths';
import { pruneOutbox, sendMail, type MailMessage, type MailResult } from './mail';
import { sendStuckRemovalEmails } from './removal';
import { ERROR_CODE_LABELS, TRASH_KEEP_MS, deleteQueuedFiles, purgeTrash, removeInside } from './admin';
import * as media from './repo/media';
import { albumTitles, existingMediaIds, queueFileDeletions } from './repo/admin';
import { deleteSetting, getNumber, getSecret, getSetting, setNumber, setSetting } from './repo/settings';
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
/**
 * The failure email goes at most once per this long. A little under an hour, so the hourly timer
 * (which fires a minute after the first run, and drifts against the wall clock) never skips an hour.
 */
export const DIGEST_MIN_GAP_MS = HOUR_MS - 5 * MINUTE_MS;
const DIGEST_SETTING = 'failure_digest_at';

const BACKUP_NAME = /^app-\d{4}-\d{2}-\d{2}\.sqlite$/;
/** A backup being written when the app stopped (with what SQLite may have left next to it). */
const PARTIAL_NAME = /^app-.*\.sqlite\.partial(-wal|-shm|-journal)?$/;
/** Files SQLite keeps next to a database file. */
const SIDE_FILES = ['-wal', '-shm', '-journal'];
const BACKUP_OK_SETTING = 'backup_ok_at';
const BACKUP_ERROR_SETTING = 'backup_error';
const BACKUP_ERROR_AT_SETTING = 'backup_error_at';
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

/**
 * Deletes old `duplicate` rows and whatever files they still have (rows first, recording the files
 * in the same transaction; see admin.deleteQueuedFiles). Returns how many.
 */
export async function purgeDuplicates(now: number = Date.now()): Promise<number> {
	const rows = tx(() => {
		const gone = media.purgeDuplicatesOlderThan(DUPLICATE_KEEP_MS, now);
		queueFileDeletions(gone, now);
		return gone;
	});
	await deleteQueuedFiles();
	return rows.length;
}

/** Nightly backups in .backups, newest first. */
function backupNames(entries: readonly fs.Dirent[]): string[] {
	return entries
		.filter((e) => e.isFile() && BACKUP_NAME.test(e.name))
		.map((e) => e.name)
		.sort()
		.reverse();
}

/**
 * The `secret` setting in a backup: which database it is a copy of (seed() picks it at random on
 * first boot and nothing changes it; "Reset access" changes access_gen). undefined when the file
 * can't be read as one of our databases.
 */
function backupIdentity(file: string): string | undefined {
	// A read-only open of a copy in WAL mode (as copies were before they were made single files)
	// leaves an empty -wal and -shm next to it; those are removed again.
	const absent = ['-wal', '-shm'].map((s) => file + s).filter((f) => !fs.existsSync(f));
	let db: Database.Database | null = null;
	try {
		db = new Database(file, { readonly: true, fileMustExist: true });
		const value = db.prepare("SELECT value FROM settings WHERE key = 'secret'").pluck().get();
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	} finally {
		db?.close();
		for (const f of absent) fs.rmSync(f, { force: true });
	}
}

/** Why no backup was made while .backups holds copies of another database (admin page and log). */
export function differentDatabaseMessage(newest: string): string {
	return (
		`No new copy was made: the copies in .backups (the newest is ${newest}) are of a different database, ` +
		'so app.sqlite was lost or replaced, and a new copy would push them out. To get the albums back, stop ' +
		'the container and restore the newest copy from before the problem (see "Backups" in the README). ' +
		'To start over on purpose, move the old copies out of .backups.'
	);
}

/**
 * Backs the database up to .backups/app-<UTC date>.sqlite (written as .partial, made a single file
 * with no -wal, then renamed) and keeps the newest BACKUPS_KEPT. Refuses (throws, writing and
 * deleting nothing) when the newest readable copy there is of a different database. The outcome is
 * kept in settings for the admin page (backupStatus). Returns the backup's path.
 */
export async function backupDatabase(now: number = Date.now()): Promise<string> {
	try {
		const file = await writeBackup(now);
		setNumber(BACKUP_OK_SETTING, now);
		deleteSetting(BACKUP_ERROR_SETTING);
		deleteSetting(BACKUP_ERROR_AT_SETTING);
		return file;
	} catch (e) {
		try {
			setSetting(BACKUP_ERROR_SETTING, e instanceof Error ? e.message : String(e));
			setNumber(BACKUP_ERROR_AT_SETTING, now);
		} catch {
			// the database itself is in trouble; the log has the backup error
		}
		throw e;
	}
}

async function writeBackup(now: number): Promise<string> {
	const dir = backupsDir();
	await fs.promises.mkdir(dir, { recursive: true });
	const live = getSecret();
	for (const name of backupNames(await list(dir))) {
		const identity = backupIdentity(path.join(dir, name));
		if (identity === undefined) continue; // not readable as ours: look at the next one
		if (identity !== live) throw new Error(differentDatabaseMessage(name));
		break;
	}

	const file = backupPath(new Date(now));
	const partial = `${file}.partial`;
	for (const f of [partial, ...SIDE_FILES.map((s) => partial + s)]) await fs.promises.rm(f, { force: true });
	await getDb().backup(partial);
	const copy = new Database(partial);
	try {
		copy.pragma('journal_mode = DELETE'); // one self-contained file, also when opened read-only
	} finally {
		copy.close();
	}
	// Side files of the copy being replaced would be applied to the new one when it is opened.
	for (const s of SIDE_FILES) await fs.promises.rm(file + s, { force: true });
	await fs.promises.rename(partial, file);

	const entries = await list(dir);
	const old = backupNames(entries).slice(BACKUPS_KEPT);
	const stale = entries.filter((e) => e.isFile() && PARTIAL_NAME.test(e.name)).map((e) => e.name);
	for (const name of [...old.flatMap((n) => [n, ...SIDE_FILES.map((s) => n + s)]), ...stale]) {
		await removeInside(dir, path.join(dir, name));
	}
	return file;
}

export interface BackupStatus {
	/** When the last database copy was made. */
	lastOkAt: number | null;
	/** Why the last attempt didn't work (cleared by the next copy that works). */
	error: string | null;
	errorAt: number | null;
}

/** The nightly backup's last outcome, for the admin page. */
export function backupStatus(): BackupStatus {
	return {
		lastOkAt: getNumber(BACKUP_OK_SETTING) ?? null,
		error: getSetting(BACKUP_ERROR_SETTING) ?? null,
		errorAt: getNumber(BACKUP_ERROR_AT_SETTING) ?? null
	};
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
 * under DIGEST_MIN_GAP_MS ago, 'nothing' when there is nothing new (or no ADMIN_EMAIL). A failed
 * send keeps the cursor, so the next hour tries again with everything since.
 */
export async function sendFailureDigest(now: number = Date.now()): Promise<MailResult | 'skipped' | 'nothing'> {
	const last = getNumber(DIGEST_SETTING);
	if (last !== undefined && now - last < DIGEST_MIN_GAP_MS) return 'skipped';
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
	await step('old saved emails deleted', () => pruneOutbox(now));
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
