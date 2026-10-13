/**
 * src/worker/photo/tools.ts is also meant for the web process's startup self-check
 * (photoToolsReport()), so importing it must not load sharp or exiftool, nor start any program:
 * the tools are detected on first use. The problem wording an admin sees is checked here too.
 */
import { describe, expect, it, vi } from 'vitest';

const started = vi.hoisted(() => [] as string[]);

vi.mock('sharp', () => {
	throw new Error('photo/tools must not load sharp');
});
vi.mock('exiftool-vendored', () => {
	throw new Error('photo/tools must not load exiftool-vendored');
});
vi.mock('node:child_process', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:child_process')>();
	const record =
		<F extends (...args: never[]) => unknown>(fn: F) =>
		(...args: Parameters<F>) => {
			started.push(String(args[0]));
			return fn(...args);
		};
	return {
		...real,
		execFile: record(real.execFile),
		execFileSync: record(real.execFileSync),
		spawn: record(real.spawn),
		spawnSync: record(real.spawnSync),
		exec: record(real.exec)
	};
});

const HEIF_OK = {
	decBin: 'heif-dec',
	infoBin: 'heif-info',
	infoFound: true,
	version: '1.19.8',
	decoders: { hevc: ['ffmpeg', 'libde265'], av1: ['dav1d', 'aom'] },
	decDisableLimits: true,
	infoDisableLimits: true
};
const FFMPEG_OK = { bin: 'ffmpeg', decodes: { jxl: true, jp2: true, bmp: true, psd: true } };

describe('photo tools module', () => {
	it('imports without sharp, exiftool or starting a program', async () => {
		const tools = await import('../../src/worker/photo/tools');
		expect(typeof tools.photoToolsReport).toBe('function');
		expect(started).toEqual([]);
	});

	it('names what an admin should install', async () => {
		const { photoToolProblems } = await import('../../src/worker/photo/tools');
		expect(photoToolProblems(HEIF_OK, FFMPEG_OK)).toEqual([]);
		expect(photoToolProblems({ ...HEIF_OK, version: null }, FFMPEG_OK)).toEqual([expect.stringMatching(/HEIF decoder \(heif-dec\) is not installed/)]);
		expect(photoToolProblems({ ...HEIF_OK, infoFound: false }, FFMPEG_OK)).toEqual([expect.stringMatching(/^heif-info \(heif-info\) is not installed/)]);
		expect(photoToolProblems({ ...HEIF_OK, decoders: { hevc: ['ffmpeg'], av1: ['aom'] } }, FFMPEG_OK)).toEqual([
			expect.stringMatching(/libde265/),
			expect.stringMatching(/dav1d/)
		]);
		expect(photoToolProblems(HEIF_OK, { ...FFMPEG_OK, decodes: { ...FFMPEG_OK.decodes, jxl: false, psd: false } })).toEqual([
			expect.stringMatching(/can't decode jxl, psd/)
		]);
		expect(started).toEqual([]);
	});
});
