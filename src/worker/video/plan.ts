/**
 * The pure video planner (docs/media-pipeline.md §3, with the "no 4K option" override): from a
 * VideoProbe and the ffmpeg capabilities to the output size, frame rate, colour path, audio
 * handling, encoder level/VBV and the exact ffmpeg argument arrays (without the binary name).
 * No I/O, so every decision is unit-tested from hand-written ffprobe JSON.
 */
import { VIDEO_BOX, type AudioChoice, type FfmpegCaps, type VideoProbe } from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';

/** The capabilities the planner looks at. */
export type PlanCaps = Pick<FfmpegCaps, 'zscale' | 'tonemap' | 'sidedata' | 'sidedataTypes' | 'libx264' | 'aac'>;

export type ColourPath = 'sdr' | 'wcg' | 'hdr';

export interface PlanOptions {
	caps: PlanCaps;
	/** VIDEO_THREADS. */
	threads: number;
	src: string;
	/** The canonical output in the work dir: <workDir>/<id>.mp4 */
	out: string;
	/** mvhd creation_time (UTC ISO); null when unknown or before 2000. */
	creationTime: string | null;
	/** HDR10 metadata for the PQ tone-map peak (stream level, else from the first frame). */
	hdrMeta?: { maxCll: number | null; masteringMaxLum: number | null };
}

