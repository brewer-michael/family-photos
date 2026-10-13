/**
 * ffprobe for videos: the facts the video lane plans from (docs/media-pipeline.md §3 "Probe and
 * plan") and the cost estimate used for video lane ordering. Used by intake in the main process
 * (kind, est_cost_s, early rejection) and again by the video lane before it converts.
 *
 * summarize() and estimateCostS() are pure (hand-written ffprobe JSON in unit tests);
 * probeVideo() runs ffprobe. ffmpegCaps() detects once per process what the configured ffmpeg
 * can do (production: Debian trixie 7.1 with zimg; local dev: Ubuntu 6.1, whose sidedata filter
 * lacks AMBIENT_VIEWING_ENVIRONMENT) for the video lane and the startup self-check.
 */
import { execFile, type ExecFileException } from 'node:child_process';
import { envWithoutSecrets, getConfig } from '#lib/server/config';
import { MediaError } from '#lib/shared/errors';

/** Subset of ffprobe -show_streams JSON we rely on (everything else is in `raw`). */
export interface FfprobeStream {
	index: number;
	codec_type?: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | string;
	codec_name?: string;
	codec_tag_string?: string;
	profile?: string;
	level?: number;
	width?: number;
	height?: number;
	pix_fmt?: string;
	bits_per_raw_sample?: string;
	sample_aspect_ratio?: string;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	field_order?: string;
	color_range?: string;
	color_space?: string;
	color_transfer?: string;
	color_primaries?: string;
	channels?: number;
	sample_rate?: string;
	bit_rate?: string;
	duration?: string;
	disposition?: Record<string, number>;
	tags?: Record<string, string>;
	side_data_list?: Array<Record<string, unknown>>;
}

export interface FfprobeFormat {
	format_name?: string;
	duration?: string;
	size?: string;
	bit_rate?: string;
	tags?: Record<string, string>;
}

export interface FfprobeResult {
	streams: FfprobeStream[];
	format: FfprobeFormat;
}

/** Codec names ffmpeg can decode in software, from `ffmpeg -hide_banner -decoders`. */
export interface Decoders {
	video: ReadonlySet<string>;
	audio: ReadonlySet<string>;
}

/**
 * sdr: BT.709/601; wcg: BT.2020 primaries with an SDR transfer; hlg/pq: HDR (including Dolby
 * Vision 8.x through its base layer). Dolby Vision without a compatible base layer is rejected.
 */
export type HdrClass = 'sdr' | 'wcg' | 'hlg' | 'pq';

export interface AudioChoice {
	index: number;
	codec: string;
	/** ffprobe profile, e.g. 'LC' for AAC-LC. */
	profile: string | null;
	/** 0 when unknown. */
	channels: number;
	/** Hz; 0 when unknown. */
	sampleRate: number;
	/** AAC-LC, 1–2 channels, 44.1 or 48 kHz: copied as-is, otherwise re-encoded. */
	copyable: boolean;
}

/** Container tags the lane uses for dates, place and Live Photo pairing (raw strings). */
export interface VideoTags {
	/** com.apple.quicktime.creationdate, e.g. '2024-07-04T11:22:31-0700' (local time + offset). */
	creationDate: string | null;
	/** mvhd creation_time (UTC), e.g. '2024-07-04T18:22:31.000000Z'. */
	creationTime: string | null;
	/** ISO 6709 location (Apple key, or the ©xyz 'location' tag Android and ffmpeg write). */
	location: string | null;
	/** com.apple.quicktime.full-frame-rate-playback-intent ('0' = play as slow motion; iOS 18+). */
	playbackIntent: string | null;
	/** com.apple.quicktime.content.identifier (Live Photo pairing). */
	contentId: string | null;
}

