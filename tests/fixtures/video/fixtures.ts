/**
 * Video fixtures F1–F19 (docs/media-pipeline.md §8), generated at test time with the local ffmpeg
 * into a temp dir (never committed). Clips are short and small so the media suite stays fast;
 * each fixture lists the encoders it needs and is skipped with a message when they are missing.
 *
 * Apple metadata is written with `-movflags use_metadata_tags` (QuickTime Keys, as an iPhone does).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { injectDvcc } from './dovi';

export const FIXTURE_FFMPEG = process.env.FIXTURE_FFMPEG ?? 'ffmpeg';

/** Apple Keys as an iPhone writes them (local time + offset, ISO 6709, Live Photo id). */
export const APPLE = {
	creationDate: '2024-07-04T11:22:31-0700',
	location: '+37.3349-122.0090+010.000/',
	contentId: '8E2C5A1B-0D7F-4C3E-9A61-2B4F6D8E0A13'
} as const;

/** F8's only date: an mvhd creation_time (a UTC instant; 20:30 on July 4 in Los Angeles). */
export const UTC_ONLY_CREATION_TIME = '2024-07-05T03:30:00.000000Z';

const appleTags = [
	'-metadata', `com.apple.quicktime.creationdate=${APPLE.creationDate}`,
	'-metadata', `com.apple.quicktime.location.ISO6709=${APPLE.location}`,
	'-metadata', `com.apple.quicktime.content.identifier=${APPLE.contentId}`,
	'-metadata', 'com.apple.quicktime.make=Apple',
	'-metadata', 'creation_time=2024-07-04T18:22:31.000000Z',
	'-movflags', 'use_metadata_tags'
];

const x265 = (params: string) => ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', `log-level=error:${params}`];
// Colour tags on the frames (ffmpeg 7.1 takes the stream's tags from them) and on the encoder (6.1).
const HLG = 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc';
const PQ = 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc';
const HLG_TAGS = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc'];
const PQ_TAGS = ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'];
const lavfi = (graph: string) => ['-f', 'lavfi', '-i', graph];
const aacStereo = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'];
const x264 = (...extra: string[]) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...extra];

export interface VideoFixture {
	id: string;
	file: string;
	what: string;
	/** ffmpeg encoders the fixture needs. */
	encoders: string[];
	/** ffmpeg invocations (arguments only); `tmp(name)` is a scratch path next to the output. */
	steps(out: string, tmp: (name: string) => string): string[][];
	/** Post-processing on the generated file. */
	post?(out: string): void;
}

