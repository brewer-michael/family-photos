/**
 * Startup self-check of the media tools (docs/PLAN.md hooks.server.ts `init`; media-pipeline.md §3
 * "Startup self-check"). Run by startQueue(); the admin page shows getSelfCheck().
 *
 * Each lane's own detection is the one source of truth, so the check and the lanes can't disagree:
 *   video lane      ffmpegCaps() + capsProblems() (encoders, zscale/tonemap/sidedata filters), plus
 *                   the video and audio decoders the format rules rely on; ffprobe `-version`
 *   photo lane      photoToolsReport() (src/worker/photo/tools.ts: the HEIF decoder and its
 *                   libde265/dav1d plugins, ffmpeg's still-image decoders); it imports neither sharp
 *                   nor exiftool, so it is safe to load in the web process
 *   exiftool        `-ver`
 *   disk            free space on /config (≥ 2 GiB per job) and /photos (≥ 2 GiB headroom)
 *
 * Problems never stop the app (the affected items fail with a clear admin detail); they are
 * logged loudly and listed for the admin. Messages are admin-facing.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { getConfig } from './config';
import { configRoot, photosRoot } from './paths';
import { capsProblems, ffmpegCaps } from './media/probe';
import { JOB_MIN_FREE_BYTES, UPLOAD_HEADROOM_BYTES, formatBytes, freeBytes } from './disk';
import { photoToolsReport } from '../../worker/photo/tools';
import { MediaError } from '#lib/shared/errors';

export interface SelfCheck {
	ok: boolean;
	checkedAt: number;
	/** Admin-facing sentences; empty when everything is in place. */
	problems: string[];
	/** Tool → version or summary, e.g. { ffmpeg: 'ffmpeg version 7.1.1-1', exiftool: '13.10' }. */
	tools: Record<string, string>;
}

interface Part {
	problems: string[];
	tools: Record<string, string>;
}

const TOOL_TIMEOUT_MS = 15_000;

/** ffmpeg video decoders (codec names) the format rules depend on, and what fails without each. */
const NEEDED_DECODERS: readonly [codec: string, what: string][] = [
	['h264', 'H.264 videos'],
	['hevc', 'iPhone (HEVC) videos'],
	['vp9', 'VP9 videos'],
	['av1', 'AV1 videos'],
	['prores', 'ProRes videos'],
	['mpeg2video', 'MPEG-2 videos']
];

/** A tool's stdout. */
function exec(bin: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(bin, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout) => {
			if (error) reject(error);
			else resolve(String(stdout));
		});
	});
}

/** One line on why a tool couldn't be run ("not installed" when the binary doesn't exist). */
function why(e: unknown): string {
	const text = MediaError.is(e) ? e.detail : e instanceof Error ? e.message : String(e);
	if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT' || /\bENOENT\b/.test(text)) return 'not installed';
	return text.split('\n')[0];
}

/** The first line of a tool's version output, without copyright noise. */
function firstLine(text: string): string {
	return text.trim().split('\n')[0].replace(/\s+Copyright.*$/, '').trim();
}

async function checkFfmpeg(): Promise<Part> {
	const c = getConfig();
	const problems: string[] = [];
	const tools: Record<string, string> = {};
	try {
		const caps = await ffmpegCaps();
		tools.ffmpeg = caps.version;
		tools['ffmpeg decoders'] = `${caps.decoders.video.size} video, ${caps.decoders.audio.size} audio`;
		problems.push(...capsProblems(caps));
		const missing = NEEDED_DECODERS.filter(([codec]) => !caps.decoders.video.has(codec)).map(([, what]) => what);
		if (missing.length > 0) problems.push(`ffmpeg can't decode ${missing.join(', ')}, so those uploads will fail.`);
		if (!caps.decoders.audio.has('aac')) problems.push('ffmpeg has no AAC decoder, so the sound of most videos will be dropped.');
	} catch (e) {
		problems.push(`ffmpeg (${c.ffmpegBin}) could not be run: ${why(e)}. Videos can't be added.`);
	}
	try {
		tools.ffprobe = firstLine(await exec(c.ffprobeBin, ['-hide_banner', '-version']));
	} catch (e) {
		problems.push(`ffprobe (${c.ffprobeBin}) could not be run: ${why(e)}. Videos can't be added.`);
	}
	return { problems, tools };
}