export interface VideoProbe {
	/** Seconds (format duration, else main video stream duration). */
	durationS: number;
	/** Coded size of the main video stream (before SAR/rotation). */
	width: number;
	height: number;
	/** Size as displayed: width × SAR, swapped when rotated by ±90°. */
	displayWidth: number;
	displayHeight: number;
	/** Pixel aspect ratio as a number (1 when unset). */
	sar: number;
	/** Display-matrix rotation in degrees as ffprobe reports it (counter-clockwise), in (-180, 180]. */
	rotation: number;
	/** avg_frame_rate, falling back to r_frame_rate (also when the average is bogus); 0 when unknown. */
	fps: number;
	codec: string;
	codecTag: string;
	profile: string | null;
	level: number | null;
	pixFmt: string | null;
	bitDepth: number;
	/** Video bit rate in bit/s (stream, else the container's total); null when unknown. */
	bitRate: number | null;
	/** 'pc' for full range (color_range pc or a yuvj* pixel format), else 'tv'. */
	colorRange: 'tv' | 'pc';
	colorSpace: string | null;
	colorTransfer: string | null;
	colorPrimaries: string | null;
	hdrClass: HdrClass;
	/** hdrClass is hlg or pq (tone mapping needed). */
	hdr: boolean;
	dolbyVision: { profile: number; compatId: number } | null;
	/** Stream-level HDR10 metadata in cd/m² (SEI-only metadata needs probeFirstFrameHdr). */
	maxCll: number | null;
	masteringMaxLum: number | null;
	interlaced: boolean;
	/** ffprobe format_name, e.g. 'mov,mp4,m4a,3gp,3g2,mj2'. */
	container: string;
	/** Index of the main (largest, non-attached-pic) video stream. */
	videoIndex: number;
	/** The source has at least one audio stream. */
	hasAudio: boolean;
	/** The audio stream to keep, or null (none, or none decodable). */
	audio: AudioChoice | null;
	/** The source had audio but none of it can be decoded. */
	audioDropped: boolean;
	/** The video stream meets every remux rule (docs/media-pipeline.md §3 "Remux criteria"). */
	remuxable: boolean;
	tags: VideoTags;
	raw: FfprobeResult;
}

/** Output box (either orientation). There is no 4K option: 4K detail stays in the archived original. */
export const VIDEO_BOX = { long: 1920, short: 1080 } as const;

/** Source caps (docs/media-pipeline.md §3 "Resource limits"). */
export const MAX_SOURCE_FPS = 240;
export const MAX_SOURCE_DIMENSION = 8192;

export function parseRate(r: string | undefined): number {
	if (!r) return 0;
	const [n, d] = r.split('/').map(Number);
	if (!Number.isFinite(n)) return 0;
	if (d === undefined) return n;
	return d ? n / d : 0;
}

function num(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
}

/** Hardware-only wrappers (cuvid, qsv, …) and the native av1 decoder, which needs a hardware accelerator. */
const HW_DECODER = /_(cuvid|qsv|v4l2m2m|mediacodec|mmal|rkmpp|amf|vaapi|vdpau|videotoolbox|vulkan|ohcodec)$/;

/** Parses `ffmpeg -hide_banner -decoders` into the codec names that have a software decoder. */
export function parseDecoders(text: string): Decoders {
	const video = new Set<string>();
	const audio = new Set<string>();
	for (const line of text.split('\n')) {
		const m = /^ ([VAS])[A-Z.]{5} (\S+)\s+(.*)$/.exec(line);
		if (!m || m[2] === '=' || HW_DECODER.test(m[2]) || m[2] === 'av1') continue;
		const codec = /\(codec (\S+)\)\s*$/.exec(m[3])?.[1] ?? m[2];
		if (m[1] === 'V') video.add(codec);
		else if (m[1] === 'A') audio.add(codec);
	}
	return { video, audio };
}

function sideData(s: FfprobeStream, type: string): Record<string, unknown> | undefined {
	return s.side_data_list?.find((d) => d.side_data_type === type);
}

/** Display-matrix rotation (ffprobe ≥ 5), else the legacy clockwise `rotate` tag; normalised to (-180, 180]. */
function rotationOf(s: FfprobeStream): number {
	let deg = num(sideData(s, 'Display Matrix')?.rotation);
	if (deg === null) {
		const legacy = num(s.tags?.rotate);
		deg = legacy === null ? 0 : -legacy;
	}
	deg = ((Math.round(deg) % 360) + 360) % 360;
	return deg > 180 ? deg - 360 : deg;
}

/**
 * avg_frame_rate, falling back to r_frame_rate. r_frame_rate is the least common multiple of the
 * stream's rates, so a larger average is bogus (raw DV reports 60000/1): then r_frame_rate wins.
 */
function frameRate(s: FfprobeStream): number {
	const avg = parseRate(s.avg_frame_rate);
	const r = parseRate(s.r_frame_rate);
	return avg > 0 && (r <= 0 || avg <= r * 1.01) ? avg : r;
}

function sarOf(s: FfprobeStream): number {
	const m = /^(\d+):(\d+)$/.exec(s.sample_aspect_ratio ?? '');
	if (!m || Number(m[1]) === 0 || Number(m[2]) === 0) return 1;
	return Number(m[1]) / Number(m[2]);
}