export const FIXTURES = {
	F1: {
		id: 'F1',
		file: 'f1-hlg-portrait.mov',
		what: '4K60 10-bit HLG HEVC shot in portrait (rotation −90), 4-channel PCM before stereo AAC, timecode, Apple keys',
		encoders: ['libx265', 'aac', 'pcm_s16le'],
		steps: (out, tmp) => [
			[
				...lavfi('testsrc2=s=3840x2160:r=60:d=1'),
				...lavfi('sine=f=440:d=1:sample_rate=48000'),
				...lavfi('aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t)|sin(660*2*PI*t)|sin(770*2*PI*t):s=48000:d=1'),
				'-map', '0:v', '-map', '2:a', '-map', '1:a',
				'-vf', `format=yuv420p10le,${HLG}`, ...x265('colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc'), ...HLG_TAGS, '-tag:v', 'hvc1',
				'-c:a:0', 'pcm_s16le', '-c:a:1', 'aac', '-b:a:1', '128k', '-ac:a:1', '2', tmp('f1.mov')
			],
			['-display_rotation:v:0', '-90', '-i', tmp('f1.mov'), '-map', '0', '-c', 'copy', '-timecode', '01:02:03:04', ...appleTags, out]
		]
	},
	F2: {
		id: 'F2',
		file: 'f2-pq-hdr10.mp4',
		what: '10-bit PQ HEVC with HDR10 mastering display and MaxCLL (SEI)',
		encoders: ['libx265', 'aac'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=1280x720:r=30:d=1'), ...lavfi('sine=d=1'),
				'-vf', `format=yuv420p10le,${PQ}`,
				...x265('colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400'),
				...PQ_TAGS, '-tag:v', 'hvc1', ...aacStereo, out
			]
		]
	},
	F2w: {
		id: 'F2w',
		file: 'f2w-bt2020-sdr.mp4',
		what: '10-bit HEVC with BT.2020 primaries and an SDR transfer (wide gamut, not HDR)',
		encoders: ['libx265', 'aac'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=640x360:r=30:d=1'), ...lavfi('sine=d=1'),
				'-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=bt2020-10:colorspace=bt2020nc',
				...x265('colorprim=bt2020:transfer=bt2020-10:colormatrix=bt2020nc'), '-tag:v', 'hvc1', ...aacStereo, out
			]
		]
	},
	F3: {
		id: 'F3',
		file: 'f3-h264-remux.mov',
		what: 'H.264 High 640×360 30 fps + AAC-LC stereo in MOV with Apple keys: remux, stream copied bit for bit',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=30:d=2'), ...lavfi('sine=d=2'), ...x264('-profile:v', 'high'), ...aacStereo, ...appleTags, out]]
	},
	F3r: {
		id: 'F3r',
		file: 'f3r-h264-portrait.mov',
		what: 'Portrait H.264 (rotation −90, like an iPhone "Most Compatible" clip): remux keeps the rotation',
		encoders: ['libx264', 'aac'],
		steps: (out, tmp) => [
			[...lavfi('testsrc2=s=640x360:r=30:d=1'), ...lavfi('sine=d=1'), ...x264(), ...aacStereo, tmp('f3r.mov')],
			['-display_rotation:v:0', '-90', '-i', tmp('f3r.mov'), '-map', '0', '-c', 'copy', out]
		]
	},
	F4: {
		id: 'F4',
		file: 'f4-pcm.mov',
		what: 'H.264 + PCM 44.1 kHz: remux with the sound re-encoded to AAC (source archived)',
		encoders: ['libx264', 'pcm_s16le'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=30:d=1'), ...lavfi('sine=d=1:sample_rate=44100'), ...x264(), '-c:a', 'pcm_s16le', '-ac', '2', out]]
	},
	F5: {
		id: 'F5',
		file: 'f5-4k30.mp4',
		what: 'H.264 3840×2160 30 fps: transcoded down to 1920×1080',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=3840x2160:r=30:d=1'), ...lavfi('sine=d=1'), ...x264(), ...aacStereo, out]]
	},
	F6: {
		id: 'F6',
		file: 'f6-240fps.mp4',
		what: '240 fps without the slow-motion intent: played at normal speed, 60 fps',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=240:d=1'), ...lavfi('sine=d=1'), ...x264(), ...aacStereo, out]]
	},
	F7: {
		id: 'F7',
		file: 'f7-vfr.mp4',
		what: 'Variable frame rate HEVC (30 fps then 15 fps): frame timing passed through',
		encoders: ['libx265', 'aac'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=640x360:r=30:d=2'), ...lavfi('sine=d=3'),
				'-vf', "setpts='if(lt(N,30),N/30,1+(N-30)/15)/TB'", '-fps_mode', 'vfr', ...x265('keyint=30'), '-tag:v', 'hvc1', ...aacStereo, out
			]
		]
	},
	F8: {
		id: 'F8',
		file: 'f8-no-audio.mp4',
		what: 'H.264 without a sound track, dated only by creation_time (UTC, like most Android and camera clips): remux',
		encoders: ['libx264'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=25:d=1'), ...x264(), '-metadata', `creation_time=${UTC_ONLY_CREATION_TIME}`, out]]
	},
	F9: {
		id: 'F9',
		file: 'f9-ntsc.dv',
		what: 'NTSC DV (interlaced 4:1:1, non-square pixels, PCM)',
		encoders: ['dvvideo', 'pcm_s16le'],
		steps: (out) => [
			[...lavfi('testsrc2=s=720x480:r=30000/1001:d=1'), ...lavfi('sine=d=1:sample_rate=48000'), '-c:v', 'dvvideo', '-pix_fmt', 'yuv411p', '-c:a', 'pcm_s16le', '-ac', '2', '-f', 'dv', out]
		]
	},
	F9b: {
		id: 'F9b',
		file: 'f9b-dolby-vision-p5.mp4',
		what: 'Dolby Vision profile 5 (no compatible base layer): rejected as unsupported',
		encoders: ['libx265'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=30:d=1'), '-vf', 'format=yuv420p10le', ...x265('repeat-headers=1'), '-tag:v', 'hvc1', out]],
		post: (out) => injectDvcc(out, { profile: 5, level: 6, compatId: 0 })
	},
	F9c: {
		id: 'F9c',
		file: 'f9c-dolby-vision-84.mp4',
		what: 'Dolby Vision 8.4 (HLG base layer, as iPhones record): tone-mapped through the base layer, no DOVI record left',
		encoders: ['libx265', 'aac'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=640x360:r=30:d=1'), ...lavfi('sine=d=1'),
				'-vf', `format=yuv420p10le,${HLG}`, ...x265('colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc'), ...HLG_TAGS, '-tag:v', 'hvc1', ...aacStereo, out
			]
		],
		post: (out) => injectDvcc(out, { profile: 8, level: 2, compatId: 4 })
	},
	F10: {
		id: 'F10',
		file: 'f10-mjpeg.avi',
		what: 'Motion JPEG (full range 4:2:2) + PCM in AVI',
		encoders: ['mjpeg', 'pcm_s16le'],
		steps: (out) => [[...lavfi('testsrc2=s=640x480:r=25:d=1'), ...lavfi('sine=d=1'), '-c:v', 'mjpeg', '-pix_fmt', 'yuvj422p', '-q:v', '3', '-c:a', 'pcm_s16le', out]]
	},
	F11: {
		id: 'F11',
		file: 'f11-wmv.wmv',
		what: 'Windows Media Video 8 + WMA 2 in ASF',
		encoders: ['wmv2', 'wmav2'],
		steps: (out) => [[...lavfi('testsrc2=s=320x240:r=25:d=1'), ...lavfi('sine=d=1'), '-c:v', 'wmv2', '-b:v', '800k', '-c:a', 'wmav2', '-b:a', '64k', out]]
	},
	F12a: {
		id: 'F12a',
		file: 'f12a-vp9.webm',
		what: 'VP9 + Opus in WebM',
		encoders: ['libvpx-vp9', 'libopus'],
		steps: (out) => [
			[...lavfi('testsrc2=s=320x240:r=30:d=1'), ...lavfi('sine=d=1:sample_rate=48000'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', '-c:a', 'libopus', out]
		]
	},
	F12b: {
		id: 'F12b',
		file: 'f12b-av1.mp4',
		what: 'AV1 + AAC in MP4',
		encoders: ['libsvtav1', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=320x240:r=30:d=1'), ...lavfi('sine=d=1'), '-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p', ...aacStereo, out]]
	},
	F14: {
		id: 'F14',
		file: 'f14-mpeg2-1080i.ts',
		what: 'MPEG-2 1080i (top field first) + AC-3 5.1 in MPEG-TS',
		encoders: ['mpeg2video', 'ac3'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=1920x1080:r=25:d=1'),
				...lavfi('aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t)|sin(660*2*PI*t)|0.1*sin(55*2*PI*t)|sin(770*2*PI*t)|sin(880*2*PI*t):s=48000:d=1:channel_layout=5.1'),
				'-c:v', 'mpeg2video', '-b:v', '15M', '-flags', '+ilme+ildct', '-top', '1', '-field_order', 'tt', '-pix_fmt', 'yuv420p',
				'-c:a', 'ac3', '-b:a', '384k', '-f', 'mpegts', out
			]
		]
	},
	F15: {
		id: 'F15',
		file: 'f15-prores-hlg.mov',
		what: 'ProRes 422 HQ 10-bit tagged HLG + PCM',
		encoders: ['prores_ks', 'pcm_s16le'],
		steps: (out) => [
			[...lavfi('testsrc2=s=1280x720:r=25:d=1'), ...lavfi('sine=d=1:sample_rate=48000'), '-vf', HLG, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', ...HLG_TAGS, '-c:a', 'pcm_s16le', out]
		]
	},
	F16: {
		id: 'F16',
		file: 'f16-sar43.mp4',
		what: 'H.264 720×480 with 4:3 pixels: shown 960×480 with square pixels',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=720x480:r=30:d=1'), ...lavfi('sine=d=1'), '-vf', 'setsar=4/3', ...x264(), ...aacStereo, out]]
	},
	F17: {
		id: 'F17',
		file: 'f17-odd.mkv',
		what: 'Odd dimensions 321×241 (H.264 4:4:4) in Matroska',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=320x240:r=30:d=1'), ...lavfi('sine=d=1'), '-vf', 'scale=321:241,format=yuv444p', '-c:v', 'libx264', '-preset', 'ultrafast', ...aacStereo, out]]
	},
	F17t: {
		id: 'F17t',
		file: 'f17t-truncated.mov',
		what: 'Phone recording cut off half way (moov at the end is lost)',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=30:d=2'), ...lavfi('sine=d=2'), ...x264(), ...aacStereo, out]],
		post: (out) => fs.truncateSync(out, Math.floor(fs.statSync(out).size / 2))
	},
	F17f: {
		id: 'F17f',
		file: 'f17f-truncated-faststart.mp4',
		what: 'Fast-start MP4 whose media data is cut off at 60%',
		encoders: ['libx264', 'aac'],
		steps: (out) => [[...lavfi('testsrc2=s=640x360:r=30:d=3'), ...lavfi('sine=d=3'), ...x264(), ...aacStereo, '-movflags', '+faststart', out]],
		post: (out) => fs.truncateSync(out, Math.floor(fs.statSync(out).size * 0.6))
	},
	F18: {
		id: 'F18',
		file: 'f18-slowmo.mov',
		what: '240 fps HEVC with full-frame-rate-playback-intent=0 (iOS 18 slow motion): retimed to 30 fps',
		encoders: ['libx265', 'aac'],
		steps: (out) => [
			[
				...lavfi('testsrc2=s=640x360:r=240:d=2'), ...lavfi('sine=d=2'), ...x265('keyint=240'), '-tag:v', 'hvc1', ...aacStereo,
				'-metadata', 'com.apple.quicktime.full-frame-rate-playback-intent=0', '-movflags', 'use_metadata_tags', out
			]
		]
	},
	F19: {
		id: 'F19',
		file: 'f19-hlg-grey.mp4',
		what: '10-bit HLG 75% grey: tone-mapped luma must land in 205–228',
		encoders: ['libx265'],
		steps: (out) => [
			[...lavfi(`nullsrc=s=320x240:r=30:d=1,format=yuv420p10le,geq=lum=721:cb=512:cr=512,${HLG}`), ...x265('colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc'), ...HLG_TAGS, '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', out]
		]
	}
} satisfies Record<string, VideoFixture>;

export type FixtureId = keyof typeof FIXTURES;

let encoders: Set<string> | null = null;

/** Encoders of the fixture ffmpeg that a fixture needs but that are missing (empty = can generate). */
export function missingEncoders(fx: VideoFixture): string[] {
	encoders ??= new Set(
		[...execFileSync(FIXTURE_FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).matchAll(/^ [VAS][A-Z.]{5} (\S+)\s/gm)].map((m) => m[1])
	);
	return fx.encoders.filter((e) => !encoders!.has(e));
}

/** Generates the fixture into `dir` (cached per dir) and returns its path. */
export function makeFixture(fx: VideoFixture, dir: string): string {
	const out = path.join(dir, fx.file);
	if (fs.existsSync(out)) return out;
	fs.mkdirSync(dir, { recursive: true });
	const tmp = (name: string) => path.join(dir, `.${fx.id}-${name}`);
	for (const args of fx.steps(out, tmp)) {
		execFileSync(FIXTURE_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
	}
	fx.post?.(out);
	return out;
}
