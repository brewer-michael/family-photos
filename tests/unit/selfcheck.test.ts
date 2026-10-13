/**
 * The media self-check against fake ffmpeg/ffprobe/heif/exiftool scripts (so the result doesn't
 * depend on the machine's tools). Each test re-imports the modules: ffmpegCaps() caches per process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHeifDecoders } from '#lib/server/selfcheck';
import { setEnv, testEnv } from '../helpers/env';

const ORIGINAL_PATH = process.env.PATH;

const DECODERS = [
	' V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
	' V....D hevc                 HEVC (High Efficiency Video Coding)',
	' V....D vp9                  Google VP9',
	' V....D libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)',
	' V....D prores               Apple ProRes (iCodec Pro)',
	' V....D mpeg2video           MPEG-2 video',
	' V....D libjxl               libjxl JPEG XL (codec jpegxl)',
	' V....D jpeg2000             JPEG 2000',
	' V....D bmp                  BMP (Windows and OS/2 bitmap)',
	' V....D psd                  Photoshop PSD file',
	' A....D aac                  AAC (Advanced Audio Coding)'
];

const HEIF_DECODERS = `HEIC decoders:
- libde265 = libde265 HEVC decoder, version 1.0.15
- ffmpeg = FFMPEG HEVC decoder 7.1.1
AVIF decoders:
- dav1d = dav1d v1.5.1
JPEG decoders:
JPEG 2000 decoders:
uncompressed: yes`;

interface FakeTools {
	filters?: string[];
	encoders?: string[];
	sidedataTypes?: string[];
	decoders?: string[];
	heifDecoders?: string;
}

let bin: string;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Writes a /bin/sh script (shell builtins only: PATH is just `bin`) that prints `out` per first argument. */
function script(name: string, cases: Record<string, string>): string {
	const file = path.join(bin, name);
	const body = Object.entries(cases)
		.map(([arg, out]) => `  ${quote(arg)}) printf '%s\\n' ${quote(out)} ;;`)
		.join('\n');
	fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = "-hide_banner" ] && shift\ncase "$1" in\n${body}\n  *) echo "unknown $1" >&2; exit 1 ;;\nesac\n`);
	fs.chmodSync(file, 0o755);
	return file;
}

function fakeTools(t: FakeTools = {}): void {
	const filters = t.filters ?? ['zscale', 'tonemap', 'sidedata', 'scale'];
	const encoders = t.encoders ?? ['libx264', 'aac'];
	const sidedata = t.sidedataTypes ?? ['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL', 'AMBIENT_VIEWING_ENVIRONMENT'];
	script('ffmpeg', {
		'-version': 'ffmpeg version 7.1.1-1+b1 Copyright (c) 2000-2025 the FFmpeg developers',
		'-filters': filters.map((f) => ` ... ${f.padEnd(16)} V->V       Some filter.`).join('\n'),
		'-encoders': encoders.map((e) => ` V....D ${e.padEnd(20)} Some encoder`).join('\n'),
		'-h': `Filter sidedata\n   type <int> ..FV.......\n${sidedata.map((s, i) => `     ${s.padEnd(15)} ${i}            ..FV....... `).join('\n')}`,
		'-decoders': (t.decoders ?? DECODERS).join('\n')
	});
	script('ffprobe', { '-version': 'ffprobe version 7.1.1-1+b1 Copyright (c) 2007-2025 the FFmpeg developers' });
	script('heif-dec', { '--version': '1.19.8', '--list-decoders': t.heifDecoders ?? HEIF_DECODERS });
	script('heif-info', { '--version': '1.19.8' });
	script('exiftool', { '-ver': '13.10' });
	setEnv({
		FFMPEG_BIN: path.join(bin, 'ffmpeg'),
		FFPROBE_BIN: path.join(bin, 'ffprobe'),
		EXIFTOOL_BIN: path.join(bin, 'exiftool'),
		HEIF_DEC_BIN: undefined
	});
	process.env.PATH = bin; // heif-dec/heif-convert/heif-info are found on PATH
}

async function fresh() {
	vi.resetModules();
	return import('#lib/server/selfcheck');
}

beforeEach(() => {
	const { root, configDir, photosDir } = testEnv();
	for (const dir of [configDir, photosDir]) fs.mkdirSync(dir, { recursive: true });
	bin = fs.mkdtempSync(path.join(root, 'bin-'));
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	process.env.PATH = ORIGINAL_PATH;
	setEnv({ FFMPEG_BIN: undefined, FFPROBE_BIN: undefined, EXIFTOOL_BIN: undefined, HEIF_DEC_BIN: undefined });
	vi.restoreAllMocks();
	vi.doUnmock('#lib/server/disk');
});

describe('runSelfCheck', () => {
	it('is OK when every tool has what the pipeline needs', async () => {
		fakeTools();
		const { runSelfCheck, getSelfCheck } = await fresh();
		expect(getSelfCheck()).toBeNull();
		const r = await runSelfCheck();
		expect(r.problems).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.checkedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(r.tools).toMatchObject({
			ffmpeg: 'ffmpeg version 7.1.1-1+b1',
			ffprobe: 'ffprobe version 7.1.1-1+b1',
			'ffmpeg decoders': '10 video, 1 audio',
			'heif decoder': 'heif-dec 1.19.8',
			'heif decoders': 'HEIC: libde265, ffmpeg; AVIF: dav1d',
			'heif-info': '1.19.8',
			exiftool: '13.10'
		});
		const { configDir, photosDir } = testEnv();
		expect(r.tools[`free space ${configDir}`]).toMatch(/ (KB|MB|GB|TB)$/);
		expect(r.tools[`free space ${photosDir}`]).toMatch(/ (KB|MB|GB|TB)$/);
		expect(getSelfCheck()).toEqual(r);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[selfcheck] media tools OK'));
	});

	it('lists what is missing, loudly, without throwing', async () => {
		fakeTools({
			filters: ['tonemap', 'sidedata'],
			encoders: ['aac'],
			sidedataTypes: ['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL'],
			decoders: DECODERS.filter((d) => !/ (hevc|libjxl) /.test(d)),
			heifDecoders: HEIF_DECODERS.replace('- dav1d = dav1d v1.5.1\n', '')
		});
		fs.rmSync(path.join(bin, 'heif-info'));
		setEnv({ EXIFTOOL_BIN: path.join(bin, 'no-exiftool') });
		const { runSelfCheck } = await fresh();
		const r = await runSelfCheck();
		expect(r.ok).toBe(false);
		const all = r.problems.join('\n');
		expect(all).toContain('no libx264 encoder');
		expect(all).toContain('no zscale filter');
		expect(all).toContain('AMBIENT_VIEWING_ENVIRONMENT');
		expect(all).toContain("can't decode iPhone (HEVC) videos, JPEG XL photos");
		expect(all).toContain('no dav1d decoder plugin');
		expect(all).not.toContain('libde265');
		expect(all).toContain('heif-info could not be run: not installed');
		expect(all).toContain('exiftool');
		expect(r.tools.exiftool).toBeUndefined();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('PROBLEM(S) WITH THE MEDIA TOOLS'));
	});

	it('falls back to heif-convert (libheif 1.17) and honours HEIF_DEC_BIN', async () => {
		fakeTools();
		fs.renameSync(path.join(bin, 'heif-dec'), path.join(bin, 'heif-convert'));
		let r = await (await fresh()).runSelfCheck();
		expect(r.tools['heif decoder']).toBe('heif-convert 1.19.8');
		expect(r.problems).toEqual([]);

		fs.renameSync(path.join(bin, 'heif-convert'), path.join(bin, 'my-heif'));
		setEnv({ HEIF_DEC_BIN: path.join(bin, 'my-heif') });
		r = await (await fresh()).runSelfCheck();
		expect(r.tools['heif decoder']).toBe(`${path.join(bin, 'my-heif')} 1.19.8`);
	});

	it('says so when there is no HEIF decoder or ffmpeg at all', async () => {
		fakeTools();
		fs.rmSync(path.join(bin, 'heif-dec'));
		setEnv({ FFMPEG_BIN: path.join(bin, 'nope'), FFPROBE_BIN: path.join(bin, 'nope') });
		const r = await (await fresh()).runSelfCheck();
		const all = r.problems.join('\n');
		expect(all).toContain("No HEIF decoder (heif-dec or heif-convert) could be run, so iPhone photos can't be added.");
		expect(all).toContain(`ffmpeg (${path.join(bin, 'nope')}) could not be run: not installed. Videos can't be added.`);
		expect(all).toContain('ffprobe');
	});

	it('warns about low free space on /config and /photos', async () => {
		fakeTools();
		vi.doMock('#lib/server/disk', async (importOriginal) => ({
			...(await importOriginal<typeof import('#lib/server/disk')>()),
			freeBytes: vi.fn(async () => 1_000_000_000)
		}));
		const r = await (await fresh()).runSelfCheck();
		const { configDir, photosDir } = testEnv();
		expect(r.problems).toEqual([
			`Only 1.0 GB is free on ${configDir}, so new photos and videos wait until more is free.`,
			`Only 1.0 GB is free on ${photosDir}, so uploads are turned away.`
		]);
	});

	it('shares one run between concurrent callers', async () => {
		fakeTools();
		const { runSelfCheck } = await fresh();
		const a = runSelfCheck();
		const b = runSelfCheck();
		expect(a).toBe(b);
		await a;
		expect(runSelfCheck()).not.toBe(a);
	});
});

describe('parseHeifDecoders', () => {
	it('reads the decoder ids of each section (heif-dec 1.19 and heif-convert 1.17 print the same)', () => {
		expect(parseHeifDecoders(HEIF_DECODERS)).toEqual({
			HEIC: ['libde265', 'ffmpeg'],
			AVIF: ['dav1d'],
			JPEG: [],
			'JPEG 2000': []
		});
		expect(parseHeifDecoders('')).toEqual({});
	});
});
