/**
 * Maintenance against the per-file temp CONFIG_DIR/PHOTOS_DIR: trash and duplicate purges (rows,
 * then files), backups (rotation, never replacing copies of another database), the .incoming and
 * cache sweeps, the hourly failure email and the timers.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { simpleParser } from 'mailparser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BACKUPS_KEPT,
	DIGEST_MIN_GAP_MS,
	FIRST_RUN_DELAY_MS,
	backupDatabase,
	backupStatus,
	purgeDuplicates,
	runDaily,
	sendFailureDigest,
	startMaintenance,
	stopMaintenance,
	sweepCache,
	sweepIncoming
} from '#lib/server/maintenance';
import { closeDb, getDb } from '#lib/server/db';
import { backupsDir, cacheDir, cacheFile, dbPath, incomingDir, incomingPath, libraryPath, originalsPath, outboxDir } from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import * as requests from '#lib/server/repo/requests';
import { freshDb, setEnv } from '../helpers/env';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
let seq = 0;

function touchFile(file: string, ageMs = 0): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, 'x');
	const t = new Date(Date.now() - ageMs);
	fs.utimesSync(file, t, t);
	return file;
}

const token = () => `tok${String(++seq).padStart(20, '0')}`;

function received(albumId: number, name = 'IMG_0001.HEIC'): string {
	return media.insertReceived({
		uploadToken: token(),
		albumId,
		sourceName: name,
		sourceSize: 100,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
}

/** A ready photo with all its files: canonical, archived original and cached previews. */
function readyWithFiles(albumId: number, extra: Partial<media.ReadyFields> = {}): string {
	const id = received(albumId);
	media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: `sha${++seq}`, estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, { conversion: 'transcode', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: 1, sourceKept: true, ...extra });
	touchFile(libraryPath(id, 'jpg'));
	touchFile(originalsPath(id, 'heic'));
	touchFile(cacheFile(id, 'thumb'));
	touchFile(cacheFile(id, 'display'));
	return id;
}

const exists = (p: string) => fs.existsSync(p);
const setTrashedAt = (id: string, at: number) =>
	getDb().prepare('UPDATE media SET deleted_at = ? WHERE id = ? OR live_photo_of = ?').run(at, id, id);

let album: number;

beforeEach(() => {
	setEnv({ SMTP_HOST: undefined, ADMIN_EMAIL: 'admin@example.com' });
	freshDb();
	for (const dir of [outboxDir(), backupsDir(), incomingDir()]) fs.rmSync(dir, { recursive: true, force: true });
	album = albums.create({ title: 'Beach', createdByName: 'Jo', createdByDevice: null }).id;
});

afterEach(() => {
	stopMaintenance();
	vi.useRealTimers();
});

describe('daily: trash', () => {
	it('deletes items trashed over 30 days ago (files, rows, memories, requests) and keeps newer ones', async () => {
		const old = readyWithFiles(album);
		const recent = readyWithFiles(album);
		const live = readyWithFiles(album);
		memories.add({ mediaId: old, authorName: 'Jo', authorDevice: 'deviceAAAAAAAAAAAAAAAA', body: 'Lovely' });
		requests.create({ mediaId: old, requesterName: 'Jo', requesterDevice: 'deviceAAAAAAAAAAAAAAAA', reason: 'in_it' });
		media.softDelete(old, 'test');
		media.softDelete(recent, 'test');
		setTrashedAt(old, Date.now() - 31 * DAY);
		setTrashedAt(recent, Date.now() - 29 * DAY);

		await runDaily();

		expect(media.getById(old)).toBeUndefined();
		for (const f of [libraryPath(old, 'jpg'), originalsPath(old, 'heic'), cacheDir(old)]) expect(exists(f), f).toBe(false);
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
		expect(getDb().prepare('SELECT COUNT(*) AS n FROM deletion_requests').get()).toEqual({ n: 0 });
		for (const id of [recent, live]) {
			expect(media.getById(id)).toBeDefined();
			expect(exists(libraryPath(id, 'jpg'))).toBe(true);
			expect(exists(cacheFile(id, 'thumb'))).toBe(true);
		}
	});

	it("takes a trashed photo's hidden Live Photo video with it", async () => {
		const photo = readyWithFiles(album, { contentId: 'CID-1' });
		const video = received(album, 'IMG_0001.MOV');
		media.markQueued(video, { kind: 'video', sourceMime: 'video/quicktime', sourceExt: 'mov', sourceSha256: 'shavid', estCostS: 1 });
		media.claimForProcessing(video);
		media.markReady(video, { conversion: 'transcode', canonicalExt: 'mp4', canonicalSize: 1, width: 1, height: 1, durationMs: 2000, takenMs: 1, sourceKept: true, contentId: 'CID-1' });
		expect(media.getById(video)?.live_photo_of).toBe(photo);
		touchFile(libraryPath(video, 'mp4'));
		touchFile(originalsPath(video, 'mov'));
		media.softDelete(photo, 'test');
		setTrashedAt(photo, Date.now() - 31 * DAY);

		await runDaily();

		expect(media.getById(photo)).toBeUndefined();
		expect(media.getById(video)).toBeUndefined();
		expect(exists(libraryPath(video, 'mp4'))).toBe(false);
		expect(exists(originalsPath(video, 'mov'))).toBe(false);
	});
});

