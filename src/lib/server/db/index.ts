/**
 * SQLite access (better-sqlite3, synchronous).
 *
 * - The web process calls getDb(), which lazily opens CONFIG_DIR/app.sqlite with
 *   migrate: true (runs migrations + first-boot seed).
 * - Each worker lane opens its own connection with openDb({ migrate: false }) and
 *   installs it with setDb(); it refuses to run against an unmigrated database.
 * - Repos use stmt(sql) for cached prepared statements on the current connection
 *   and tx(fn) for transactions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { dbPath } from '#lib/server/paths';
import { LATEST_VERSION, migrations } from './migrations/index';

export type DB = Database.Database;
export type Statement = Database.Statement;

export interface OpenDbOptions {
	/** Run pending migrations and the first-boot seed (web process). Workers pass false. */
	migrate: boolean;
	/** Defaults to CONFIG_DIR/app.sqlite. ':memory:' works for tests. */
	path?: string;
	readonly?: boolean;
}

export const DEFAULT_ALBUM_TITLE = 'Everyday Photos';

export function openDb(opts: OpenDbOptions): DB {
	const file = opts.path ?? dbPath();
	if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file, { readonly: opts.readonly ?? false, timeout: 5000 });
	try {
		if (!opts.readonly) db.pragma('journal_mode = WAL');
		db.pragma('foreign_keys = ON');
		db.pragma('busy_timeout = 5000');
		db.pragma('synchronous = NORMAL');
		if (opts.migrate) {
			migrate(db);
			seed(db);
		} else {
			const v = userVersion(db);
			if (v < LATEST_VERSION) {
				throw new Error(
					`Database ${file} is at schema version ${v} but this build needs ${LATEST_VERSION}. ` +
						'The web process runs migrations at startup; start it first.'
				);
			}
		}
		if (userVersion(db) > LATEST_VERSION) {
			throw new Error(
				`Database ${file} is at schema version ${userVersion(db)}, newer than this build (${LATEST_VERSION}). ` +
					'Downgrading is not supported; restore a backup or run the newer image.'
			);
		}
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

export function userVersion(db: DB): number {
	return db.pragma('user_version', { simple: true }) as number;
}

/** Applies every migration newer than PRAGMA user_version, each in its own transaction. Idempotent. */
export function migrate(db: DB): number {
	let applied = 0;
	for (const m of migrations) {
		if (m.version <= userVersion(db)) continue;
		db.transaction(() => {
			db.exec(m.sql);
			db.pragma(`user_version = ${m.version}`);
		}).immediate();
		applied++;
	}
	return applied;
}

/** First-boot data: secret, access_gen=1, the "Everyday Photos" album. Idempotent. */
export function seed(db: DB): void {
	db.transaction(() => {
		const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
		ins.run('secret', randomBytes(32).toString('hex'));
		ins.run('access_gen', '1');
		const hasDefault = db.prepare("SELECT value FROM settings WHERE key = 'default_album_id'").get();
		if (!hasDefault) {
			const now = Date.now();
			const r = db
				.prepare(
					`INSERT INTO albums(title, created_by_name, created_at, updated_at)
					 VALUES (?, NULL, ?, ?)`
				)
				.run(DEFAULT_ALBUM_TITLE, now, now);
			ins.run('default_album_id', String(r.lastInsertRowid));
		}
	}).immediate();
}

// ---------------------------------------------------------------------------
// Process-wide connection
// ---------------------------------------------------------------------------

let current: DB | null = null;
let statements = new Map<string, Statement>();

/** The process-wide connection. Opens CONFIG_DIR/app.sqlite with migrate: true on first use. */
export function getDb(): DB {
	if (!current) setDb(openDb({ migrate: true }));
	return current!;
}

/** Installs a connection as the process-wide one (worker: setDb(openDb({ migrate: false }))). */
export function setDb(db: DB): void {
	if (current && current !== db && current.open) current.close();
	current = db;
	statements = new Map();
}

export function closeDb(): void {
	if (current?.open) current.close();
	current = null;
	statements = new Map();
}

export function isDbOpen(): boolean {
	return !!current?.open;
}

/** Cached prepared statement on the current connection. */
export function stmt(sql: string): Statement {
	const db = getDb();
	let s = statements.get(sql);
	if (!s) {
		s = db.prepare(sql);
		statements.set(sql, s);
	}
	return s;
}

/** Runs fn in a transaction (BEGIN IMMEDIATE, so writers queue on busy_timeout instead of failing). */
export function tx<T>(fn: () => T): T {
	return getDb().transaction(fn).immediate();
}

/** SQLite constraint violation helper (better-sqlite3 SqliteError code). */
export function isUniqueViolation(e: unknown): boolean {
	const code = (e as { code?: unknown } | null)?.code;
	return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export { LATEST_VERSION };
