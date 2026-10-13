/**
 * Decoder detection and the HEIF failure paths that need a particular libheif: the real tools are
 * detected as installed (heif-dec on libheif ≥ 1.18, heif-convert on 1.17), and small wrapper
 * scripts around them (via HEIF_DEC_BIN) stand in for heif-dec 1.19 hitting a security limit.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getConfig } from '#lib/server/config';
import { getDb } from '#lib/server/db';
import * as paths from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import { MediaError } from '#lib/shared/errors';
import { freshDb, setEnv, testEnv } from '../helpers/env';
import { PHOTO_FIXTURES } from '../helpers/photo-fixtures';
import type { WorkerContext } from '../../src/worker/context';
import { endExiftool } from '../../src/worker/exiftool';
import { processPhoto } from '../../src/worker/photo';
import { ffmpegImageTools, forgetPhotoTools, heifTools, photoToolProblems, photoToolsReport } from '../../src/worker/photo/tools';

const onPath = (bin: string) => {
	try {
		execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

/** The decoder the machine really has. */
const REAL_DEC = onPath('heif-dec') ? 'heif-dec' : 'heif-convert';

let albumId: number;
let fakes: string;

beforeAll(() => {
	freshDb();
	paths.ensureDirs();
	albumId = albums.create({ title: 'Tool tests', createdByName: 'Test', createdByDevice: 'deviceTTTTTTTTTTTTTTTT' }).id;
	fakes = fs.mkdtempSync(path.join(testEnv().root, 'fakes-'));
});

afterEach(() => {
	setEnv({ HEIF_DEC_BIN: undefined });
	forgetPhotoTools();
});

afterAll(async () => {
	await endExiftool();
});

/**
 * A heif-dec stand-in: `--help` advertises libheif 1.19.8 (with or without --disable-limits),
 * --list-decoders and every decode with --disable-limits go to the real decoder, and any other
 * decode fails with libheif's security-limit error.
 */
function fakeHeifDec(name: string, opts: { disableLimits: boolean }): string {
	const dir = path.join(fakes, name);
	fs.mkdirSync(dir);
	const file = path.join(dir, 'heif-dec');
	fs.writeFileSync(
		file,
		`#!/bin/sh
case " $* " in
  *" --help "*)
    echo " heif-dec  libheif version: 1.19.8"
    ${opts.disableLimits ? `echo "      --disable-limits           disable all security limits"` : ''}
    exit 0;;
  *" --list-decoders "*) exec ${REAL_DEC} --list-decoders;;
  *" --disable-limits "*)
    for a do shift; [ "$a" = "--disable-limits" ] || set -- "$@" "$a"; done
    exec ${REAL_DEC} "$@";;
esac
echo "Could not read HEIF/AVIF file: Memory allocation error: Security limit exceeded: Image size exceeds the maximum" >&2
exit 1
`,
		{ mode: 0o755 }
	);
	return file;
}

async function enqueue(file: string): Promise<string> {
	const token = randomBytes(16).toString('base64url');
	fs.copyFileSync(file, paths.incomingPath(token));
	const id = media.insertReceived({
		uploadToken: token,
		albumId,
		sourceName: path.basename(file),
		sourceSize: fs.statSync(file).size,
		clientMtimeMs: null,
		uploadedByName: 'Test',
		uploadedByDevice: 'deviceTTTTTTTTTTTTTTTT'
	});
	media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: randomBytes(32).toString('hex'), estCostS: null });
	media.claimForProcessing(id);
	return id;
}

function context(logs: string[]): WorkerContext {
	const line = (level: string) => (m: string) => logs.push(`${level} ${m}`);
	return {
		db: getDb(),
		config: getConfig(),
		paths,
		lane: 'photo',
		progress: () => undefined,
		signal: new AbortController().signal,
		log: { info: line('INFO'), warn: line('WARN'), error: line('ERROR') }
	};
}

async function failure(id: string, logs: string[] = []): Promise<MediaError> {
	const err = await processPhoto(id, context(logs)).then(
		() => null,
		(e: unknown) => e
	);
	expect(MediaError.is(err), String(err)).toBe(true);
	return err as MediaError;
}

describe('tool detection', () => {
	it('finds the installed HEIF decoder, its decoders and limits support', async () => {
		const h = await heifTools();
		expect(h.decBin).toBe(REAL_DEC);
		expect(h.infoBin).toBe('heif-info');
		expect(h.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(h.decoders.hevc).toContain('libde265');
		expect(h.decoders.av1).toContain('dav1d');
		// heif-dec arrived with libheif 1.18, together with --disable-limits.
		expect(h.decDisableLimits).toBe(REAL_DEC === 'heif-dec');
		const report = await photoToolsReport();
		expect(report.problems.filter((p) => /HEIF|libheif/.test(p))).toEqual([]);
		expect(report.tools[REAL_DEC]).toContain(`libheif ${h.version}`);
	});

	it('uses HEIF_DEC_BIN and the heif-info next to it', async () => {
		const dec = fakeHeifDec('override', { disableLimits: true });
		fs.writeFileSync(path.join(path.dirname(dec), 'heif-info'), '#!/bin/sh\nexec heif-info "$@"\n', { mode: 0o755 });
		setEnv({ HEIF_DEC_BIN: dec });
		forgetPhotoTools();
		const h = await heifTools();
		expect(h).toMatchObject({ decBin: dec, infoBin: path.join(path.dirname(dec), 'heif-info'), version: '1.19.8', decDisableLimits: true });
		expect(h.decoders.hevc).toContain('libde265');
	});

	it('reports a missing HEIF decoder', async () => {
		setEnv({ HEIF_DEC_BIN: path.join(fakes, 'no-such-heif-dec') });
		forgetPhotoTools();
		const h = await heifTools();
		expect(h.version).toBeNull();
		expect(photoToolProblems(h, await ffmpegImageTools()).join(' ')).toMatch(/not installed/);
	});
});

describe('HEIF security limits', () => {
	it('retries once with --disable-limits when the decoder supports it', async () => {
		setEnv({ HEIF_DEC_BIN: fakeHeifDec('limits', { disableLimits: true }) });
		forgetPhotoTools();
		const id = await enqueue(path.join(PHOTO_FIXTURES, 'o1.heic'));
		const logs: string[] = [];
		await processPhoto(id, context(logs));
		expect(media.getById(id)?.status).toBe('ready');
		expect(logs.some((l) => l.includes('retrying with --disable-limits'))).toBe(true);
	});

	it('fails as too_large when the decoder has no --disable-limits', async () => {
		setEnv({ HEIF_DEC_BIN: fakeHeifDec('nolimits', { disableLimits: false }) });
		forgetPhotoTools();
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'o1.heic')));
		expect(e.code).toBe('too_large');
	});

	it('is a retryable failure when the decoder cannot start', async () => {
		setEnv({ HEIF_DEC_BIN: path.join(fakes, 'missing-heif-dec') });
		forgetPhotoTools();
		const e = await failure(await enqueue(path.join(PHOTO_FIXTURES, 'o1.heic')));
		expect(e.code).toBe('retryable');
	});
});