function bitDepthOf(s: FfprobeStream): number {
	const raw = num(s.bits_per_raw_sample);
	if (raw !== null && raw >= 8) return raw;
	const m = /p(\d{2})(le|be)$/.exec(s.pix_fmt ?? '');
	return m ? Number(m[1]) : 8;
}

function doviOf(s: FfprobeStream): VideoProbe['dolbyVision'] {
	const d = sideData(s, 'DOVI configuration record');
	if (!d) return null;
	return { profile: num(d.dv_profile) ?? -1, compatId: num(d.dv_bl_signal_compatibility_id) ?? -1 };
}

function hdrClassOf(s: FfprobeStream, dovi: VideoProbe['dolbyVision']): HdrClass {
	if (s.color_transfer === 'smpte2084') return 'pq';
	if (s.color_transfer === 'arib-std-b67') return 'hlg';
	if (dovi?.compatId === 4) return 'hlg';
	if (dovi?.compatId === 1 || dovi?.compatId === 6) return 'pq';
	if (s.color_primaries === 'bt2020' || s.color_space === 'bt2020nc' || s.color_space === 'bt2020c') return 'wcg';
	return 'sdr';
}

function lowerKeys(tags: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(tags ?? {})) out[k.toLowerCase()] = v;
	return out;
}

/** Decodable, not Apple spatial audio (APAC); prefer AAC, then the default stream, then the lowest index. */
function chooseAudio(streams: FfprobeStream[], decoders: Decoders | null): AudioChoice | null {
	const candidates = streams.filter(
		(s) =>
			s.codec_type === 'audio' &&
			!!s.codec_name &&
			(!decoders || decoders.audio.has(s.codec_name)) &&
			(s.codec_tag_string ?? '').toLowerCase() !== 'apac'
	);
	const rank = (s: FfprobeStream) => (s.codec_name === 'aac' ? 0 : 2) + (s.disposition?.default === 1 ? 0 : 1);
	candidates.sort((x, y) => rank(x) - rank(y) || x.index - y.index);
	const a = candidates[0];
	if (!a) return null;
	const channels = a.channels ?? 0;
	const sampleRate = num(a.sample_rate) ?? 0;
	return {
		index: a.index,
		codec: a.codec_name!,
		profile: a.profile ?? null,
		channels,
		sampleRate,
		copyable:
			a.codec_name === 'aac' &&
			a.profile === 'LC' &&
			channels >= 1 &&
			channels <= 2 &&
			(sampleRate === 44100 || sampleRate === 48000)
	};
}

const INTERLACED_ORDERS = new Set(['tt', 'bb', 'tb', 'bt']);
const REMUX_CONTAINERS = new Set(['mov', 'mp4', 'm4v', '3gp', 'matroska']);
const REMUX_H264_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main', 'High']);
const REMUX_MAX_BITRATE = 20_000_000;

/** The video-stream facts; the rest of VideoProbe is derived from these plus the other streams. */
type VideoFacts = Omit<VideoProbe, 'hasAudio' | 'audio' | 'audioDropped' | 'remuxable' | 'tags' | 'raw'>;

function isRemuxable(p: VideoFacts): boolean {
	const long = Math.max(p.displayWidth, p.displayHeight);
	const short = Math.min(p.displayWidth, p.displayHeight);
	return (
		p.container.split(',').some((c) => REMUX_CONTAINERS.has(c)) &&
		p.codec === 'h264' &&
		REMUX_H264_PROFILES.has(p.profile ?? '') &&
		(p.pixFmt === 'yuv420p' || p.pixFmt === 'yuvj420p') &&
		p.codecTag.toLowerCase() !== 'avc3' &&
		!p.interlaced &&
		p.level !== null &&
		p.level <= 42 &&
		long <= VIDEO_BOX.long &&
		short <= VIDEO_BOX.short &&
		p.sar === 1 &&
		p.fps <= 60.5 &&
		p.bitRate !== null &&
		p.bitRate <= REMUX_MAX_BITRATE &&
		p.hdrClass === 'sdr' &&
		p.colorPrimaries !== 'bt2020' &&
		p.colorSpace !== 'bt2020nc' &&
		p.colorSpace !== 'bt2020c' &&
		p.dolbyVision === null
	);
}

/**
 * Summarises ffprobe JSON. Throws MediaError('unsupported') when there is no video stream, its
 * codec can't be decoded (when `decoders` is given), or it is Dolby Vision without a compatible
 * base layer (profile 5). Without `decoders`, every named codec counts as decodable.
 */