describe('daily: duplicates', () => {
	it('deletes duplicate rows older than 24 h with any upload or original they still have', async () => {
		const original = readyWithFiles(album);
		const dupOld = received(album);
		const dupNew = received(album);
		const oldToken = media.getById(dupOld)!.upload_token!;
		touchFile(incomingPath(oldToken));
		touchFile(`${incomingPath(oldToken)}.json`);
		touchFile(originalsPath(dupOld, 'heic'));
		getDb()
			.prepare(`UPDATE media SET status = 'duplicate', duplicate_of = ?, source_ext = 'heic', source_kept = 1, updated_at = ? WHERE id = ?`)
			.run(original, Date.now() - 25 * HOUR, dupOld);
		media.markDuplicate(dupNew, original, 'shaX');

		expect(await purgeDuplicates()).toBe(1);
		expect(media.getById(dupOld)).toBeUndefined();
		expect(exists(originalsPath(dupOld, 'heic'))).toBe(false);
		expect(exists(incomingPath(oldToken))).toBe(false);
		expect(exists(`${incomingPath(oldToken)}.json`)).toBe(false);
		expect(media.getById(dupNew)?.status).toBe('duplicate');
		expect(exists(originalsPath(original, 'heic'))).toBe(true);
	});
});

describe('daily: backups', () => {
	it('writes a consistent app-YYYY-MM-DD.sqlite and keeps the newest seven', async () => {
		fs.mkdirSync(backupsDir(), { recursive: true });
		for (let d = 1; d <= 9; d++) touchFile(path.join(backupsDir(), `app-2026-01-0${d}.sqlite`));
		touchFile(path.join(backupsDir(), 'app-2026-01-09.sqlite.partial'));
		touchFile(path.join(backupsDir(), 'notes.txt'));
		const now = Date.UTC(2026, 9, 13, 3, 0);

		const file = await backupDatabase(now);

		expect(path.basename(file)).toBe('app-2026-10-13.sqlite');
		const names = fs.readdirSync(backupsDir()).sort();
		expect(names.filter((n) => n.endsWith('.sqlite'))).toEqual([
			'app-2026-01-04.sqlite',
			'app-2026-01-05.sqlite',
			'app-2026-01-06.sqlite',
			'app-2026-01-07.sqlite',
			'app-2026-01-08.sqlite',
			'app-2026-01-09.sqlite',
			'app-2026-10-13.sqlite'
		]);
		expect(names.filter((n) => n.endsWith('.sqlite'))).toHaveLength(BACKUPS_KEPT);
		expect(names).toContain('notes.txt'); // not ours: left alone
		expect(names.some((n) => n.endsWith('.partial'))).toBe(false);

		const copy = new Database(file, { readonly: true });
		try {
			expect(copy.prepare('SELECT title FROM albums WHERE id = ?').get(album)).toEqual({ title: 'Beach' });
			expect(copy.pragma('journal_mode', { simple: true })).toBe('delete'); // one file, nothing next to it
		} finally {
			copy.close();
		}
		expect(fs.readdirSync(backupsDir()).filter((n) => /-(wal|shm|journal)$/.test(n))).toEqual([]);
		expect(backupStatus()).toEqual({ lastOkAt: now, error: null, errorAt: null });
	});

	const titlesIn = (file: string): string[] => {
		const db = new Database(file, { readonly: true });
		try {
			return db.prepare('SELECT title FROM albums ORDER BY id').pluck().all() as string[];
		} finally {
			db.close();
		}
	};
	const day = (d: number) => Date.UTC(2026, 9, d, 3, 0);
	const backupFiles = () => fs.readdirSync(backupsDir()).filter((n) => n.endsWith('.sqlite')).sort();

	it('never replaces copies of another database: lost appdata stops the backups until a copy is restored', async () => {
		for (let d = 7; d <= 13; d++) await backupDatabase(day(d));
		const before = backupFiles();
		expect(before).toHaveLength(BACKUPS_KEPT);

		// /config is lost: the app starts on a new, empty database (new secret) next to the old copies.
		freshDb();
		const restart = Date.UTC(2026, 9, 13, 12, 1);
		await expect(backupDatabase(restart)).rejects.toThrow(/different database/);
		for (let d = 14; d <= 21; d++) await expect(backupDatabase(day(d))).rejects.toThrow(/different database/);
		expect(backupFiles()).toEqual(before);
		expect(titlesIn(path.join(backupsDir(), 'app-2026-10-13.sqlite'))).toEqual(['Everyday Photos', 'Beach']);
		expect(fs.readdirSync(backupsDir()).filter((n) => /-(wal|shm|journal)$/.test(n))).toEqual([]);
		const status = backupStatus();
		expect(status).toMatchObject({ lastOkAt: null, errorAt: day(21) });
		expect(status.error).toContain('app-2026-10-13.sqlite');
		expect(status.error).toContain('move the old copies out of .backups');

		// The admin restores the newest copy: backups carry on, and the error is gone.
		closeDb();
		for (const f of ['', '-wal', '-shm']) fs.rmSync(dbPath() + f, { force: true });
		fs.copyFileSync(path.join(backupsDir(), 'app-2026-10-13.sqlite'), dbPath());
		await backupDatabase(day(22));
		expect(backupStatus()).toEqual({ lastOkAt: day(22), error: null, errorAt: null });
		expect(backupFiles()).toHaveLength(BACKUPS_KEPT);
		expect(titlesIn(path.join(backupsDir(), 'app-2026-10-22.sqlite'))).toEqual(['Everyday Photos', 'Beach']);
	});

	it('starting over on purpose: once the old copies are moved away, backups start again', async () => {
		await backupDatabase(day(12));
		freshDb();
		await expect(backupDatabase(day(13))).rejects.toThrow(/different database/);
		fs.renameSync(backupsDir(), `${backupsDir()}-old`);
		await backupDatabase(day(13));
		expect(backupFiles()).toEqual(['app-2026-10-13.sqlite']);
		expect(backupStatus().error).toBeNull();
		fs.rmSync(`${backupsDir()}-old`, { recursive: true, force: true });
	});

	it('reads older copies made in WAL mode without leaving -wal/-shm next to them', async () => {
		fs.mkdirSync(backupsDir(), { recursive: true });
		await getDb().backup(path.join(backupsDir(), 'app-2026-10-12.sqlite')); // as copies were made before
		await backupDatabase(day(13));
		expect(fs.readdirSync(backupsDir()).sort()).toEqual(['app-2026-10-12.sqlite', 'app-2026-10-13.sqlite']);
	});

	it('leaves the copies made before an upgrade alone', async () => {
		fs.mkdirSync(backupsDir(), { recursive: true });
		const pre = touchFile(path.join(backupsDir(), 'app-pre-v1-2026-01-01.sqlite'));
		for (let d = 1; d <= 9; d++) await backupDatabase(day(d));
		expect(exists(pre)).toBe(true);
		expect(backupFiles()).toHaveLength(BACKUPS_KEPT + 1);
	});
});

