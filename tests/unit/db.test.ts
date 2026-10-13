import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_VERSION, migrate, openDb, seed, userVersion, DEFAULT_ALBUM_TITLE } from '#lib/server/db';
import { migrations } from '#lib/server/db/migrations/index';
import { backupsDir } from '#lib/server/paths';
import { testEnv } from '../helpers/env';

function tempDbPath(name: string): string {
	const dir = path.join(testEnv().root, 'db-tests');
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, name);
}

describe('migrations', () => {
	it('are loaded from migrations/*.sql (import.meta.glob ?raw)', () => {
		expect(migrations.length).toBeGreaterThanOrEqual(1);
		expect(migrations[0]).toMatchObject({ version: 1, name: '001_init.sql' });
		expect(migrations[0].sql).toContain('CREATE TABLE media');
		expect(LATEST_VERSION).toBe(migrations.length);
	});

	it('migrate + seed on a fresh database, idempotently', () => {
		const file = tempDbPath('fresh.sqlite');
		const db = openDb({ migrate: true, path: file });
		expect(userVersion(db)).toBe(LATEST_VERSION);
		expect(migrate(db)).toBe(0); // nothing left to apply
		seed(db);
		seed(db);
		const albums = db.prepare('SELECT title FROM albums').all() as { title: string }[];
		expect(albums).toEqual([{ title: DEFAULT_ALBUM_TITLE }]);
		const settings = Object.fromEntries(
			(db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
		);
		expect(settings.secret).toMatch(/^[0-9a-f]{64}$/);
		expect(settings.access_gen).toBe('1');
		expect(Number(settings.default_album_id)).toBeGreaterThan(0);
		const secret = settings.secret;
		db.close();

		// reopen: same secret, still one album
		const again = openDb({ migrate: true, path: file });
		expect(again.prepare("SELECT value FROM settings WHERE key = 'secret'").pluck().get()).toBe(secret);
		expect(again.prepare('SELECT COUNT(*) FROM albums').pluck().get()).toBe(1);
		again.close();
	});

	it('sets WAL, foreign keys, busy_timeout 5000 and synchronous FULL (durable commits)', () => {
		const db = openDb({ migrate: true, path: tempDbPath('pragmas.sqlite') });
		expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
		expect(db.pragma('synchronous', { simple: true })).toBe(2); // FULL
		db.close();
	});

	it('migrate: false refuses an unmigrated database (worker before web)', () => {
		const file = tempDbPath('empty.sqlite');
		expect(() => openDb({ migrate: false, path: file })).toThrow(/schema version 0/);
		openDb({ migrate: true, path: file }).close();
		const worker = openDb({ migrate: false, path: file });
		expect(userVersion(worker)).toBe(LATEST_VERSION);
		worker.close();
	});

	/** A database as version 1 of the app left it: only 001 applied, with an album in it. */
	function versionOneDb(name: string): string {
		const file = tempDbPath(name);
		const db = new Database(file);
		db.pragma('journal_mode = WAL');
		db.exec(migrations[0].sql);
		db.pragma('user_version = 1');
		db.prepare("INSERT INTO settings(key, value) VALUES ('secret', 'v1-secret')").run();
		db.prepare("INSERT INTO albums(title, created_at, updated_at) VALUES ('Grandma 90th', 1, 1)").run();
		db.close();
		return file;
	}
	const preCopy = () => path.join(backupsDir(), `app-pre-v1-${new Date().toISOString().slice(0, 10)}.sqlite`);

	it('copies the database to .backups before upgrading it (once a day per version), and not a new one', () => {
		expect(LATEST_VERSION).toBeGreaterThan(1);
		fs.rmSync(backupsDir(), { recursive: true, force: true });
		openDb({ migrate: true, path: tempDbPath('new.sqlite') }).close();
		expect(fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()) : []).toEqual([]);

		const file = versionOneDb('upgrade.sqlite');
		const db = openDb({ migrate: true, path: file });
		expect(userVersion(db)).toBe(LATEST_VERSION);
		db.close();
		expect(fs.readdirSync(backupsDir())).toEqual([path.basename(preCopy())]);
		const copy = new Database(preCopy(), { readonly: true });
		try {
			expect(copy.pragma('user_version', { simple: true })).toBe(1); // the old version can open it
			expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
			expect(copy.prepare('SELECT title FROM albums').pluck().all()).toEqual(['Grandma 90th']);
		} finally {
			copy.close();
		}

		// A second v1 database upgraded the same day (a retried start) doesn't pile up copies.
		openDb({ migrate: true, path: versionOneDb('upgrade-again.sqlite') }).close();
		expect(fs.readdirSync(backupsDir())).toEqual([path.basename(preCopy())]);
		fs.rmSync(backupsDir(), { recursive: true, force: true });
	});

	it('does not upgrade when the copy before it cannot be made', () => {
		fs.rmSync(backupsDir(), { recursive: true, force: true });
		fs.mkdirSync(path.dirname(backupsDir()), { recursive: true });
		fs.writeFileSync(backupsDir(), 'not a folder');
		try {
			const file = versionOneDb('blocked.sqlite');
			expect(() => openDb({ migrate: true, path: file })).toThrow(/Could not copy the database .* before upgrading it from version 1/);
			const db = new Database(file, { readonly: true });
			expect(db.pragma('user_version', { simple: true })).toBe(1);
			db.close();
		} finally {
			fs.rmSync(backupsDir(), { force: true });
		}
	});

	it('counts the items of an album from the index alone (admin album list)', () => {
		const db = openDb({ migrate: true, path: tempDbPath('plan.sqlite') });
		const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as { detail: string }[]).map((r) => r.detail).join(' | ');
		// Searched in the index (a scan would read the whole media table once per album).
		expect(plan('SELECT COUNT(*) FROM media m WHERE m.album_id = ? AND m.live_photo_of IS NULL')).toBe(
			'SEARCH m USING INDEX media_album_items (album_id=?)'
		);
		expect(
			plan(`SELECT COUNT(*) FROM media m WHERE m.album_id = ? AND m.live_photo_of IS NULL AND m.status = 'ready' AND m.deleted_at IS NULL`)
		).toBe('SEARCH m USING INDEX media_album_items (album_id=? AND status=? AND deleted_at=?)');
		// The album grid keeps its own index (and its order).
		expect(
			plan(`SELECT id FROM media WHERE album_id = ? AND status = 'ready' AND deleted_at IS NULL AND live_photo_of IS NULL ORDER BY taken_ms DESC, id DESC LIMIT 60`)
		).toContain('media_album_view');
		db.close();
	});

	it('refuses a database from a newer build', () => {
		const file = tempDbPath('newer.sqlite');
		const db = openDb({ migrate: true, path: file });
		db.pragma(`user_version = ${LATEST_VERSION + 1}`);
		db.close();
		expect(() => openDb({ migrate: true, path: file })).toThrow(/newer than this build/);
	});

	it('enforces the CHECK constraints and STRICT types', () => {
		const db = openDb({ migrate: true, path: tempDbPath('checks.sqlite') });
		const now = Date.now();
		const ins = db.prepare(
			`INSERT INTO media(id, album_id, uploaded_by_name, uploaded_by_device, status, source_name, source_size, created_at, updated_at)
			 VALUES (?, 1, 'A', 'dev', ?, 'x.jpg', 1, ?, ?)`
		);
		expect(() => ins.run('01ARZ3NDEKTSV4RRFFQ69G5FA1', 'bogus', now, now)).toThrow(/CHECK/);
		ins.run('01ARZ3NDEKTSV4RRFFQ69G5FA2', 'received', now, now);
		expect(() =>
			db.prepare(`UPDATE media SET error_code = 'nope' WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FA2'`).run()
		).toThrow(/CHECK/);
		expect(() =>
			db.prepare(`UPDATE media SET width = 'wide' WHERE id = '01ARZ3NDEKTSV4RRFFQ69G5FA2'`).run()
		).toThrow();
		expect(() =>
			db.prepare(`INSERT INTO memories(media_id, author_name, author_device, body, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FA2','A','d','',1,1)`).run()
		).toThrow(/CHECK/);
		// foreign keys are on
		expect(() =>
			db.prepare(`INSERT INTO memories(media_id, author_name, author_device, body, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FA9','A','d','hi',1,1)`).run()
		).toThrow(/FOREIGN KEY/);
		db.close();
	});
});