export function summarize(raw: FfprobeResult, opts: { decoders?: Decoders | null } = {}): VideoProbe {
	const streams = raw.streams ?? [];
	const format = raw.format ?? {};
	const decoders = opts.decoders ?? null;
	const videos = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
	if (videos.length === 0) throw new MediaError('unsupported', 'no video stream');
	const v = videos.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a));
	if (!v.codec_name || (decoders && !decoders.video.has(v.codec_name))) {
		throw new MediaError('unsupported', `no decoder for the video stream (${v.codec_name ?? v.codec_tag_string ?? 'unknown codec'})`);
	}
	const dolbyVision = doviOf(v);
	if (dolbyVision?.compatId === 0) {
		throw new MediaError('unsupported', `Dolby Vision profile ${dolbyVision.profile} has no compatible base layer`);
	}

	const width = v.width ?? 0;
	const height = v.height ?? 0;
	const sar = sarOf(v);
	const rotation = rotationOf(v);
	const w = Math.round(width * sar);
	const swap = Math.abs(rotation) % 180 === 90;
	const hdrClass = hdrClassOf(v, dolbyVision);
	const mastering = sideData(v, 'Mastering display metadata');
	const cll = sideData(v, 'Content light level metadata');
	const vtags = lowerKeys(v.tags);
	const ftags = lowerKeys(format.tags);
	const audioStreams = streams.filter((s) => s.codec_type === 'audio');
	const audio = chooseAudio(streams, decoders);

	const base: VideoFacts = {
		durationS: num(format.duration) ?? num(v.duration) ?? 0,
		width,
		height,
		displayWidth: swap ? height : w,
		displayHeight: swap ? w : height,
		sar,
		rotation,
		fps: frameRate(v),
		codec: v.codec_name,
		codecTag: v.codec_tag_string ?? '',
		profile: v.profile ?? null,
		level: num(v.level),
		pixFmt: v.pix_fmt ?? null,
		bitDepth: bitDepthOf(v),
		bitRate: num(v.bit_rate) ?? num(vtags['bps']) ?? num(vtags['bps-eng']) ?? num(format.bit_rate),
		colorRange: v.color_range === 'pc' || (v.pix_fmt ?? '').startsWith('yuvj') ? 'pc' : 'tv',
		colorSpace: v.color_space ?? null,
		colorTransfer: v.color_transfer ?? null,
		colorPrimaries: v.color_primaries ?? null,
		hdrClass,
		hdr: hdrClass === 'hlg' || hdrClass === 'pq',
		dolbyVision,
		maxCll: num(cll?.max_content) || null,
		masteringMaxLum: parseRate(String(mastering?.max_luminance ?? '')) || null,
		interlaced: INTERLACED_ORDERS.has(v.field_order ?? '') || v.codec_name === 'dvvideo' || v.codec_name === 'mpeg2video',
		container: format.format_name ?? '',
		videoIndex: v.index
	};
	return {
		...base,
		hasAudio: audioStreams.length > 0,
		audio,
		audioDropped: audioStreams.length > 0 && audio === null,
		remuxable: isRemuxable(base),
		tags: {
			creationDate: ftags['com.apple.quicktime.creationdate'] ?? null,
			creationTime: ftags['creation_time'] ?? vtags['creation_time'] ?? null,
			location: ftags['com.apple.quicktime.location.iso6709'] ?? ftags['location'] ?? null,
			playbackIntent: ftags['com.apple.quicktime.full-frame-rate-playback-intent'] ?? null,
			contentId: ftags['com.apple.quicktime.content.identifier'] ?? null
		},
		raw
	};
}

/**
 * Size, duration and frame-rate caps → MediaError('too_large'); a video without a duration →
 * MediaError('corrupt'). `maxDurationS` is MAX_VIDEO_MINUTES in seconds.
 */