/** The photo lane's own report (HEIF decoder and plugins, ffmpeg's still-image decoders). */
async function checkPhotoTools(): Promise<Part> {
	try {
		return await photoToolsReport();
	} catch (e) {
		return { problems: [`The photo tools could not be checked: ${why(e)}.`], tools: {} };
	}
}

/** EXIFTOOL_BIN / EXIFTOOL_PATH (as the lanes read them), else the system exiftool (libimage-exiftool-perl). */
function exiftoolBin(): string {
	return getConfig().exiftoolBin ?? (fs.existsSync('/usr/bin/exiftool') ? '/usr/bin/exiftool' : 'exiftool');
}

async function checkExiftool(): Promise<Part> {
	const bin = exiftoolBin();
	try {
		return { problems: [], tools: { exiftool: firstLine(await exec(bin, ['-ver'])) } };
	} catch (e) {
		return { problems: [`exiftool (${bin}) could not be run: ${why(e)}, so dates and places can't be read.`], tools: {} };
	}
}

async function checkDisk(): Promise<Part> {
	const problems: string[] = [];
	const tools: Record<string, string> = {};
	const spots: [dir: string, min: number, effect: string][] = [
		[configRoot(), JOB_MIN_FREE_BYTES, 'new photos and videos wait until more is free'],
		[photosRoot(), UPLOAD_HEADROOM_BYTES, 'uploads are turned away']
	];
	for (const [dir, min, effect] of spots) {
		try {
			const free = await freeBytes(dir);
			tools[`free space ${dir}`] = formatBytes(free);
			if (free < min) problems.push(`Only ${formatBytes(free)} is free on ${dir}, so ${effect}.`);
		} catch (e) {
			problems.push(`Free space on ${dir} could not be read: ${(e as Error).message}.`);
		}
	}
	return { problems, tools };
}

let last: SelfCheck | null = null;
let running: Promise<SelfCheck> | null = null;

/** The latest finished self-check, or null before the first one completes. */
export function getSelfCheck(): SelfCheck | null {
	return last;
}

/** Runs every check (concurrent calls share one run), stores and logs the result. Never rejects. */
export function runSelfCheck(): Promise<SelfCheck> {
	running ??= Promise.all([checkFfmpeg(), checkPhotoTools(), checkExiftool(), checkDisk()])
		.then(
			(parts): Part[] => parts,
			(e: unknown): Part[] => [{ problems: [`The self-check itself failed: ${why(e)}`], tools: {} }]
		)
		.then((parts) => {
			const problems = parts.flatMap((p) => p.problems);
			const result: SelfCheck = {
				ok: problems.length === 0,
				checkedAt: Date.now(),
				problems,
				tools: Object.assign({}, ...parts.map((p) => p.tools)) as Record<string, string>
			};
			last = result;
			report(result);
			return result;
		})
		.finally(() => {
			running = null;
		});
	return running;
}

function report(r: SelfCheck): void {
	const summary = Object.entries(r.tools)
		.map(([k, v]) => `${k}: ${v}`)
		.join(' | ');
	if (r.ok) {
		console.log(`[selfcheck] media tools OK — ${summary}`);
		return;
	}
	console.error(
		`\n[selfcheck] ${r.problems.length} PROBLEM(S) WITH THE MEDIA TOOLS — affected uploads will fail:\n` +
			r.problems.map((p) => `  !! ${p}`).join('\n') +
			`\n[selfcheck] ${summary}\n`
	);
}
