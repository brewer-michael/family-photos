/**
 * ffprobe for videos (intake: 30 s timeout) and the cost estimate used for video lane ordering.
 *
 * PARTIAL — probeVideo runs ffprobe and summarises the main stream. TODO(video track):
 * SAR/rotation-aware display size, HDR class (PQ/HLG/DV compat id), audio selection,
 * remux eligibility (docs/media-pipeline.md §3 "Probe and plan").
 */
import { execFile } from 'node:child_process';
import { getConfig } from '#lib/server/config';
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

export interface VideoProbe {
	/** Seconds (format duration, else main video stream duration). */
	durationS: number;
	/** Coded size of the main video stream (before SAR/rotation). */
	width: number;
	height: number;
	/** avg_frame_rate, falling back to r_frame_rate. */
	fps: number;
	codec: string;
	/** True for PQ/HLG transfer or a Dolby Vision record (refined by the video track). */
	hdr: boolean;
	hasAudio: boolean;
	/** Index of the main (largest, non-attached-pic) video stream. */
	videoIndex: number;
	raw: FfprobeResult;
}

export function parseRate(r: string | undefined): number {
	if (!r) return 0;
	const [n, d] = r.split('/').map(Number);
	if (!Number.isFinite(n)) return 0;
	if (d === undefined) return n;
	return d ? n / d : 0;
}

export function summarize(raw: FfprobeResult): VideoProbe {
	const videos = raw.streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
	if (videos.length === 0) throw new MediaError('unsupported', 'no video stream');
	const v = videos.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a));
	const durationS = Number(raw.format.duration ?? v.duration ?? 0) || 0;
	const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
	const hdr =
		v.color_transfer === 'smpte2084' ||
		v.color_transfer === 'arib-std-b67' ||
		!!v.side_data_list?.some((d) => String(d.side_data_type ?? '').includes('DOVI'));
	return {
		durationS,
		width: v.width ?? 0,
		height: v.height ?? 0,
		fps,
		codec: v.codec_name ?? 'unknown',
		hdr,
		hasAudio: raw.streams.some((s) => s.codec_type === 'audio'),
		videoIndex: v.index,
		raw
	};
}

/** Runs ffprobe (JSON). Rejects with MediaError('corrupt'|'unsupported'|'retryable'). */
export async function probeVideo(path: string, opts: { timeoutMs?: number } = {}): Promise<VideoProbe> {
	const bin = getConfig().ffprobeBin;
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			bin,
			['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
			{ timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
			(err, out, stderr) => {
				if (err) {
					const e = err as NodeJS.ErrnoException & { killed?: boolean };
					if (e.killed || e.code === 'ENOENT') reject(new MediaError('retryable', `ffprobe: ${e.message}`));
					else reject(new MediaError('corrupt', `ffprobe failed: ${String(stderr).slice(0, 500)}`));
					return;
				}
				resolve(out);
			}
		);
	});
	let raw: FfprobeResult;
	try {
		raw = JSON.parse(stdout) as FfprobeResult;
	} catch {
		throw new MediaError('corrupt', 'ffprobe returned invalid JSON');
	}
	raw.streams ??= [];
	raw.format ??= {};
	return summarize(raw);
}

/**
 * est_cost_s = dur × (W·H·fps)/(1920·1080·30) × (hdr ? 1.5 : 1) × (remux ? 0.02 : 1).
 * TODO(video track): pass the remux decision once planning exists.
 */
export function estimateCostS(probe: VideoProbe, opts: { remux?: boolean } = {}): number {
	const px = (probe.width * probe.height * (probe.fps || 30)) / (1920 * 1080 * 30);
	return probe.durationS * px * (probe.hdr ? 1.5 : 1) * (opts.remux ? 0.02 : 1);
}
