/**
 * Seeds ready media for UI tests without the worker: rows go straight into the server's temp
 * database (WAL, so the running server sees them at once) and small files into its PHOTOS_DIR
 * library and CONFIG_DIR cache, exactly where the pipeline would put them.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { monotonicFactory } from 'ulid';
import type { BrowserContext } from '@playwright/test';
import { e2eDir } from './helpers';

const newId = monotonicFactory();

export interface SeedItem {
	/** Uploaded name, e.g. "IMG_1234.HEIC" (downloads are named from it). */
	name: string;
	kind?: 'photo' | 'video';
	/** Local wall time (+offset), e.g. "2024-07-04T11:22:31-07:00". */
	takenAt: string;
	by?: string;
	device?: string;
	/** Hidden Live Photo video of this photo id. */
	livePhotoOf?: string;
	/** Fill colour of the generated picture. */
	color?: string;
	/** Default 'ready'. Unfinished items get no canonical file (videos get a poster). */
	status?: 'ready' | 'queued' | 'processing' | 'failed';
	errorCode?: 'retryable' | 'unsupported';
	/** Trashed at this time (ms). */
	deletedAt?: number;
}

function db(): Database.Database {
	const d = new Database(path.join(e2eDir(), 'config', 'app.sqlite'), { fileMustExist: true, timeout: 10_000 });
	d.pragma('busy_timeout = 10000');
	return d;
}

const shard = (id: string) => id.slice(-2);
const libraryFile = (id: string, ext: string) => path.join(e2eDir(), 'photos', 'library', shard(id), `${id}.${ext}`);
const cacheFile = (id: string, variant: string) => path.join(e2eDir(), 'config', 'cache', shard(id), id, `${variant}.webp`);

function write(file: string, bytes: Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}

/** A 1-second test-pattern MP4, made once per run with ffmpeg. */
function sampleVideo(): Buffer {
	const file = path.join(e2eDir(), 'seed-sample.mp4');
	if (!fs.existsSync(file)) {
		execFileSync('ffmpeg', [
			'-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=1',
			'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file
		]);
	}
	return fs.readFileSync(file);
}

export function seedAlbum(title: string, opts: { device?: string; by?: string } = {}): number {
	const d = db();
	try {
		const now = Date.now();
		return Number(
			d
				.prepare(
					`INSERT INTO albums(title, created_by_name, created_by_device, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
				)
				.run(title, opts.by ?? 'Seeder', opts.device ?? 'seed-device-0000000000', now, now).lastInsertRowid
		);
	} finally {
		d.close();
	}
}

/** Inserts one item (ready by default) with its files where the pipeline would put them. Returns its id. */
export async function seedMedia(albumId: number, item: SeedItem): Promise<string> {
	const id = newId();
	const kind = item.kind ?? 'photo';
	const status = item.status ?? 'ready';
	const ready = status === 'ready';
	const ext = kind === 'video' ? 'mp4' : 'jpg';
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(item.takenAt)!;
	const takenMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	const picture = sharp({ create: { width: 640, height: 480, channels: 3, background: item.color ?? '#c96f3b' } });
	let size = 1000;
	if (ready) {
		const canonical = kind === 'video' ? sampleVideo() : await picture.clone().jpeg({ quality: 80 }).toBuffer();
		size = canonical.length;
		write(libraryFile(id, ext), canonical);
		write(cacheFile(id, 'thumb'), await picture.clone().resize(480, 360).webp().toBuffer());
		if (kind === 'photo') write(cacheFile(id, 'display'), await picture.clone().webp().toBuffer());
	}
	if (kind === 'video') write(cacheFile(id, 'poster'), await picture.clone().webp().toBuffer());

	const d = db();
	try {
		const now = Date.now();
		d.prepare(
			`INSERT INTO media(id, upload_token, album_id, uploaded_by_name, uploaded_by_device, kind, status, attempts,
				error_code, pipeline_version, source_name, source_mime, source_ext, source_size, source_sha256, conversion,
				canonical_ext, canonical_size, width, height, duration_ms, taken_at, taken_ms, live_photo_of,
				created_at, updated_at, deleted_at, deleted_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			ready ? null : randomBytes(16).toString('base64url'),
			albumId,
			item.by ?? 'Aunt Linda',
			item.device ?? 'seed-device-0000000000',
			kind,
			status,
			status === 'failed' ? (item.errorCode ?? 'unsupported') : null,
			ready ? 1 : 0,
			item.name,
			kind === 'video' ? 'video/quicktime' : 'image/heic',
			kind === 'video' ? 'mov' : 'heic',
			size,
			randomBytes(32).toString('hex'),
			ready ? 'transcode' : null,
			ready ? ext : null,
			ready ? size : null,
			ready ? 640 : null,
			ready ? 480 : null,
			ready && kind === 'video' ? 1000 : null,
			ready ? item.takenAt : null,
			ready ? takenMs : null,
			item.livePhotoOf ?? null,
			now,
			now,
			item.deletedAt ?? null,
			item.deletedAt ? 'test' : null
		);
		if (ready) d.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(now, albumId);
	} finally {
		d.close();
	}
	return id;
}

/** The device id inside a context's signed fp_device cookie (body = base64url JSON {d, n}). */
export async function deviceIdOf(context: BrowserContext): Promise<string> {
	const cookie = (await context.cookies()).find((c) => c.name === 'fp_device');
	if (!cookie) throw new Error('No fp_device cookie: log in first');
	return (JSON.parse(Buffer.from(cookie.value.split('.')[0], 'base64url').toString('utf8')) as { d: string }).d;
}

/** Runs a query against the server's database (for assertions on what the UI stored). */
export function readRows<T>(sql: string, ...params: unknown[]): T[] {
	const d = db();
	try {
		return d.prepare(sql).all(...params) as T[];
	} finally {
		d.close();
	}
}
