import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATEST_VERSION, migrate, openDb, seed, userVersion, DEFAULT_ALBUM_TITLE } from '#lib/server/db';
import { migrations } from '#lib/server/db/migrations/index';
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

	it('sets WAL, foreign keys, busy_timeout 5000 and synchronous NORMAL', () => {
		const db = openDb({ migrate: true, path: tempDbPath('pragmas.sqlite') });
		expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
		expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
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