describe('daily: sweeps', () => {
	it('deletes uploads untouched for 48 h whose token no item uses, and nothing else', async () => {
		const stale = 'abandonedAAAAAAAAAAAAA';
		const fresh = 'stillUploadingBBBBBBBB';
		const jsonOnly = 'orphanJsonCCCCCCCCCCCC';
		const inUse = media.getById(received(album))!.upload_token!;
		touchFile(incomingPath(stale), 49 * HOUR);
		touchFile(`${incomingPath(stale)}.json`, 49 * HOUR);
		touchFile(incomingPath(fresh), 49 * HOUR);
		touchFile(`${incomingPath(fresh)}.json`, HOUR); // metadata touched recently: still going
		touchFile(`${incomingPath(jsonOnly)}.json`, 72 * HOUR);
		touchFile(incomingPath(inUse), 72 * HOUR);
		touchFile(path.join(incomingDir(), 'README.txt'), 72 * HOUR);

		expect(await sweepIncoming()).toBe(2);
		expect(fs.readdirSync(incomingDir()).sort()).toEqual(['README.txt', fresh, `${fresh}.json`, inUse].sort());
	});

	it('keeps the upload of a committed item until its lane has archived or deleted the source', async () => {
		// A lane that died after markReady() but before archiving: the row is ready and still holds its token.
		const id = received(album);
		const tok = media.getById(id)!.upload_token!;
		media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: `sha${++seq}`, estCostS: null });
		media.claimForProcessing(id);
		media.markReady(id, { conversion: 'transcode', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: 1, sourceKept: true });
		touchFile(incomingPath(tok), 72 * HOUR);
		expect(await sweepIncoming()).toBe(0);
		expect(exists(incomingPath(tok))).toBe(true);
		// Settled (here: the lane could not archive it and recorded that): the leftover goes.
		media.markOriginalDeleted(id);
		media.sourceSettled(id);
		expect(await sweepIncoming()).toBe(1);
		expect(exists(incomingPath(tok))).toBe(false);
	});

	it('deletes cache dirs of items that no longer exist once they are an hour old', async () => {
		const id = readyWithFiles(album);
		const gone = '01JAAAAAAAAAAAAAAAAAAAAAZZ';
		const goneNew = '01JBBBBBBBBBBBBBBBBBBBBBZZ';
		touchFile(path.join(cacheDir(gone), 'thumb.webp'));
		touchFile(path.join(cacheDir(goneNew), 'thumb.webp'));
		const old = new Date(Date.now() - 2 * HOUR);
		fs.utimesSync(cacheDir(gone), old, old);
		const stray = touchFile(path.join(path.dirname(cacheDir(id)), 'not-an-id', 'x'));

		expect(await sweepCache()).toBe(1);
		expect(exists(cacheDir(gone))).toBe(false);
		expect(exists(cacheDir(goneNew))).toBe(true);
		expect(exists(cacheFile(id, 'thumb'))).toBe(true);
		expect(exists(stray)).toBe(true);
	});
});