export interface VideoPlan {
	mode: 'remux' | 'transcode';
	/** Output size as displayed (even, fitted to 1920×1080 in either orientation). */
	width: number;
	height: number;
	fpsIn: number;
	/** Frame rate used for the level, VBV and GOP (passthrough keeps the source timing). */
	fpsOut: number;
	slowmo: boolean;
	colour: ColourPath;
	/** HDR only: zscale input transfer and the tonemap peak (× 100 cd/m²). */
	tin: 'arib-std-b67' | 'smpte2084' | null;
	peak: number | null;
	interlaced: boolean;
	audioIndex: number | null;
	audioCopy: boolean;
	audioDropped: boolean;
	level: '4.0' | '4.2';
	maxrateK: number;
	/** Expected output duration (× fpsIn/30 for slow motion). */
	expectedDurationS: number;
	/**
	 * The canonical file is not a lossless copy of every source stream (transcode, re-encoded
	 * audio, or a dropped stream): the source is archived when KEEP_ORIGINALS is on.
	 */
	lossy: boolean;
	/** ffmpeg arguments for the conversion (progress on stdout). */
	args: string[];
	/** ffmpeg arguments for the poster frame (PNG on stdout). */
	posterArgs: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Even output size: s = min(1, LONG/long, SHORT/short), W,H = max(2, round(x·s/2)·2). */
export function outputSize(displayWidth: number, displayHeight: number): { width: number; height: number } {
	const long = Math.max(displayWidth, displayHeight);
	const short = Math.min(displayWidth, displayHeight);
	const s = Math.min(1, VIDEO_BOX.long / long, VIDEO_BOX.short / short);
	const even = (x: number) => Math.max(2, Math.round((x * s) / 2) * 2);
	return { width: even(displayWidth), height: even(displayHeight) };
}

/** atempo accepts 0.5–100 per instance: 30/240 → 'atempo=0.5,atempo=0.5,atempo=0.5'. */
export function atempoChain(factor: number): string {
	const parts: string[] = [];
	let f = factor;
	while (f < 0.5) {
		parts.push('atempo=0.5');
		f /= 0.5;
	}
	if (Math.abs(f - 1) > 1e-6) parts.push(`atempo=${Number(f.toFixed(6))}`);
	return parts.join(',');
}

/** H.264 level for the 1080p box: 4.2 above 30 fps (1080p60), else 4.0. */
export function levelFor(fpsOut: number): '4.0' | '4.2' {
	return fpsOut > 30 ? '4.2' : '4.0';
}

/** VBV maxrate in kbit/s: 10 Mbit/s at 1080p30, scaled by pixel count^0.75, ×1.4 above 30 fps. */
export function maxrateKbps(width: number, height: number, fpsOut: number): number {
	return clamp(10000 * Math.pow((width * height) / 2073600, 0.75) * (fpsOut > 30 ? 1.4 : 1), 1500, 14000) | 0;
}

/** scale's matrix name for the source: bt709 | bt601 | bt2020; untagged → HD (short edge ≥ 720) ? bt709 : bt601. */
export function inputMatrix(p: Pick<VideoProbe, 'colorSpace' | 'width' | 'height'>): 'bt709' | 'bt601' | 'bt2020' {
	switch (p.colorSpace) {
		case 'bt709':
			return 'bt709';
		case 'smpte170m':
		case 'bt470bg':
		case 'fcc':
			return 'bt601';
		case 'bt2020nc':
		case 'bt2020c':
			return 'bt2020';
		default:
			return Math.min(p.width, p.height) >= 720 ? 'bt709' : 'bt601';
	}
}

function colourPathOf(p: VideoProbe): ColourPath {
	if (p.hdr) return 'hdr';
	return p.hdrClass === 'wcg' ? 'wcg' : 'sdr';
}

/** The PQ tone-map peak from MaxCLL, else the mastering display's max luminance, else 1000 cd/m². */
export function pqPeak(maxCll: number | null, masteringMaxLum: number | null): number {
	return clamp((maxCll || masteringMaxLum || 1000) / 100, 2, 40);
}

interface ColourChainInput {
	path: ColourPath;
	width: number;
	height: number;
	probe: VideoProbe;
	tin: 'arib-std-b67' | 'smpte2084' | null;
	peak: number | null;
}

/**
 * The colour chain (resize + colour conversion to 8-bit BT.709 limited 4:2:0, SAR 1:1), shared by
 * the conversion and the poster:
 *   sdr: swscale with explicit in/out matrix and range;
 *   wcg: zscale BT.2020 → BT.709;
 *   hdr: zscale to linear light (npl=100) → float → BT.709 primaries → mobius tone map → BT.709.
 * Every chain ends by tagging the frames BT.709 limited (setparams): ffmpeg 7.1 takes the output's
 * colour tags from the frames, so -color_primaries/-color_trc alone leave a swscale output untagged.
 */
export function colourChain(c: ColourChainInput): string[] {
	const { width: W, height: H, probe: p } = c;
	const rin = p.colorRange === 'pc' ? 'full' : 'limited';
	const min = p.colorSpace === 'bt2020c' ? 'bt2020c' : 'bt2020nc';
	const tag = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
	switch (c.path) {
		case 'sdr':
			return [
				`scale=w=${W}:h=${H}:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=${inputMatrix(p)}:out_color_matrix=bt709:in_range=${p.colorRange}:out_range=tv`,
				'setsar=1',
				'format=yuv420p',
				tag
			];
		case 'wcg':
			return [
				`zscale=w=${W}:h=${H}:filter=lanczos:pin=bt2020:min=${min}:tin=bt2020-10:rin=${rin}:p=bt709:m=bt709:t=bt709:r=limited:dither=ordered`,
				'setsar=1',
				'format=yuv420p',
				tag
			];
		case 'hdr':
			return [
				`zscale=w=${W}:h=${H}:filter=lanczos:tin=${c.tin}:pin=bt2020:min=${min}:rin=${rin}:t=linear:npl=100`,
				'format=gbrpf32le',
				'zscale=p=bt709',
				`tonemap=tonemap=mobius:desat=0:peak=${c.peak}`,
				'zscale=t=bt709:m=bt709:r=limited:dither=ordered',
				'setsar=1',
				'format=yuv420p',
				tag
			];
	}
}

/**
 * Deletes HDR frame side data so the muxer doesn't write mastering/light-level/ambient boxes into
 * an SDR file (ffmpeg 7.1 passes global side data through the filter graph).
 */
export function sidedataDeletes(caps: Pick<FfmpegCaps, 'sidedata' | 'sidedataTypes'>): string[] {
	if (!caps.sidedata) return [];
	return ['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL', 'AMBIENT_VIEWING_ENVIRONMENT']
		.filter((t) => caps.sidedataTypes.has(t))
		.map((t) => `sidedata=mode=delete:type=${t}`);
}

const DEINTERLACE = 'bwdif=mode=send_frame:parity=auto:deint=interlaced';

/**
 * Duration of the streams that are kept: the container's duration can include a longer data
 * track (timecode, metadata) or an undecodable audio track that the output drops.
 */
function keptDurationS(p: VideoProbe): number {
	const kept = [p.videoIndex, ...(p.audio ? [p.audio.index] : [])];
	const durations = p.raw.streams
		.filter((s) => kept.includes(s.index))
		.map((s) => Number(s.duration))
		.filter((d) => Number.isFinite(d) && d > 0);
	return durations.length > 0 ? Math.max(...durations) : p.durationS;
}

function requireCaps(path: ColourPath, caps: PlanCaps): void {
	const missing: string[] = [];
	if (!caps.libx264) missing.push('the libx264 encoder');
	if (path !== 'sdr' && !caps.zscale) missing.push('the zscale filter (libzimg)');
	if (path === 'hdr' && !caps.tonemap) missing.push('the tonemap filter');
	if (path === 'hdr' && !caps.sidedata) missing.push('the sidedata filter');
	if (missing.length > 0) {
		const kind = path === 'hdr' ? 'HDR' : path === 'wcg' ? 'wide-colour' : 'this';
		throw new MediaError(
			'unsupported',
			`converting ${kind} video needs ${missing.join(', ')}, which this server's ffmpeg lacks; ` +
				'install an ffmpeg that has them (the Docker image does) and retry the item'
		);
	}
}

/**
 * Sound: copied when it is AAC-LC with ≤ 2 channels at 44.1/48 kHz (never for slow motion), else
 * AAC at 192k stereo / 96k mono, slowed by `tempo` (an atempo chain) for slow motion.
 */
export function audioArgs(a: AudioChoice | null, copy: boolean, tempo: string): string[] {
	if (!a) return [];
	if (copy) return ['-c:a', 'copy'];
	const ch = a.channels || 2;
	return [...(tempo ? ['-af', tempo] : []), '-c:a', 'aac', '-b:a', ch >= 2 ? '192k' : '96k', '-ac', String(Math.min(ch, 2)),
		...(a.sampleRate === 44100 || a.sampleRate === 48000 ? [] : ['-ar', '48000'])];
}

/** H.264 High 8-bit BT.709 with an explicit level (x264 would pick 5.0 for 1080p60) and VBV cap. */
export function x264Args(level: string, maxrateK: number, fpsOut: number, threads: string): string[] {
	return ['-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
		'-profile:v', 'high', '-level:v', level, '-maxrate', `${maxrateK}k`, '-bufsize', `${2 * maxrateK}k`,
		'-g', String(2 * Math.round(fpsOut)), '-x264-params', 'aq-mode=3', '-pix_fmt', 'yuv420p',
		'-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-threads', threads];
}

/**
 * Poster frame at min(1 s, 10%) (0 for clips under 2 s): the colour chain (deinterlaced, never
 * retimed), the most representative of 24 frames, then an explicit BT.709 → RGB step; PNG on stdout.
 */
export function posterArgs(o: { src: string; videoIndex: number; durationS: number; interlaced: boolean; chain: string[]; threads: string }): string[] {
	const vf = [...(o.interlaced ? [DEINTERLACE] : []), ...o.chain, 'thumbnail=n=24', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc', 'format=rgb24'];
	const ss = o.durationS >= 2 ? Math.min(1, o.durationS * 0.1) : 0;
	return ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(ss), '-threads', o.threads, '-i', o.src,
		'-map', `0:${o.videoIndex}`, '-vf', vf.join(','), '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'];
}

/** Plans the conversion. Throws MediaError('unsupported') when ffmpeg lacks what the source needs. */
export function planVideo(p: VideoProbe, o: PlanOptions): VideoPlan {
	const { width: W, height: H } = outputSize(p.displayWidth, p.displayHeight);
	const fpsIn = p.fps;
	const slowmo = fpsIn >= 100 && p.tags.playbackIntent === '0';
	const fpsOut = slowmo ? 30 : fpsIn > 60.5 ? 60 : fpsIn || 30;
	const mode = p.remuxable ? 'remux' : 'transcode';
	const colour = colourPathOf(p);
	const tin = colour !== 'hdr' ? null : p.hdrClass === 'hlg' ? 'arib-std-b67' : 'smpte2084';
	const peak =
		colour !== 'hdr'
			? null
			: p.hdrClass === 'hlg'
				? 10
				: pqPeak(o.hdrMeta?.maxCll ?? p.maxCll, o.hdrMeta?.masteringMaxLum ?? p.masteringMaxLum);
	if (mode === 'transcode') requireCaps(colour, o.caps);
	const a = p.audio;
	const audioCopy = !!a?.copyable && !slowmo;
	if (a && !audioCopy && !o.caps.aac) {
		throw new MediaError('unsupported', "re-encoding the sound needs ffmpeg's aac encoder, which this server's ffmpeg lacks");
	}
	const level = levelFor(fpsOut);
	const maxrateK = maxrateKbps(W, H, fpsOut);
	const T = String(o.threads);
	const dur = keptDurationS(p);

	const head = ['-hide_banner', '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
		'-filter_threads', T, '-threads', T, '-i', o.src];
	const maps = ['-map', `0:${p.videoIndex}`, ...(a ? ['-map', `0:${a.index}`] : [])];
	const audio = audioArgs(a, audioCopy, slowmo ? atempoChain(30 / fpsIn) : '');
	const meta = ['-map_metadata', '-1', '-map_chapters', '-1', ...(o.creationTime ? ['-metadata', `creation_time=${o.creationTime}`] : [])];
	const tail = ['-movflags', '+faststart', '-f', 'mp4', o.out];
	const chain = colourChain({ path: colour, width: W, height: H, probe: p, tin, peak });
	let args: string[];
	if (mode === 'remux') {
		args = [...head, ...maps, '-c:v', 'copy', ...audio, ...meta, ...tail];
	} else {
		const pre = [
			...(p.interlaced ? [DEINTERLACE] : []),
			...(slowmo ? [`setpts=${Number((fpsIn / 30).toFixed(6))}*PTS`, 'fps=30'] : fpsIn > 60.5 ? ['fps=60'] : [])
		];
		const vf = [...pre, ...chain, ...sidedataDeletes(o.caps)].join(',');
		args = [...head, ...maps, '-vf', vf, ...x264Args(level, maxrateK, fpsOut, T), ...audio, ...meta, ...tail];
	}

	return {
		mode,
		width: mode === 'remux' ? p.displayWidth : W,
		height: mode === 'remux' ? p.displayHeight : H,
		fpsIn,
		fpsOut,
		slowmo,
		colour,
		tin,
		peak,
		interlaced: p.interlaced,
		audioIndex: a?.index ?? null,
		audioCopy,
		audioDropped: p.audioDropped,
		level,
		maxrateK,
		expectedDurationS: slowmo ? (dur * fpsIn) / 30 : dur,
		lossy: mode === 'transcode' || (!!a && !audioCopy) || p.raw.streams.length > 1 + (a ? 1 : 0),
		args,
		posterArgs: posterArgs({ src: o.src, videoIndex: p.videoIndex, durationS: dur, interlaced: p.interlaced, chain, threads: T })
	};
}
