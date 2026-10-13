/**
 * What the photo lane's external decoders can do, detected once per process at runtime, so the
 * same code runs on libheif 1.17 (Ubuntu 24.04: heif-convert, no --disable-limits) and 1.19
 * (Debian trixie: heif-dec) and on ffmpeg 6.1 or 7.1.
 *
 * - HEIF: HEIF_DEC_BIN, else heif-dec, else heif-convert; heif-info next to it. Decoder ids come
 *   from `--list-decoders`; --disable-limits support from `--help`.
 * - ffmpeg: which still-image decoders exist (JPEG XL, JPEG 2000, BMP, PSD).
 *
 * No sharp or exiftool imports: the web process's startup self-check may use photoToolsReport().
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '#lib/server/config';

export interface HeifTools {
	/** heif-dec (libheif ≥ 1.18), heif-convert (1.17) or HEIF_DEC_BIN. */
	decBin: string;
	infoBin: string;
	/** libheif version from the help banner, e.g. '1.19.8'; null if the tool is missing. */
	version: string | null;
	/** Decoder ids from `--list-decoders`, in listed order. */
	decoders: { hevc: string[]; av1: string[] };
	/** The decoder / heif-info accept --disable-limits (libheif ≥ 1.18). */
	decDisableLimits: boolean;
	infoDisableLimits: boolean;
}

export type FfmpegImageCodec = 'jxl' | 'jp2' | 'bmp' | 'psd';

export interface FfmpegImageTools {
	bin: string;
	/** Which still-image formats the configured ffmpeg can decode. */
	decodes: Record<FfmpegImageCodec, boolean>;
}

/** ffmpeg decoder names that can read each format (native or library-backed). */
const FFMPEG_DECODERS: Record<FfmpegImageCodec, string[]> = {
	jxl: ['libjxl', 'jpegxl'],
	jp2: ['jpeg2000', 'libopenjpeg'],
	bmp: ['bmp'],
	psd: ['psd']
};

/** Preferred decoder order per codec (docs/media-pipeline.md §2): ffmpegdec first for HEVC. */
const PREFERRED = { hevc: ['ffmpeg', 'libde265'], av1: ['dav1d', 'aom'] } as const;

interface Captured {
	/** False when the program could not be started (missing). */
	started: boolean;
	out: string;
}

/** stdout + stderr of a short command, whatever its exit code. */
function capture(cmd: string, args: string[]): Promise<Captured> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = (err as NodeJS.ErrnoException | null)?.code;
			resolve({ started: code !== 'ENOENT' && code !== 'EACCES', out: `${stdout}\n${stderr}` });
		});
	});
}

function onPath(name: string): boolean {
	return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
		try {
			fs.accessSync(path.join(dir, name), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/** `--list-decoders` output ("HEIC decoders:" / "- libde265 = …" lines) → ids per codec. */
export function parseDecoderList(text: string): HeifTools['decoders'] {
	const decoders: HeifTools['decoders'] = { hevc: [], av1: [] };
	let section: keyof HeifTools['decoders'] | null = null;
	for (const line of text.split('\n')) {
		const head = /^(\S.*) decoders:\s*$/.exec(line);
		if (head) {
			section = head[1] === 'HEIC' ? 'hevc' : head[1] === 'AVIF' ? 'av1' : null;
			continue;
		}
		const item = /^- (\S+) = /.exec(line);
		if (item && section) decoders[section].push(item[1]);
	}
	return decoders;
}

/** Decoder ids to try, in order, for a codec: the preferred ones first, then anything else listed. */
export function decoderOrder(tools: HeifTools, codec: 'hevc' | 'av1'): string[] {
	const preferred: readonly string[] = PREFERRED[codec];
	const listed = tools.decoders[codec];
	return [...preferred.filter((d) => listed.includes(d)), ...listed.filter((d) => !preferred.includes(d))];
}

async function detectHeif(): Promise<HeifTools> {
	const configured = getConfig().heifDecBin;
	const decBin = configured ?? (onPath('heif-dec') ? 'heif-dec' : 'heif-convert');
	const sibling = path.join(path.dirname(decBin), 'heif-info');
	const infoBin = decBin.includes('/') && fs.existsSync(sibling) ? sibling : 'heif-info';
	const [help, list, infoHelp] = await Promise.all([
		capture(decBin, ['--help']),
		capture(decBin, ['--list-decoders']),
		capture(infoBin, ['--help'])
	]);
	return {
		decBin,
		infoBin,
		version: help.started ? (/libheif version: (\S+)/.exec(help.out)?.[1] ?? null) : null,
		decoders: list.started ? parseDecoderList(list.out) : { hevc: [], av1: [] },
		decDisableLimits: help.out.includes('--disable-limits'),
		infoDisableLimits: infoHelp.out.includes('--disable-limits')
	};
}

async function detectFfmpeg(): Promise<FfmpegImageTools> {
	const bin = getConfig().ffmpegBin;
	const { out } = await capture(bin, ['-hide_banner', '-decoders']);
	const names = new Set([...out.matchAll(/^\s*V[A-Z.]{5}\s+(\S+)/gm)].map((m) => m[1]));
	const decodes = Object.fromEntries(
		Object.entries(FFMPEG_DECODERS).map(([k, list]) => [k, list.some((d) => names.has(d))])
	) as Record<FfmpegImageCodec, boolean>;
	return { bin, decodes };
}

let heif: Promise<HeifTools> | null = null;
let ffmpeg: Promise<FfmpegImageTools> | null = null;

export function heifTools(): Promise<HeifTools> {
	heif ??= detectHeif();
	return heif;
}

export function ffmpegImageTools(): Promise<FfmpegImageTools> {
	ffmpeg ??= detectFfmpeg();
	return ffmpeg;
}

/** Tests only: detect again on next use (e.g. after changing HEIF_DEC_BIN). */
export function forgetPhotoTools(): void {
	heif = null;
	ffmpeg = null;
}

/** Problems an admin should fix (missing HEIF tools or decoder plugins, missing ffmpeg decoders). */
export function photoToolProblems(h: HeifTools, f: FfmpegImageTools): string[] {
	const problems: string[] = [];
	if (!h.version) problems.push(`The HEIF decoder (${h.decBin}) is not installed, so iPhone photos can't be added.`);
	else {
		if (!h.decoders.hevc.includes('libde265')) problems.push('libheif has no libde265 decoder (libheif-plugin-libde265), so iPhone photos may fail.');
		if (!h.decoders.av1.includes('dav1d')) problems.push('libheif has no dav1d decoder (libheif-plugin-dav1d), so AVIF photos may fail.');
	}
	const missing = (Object.keys(f.decodes) as FfmpegImageCodec[]).filter((k) => !f.decodes[k]);
	if (missing.length > 0) problems.push(`ffmpeg can't decode ${missing.join(', ')} images; those uploads will be refused.`);
	return problems;
}

/** For the startup self-check: tool versions and problems. */
export async function photoToolsReport(): Promise<{ problems: string[]; tools: Record<string, string> }> {
	const [h, f] = await Promise.all([heifTools(), ffmpegImageTools()]);
	return {
		problems: photoToolProblems(h, f),
		tools: {
			[path.basename(h.decBin)]: h.version ? `libheif ${h.version} (decoders: ${[...h.decoders.hevc, ...h.decoders.av1].join(', ') || 'none'})` : 'missing'
		}
	};
}
