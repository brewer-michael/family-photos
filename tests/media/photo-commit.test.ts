/**
 * The photo lane's commit order against kills and power cuts (src/worker/README.md): the source
 * stays untouched in .incoming/<token> until media.markReady() has committed, the upload token is
 * released only after the source was archived or deleted, and the state a dead lane leaves behind
 * at either step is finished, never lost. The repo's markReady/sourceSettled and the lane's
 * settleSource are wrapped to look at the files at those exact moments; everything else is real.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConfig } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import { sweepIncoming } from '#lib/server/maintenance';
import { detectFile } from '#lib/server/media/detect';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { MediaError } from '#lib/shared/errors';
import { freshDb } from '../helpers/env';
import { PHOTO_FIXTURES } from '../helpers/photo-fixtures';
import type { WorkerContext } from '../../src/worker/context';
import { endExiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';
import { settleInterrupted, settleSource } from '../../src/worker/settle';

vi.mock('#lib/server/repo/media', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/server/repo/media')>();
	return { ...real, markReady: vi.fn(real.markReady), sourceSettled: vi.fn(real.sourceSettled) };
});
vi.mock('../../src/worker/settle', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/worker/settle')>();
	return { ...real, settleSource: vi.fn(real.settleSource) };
});

const DEVICE = 'deviceCCCCCCCCCCCCCCCC';
const HOUR = 3600_000;
let albumId: number;

beforeAll(() => {
	freshDb();
	paths.ensureDirs();
	albumId = albums.create({ title: 'Commit tests', createdByName: 'Test', createdByDevice: DEVICE }).id;
});

afterEach(() => {
	vi.mocked(media.markReady).mockClear();
	vi.mocked(media.sourceSettled).mockClear();
	vi.mocked(settleSource).mockClear();
});

afterAll(async () => {
	await endExiftool();
});

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixture = (name: string) => path.join(PHOTO_FIXTURES, name);

async function enqueue(file: string): Promise<{ id: string; src: string }> {
	const token = randomBytes(16).toString('base64url');
	const src = paths.incomingPath(token);
	fs.copyFileSync(file, src);
	const det = await detectFile(src);
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(src).size,
		clientMtimeMs: null,
		uploadedByName: 'Test',
		uploadedByDevice: DEVICE
	});
	media.markQueued(id, { kind: 'photo', sourceMime: det.mime, sourceExt: det.ext, sourceSha256: randomBytes(32).toString('hex'), estCostS: null });
	expect(media.claimForProcessing(id)?.status).toBe('processing');
	return { id, src };
}

function context(): WorkerContext {
	const quiet = () => undefined;
	return {
		db: getDb(),
		config: getConfig(),
		paths,
		lane: 'photo',
		progress: quiet,
		signal: new AbortController().signal,
		log: { info: quiet, warn: quiet, error: quiet }
	};
}

/** What the files look like when markReady() and sourceSettled() are called. */
function watchCommit(id: string, src: string, ext: string, sourceExt: string) {
	const seen: Record<string, unknown> = {};
	vi.mocked(media.markReady).mockImplementationOnce((...args) => {
		seen.atCommit = {
			source: fs.existsSync(src) ? sha(src) : null,
			library: fs.existsSync(paths.libraryPath(id, ext)),
			original: fs.existsSync(paths.originalsPath(id, sourceExt))
		};
		return vi.mocked(media.markReady).getMockImplementation()!(...args);
	});
	vi.mocked(media.sourceSettled).mockImplementationOnce((...args) => {
		const row = media.getById(id)!;
		seen.atRelease = {
			status: row.status,
			token: row.upload_token !== null,
			source: fs.existsSync(src),
			original: fs.existsSync(paths.originalsPath(id, sourceExt)) ? sha(paths.originalsPath(id, sourceExt)) : null
		};
		return vi.mocked(media.sourceSettled).getMockImplementation()!(...args);
	});
	return seen;
}

