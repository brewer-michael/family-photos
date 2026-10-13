import { describe, expect, it } from 'vitest';
import {
	capsProblems,
	checkLimits,
	estimateCostS,
	parseDecoders,
	parseEncoders,
	parseFilters,
	parseSidedataTypes,
	summarize,
	type Decoders,
	type FfmpegCaps,
	type FfprobeResult,
	type FfprobeStream
} from '#lib/server/media/probe';
import { MediaError } from '#lib/shared/errors';
import {
	atempoChain,
	inputMatrix,
	levelFor,
	maxrateKbps,
	outputSize,
	planVideo,
	pqPeak,
	sidedataDeletes,
	type PlanOptions
} from '../../src/worker/video/plan';

// Hand-written ffprobe JSON (-show_format -show_streams), shaped like ffprobe 6.1/7.1 output.

const DECODERS: Decoders = {
	video: new Set(['h264', 'hevc', 'mpeg2video', 'mjpeg', 'prores', 'vp9', 'av1', 'dvvideo']),
	// 'apac' is "Marian's A-pac audio", which ffmpeg lists, not Apple's spatial audio.
	audio: new Set(['aac', 'ac3', 'pcm_s16le', 'apac', 'opus'])
};

const CAPS: FfmpegCaps = {
	version: 'ffmpeg version 7.1.1',
	zscale: true,
	tonemap: true,
	sidedata: true,
	sidedataTypes: new Set(['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL', 'AMBIENT_VIEWING_ENVIRONMENT']),
	libx264: true,
	aac: true,
	decoders: DECODERS
};

const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
	caps: CAPS,
	threads: 2,
	src: '/photos/.incoming/tok',
	out: '/photos/.work/ID/ID.mp4',
	creationTime: '2024-07-04T18:22:31.000Z',
	...over
});

function h264(over: Partial<FfprobeStream> = {}): FfprobeStream {
	return {
		index: 0,
		codec_type: 'video',
		codec_name: 'h264',
		codec_tag_string: 'avc1',
		profile: 'High',
		level: 40,
		width: 1920,
		height: 1080,
		pix_fmt: 'yuv420p',
		sample_aspect_ratio: '1:1',
		avg_frame_rate: '30/1',
		r_frame_rate: '30/1',
		field_order: 'progressive',
		color_range: 'tv',
		color_space: 'bt709',
		color_transfer: 'bt709',
		color_primaries: 'bt709',
		bit_rate: '12000000',
		...over
	};
}

function aac(index: number, over: Partial<FfprobeStream> = {}): FfprobeStream {
	return { index, codec_type: 'audio', codec_name: 'aac', codec_tag_string: 'mp4a', profile: 'LC', channels: 2, sample_rate: '48000', ...over };
}

function hevcHlg(over: Partial<FfprobeStream> = {}): FfprobeStream {
	return h264({
		codec_name: 'hevc',
		codec_tag_string: 'hvc1',
		profile: 'Main 10',
		level: 153,
		width: 3840,
		height: 2160,
		pix_fmt: 'yuv420p10le',
		avg_frame_rate: '60/1',
		r_frame_rate: '60/1',
		color_space: 'bt2020nc',
		color_transfer: 'arib-std-b67',
		color_primaries: 'bt2020',
		bit_rate: '50000000',
		...over
	});
}

