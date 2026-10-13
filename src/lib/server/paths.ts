/**
 * Every on-disk location, per "Storage layout" in docs/PLAN.md.
 *
 *   PHOTOS_DIR/library/<sh>/<id>.<ext>      canonical file
 *   PHOTOS_DIR/originals/<sh>/<id>.<ext>    archived source (admin only)
 *   PHOTOS_DIR/.incoming/<token>(+.json)    tus partials
 *   PHOTOS_DIR/.work/<id>/                  canonical output before verify + rename
 *   PHOTOS_DIR/.backups/app-YYYY-MM-DD.sqlite
 *   CONFIG_DIR/app.sqlite
 *   CONFIG_DIR/cache/<sh>/<id>/{thumb,display,poster}.webp
 *   CONFIG_DIR/tmp/<id>/
 *   CONFIG_DIR/outbox/*.eml
 *
 * <sh> is the last two characters of the ULID. Every function validates the id so
 * a path can never escape its root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config';
import { ULID_RE, type CacheVariant } from '#lib/shared/media-types';

function assertId(id: string): string {
	if (!ULID_RE.test(id)) throw new Error(`Invalid media id: ${JSON.stringify(id)}`);
	return id;
}

function assertExt(ext: string): string {
	const e = ext.replace(/^\./, '').toLowerCase();
	if (!/^[a-z0-9]{1,10}$/.test(e)) throw new Error(`Invalid file extension: ${JSON.stringify(ext)}`);
	return e;
}

/** Shard: last two characters of the ULID. */
export function sh(id: string): string {
	return assertId(id).slice(-2);
}

export const photosRoot = (): string => getConfig().photosDir;
export const configRoot = (): string => getConfig().configDir;

export const libraryRoot = (): string => path.join(photosRoot(), 'library');
export const originalsRoot = (): string => path.join(photosRoot(), 'originals');
export const incomingDir = (): string => path.join(photosRoot(), '.incoming');
export const workRoot = (): string => path.join(photosRoot(), '.work');
export const backupsDir = (): string => path.join(photosRoot(), '.backups');
export const cacheRoot = (): string => path.join(configRoot(), 'cache');
export const tmpRoot = (): string => path.join(configRoot(), 'tmp');
export const outboxDir = (): string => path.join(configRoot(), 'outbox');
export const dbPath = (): string => path.join(configRoot(), 'app.sqlite');

/** Canonical file: library/<sh>/<id>.<jpg|png|gif|mp4> */
export function libraryPath(id: string, ext: string): string {
	return path.join(libraryRoot(), sh(id), `${id}.${assertExt(ext)}`);
}

/** Archived source: originals/<sh>/<id>.<heic|mov|dng|…> */
export function originalsPath(id: string, ext: string): string {
	return path.join(originalsRoot(), sh(id), `${id}.${assertExt(ext)}`);
}

/** tus upload data file for an upload token (the FileStore also writes `<token>.json`). */
export function incomingPath(token: string): string {
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error('Invalid upload token');
	return path.join(incomingDir(), token);
}

/** Per-job output directory on the photos filesystem (same fs as library → atomic rename). */
export function workDir(id: string): string {
	return path.join(workRoot(), assertId(id));
}

/** Per-item derivative directory: cache/<sh>/<id>/ */
export function cacheDir(id: string): string {
	return path.join(cacheRoot(), sh(id), id);
}

/** cache/<sh>/<id>/<variant>.webp */
export function cacheFile(id: string, variant: CacheVariant): string {
	if (variant !== 'thumb' && variant !== 'display' && variant !== 'poster') {
		throw new Error(`Invalid cache variant: ${String(variant)}`);
	}
	return path.join(cacheDir(id), `${variant}.webp`);
}

/** Per-job scratch directory on the config (SSD) filesystem. */
export function tmpDir(id: string): string {
	return path.join(tmpRoot(), assertId(id));
}

/** Nightly backup file name for a date: .backups/app-YYYY-MM-DD.sqlite */
export function backupPath(date: Date = new Date()): string {
	const d = date.toISOString().slice(0, 10);
	return path.join(backupsDir(), `app-${d}.sqlite`);
}

/** Creates every root directory (idempotent). Called at startup by the web process. */
export function ensureDirs(): void {
	for (const dir of [
		configRoot(),
		photosRoot(),
		libraryRoot(),
		originalsRoot(),
		incomingDir(),
		workRoot(),
		backupsDir(),
		cacheRoot(),
		tmpRoot(),
		outboxDir()
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
