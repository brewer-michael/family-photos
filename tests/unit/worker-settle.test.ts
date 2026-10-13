/**
 * The source's side of the lanes' commit order (src/worker/settle.ts): a source is archived or
 * deleted only after markReady(), the upload token is released only after that, and a lane that
 * died in between finishes the job when it starts again (settleInterrupted).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { incomingPath, originalsPath, workDir } from '#lib/server/paths';
import * as media from '#lib/server/repo/media';
import * as settings from '#lib/server/repo/settings';
import type { Kind } from '#lib/shared/media-types';
import { freshDb } from '../helpers/env';
import { linkSource, locateSource, settleInterrupted, settleSource } from '../../src/worker/settle';

let seq = 0;
let album: number;
let logs: string[] = [];
const log = {
	info: (m: string) => logs.push(`INFO ${m}`),
	warn: (m: string) => logs.push(`WARN ${m}`),
	error: (m: string, e?: Record<string, unknown>) => logs.push(`ERROR ${m} ${JSON.stringify(e ?? {})}`)
};

function write(file: string, body = 'source bytes'): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
}

/** A row the lane is converting: 'processing', its upload in .incoming/<token>. */
function processing(kind: Kind = 'photo', ext = kind === 'photo' ? 'heic' : 'mov'): { id: string; token: string } {
	const token = `tok${String(++seq).padStart(20, '0')}`;
	const id = media.insertReceived({
		uploadToken: token,
		albumId: album,
		sourceName: `IMG_${seq}.${ext}`,
		sourceSize: 12,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
	media.markQueued(id, { kind, sourceMime: 'application/octet-stream', sourceExt: ext, sourceSha256: `sha${seq}`, estCostS: null });
	expect(media.claimForProcessing(id)?.status).toBe('processing');
	write(incomingPath(token));
	return { id, token };
}

/** markReady() as the lane commits it, with no settle after it (the lane died there). */
function committed(kind: Kind, sourceKept: boolean): { id: string; token: string } {
	const p = processing(kind);
	expect(
		media.markReady(p.id, { conversion: 'transcode', canonicalExt: kind === 'photo' ? 'jpg' : 'mp4', canonicalSize: 1, width: 1, height: 1, takenMs: 1, sourceKept })
	).toBe(true);
	return p;
}

beforeEach(() => {
	freshDb();
	album = settings.getDefaultAlbumId()!;
	logs = [];
});

describe('settleSource (after the commit)', () => {
	it('archives a kept source, fsyncs it, then releases the upload token', async () => {
		const { id, token } = committed('photo', true);
		expect(media.getById(id)).toMatchObject({ status: 'ready', upload_token: token, source_kept: 1 });
		await settleSource(id, incomingPath(token), true, 'heic', log, `photo ${id}`);
		expect(fs.existsSync(incomingPath(token))).toBe(false);
		expect(fs.readFileSync(originalsPath(id, 'heic'), 'utf8')).toBe('source bytes');
		expect(media.getById(id)).toMatchObject({ upload_token: null, source_kept: 1 });
		expect(logs).toEqual([]);
	});

	it('deletes a source that is not kept (passthrough, or KEEP_ORIGINALS off)', async () => {
		const { id, token } = committed('video', false);
		await settleSource(id, incomingPath(token), false, 'mov', log, `video ${id}`);
		expect(fs.existsSync(incomingPath(token))).toBe(false);
		expect(fs.existsSync(originalsPath(id, 'mov'))).toBe(false);
		expect(media.getById(id)).toMatchObject({ upload_token: null, source_kept: 0 });
	});

	it('records "no original kept" when archiving fails, and still releases the token', async () => {
		const { id, token } = committed('photo', true);
		await settleSource(id, incomingPath(token), true, 'he.ic', log, `photo ${id}`);
		expect(media.getById(id)).toMatchObject({ upload_token: null, source_kept: 0 });
		expect(logs).toEqual([expect.stringMatching(/^ERROR photo \w+: could not archive the source/)]);
	});
});

describe('settleInterrupted (a lane starting after one died mid-commit)', () => {
	it('finishes every unsettled ready row of its kind and leaves everything else alone', async () => {
		const inIncoming = committed('photo', true); // died after markReady, before the archive rename
		const archived = committed('photo', true); // died after the rename, before sourceSettled
		fs.mkdirSync(path.dirname(originalsPath(archived.id, 'heic')), { recursive: true });
		fs.renameSync(incomingPath(archived.token), originalsPath(archived.id, 'heic'));
		const notKept = committed('photo', false);
		const lost = committed('photo', true);
		fs.rmSync(incomingPath(lost.token));
		const video = committed('video', true);
		const running = processing('photo');

		expect(await settleInterrupted('photo', log)).toBe(4);

		for (const p of [inIncoming, archived]) {
			expect(media.getById(p.id)).toMatchObject({ status: 'ready', upload_token: null, source_kept: 1 });
			expect(fs.readFileSync(originalsPath(p.id, 'heic'), 'utf8')).toBe('source bytes');
			expect(fs.existsSync(incomingPath(p.token))).toBe(false);
		}
		expect(media.getById(notKept.id)).toMatchObject({ upload_token: null, source_kept: 0 });
		expect(fs.existsSync(incomingPath(notKept.token))).toBe(false);
		// Nothing left to archive: the row no longer claims an original ("Download original" hides).
		expect(media.getById(lost.id)).toMatchObject({ upload_token: null, source_kept: 0 });
		expect(media.sourcePath(media.getById(lost.id)!)).toBeNull();
		// Other lanes' rows and unfinished jobs are not this step's business.
		expect(media.getById(video.id)).toMatchObject({ upload_token: video.token });
		expect(fs.existsSync(incomingPath(video.token))).toBe(true);
		expect(media.getById(running.id)).toMatchObject({ status: 'processing', upload_token: running.token });
		expect(fs.existsSync(incomingPath(running.token))).toBe(true);

		expect(await settleInterrupted('photo', log)).toBe(0);
		expect(await settleInterrupted('video', log)).toBe(1);
		expect(fs.existsSync(originalsPath(video.id, 'mov'))).toBe(true);
	});
});

describe('locateSource', () => {
	it('reads the upload while the token is held, else the archived original, whichever exists', async () => {
		const { id, token } = committed('photo', true);
		expect(await locateSource(media.getById(id)!)).toBe(incomingPath(token));
		// Archived, token not released yet (a lane died in between): found in originals/.
		fs.mkdirSync(path.dirname(originalsPath(id, 'heic')), { recursive: true });
		fs.renameSync(incomingPath(token), originalsPath(id, 'heic'));
		expect(await locateSource(media.getById(id)!)).toBe(originalsPath(id, 'heic'));
		media.sourceSettled(id);
		expect(await locateSource(media.getById(id)!)).toBe(originalsPath(id, 'heic'));
		// Neither exists: the preferred path, for the lane's "missing" error.
		fs.rmSync(originalsPath(id, 'heic'));
		expect(await locateSource(media.getById(id)!)).toBe(originalsPath(id, 'heic'));
		media.markOriginalDeleted(id);
		expect(await locateSource(media.getById(id)!)).toBeNull();
	});
});

describe('linkSource (passthrough canonical file)', () => {
	it('gives the source a second name in .work/ and leaves the source where it is', async () => {
		const { id, token } = processing('photo', 'jpg');
		const dest = path.join(workDir(id), `${id}.jpg`);
		fs.mkdirSync(workDir(id), { recursive: true });
		write(dest, 'stale output of an earlier attempt');
		expect(await linkSource(incomingPath(token), dest)).toBe(dest);
		expect(fs.readFileSync(dest, 'utf8')).toBe('source bytes');
		expect(fs.statSync(dest).ino).toBe(fs.statSync(incomingPath(token)).ino);
		fs.rmSync(dest);
		expect(fs.readFileSync(incomingPath(token), 'utf8')).toBe('source bytes');
	});
});