describe('commit order', () => {
	it('passthrough: the upload is untouched until the commit and deleted only after it', async () => {
		const { id, src } = await enqueue(fixture('o1.jpg'));
		const before = sha(src);
		const seen = watchCommit(id, src, 'jpg', 'jpg');
		await processPhoto(id, context());
		// At the commit the canonical file is already in library/ and the upload is still whole.
		expect(seen.atCommit).toEqual({ source: before, library: true, original: false });
		// The token is released only once the upload is gone (library/ holds the bytes).
		expect(seen.atRelease).toEqual({ status: 'ready', token: true, source: false, original: null });
		expect(media.getById(id)).toMatchObject({ status: 'ready', conversion: 'none', upload_token: null, source_kept: 0 });
		expect(sha(paths.libraryPath(id, 'jpg'))).toBe(sha(fixture('o1.jpg')));
	});

	it('transcode: the source is archived after the commit, and the token released after that', async () => {
		const { id, src } = await enqueue(fixture('o6.heic'));
		const seen = watchCommit(id, src, 'jpg', 'heic');
		await processPhoto(id, context());
		expect(seen.atCommit).toEqual({ source: sha(fixture('o6.heic')), library: true, original: false });
		expect(seen.atRelease).toEqual({ status: 'ready', token: true, source: false, original: sha(fixture('o6.heic')) });
		expect(media.getById(id)).toMatchObject({ status: 'ready', upload_token: null, source_kept: 1 });
	});
});

describe('a lane killed mid-commit', () => {
	it('before the commit: the upload is still there, so the next attempt works', async () => {
		const { id, src } = await enqueue(fixture('o2.jpg'));
		// The lane dies at the commit (the canonical file was already renamed into library/).
		vi.mocked(media.markReady).mockImplementationOnce(() => {
			throw new Error('killed');
		});
		await expect(processPhoto(id, context())).rejects.toThrow('killed');
		expect(sha(src)).toBe(sha(fixture('o2.jpg')));
		// A real kill skips the lane's cleanup: library/ keeps the second name of the upload.
		fs.mkdirSync(path.dirname(paths.libraryPath(id, 'jpg')), { recursive: true });
		fs.linkSync(src, paths.libraryPath(id, 'jpg'));
		// Restart: requeueInterrupted() and the lane picks it up again.
		expect(media.requeueInterrupted().requeued).toContain(id);
		expect(media.claimForProcessing(id)?.status).toBe('processing');
		await processPhoto(id, context());
		expect(media.getById(id)).toMatchObject({ status: 'ready', conversion: 'none', upload_token: null });
		expect(sha(paths.libraryPath(id, 'jpg'))).toBe(sha(fixture('o2.jpg')));
		expect(fs.existsSync(src)).toBe(false);
	});

	it('after the commit, before archiving: the sweep keeps the source and the restarted lane archives it', async () => {
		const { id, src } = await enqueue(fixture('o3.heic'));
		vi.mocked(settleSource).mockImplementationOnce(async () => undefined); // dies right after markReady()
		await processPhoto(id, context());
		const row = media.getById(id)!;
		expect(row).toMatchObject({ status: 'ready', source_kept: 1 });
		expect(row.upload_token).not.toBeNull();
		expect(media.sourcePath(row)).toBe(src);

		// Days later the .incoming sweep runs before anything else: the source is still needed.
		const old = new Date(Date.now() - 72 * HOUR);
		fs.utimesSync(src, old, old);
		expect(await sweepIncoming()).toBe(0);
		expect(fs.existsSync(src)).toBe(true);

		// The lane starts again: it finishes the archive and releases the token.
		expect(await settleInterrupted('photo', context().log)).toBe(1);
		expect(media.getById(id)).toMatchObject({ status: 'ready', upload_token: null, source_kept: 1 });
		expect(sha(paths.originalsPath(id, 'heic'))).toBe(sha(fixture('o3.heic')));
		expect(fs.existsSync(src)).toBe(false);
	});

	it('the source of a row that left processing is untouched (no commit)', async () => {
		const { id, src } = await enqueue(fixture('o4.jpg'));
		expect(media.requeue(id)).toBe(true);
		const err = await processPhoto(id, context()).then(
			() => null,
			(e: unknown) => e
		);
		expect(MediaError.is(err) && err.code).toBe('retryable');
		expect(sha(src)).toBe(sha(fixture('o4.jpg')));
		expect(fs.existsSync(paths.libraryPath(id, 'jpg'))).toBe(false);
		expect(media.sourceSettled).not.toHaveBeenCalled();
	});
});
