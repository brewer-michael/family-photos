/**
 * "Verify and commit" checks on the canonical MP4 (docs/media-pipeline.md §3), run after the
 * exiftool step and before the file is renamed into library/.
 */
import { ffprobeJson, type FfprobeResult, type FfprobeStream } from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';
import { faststartProblem, topLevelBoxes } from './mp4';

export interface OutputExpectation {
	mode: 'remux' | 'transcode';
	/** Whether the plan kept an audio stream. */
	audio: boolean;
	expectedDurationS: number;
}

const TRANSCODE_FORBIDDEN_SIDE_DATA = ['Display Matrix', 'Mastering display metadata', 'Content light level metadata', 'DOVI configuration record'];

function checkAudio(a: FfprobeStream): string[] {
	const problems: string[] = [];
	if (a.codec_name !== 'aac' || a.profile !== 'LC') problems.push(`audio is ${a.codec_name ?? '?'} ${a.profile ?? ''}, not AAC-LC`.trim());
	if (!a.channels || a.channels > 2) problems.push(`audio has ${a.channels ?? '?'} channels`);
	if (a.sample_rate !== '44100' && a.sample_rate !== '48000') problems.push(`audio sample rate is ${a.sample_rate ?? '?'}`);
	return problems;
}

/** Pure: every rule the output breaks (empty when it passes). */
export function checkOutput(raw: FfprobeResult, exp: OutputExpectation): string[] {
	const problems: string[] = [];
	const videos = raw.streams.filter((s) => s.codec_type === 'video');
	const audios = raw.streams.filter((s) => s.codec_type === 'audio');
	const others = raw.streams.filter((s) => s.codec_type !== 'video' && s.codec_type !== 'audio');
	if (videos.length !== 1) problems.push(`expected one video track, found ${videos.length}`);
	if (others.length > 0) problems.push(`unexpected ${others.map((s) => s.codec_type ?? '?').join(', ')} track(s)`);
	if (audios.length > 1) problems.push(`expected at most one audio track, found ${audios.length}`);
	if (exp.audio && audios.length === 0) problems.push('the audio track is missing');
	if (!exp.audio && audios.length > 0) problems.push('unexpected audio track');

	const v = videos[0];
	if (v) {
		const pixFmts = exp.mode === 'remux' ? ['yuv420p', 'yuvj420p'] : ['yuv420p'];
		if (v.codec_name !== 'h264') problems.push(`video is ${v.codec_name ?? '?'}, not h264`);
		if (!pixFmts.includes(v.pix_fmt ?? '')) problems.push(`pixel format is ${v.pix_fmt ?? '?'}`);
		if (typeof v.level !== 'number' || v.level > 42) problems.push(`H.264 level is ${v.level ?? '?'} (max 42)`);
		// A remux keeps the source's rotation matrix and tags; a transcode is plain BT.709 SDR, upright.
		if (exp.mode === 'transcode') {
			for (const [k, val] of [['primaries', v.color_primaries], ['transfer', v.color_transfer], ['matrix', v.color_space]] as const) {
				if (val !== 'bt709') problems.push(`colour ${k} is ${val ?? 'untagged'}, not bt709`);
			}
			for (const sd of v.side_data_list ?? []) {
				if (TRANSCODE_FORBIDDEN_SIDE_DATA.includes(String(sd.side_data_type))) problems.push(`unexpected ${String(sd.side_data_type)}`);
			}
		}
	}
	if (audios[0]) problems.push(...checkAudio(audios[0]));

	const dur = Number(raw.format.duration);
	const tol = Math.max(0.1, 0.02 * exp.expectedDurationS);
	if (!Number.isFinite(dur) || Math.abs(dur - exp.expectedDurationS) > tol) {
		problems.push(`duration is ${Number.isFinite(dur) ? dur.toFixed(3) : '?'} s, expected ${exp.expectedDurationS.toFixed(3)} s ± ${tol.toFixed(3)}`);
	}
	return problems;
}

/**
 * Probes the output and walks its boxes. Returns the output duration (s). A short output means the
 * source ended early (truncated upload): 'corrupt'; any other broken rule: 'unsupported'.
 */
export async function verifyOutput(file: string, exp: OutputExpectation, signal?: AbortSignal): Promise<number> {
	const raw = await ffprobeJson(file, { signal });
	const problems = checkOutput(raw, exp);
	try {
		const layout = faststartProblem(await topLevelBoxes(file));
		if (layout) problems.push(layout);
	} catch (e) {
		problems.push((e as Error).message);
	}
	if (problems.length > 0) {
		const short = Number(raw.format.duration) < exp.expectedDurationS;
		const onlyDuration = problems.length === 1 && problems[0].startsWith('duration');
		throw new MediaError(onlyDuration && short ? 'corrupt' : 'unsupported', `output check failed: ${problems.join('; ')}`);
	}
	return Number(raw.format.duration);
}