export function checkLimits(p: VideoProbe, maxDurationS: number): void {
	if (!(p.durationS > 0)) throw new MediaError('corrupt', 'the video has no duration');
	if (p.durationS > maxDurationS) {
		const fmt = (s: number) => (s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
		throw new MediaError('too_large', `video is ${fmt(p.durationS)} long; the limit is ${fmt(maxDurationS)} (MAX_VIDEO_MINUTES)`);
	}
	if (Math.max(p.width, p.height) > MAX_SOURCE_DIMENSION) {
		throw new MediaError('too_large', `video is ${p.width}×${p.height}; the limit is ${MAX_SOURCE_DIMENSION} px per side`);
	}
	if (p.fps > MAX_SOURCE_FPS + 1) {
		throw new MediaError('too_large', `video is ${p.fps.toFixed(1)} fps; the limit is ${MAX_SOURCE_FPS} fps`);
	}
}

interface ExecFailure {
	error: ExecFileException;
	stderr: string;
}

function exec(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			// ffprobe reads uploaded bytes (intake runs it in the web process): no secrets for it.
			{ timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL', signal, env: envWithoutSecrets() },
			(error, stdout, stderr) => {
				if (error) reject({ error, stderr: String(stderr) } satisfies ExecFailure);
				else resolve(stdout);
			}
		);
	});
}

function probeError(f: ExecFailure, what: string): MediaError {
	const e = f.error;
	if (e.name === 'AbortError') return new MediaError('retryable', `${what}: cancelled`);
	if (e.killed || e.code === 'ENOENT') return new MediaError('retryable', `${what}: ${e.message}`);
	return new MediaError('corrupt', `${what} failed: ${f.stderr.trim().slice(0, 500)}`);
}

export interface ProbeOptions {
	/** Default 30 s. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Raw ffprobe JSON (-show_format -show_streams). Rejects with MediaError('corrupt'|'retryable'). */
export async function ffprobeJson(path: string, opts: ProbeOptions = {}): Promise<FfprobeResult> {
	let stdout: string;
	try {
		stdout = await exec(
			getConfig().ffprobeBin,
			['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
			opts.timeoutMs ?? 30_000,
			opts.signal
		);
	} catch (f) {
		throw probeError(f as ExecFailure, 'ffprobe');
	}
	let raw: FfprobeResult;
	try {
		raw = JSON.parse(stdout) as FfprobeResult;
	} catch {
		throw new MediaError('corrupt', 'ffprobe returned invalid JSON');
	}
	raw.streams ??= [];
	raw.format ??= {};
	return raw;
}

/** Runs `ffmpeg -hide_banner …args` and returns stdout; MediaError('retryable') when it can't. */
async function ffmpegText(args: string[]): Promise<string> {
	try {
		return await exec(getConfig().ffmpegBin, ['-hide_banner', ...args], 30_000);
	} catch (f) {
		throw new MediaError('retryable', `ffmpeg ${args.join(' ')} failed: ${(f as ExecFailure).error.message}`);
	}
}

let decodersCache: Promise<Decoders> | null = null;

/** Software decoders of the configured ffmpeg, parsed once per process. */
export function ffmpegDecoders(): Promise<Decoders> {
	decodersCache ??= ffmpegText(['-decoders']).then(parseDecoders, (e: unknown) => {
		decodersCache = null;
		throw e;
	});
	return decodersCache;
}

/** What the configured ffmpeg can do, as far as the video lane is concerned. */
export interface FfmpegCaps {
	/** e.g. 'ffmpeg version 7.1.1' (first line of `ffmpeg -version`, without the copyright). */
	version: string;
	zscale: boolean;
	tonemap: boolean;
	/** The `sidedata` filter, and the frame side-data types it can delete. */
	sidedata: boolean;
	sidedataTypes: ReadonlySet<string>;
	libx264: boolean;
	aac: boolean;
	decoders: Decoders;
}

/** ` TS. bwdif   V->V   Deinterlace…` → 'bwdif' (from `ffmpeg -filters`). */
export function parseFilters(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/^ [A-Z.|]{3} (\S+)\s+\S+->\S+/gm)) out.add(m[1]);
	return out;
}

/** ` V....D libx264   libx264 H.264 … (codec h264)` → 'libx264' (from `ffmpeg -encoders`). */
export function parseEncoders(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(/^ [VAS][A-Z.]{5} (\S+)\s/gm)) if (m[1] !== '=') out.add(m[1]);
	return out;
}

/** The `type` constants listed by `ffmpeg -h filter=sidedata`, e.g. 'MASTERING_DISPLAY_METADATA'. */
export function parseSidedataTypes(help: string): Set<string> {
	const out = new Set<string>();
	for (const m of help.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s+-?\d+\s+[.A-Z]{6,}/gm)) out.add(m[1]);
	return out;
}

let capsCache: Promise<FfmpegCaps> | null = null;

