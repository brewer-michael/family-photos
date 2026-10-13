/**
 * Still images libvips can't read in our sharp build: JPEG XL, JPEG 2000, BMP and PSD (flattened
 * composite), decoded by ffmpeg to a PNG in the job's tmp dir (docs/media-pipeline.md §2 "Other
 * decoders"). The demuxer is pinned to the detected type and only the file protocol is allowed,
 * so ffmpeg never probes untrusted bytes as a playlist or anything that opens other files or URLs.
 * A decoder the local ffmpeg lacks means that type fails as unsupported.
 */
import fs from 'node:fs/promises';
import { MediaError } from '#lib/shared/errors';
import { run, RunError } from '../spawn';
import type { FfmpegImageCodec, FfmpegImageTools } from './tools';

const DEMUXER: Record<FfmpegImageCodec, string> = {
	jxl: 'jpegxl_pipe',
	jp2: 'j2k_pipe',
	bmp: 'bmp_pipe',
	psd: 'psd_pipe'
};

const TIMEOUT_MS = 120_000;

export async function ffmpegDecode(src: string, out: string, codec: FfmpegImageCodec, tools: FfmpegImageTools, signal: AbortSignal): Promise<void> {
	if (!tools.decodes[codec]) throw new MediaError('unsupported', `this ffmpeg has no ${codec} decoder`);
	const args = ['-hide_banner', '-v', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', DEMUXER[codec], '-i', src, '-frames:v', '1', '-c:v', 'png', '-y', out];
	try {
		await run(tools.bin, args, { timeoutMs: TIMEOUT_MS, signal });
	} catch (e) {
		if (e instanceof RunError && e.reason === 'exit') throw new MediaError('corrupt', `ffmpeg ${codec}: ${e.stderr.trim().split('\n').slice(-3).join(' | ')}`);
		throw new MediaError('retryable', `ffmpeg ${codec}: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		await fs.access(out);
	} catch {
		throw new MediaError('corrupt', `ffmpeg ${codec} wrote no image`);
	}
}