function probe(streams: FfprobeStream[], format: FfprobeResult['format'] = {}): FfprobeResult {
	return { streams, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000', ...format } };
}

const sum = (raw: FfprobeResult) => summarize(raw, { decoders: DECODERS });

function vf(args: string[]): string {
	return args[args.indexOf('-vf') + 1];
}

function after(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i < 0 ? undefined : args[i + 1];
}

describe('probe summary', () => {
	it('picks the largest non-cover video stream and keeps the old summary fields', () => {
		const p = sum(
			probe([
				{ index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 4000, height: 4000, disposition: { attached_pic: 1 } },
				h264({ index: 1, width: 640, height: 360 }),
				h264({ index: 2 }),
				aac(3)
			])
		);
		expect(p).toMatchObject({ videoIndex: 2, width: 1920, height: 1080, fps: 30, codec: 'h264', hdr: false, hasAudio: true, durationS: 10 });
	});

	it('skips an APAC track listed before the AAC track', () => {
		const p = sum(probe([hevcHlg(), { index: 1, codec_type: 'audio', codec_name: 'apac', codec_tag_string: 'apac', channels: 4, sample_rate: '48000' }, aac(2)]));
		expect(p.audio).toMatchObject({ index: 2, codec: 'aac', copyable: true });
		expect(p.audioDropped).toBe(false);
	});

	it('ignores an audio stream without codec_name and prefers AAC, then default, then lowest index', () => {
		const p = sum(
			probe([
				h264(),
				{ index: 1, codec_type: 'audio', codec_tag_string: 'lpcm', channels: 2 },
				{ index: 2, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000', disposition: { default: 1 } },
				aac(3, { disposition: { default: 0 } })
			])
		);
		expect(p.audio?.index).toBe(3);
		const noAac = sum(
			probe([
				h264(),
				{ index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '48000' },
				{ index: 2, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '48000', disposition: { default: 1 } }
			])
		);
		expect(noAac.audio?.index).toBe(2);
	});

	it('only undecodable audio → no audio, audio_dropped, source archived', () => {
		const raw = probe([h264(), { index: 1, codec_type: 'audio', codec_name: 'apac', codec_tag_string: 'apac', channels: 4 }, { index: 2, codec_type: 'audio', codec_name: 'qdmc' }]);
		const p = sum(raw);
		expect(p).toMatchObject({ hasAudio: true, audio: null, audioDropped: true });
		const plan = planVideo(p, opts());
		expect(plan).toMatchObject({ mode: 'remux', audioIndex: null, audioDropped: true, lossy: true });
		expect(plan.args.filter((a) => a.startsWith('0:'))).toEqual(['0:0']);
		expect(plan.args).not.toContain('-c:a');
	});

	it('rejects a missing video codec name, an undecodable video codec and no video at all', () => {
		expect(() => sum(probe([{ index: 0, codec_type: 'video', codec_tag_string: 'xxxx', width: 640, height: 480 }]))).toThrow(/no decoder/);
		expect(() => sum(probe([h264({ codec_name: 'cfhd' })]))).toThrow(MediaError);
		try {
			sum(probe([aac(0)]));
			expect.unreachable();
		} catch (e) {
			expect(MediaError.is(e) && e.code).toBe('unsupported');
		}
	});

	it('Dolby Vision: profile 5 is unsupported; 8.4 is HLG and 8.1 is PQ through the base layer', () => {
		const dv = (profile: number, compat: number, over: Partial<FfprobeStream> = {}) =>
			hevcHlg({
				codec_tag_string: 'dvh1',
				color_transfer: undefined,
				color_primaries: undefined,
				color_space: undefined,
				side_data_list: [{ side_data_type: 'DOVI configuration record', dv_version_major: 1, dv_profile: profile, dv_level: 6, rpu_present_flag: 1, el_present_flag: 0, bl_present_flag: 1, dv_bl_signal_compatibility_id: compat }],
				...over
			});
		try {
			sum(probe([dv(5, 0)]));
			expect.unreachable();
		} catch (e) {
			expect(MediaError.is(e) && e.code).toBe('unsupported');
			expect(MediaError.is(e) && e.detail).toMatch(/profile 5/);
		}
		expect(sum(probe([dv(8, 4)])).hdrClass).toBe('hlg');
		expect(sum(probe([dv(8, 1)])).hdrClass).toBe('pq');
		expect(sum(probe([dv(8, 4, { color_transfer: 'arib-std-b67' })])).dolbyVision).toEqual({ profile: 8, compatId: 4 });
	});

	it('classifies PQ, HLG, wide gamut and SDR', () => {
		expect(sum(probe([hevcHlg({ color_transfer: 'smpte2084' })])).hdrClass).toBe('pq');
		expect(sum(probe([hevcHlg()])).hdrClass).toBe('hlg');
		const wcg = sum(probe([hevcHlg({ color_transfer: 'bt2020-10' })]));
		expect(wcg).toMatchObject({ hdrClass: 'wcg', hdr: false });
		expect(sum(probe([h264()])).hdrClass).toBe('sdr');
	});

	it('displayed size accounts for SAR and rotation (display matrix and legacy rotate tag)', () => {
		const rotated = sum(probe([hevcHlg({ side_data_list: [{ side_data_type: 'Display Matrix', displaymatrix: '…', rotation: -90 }] })]));
		expect(rotated).toMatchObject({ rotation: -90, displayWidth: 2160, displayHeight: 3840 });
		const legacy = sum(probe([h264({ tags: { rotate: '90' } })]));
		expect(legacy).toMatchObject({ rotation: -90, displayWidth: 1080, displayHeight: 1920 });
		const upside = sum(probe([h264({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] })]));
		expect(upside).toMatchObject({ rotation: 180, displayWidth: 1920, displayHeight: 1080 });
		const sar = sum(probe([h264({ width: 720, height: 480, sample_aspect_ratio: '4:3' })]));
		expect(sar).toMatchObject({ sar: 4 / 3, displayWidth: 960, displayHeight: 480 });
		expect(sum(probe([h264({ sample_aspect_ratio: '0:1' })])).sar).toBe(1);
	});

	it('reads fps (avg, then r), bit depth, range, interlacing and container tags', () => {
		const p = sum(
			probe([h264({ avg_frame_rate: '0/0', r_frame_rate: '30000/1001', pix_fmt: 'yuvj420p', field_order: 'tt' })], {
				tags: {
					'com.apple.quicktime.creationdate': '2024-07-04T11:22:31-0700',
					'com.apple.quicktime.location.ISO6709': '+37.3349-122.0090+010.000/',
					'com.apple.quicktime.full-frame-rate-playback-intent': '0',
					'com.apple.quicktime.content.identifier': 'ABC-123',
					creation_time: '2024-07-04T18:22:31.000000Z'
				}
			})
		);
		expect(p.fps).toBeCloseTo(29.97, 2);
		// Raw DV: avg_frame_rate 60000/1 is bogus (above r_frame_rate), so r_frame_rate wins.
		expect(sum(probe([h264({ avg_frame_rate: '60000/1', r_frame_rate: '30000/1001' })])).fps).toBeCloseTo(29.97, 2);
		// VFR: the average is below r_frame_rate and is used.
		expect(sum(probe([h264({ avg_frame_rate: '600/29', r_frame_rate: '30/1' })])).fps).toBeCloseTo(20.69, 2);
		expect(p).toMatchObject({ colorRange: 'pc', interlaced: true, bitDepth: 8 });
		expect(p.tags).toEqual({
			creationDate: '2024-07-04T11:22:31-0700',
			creationTime: '2024-07-04T18:22:31.000000Z',
			location: '+37.3349-122.0090+010.000/',
			playbackIntent: '0',
			contentId: 'ABC-123'
		});
		expect(sum(probe([hevcHlg()])).bitDepth).toBe(10);
		expect(sum(probe([h264({ codec_name: 'mpeg2video', field_order: undefined })])).interlaced).toBe(true);
		// Android / ffmpeg ©xyz location
		expect(sum(probe([h264()], { tags: { location: '+48.8584+002.2945/' } })).tags.location).toBe('+48.8584+002.2945/');
	});

	it('remux criteria: all must hold', () => {
		const ok = (s: Partial<FfprobeStream>, format: Partial<FfprobeResult['format']> = {}) => sum(probe([h264(s), aac(1)], format)).remuxable;
		expect(ok({})).toBe(true);
		expect(ok({ profile: 'Constrained Baseline', level: 31, width: 1280, height: 720 })).toBe(true);
		expect(ok({ pix_fmt: 'yuvj420p' })).toBe(true);
		expect(ok({}, { format_name: 'matroska,webm' })).toBe(true);
		expect(ok({ field_order: undefined })).toBe(true); // unknown field order is fine
		expect(ok({}, { format_name: 'avi' })).toBe(false);
		expect(ok({}, { format_name: 'mpegts' })).toBe(false);
		expect(ok({ codec_tag_string: 'avc3' })).toBe(false);
		expect(ok({ profile: 'High 10', pix_fmt: 'yuv420p10le' })).toBe(false);
		expect(ok({ profile: 'High 4:4:4 Predictive', pix_fmt: 'yuv444p' })).toBe(false);
		expect(ok({ level: 50 })).toBe(false);
		expect(ok({ field_order: 'tt' })).toBe(false);
		expect(ok({ width: 3840, height: 2160 })).toBe(false);
		expect(ok({ width: 1080, height: 1920 })).toBe(true); // portrait fits the box
		expect(ok({ sample_aspect_ratio: '4:3', width: 720, height: 480 })).toBe(false);
		expect(ok({ avg_frame_rate: '120/1', r_frame_rate: '120/1' })).toBe(false);
		expect(ok({ avg_frame_rate: '60/1', r_frame_rate: '60/1' })).toBe(true);
		expect(ok({ bit_rate: '25000000' })).toBe(false);
		expect(ok({ bit_rate: undefined }, { bit_rate: '8000000' })).toBe(true);
		expect(ok({ color_primaries: 'bt2020' })).toBe(false);
		expect(ok({ color_space: 'bt2020nc' })).toBe(false);
		expect(ok({ color_transfer: 'smpte2084' })).toBe(false);
	});

	it('caps: duration (MAX_VIDEO_MINUTES), size and frame rate', () => {
		const p = sum(probe([h264()], { duration: '7300' }));
		expect(() => checkLimits(p, 7200)).toThrow('video is 122 min long; the limit is 120 min (MAX_VIDEO_MINUTES)');
		expect(() => checkLimits(sum(probe([h264()], { duration: '75' })), 60)).toThrow('video is 75 s long; the limit is 60 s');
		expect(() => checkLimits(sum(probe([h264()])), 7200)).not.toThrow();
		const codes = (raw: FfprobeResult) => {
			try {
				checkLimits(sum(raw), 7200);
				return null;
			} catch (e) {
				return MediaError.is(e) ? e.code : 'other';
			}
		};
		expect(codes(probe([h264({ width: 8704, height: 4352 })]))).toBe('too_large');
		expect(codes(probe([h264({ avg_frame_rate: '480/1', r_frame_rate: '480/1' })]))).toBe('too_large');
		expect(codes(probe([h264({ avg_frame_rate: '240000/1001', r_frame_rate: '240000/1001' })]))).toBeNull();
		expect(codes(probe([h264()], { duration: undefined }))).toBe('corrupt');
	});

	it('estimates cost with the remux decision', () => {
		const remux = sum(probe([h264()]));
		expect(estimateCostS(remux)).toBeCloseTo(10 * 0.02, 6);
		expect(estimateCostS(remux, { remux: false })).toBeCloseTo(10, 6);
		const hlg = sum(probe([hevcHlg()]));
		expect(estimateCostS(hlg)).toBeCloseTo(10 * 8 * 1.5, 6);
	});

	it('parses ffmpeg -decoders, mapping decoder names to codecs and skipping hardware-only ones', () => {
		const d = parseDecoders(
			[
				'Decoders:',
				' V..... = Video',
				' A..... = Audio',
				' ------',
				' VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
				' V..... h264_cuvid           Nvidia CUVID H264 decoder (codec h264)',
				' V....D av1                  Alliance for Open Media AV1',
				' V..... libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)',
				' V..... av1_qsv              AV1 video (Intel Quick Sync Video acceleration) (codec av1)',
				' V..... hevc_v4l2m2m         V4L2 mem2mem HEVC decoder wrapper (codec hevc)',
				' A....D amrnb                AMR-NB (Adaptive Multi-Rate NarrowBand) (codec amr_nb)',
				' A....D aac                  AAC (Advanced Audio Coding)',
				' S..... ass                  ASS (Advanced SubStation Alpha) subtitle'
			].join('\n')
		);
		expect([...d.video].sort()).toEqual(['av1', 'h264']);
		expect([...d.audio].sort()).toEqual(['aac', 'amr_nb']);
	});
});

describe('ffmpeg capabilities', () => {
	it('reads filters, encoders and sidedata types', () => {
		const filters = parseFilters(
			['Filters:', '  T.. = Timeline support', ' TS. bwdif             V->V       Deinterlace the input image.', ' .SC zscale            V->V       Apply resizing.', ' ... abuffer           |->A       Buffer audio frames.'].join('\n')
		);
		expect([...filters]).toEqual(['bwdif', 'zscale', 'abuffer']);
		const enc = parseEncoders(['Encoders:', ' V..... = Video', ' V....D libx264              libx264 H.264 (codec h264)', ' A....D aac                  AAC (Advanced Audio Coding)'].join('\n'));
		expect([...enc]).toEqual(['libx264', 'aac']);
		const types = parseSidedataTypes(
			[
				'sidedata AVOptions:',
				'   mode              <int>        ..FV....... set a mode of operation (from 0 to 1) (default select)',
				'     select          0            ..FV.......',
				'     MASTERING_DISPLAY_METADATA 11           ..FV.......',
				'     AMBIENT_VIEWING_ENVIRONMENT 26           ..FV.......'
			].join('\n')
		);
		expect([...types]).toEqual(['MASTERING_DISPLAY_METADATA', 'AMBIENT_VIEWING_ENVIRONMENT']);
	});

	it('explains what is missing for the self-check', () => {
		expect(capsProblems(CAPS)).toEqual([]);
		const old = capsProblems({ ...CAPS, version: 'ffmpeg version 6.1.1', zscale: false, sidedataTypes: new Set(['MASTERING_DISPLAY_METADATA']) });
		expect(old).toHaveLength(2);
		expect(old[0]).toMatch(/zscale.*HDR/);
		expect(old[1]).toMatch(/^ffmpeg version 6\.1\.1: .*AMBIENT_VIEWING_ENVIRONMENT/);
		expect(capsProblems({ ...CAPS, libx264: false, aac: false })).toHaveLength(2);
	});
});

describe('planner building blocks', () => {
	it('fits the 1920×1080 box in either orientation with even sizes', () => {
		expect(outputSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
		expect(outputSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
		expect(outputSize(1280, 720)).toEqual({ width: 1280, height: 720 });
		expect(outputSize(321, 241)).toEqual({ width: 322, height: 242 });
		expect(outputSize(4095, 2161)).toEqual({ width: 1920, height: 1014 });
		expect(outputSize(1440, 1080)).toEqual({ width: 1440, height: 1080 });
		expect(outputSize(1, 1)).toEqual({ width: 2, height: 2 });
	});

	it('atempo chains stay within 0.5–100 per filter', () => {
		expect(atempoChain(30 / 240)).toBe('atempo=0.5,atempo=0.5,atempo=0.5');
		expect(atempoChain(30 / 120)).toBe('atempo=0.5,atempo=0.5');
		expect(atempoChain(30 / 100)).toBe('atempo=0.5,atempo=0.6');
		expect(atempoChain(1)).toBe('');
	});

	it('level, VBV maxrate, matrix and PQ peak', () => {
		expect(levelFor(30)).toBe('4.0');
		expect(levelFor(29.97)).toBe('4.0');
		expect(levelFor(60)).toBe('4.2');
		expect(maxrateKbps(1920, 1080, 30)).toBe(10000);
		expect(maxrateKbps(1920, 1080, 60)).toBe(14000);
		expect(maxrateKbps(320, 240, 30)).toBe(1500);
		expect(inputMatrix({ colorSpace: null, width: 1920, height: 1080 })).toBe('bt709');
		expect(inputMatrix({ colorSpace: null, width: 640, height: 480 })).toBe('bt601');
		expect(inputMatrix({ colorSpace: null, width: 1080, height: 1920 })).toBe('bt709');
		expect(inputMatrix({ colorSpace: 'smpte170m', width: 1920, height: 1080 })).toBe('bt601');
		expect(pqPeak(4000, 1000)).toBe(40);
		expect(pqPeak(null, 1000)).toBe(10);
		expect(pqPeak(null, null)).toBe(10);
		expect(pqPeak(100, null)).toBe(2);
		expect(pqPeak(10000, null)).toBe(40);
	});

	it('deletes the ambient viewing environment only where the sidedata filter knows it (ffmpeg 7.1)', () => {
		expect(sidedataDeletes(CAPS)).toEqual([
			'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
			'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
			'sidedata=mode=delete:type=AMBIENT_VIEWING_ENVIRONMENT'
		]);
		expect(sidedataDeletes({ ...CAPS, sidedataTypes: new Set(['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL']) })).toHaveLength(2);
		expect(sidedataDeletes({ ...CAPS, sidedata: false })).toEqual([]);
	});
});

describe('planVideo', () => {
	it('remuxes compliant H.264 and copies AAC-LC (lossless: the source is deleted)', () => {
		const plan = planVideo(sum(probe([h264(), aac(1)])), opts());
		expect(plan).toMatchObject({ mode: 'remux', width: 1920, height: 1080, audioCopy: true, lossy: false, colour: 'sdr', slowmo: false });
		expect(plan.args).toEqual([
			'-hide_banner', '-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '1',
			'-filter_threads', '2', '-threads', '2', '-i', '/photos/.incoming/tok',
			'-map', '0:0', '-map', '0:1', '-c:v', 'copy', '-c:a', 'copy',
			'-map_metadata', '-1', '-map_chapters', '-1', '-metadata', 'creation_time=2024-07-04T18:22:31.000Z',
			'-movflags', '+faststart', '-f', 'mp4', '/photos/.work/ID/ID.mp4'
		]);
		expect(plan.expectedDurationS).toBe(10);
	});

	it('remux re-encodes PCM audio and keeps the source; a dropped timecode track also keeps it', () => {
		const pcm = planVideo(sum(probe([h264(), { index: 1, codec_type: 'audio', codec_name: 'pcm_s16le', channels: 2, sample_rate: '44100' }])), opts());
		expect(pcm).toMatchObject({ mode: 'remux', audioCopy: false, lossy: true });
		expect(pcm.args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
		expect(pcm.args).not.toContain('-ar');
		const mono = planVideo(sum(probe([h264(), aac(1, { channels: 1, sample_rate: '22050', profile: 'HE-AAC' })])), opts());
		expect(mono.args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-ar', '48000']));
		const tmcd = planVideo(sum(probe([h264(), aac(1), { index: 2, codec_type: 'data', codec_tag_string: 'tmcd' }])), opts());
		expect(tmcd).toMatchObject({ mode: 'remux', audioCopy: true, lossy: true });
		const none = planVideo(sum(probe([h264()])), opts({ creationTime: null }));
		expect(none).toMatchObject({ mode: 'remux', audioIndex: null, lossy: false });
		expect(none.args).not.toContain('-metadata');
	});

	it('portrait 4K60 HLG: tone-mapped 1080×1920 at level 4.2 with the full HDR chain', () => {
		const p = sum(probe([hevcHlg({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), aac(1)]));
		const plan = planVideo(p, opts({ threads: 4 }));
		expect(plan).toMatchObject({ mode: 'transcode', width: 1080, height: 1920, fpsOut: 60, colour: 'hdr', tin: 'arib-std-b67', peak: 10, level: '4.2', maxrateK: 14000, audioCopy: true, lossy: true });
		expect(vf(plan.args)).toBe(
			[
				'zscale=w=1080:h=1920:filter=lanczos:tin=arib-std-b67:pin=bt2020:min=bt2020nc:rin=limited:t=linear:npl=100',
				'format=gbrpf32le',
				'zscale=p=bt709',
				'tonemap=tonemap=mobius:desat=0:peak=10',
				'zscale=t=bt709:m=bt709:r=limited:dither=ordered',
				'setsar=1',
				'format=yuv420p',
				'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
				'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
				'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL',
				'sidedata=mode=delete:type=AMBIENT_VIEWING_ENVIRONMENT'
			].join(',')
		);
		expect(plan.args).toEqual(
			expect.arrayContaining(['-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high',
				'-level:v', '4.2', '-maxrate', '14000k', '-bufsize', '28000k', '-g', '120', '-x264-params', 'aq-mode=3', '-pix_fmt', 'yuv420p',
				'-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'])
		);
		expect(after(plan.args, '-threads')).toBe('4');
		expect(plan.args).not.toContain('-metadata:s:v');
		// Poster: same colour chain, no sidedata deletes, then BT.709 → RGB PNG on stdout.
		const pvf = vf(plan.posterArgs);
		expect(pvf.startsWith('zscale=w=1080:h=1920')).toBe(true);
		expect(pvf).not.toContain('sidedata');
		expect(pvf).toContain('thumbnail=n=24');
		expect(pvf.endsWith('scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24')).toBe(true);
		expect(after(plan.posterArgs, '-ss')).toBe('1');
		expect(plan.posterArgs.slice(-7)).toEqual(['-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
		expect(after(plan.posterArgs, '-map')).toBe('0:0');
	});

	it('PQ uses MaxCLL for the peak (frame metadata wins over none)', () => {
		const pq = sum(probe([hevcHlg({ color_transfer: 'smpte2084', side_data_list: [{ side_data_type: 'Content light level metadata', max_content: 4000, max_average: 400 }] })]));
		expect(pq.maxCll).toBe(4000);
		expect(planVideo(pq, opts())).toMatchObject({ tin: 'smpte2084', peak: 40 });
		const bare = sum(probe([hevcHlg({ color_transfer: 'smpte2084' })]));
		expect(planVideo(bare, opts()).peak).toBe(10);
		expect(planVideo(bare, opts({ hdrMeta: { maxCll: null, masteringMaxLum: 600 } })).peak).toBe(6);
		const mdcv = sum(probe([hevcHlg({ color_transfer: 'smpte2084', side_data_list: [{ side_data_type: 'Mastering display metadata', max_luminance: '10000000/10000', min_luminance: '50/10000' }] })]));
		expect(mdcv.masteringMaxLum).toBe(1000);
	});

	it('wide-gamut SDR goes through zscale BT.2020 → BT.709', () => {
		const plan = planVideo(sum(probe([hevcHlg({ color_transfer: 'bt2020-10', width: 1920, height: 1080, avg_frame_rate: '30/1' })])), opts());
		expect(plan.colour).toBe('wcg');
		expect(vf(plan.args)).toContain('zscale=w=1920:h=1080:filter=lanczos:pin=bt2020:min=bt2020nc:tin=bt2020-10:rin=limited:p=bt709:m=bt709:t=bt709:r=limited:dither=ordered,setsar=1,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709');
	});

	it('240 fps with playback intent 0 is retimed to 30 fps slow motion', () => {
		const raw = probe([hevcHlg({ width: 1280, height: 720, avg_frame_rate: '240/1', r_frame_rate: '240/1', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', pix_fmt: 'yuv420p' }), aac(1)], {
			duration: '2.000000',
			tags: { 'com.apple.quicktime.full-frame-rate-playback-intent': '0' }
		});
		const plan = planVideo(sum(raw), opts());
		expect(plan).toMatchObject({ slowmo: true, fpsOut: 30, level: '4.0', audioCopy: false, expectedDurationS: 16 });
		expect(vf(plan.args).startsWith('setpts=8*PTS,fps=30,scale=w=1280:h=720')).toBe(true);
		expect(after(plan.args, '-af')).toBe('atempo=0.5,atempo=0.5,atempo=0.5');
		expect(after(plan.args, '-g')).toBe('60');
		// The poster isn't retimed.
		expect(vf(plan.posterArgs)).not.toContain('setpts');
		// Without the intent key (or intent 1): normal speed, capped at 60 fps.
		const normal = planVideo(sum({ ...raw, format: { ...raw.format, tags: {} } }), opts());
		expect(normal).toMatchObject({ slowmo: false, fpsOut: 60, level: '4.2', expectedDurationS: 2, audioCopy: true });
		expect(vf(normal.args).startsWith('fps=60,scale=')).toBe(true);
	});

	it('1080i MPEG-2 with 5.1 AC-3: deinterlaced, stereo AAC', () => {
		const raw = probe(
			[
				h264({ codec_name: 'mpeg2video', codec_tag_string: '[0][0][0][0]', profile: 'Main', level: 4, field_order: 'tt', avg_frame_rate: '25/1', r_frame_rate: '25/1', color_space: undefined, color_primaries: undefined, color_transfer: undefined }),
				{ index: 1, codec_type: 'audio', codec_name: 'ac3', channels: 6, sample_rate: '48000' }
			],
			{ format_name: 'mpegts' }
		);
		const plan = planVideo(sum(raw), opts());
		expect(plan).toMatchObject({ mode: 'transcode', interlaced: true, width: 1920, height: 1080, fpsOut: 25, level: '4.0' });
		expect(vf(plan.args)).toBe(
			'bwdif=mode=send_frame:parity=auto:deint=interlaced,scale=w=1920:h=1080:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv,setsar=1,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709,sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA,sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL,sidedata=mode=delete:type=AMBIENT_VIEWING_ENVIRONMENT'
		);
		expect(plan.args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
		expect(vf(plan.posterArgs).startsWith('bwdif=')).toBe(true);
	});

	it('SAR 4:3, odd dimensions, full-range MJPEG and untagged SD', () => {
		const sar = planVideo(sum(probe([h264({ width: 720, height: 480, sample_aspect_ratio: '4:3', color_space: 'smpte170m' })])), opts());
		expect(sar).toMatchObject({ mode: 'transcode', width: 960, height: 480 });
		expect(vf(sar.args)).toContain('scale=w=960:h=480:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt601:');
		expect(vf(sar.args)).toContain(',setsar=1,');
		const odd = planVideo(sum(probe([h264({ width: 321, height: 241, pix_fmt: 'yuv444p', profile: 'High 4:4:4 Predictive' })])), opts());
		expect(odd).toMatchObject({ width: 322, height: 242 });
		const mjpeg = planVideo(
			sum(probe([h264({ codec_name: 'mjpeg', width: 640, height: 480, pix_fmt: 'yuvj422p', color_range: 'pc', color_space: undefined })], { format_name: 'avi' })),
			opts()
		);
		expect(vf(mjpeg.args)).toContain('in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv');
	});

	it('missing filters fail HDR/wide-gamut sources as unsupported with a clear reason, never wrong colours', () => {
		const hlg = sum(probe([hevcHlg()]));
		const noZimg = { ...CAPS, zscale: false };
		try {
			planVideo(hlg, opts({ caps: noZimg }));
			expect.unreachable();
		} catch (e) {
			expect(MediaError.is(e) && e.code).toBe('unsupported');
			expect(MediaError.is(e) && e.detail).toMatch(/zscale/);
		}
		expect(() => planVideo(sum(probe([hevcHlg({ color_transfer: 'bt2020-10' })])), opts({ caps: noZimg }))).toThrow(/zscale/);
		expect(() => planVideo(hlg, opts({ caps: { ...CAPS, tonemap: false } }))).toThrow(/tonemap/);
		// SDR sources don't need zimg; remuxes don't need libx264.
		expect(planVideo(sum(probe([h264({ width: 3840, height: 2160 })])), opts({ caps: noZimg })).mode).toBe('transcode');
		expect(planVideo(sum(probe([h264(), aac(1)])), opts({ caps: { ...CAPS, libx264: false } })).mode).toBe('remux');
		expect(() => planVideo(sum(probe([h264({ width: 3840, height: 2160 })])), opts({ caps: { ...CAPS, libx264: false } }))).toThrow(/libx264/);
	});

	it('6.1-style sidedata filter without AMBIENT_VIEWING_ENVIRONMENT still plans HDR', () => {
		const caps61 = { ...CAPS, sidedataTypes: new Set(['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL']) };
		const plan = planVideo(sum(probe([hevcHlg()])), opts({ caps: caps61 }));
		expect(vf(plan.args)).not.toContain('AMBIENT');
		expect(vf(plan.args).endsWith('sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL')).toBe(true);
	});

	it('expects the duration of the kept streams, not of a longer dropped track', () => {
		const raw = probe([h264({ duration: '10.000000' }), aac(1, { duration: '10.020000' }), { index: 2, codec_type: 'data', codec_tag_string: 'mebx', duration: '12.000000' }], { duration: '12.000000' });
		expect(planVideo(sum(raw), opts()).expectedDurationS).toBeCloseTo(10.02, 6);
		// Matroska: no stream durations, the container's is used.
		expect(planVideo(sum(probe([h264(), aac(1)], { duration: '7.5' })), opts()).expectedDurationS).toBe(7.5);
	});

	it('short clips take the poster from the first frame', () => {
		const plan = planVideo(sum(probe([h264()], { duration: '1.5' })), opts());
		expect(after(plan.posterArgs, '-ss')).toBe('0');
		const ten = planVideo(sum(probe([h264()], { duration: '5' })), opts());
		expect(after(ten.posterArgs, '-ss')).toBe('0.5');
	});
});