describe('hourly: failure email', () => {
	const emails = () => (fs.existsSync(outboxDir()) ? fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.eml')).sort() : []);

	async function lastEmailText(): Promise<{ subject: string; text: string }> {
		const files = emails();
		const mail = await simpleParser(fs.readFileSync(path.join(outboxDir(), files[files.length - 1])));
		return { subject: mail.subject ?? '', text: mail.text ?? '' };
	}

	function failNow(name: string, at: number): string {
		const id = received(album, name);
		media.markFailed(id, 'corrupt', 'heif-dec: Invalid input: Unexpected end of file\nmore');
		getDb().prepare('UPDATE media SET updated_at = ? WHERE id = ?').run(at, id);
		return id;
	}

	it('sends nothing when nothing failed', async () => {
		expect(await sendFailureDigest()).toBe('nothing');
		expect(emails()).toEqual([]);
	});

	it('lists what failed since the last email, at most once an hour', async () => {
		const t0 = Date.now();
		failNow('IMG_0001.HEIC', t0 - 10 * 60_000);
		expect(await sendFailureDigest(t0)).toBe('saved');
		const first = await lastEmailText();
		expect(first.subject).toBe("1 upload didn't work");
		expect(first.text).toContain('IMG_0001.HEIC, added by Aunt Linda to "Beach": The file is damaged.');
		expect(first.text).toContain('Details: heif-dec: Invalid input: Unexpected end of file');
		expect(first.text).toContain('http://localhost:3000/admin');

		failNow('IMG_0002.HEIC', t0 + 60_000);
		failNow('IMG_0003.HEIC', t0 + 2 * 60_000);
		expect(await sendFailureDigest(t0 + 30 * 60_000)).toBe('skipped');
		expect(emails()).toHaveLength(1);

		expect(await sendFailureDigest(t0 + HOUR)).toBe('saved');
		const second = await lastEmailText();
		expect(second.subject).toBe("2 uploads didn't work");
		expect(second.text).not.toContain('IMG_0001');
		expect(second.text).toContain('IMG_0002.HEIC');
		expect(second.text).toContain('IMG_0003.HEIC');

		expect(await sendFailureDigest(t0 + 2 * HOUR)).toBe('nothing');
		expect(emails()).toHaveLength(2);
	});

	it('allows a few minutes of slack, so a timer that fires a little early still sends', async () => {
		const t0 = Date.now();
		failNow('IMG_0005.HEIC', t0 - 60_000);
		expect(await sendFailureDigest(t0)).toBe('saved');
		failNow('IMG_0006.HEIC', t0 + 60_000);
		expect(await sendFailureDigest(t0 + DIGEST_MIN_GAP_MS - 1)).toBe('skipped');
		expect(await sendFailureDigest(t0 + HOUR - 60_000)).toBe('saved');
		expect(DIGEST_MIN_GAP_MS).toBeGreaterThanOrEqual(50 * 60_000);
	});

	it('keeps the failures for the next hour when sending fails', async () => {
		const t0 = Date.now();
		failNow('IMG_0004.HEIC', t0 - 60_000);
		setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });
		await expect(sendFailureDigest(t0)).rejects.toThrow();
		setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined });
		expect(await sendFailureDigest(t0 + 60_000)).toBe('saved');
		expect((await lastEmailText()).text).toContain('IMG_0004.HEIC');
	});
});