/** Detects (once per process) the configured ffmpeg's capabilities. A failure is not cached. */
export function ffmpegCaps(): Promise<FfmpegCaps> {
	capsCache ??= Promise.all([
		ffmpegText(['-version']),
		ffmpegText(['-filters']),
		ffmpegText(['-encoders']),
		ffmpegText(['-h', 'filter=sidedata']),
		ffmpegDecoders()
	]).then(
		([version, filters, encoders, sidedataHelp, decoders]) => {
			const f = parseFilters(filters);
			const e = parseEncoders(encoders);
			return {
				version: version.split('\n')[0].replace(/\s+Copyright.*$/, '').trim(),
				zscale: f.has('zscale'),
				tonemap: f.has('tonemap'),
				sidedata: f.has('sidedata'),
				sidedataTypes: f.has('sidedata') ? parseSidedataTypes(sidedataHelp) : new Set<string>(),
				libx264: e.has('libx264'),
				aac: e.has('aac'),
				decoders
			};
		},
		(e: unknown) => {
			capsCache = null;
			throw e;
		}
	);
	return capsCache;
}

/** What's missing, in admin words (startup self-check). Empty when the video lane has everything. */
export function capsProblems(c: FfmpegCaps): string[] {
	const out: string[] = [];
	if (!c.libx264) out.push('ffmpeg has no libx264 encoder, so videos that need converting will fail.');
	if (!c.aac) out.push('ffmpeg has no aac encoder, so videos whose sound needs converting will fail.');
	if (!c.zscale) out.push('ffmpeg has no zscale filter (libzimg), so HDR and wide-colour videos will fail.');
	if (!c.tonemap || !c.sidedata) out.push('ffmpeg lacks the tonemap or sidedata filter, so HDR videos will fail.');
	if (c.sidedata && !c.sidedataTypes.has('AMBIENT_VIEWING_ENVIRONMENT')) {
		out.push(`${c.version}: its sidedata filter can't remove AMBIENT_VIEWING_ENVIRONMENT data (the Docker image's ffmpeg 7.1 can).`);
	}
	return out;
}

export interface ProbeVideoOptions extends ProbeOptions {
	/** Default MAX_VIDEO_MINUTES. */
	maxDurationS?: number;
	/** Default: ffmpegDecoders(). */
	decoders?: Decoders;
}

/**
 * Probes a video and applies the caps. Rejects with MediaError: 'corrupt' (unreadable),
 * 'unsupported' (no decodable video track, Dolby Vision profile 5), 'too_large' (caps) or
 * 'retryable' (timeout, ffprobe missing).
 */
export async function probeVideo(path: string, opts: ProbeVideoOptions = {}): Promise<VideoProbe> {
	const [raw, decoders] = await Promise.all([ffprobeJson(path, opts), opts.decoders ?? ffmpegDecoders()]);
	const probe = summarize(raw, { decoders });
	checkLimits(probe, opts.maxDurationS ?? getConfig().maxVideoSeconds);
	return probe;
}

/**
 * HDR10 metadata carried in the first frame (HEVC SEI), for PQ sources whose container has none.
 * Returns nulls when absent or when the probe fails (the tone-map peak then falls back to 1000 nits).
 */
export async function probeFirstFrameHdr(
	path: string,
	videoIndex: number,
	opts: ProbeOptions = {}
): Promise<{ maxCll: number | null; masteringMaxLum: number | null }> {
	try {
		const out = await exec(
			getConfig().ffprobeBin,
			['-v', 'error', '-select_streams', String(videoIndex), '-read_intervals', '%+#1', '-show_frames', '-print_format', 'json', path],
			opts.timeoutMs ?? 30_000,
			opts.signal
		);
		const frame = (JSON.parse(out) as { frames?: FfprobeStream[] }).frames?.[0];
		if (!frame) return { maxCll: null, masteringMaxLum: null };
		return {
			maxCll: num(sideData(frame, 'Content light level metadata')?.max_content) || null,
			masteringMaxLum: parseRate(String(sideData(frame, 'Mastering display metadata')?.max_luminance ?? '')) || null
		};
	} catch {
		return { maxCll: null, masteringMaxLum: null };
	}
}

/**
 * est_cost_s = dur × (W·H·fps)/(1920·1080·30) × (hdr ? 1.5 : 1) × (remux ? 0.02 : 1).
 * `remux` defaults to the probe's own remux decision.
 */
export function estimateCostS(probe: VideoProbe, opts: { remux?: boolean } = {}): number {
	const remux = opts.remux ?? probe.remuxable;
	const px = (probe.width * probe.height * (probe.fps || 30)) / (1920 * 1080 * 30);
	return probe.durationS * px * (probe.hdr ? 1.5 : 1) * (remux ? 0.02 : 1);
}