describe('scheduling', () => {
	it('runs a minute after start, keeps hourly and daily timers, and stops cleanly', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		startMaintenance();
		startMaintenance(); // idempotent
		expect(vi.getTimerCount()).toBe(3);
		expect(fs.existsSync(backupsDir()) && fs.readdirSync(backupsDir()).length > 0).toBe(false);

		await vi.advanceTimersByTimeAsync(FIRST_RUN_DELAY_MS);
		vi.useRealTimers();
		await vi.waitFor(() => expect(fs.readdirSync(backupsDir()).some((n) => n.endsWith('.sqlite'))).toBe(true), { timeout: 10_000 });

		stopMaintenance();
	});

	it('emails failures on the first hourly run and again on the next one, an hour later', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		const emails = () => (fs.existsSync(outboxDir()) ? fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.eml')) : []);
		const fail = (name: string) => media.markFailed(received(album, name), 'corrupt', 'broken');
		fail('IMG_0007.HEIC');
		startMaintenance();

		await vi.advanceTimersByTimeAsync(FIRST_RUN_DELAY_MS);
		await vi.waitFor(() => expect(emails()).toHaveLength(1), { timeout: 10_000 });
		// The daily run started at the same time; let it finish before the clock moves on.
		await vi.waitFor(() => expect(fs.readdirSync(backupsDir()).some((n) => n.endsWith('.sqlite'))).toBe(true), { timeout: 10_000 });

		fail('IMG_0008.HEIC');
		await vi.advanceTimersByTimeAsync(HOUR - 1000);
		expect(emails()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1000); // the hourly timer: 59 minutes after the first email
		await vi.waitFor(() => expect(emails()).toHaveLength(2), { timeout: 10_000 });
	});

	it('the daily run also deletes saved emails older than 90 days', async () => {
		fs.mkdirSync(outboxDir(), { recursive: true });
		const old = touchFile(path.join(outboxDir(), '2026-01-01T00-00-00-000Z-0badc0de.eml'), 91 * DAY);
		const recent = touchFile(path.join(outboxDir(), '2026-10-01T00-00-00-000Z-0badc0de.eml'), 10 * DAY);
		await runDaily();
		expect(exists(old)).toBe(false);
		expect(exists(recent)).toBe(true);
	});

	it('stopMaintenance clears every timer', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		startMaintenance();
		stopMaintenance();
		expect(vi.getTimerCount()).toBe(0);
	});
});
