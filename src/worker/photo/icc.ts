/**
 * A Display P3 ICC profile built in code (ICC v4.3 matrix/TRC display profile: Display P3
 * primaries, D65 white adapted to the D50 connection space with Bradford, the sRGB tone curve), so
 * it is ours to ship. Its description reads "Display P3", like the profile in iPhone photos.
 *
 * Used when a HEIF says "P3" only in its nclx colour box: libheif then writes no ICC profile into
 * the decoded PNG and the pixels would otherwise be read as sRGB, so embedIccInPng() tags the PNG
 * before sharp sees it. The fixture generator also tags its P3 test images with the profile. Keep
 * this module free of non-erasable TypeScript and of imports other than node:*
 * (tests/fixtures/photo/generate.mjs imports it directly).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const DISPLAY_P3 = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: [0.3127, 0.329] } as const;

/** The PCS illuminant exactly as the ICC header stores it (s15Fixed16 0xF6D6, 0x10000, 0xD32D). */
const D50_FIXED: Vec3 = [0xf6d6, 0x10000, 0xd32d];
const D50: Vec3 = [D50_FIXED[0] / 65536, 1, D50_FIXED[2] / 65536];

const BRADFORD: Mat3 = [
	[0.8951, 0.2664, -0.1614],
	[-0.7502, 1.7135, 0.0367],
	[0.0389, -0.0685, 1.0296]
];

const xyY = ([x, y]: readonly [number, number]): Vec3 => [x / y, 1, (1 - x - y) / y];

const mulV = (m: Mat3, v: Vec3): Vec3 => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]) as Vec3;

const mulM = (a: Mat3, b: Mat3): Mat3 =>
	a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])) as Mat3;

function invert(m: Mat3): Mat3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	return [
		[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
		[(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
		[(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]
	];
}

/** RGB → XYZ for the given primaries, scaled so that RGB white maps to the white point. */
function rgbToXyz(): Mat3 {
	const cols = [xyY(DISPLAY_P3.r), xyY(DISPLAY_P3.g), xyY(DISPLAY_P3.b)];
	const p: Mat3 = [0, 1, 2].map((i) => cols.map((c) => c[i])) as Mat3;
	const s = mulV(invert(p), xyY(DISPLAY_P3.white));
	return p.map((row) => row.map((v, j) => v * s[j])) as Mat3;
}

/** Bradford chromatic adaptation from the profile's white point to D50. */
function chad(): Mat3 {
	const src = mulV(BRADFORD, xyY(DISPLAY_P3.white));
	const dst = mulV(BRADFORD, D50);
	const scale: Mat3 = [
		[dst[0] / src[0], 0, 0],
		[0, dst[1] / src[1], 0],
		[0, 0, dst[2] / src[2]]
	];
	return mulM(invert(BRADFORD), mulM(scale, BRADFORD));
}

const s15 = (v: number): number => Math.round(v * 65536);

function tag(type: string, body: Buffer): Buffer {
	const b = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.alloc(4), body]);
	return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
}

function fixed(values: number[], prescaled = false): Buffer {
	const b = Buffer.alloc(values.length * 4);
	values.forEach((v, i) => b.writeInt32BE(prescaled ? v : s15(v), i * 4));
	return b;
}

function mluc(text: string): Buffer {
	const str = Buffer.from(text, 'utf16le').swap16();
	const head = Buffer.alloc(20);
	head.writeUInt32BE(1, 0); // one record
	head.writeUInt32BE(12, 4); // record size
	head.write('enUS', 8, 'latin1');
	head.writeUInt32BE(str.length, 12);
	head.writeUInt32BE(28, 16); // string offset from the start of the tag
	return tag('mluc', Buffer.concat([head, str]));
}

function para(): Buffer {
	// Function type 3 (the sRGB curve): Y = (aX+b)^g for X ≥ d, else cX.
	const head = Buffer.alloc(4);
	head.writeUInt16BE(3, 0);
	return tag('para', Buffer.concat([head, fixed([2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045])]));
}

function build(): Buffer {
	const toD50 = mulM(chad(), rgbToXyz());
	const colorant = (j: number) => tag('XYZ ', fixed([toD50[0][j], toD50[1][j], toD50[2][j]]));
	const trc = para();
	const tags: [string, Buffer][] = [
		['desc', mluc('Display P3')],
		['cprt', mluc('No copyright, use freely')],
		['wtpt', tag('XYZ ', fixed(D50_FIXED, true))],
		['rXYZ', colorant(0)],
		['gXYZ', colorant(1)],
		['bXYZ', colorant(2)],
		['rTRC', trc],
		['gTRC', trc],
		['bTRC', trc],
		['chad', tag('sf32', fixed(chad().flat()))]
	];

	// Tag data in order; the three TRC tags share one copy.
	const table = Buffer.alloc(4 + tags.length * 12);
	table.writeUInt32BE(tags.length, 0);
	const blobs: Buffer[] = [];
	const offsets = new Map<Buffer, number>();
	let offset = 128 + table.length;
	tags.forEach(([sig, data], i) => {
		let at = offsets.get(data);
		if (at === undefined) {
			at = offset;
			offsets.set(data, at);
			blobs.push(data);
			offset += data.length;
		}
		table.write(sig, 4 + i * 12, 'latin1');
		table.writeUInt32BE(at, 8 + i * 12);
		table.writeUInt32BE(data.length, 12 + i * 12);
	});

	const header = Buffer.alloc(128);
	header.writeUInt32BE(offset, 0);
	header.writeUInt32BE(0x04300000, 8); // version 4.3
	header.write('mntrRGB XYZ ', 12, 'latin1');
	[2026, 1, 1, 0, 0, 0].forEach((v, i) => header.writeUInt16BE(v, 24 + i * 2));
	header.write('acsp', 36, 'latin1');
	fixed(D50_FIXED, true).copy(header, 68);
	const profile = Buffer.concat([header, table, ...blobs]);
	// Profile ID: MD5 of the profile with the flags, intent and ID fields zeroed (they are).
	createHash('md5').update(profile).digest().copy(profile, 84);
	return profile;
}

let cached: Buffer | null = null;

/** The profile bytes (≈ 0.5 KB), built once. */
export function displayP3Icc(): Buffer {
	cached ??= build();
	return cached;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 CRC). */
const PNG_HEAD = 33;

function pngChunk(type: string, data: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	typed.copy(out, 4);
	out.writeUInt32BE(zlib.crc32(typed), 8 + data.length);
	return out;
}

/**
 * Rewrites a PNG that has no colour profile with an iCCP chunk right after IHDR, streaming the
 * rest of the file (decoded HEIFs can be hundreds of MB).
 */
export async function embedIccInPng(file: string, icc: Buffer, name: string): Promise<void> {
	const head = Buffer.alloc(PNG_HEAD);
	const fh = await fs.open(file, 'r');
	try {
		await fh.read(head, 0, PNG_HEAD, 0);
	} finally {
		await fh.close();
	}
	if (!head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString('latin1', 12, 16) !== 'IHDR' || head.readUInt32BE(8) !== 13) {
		throw new Error(`${file} does not start with a PNG IHDR chunk`);
	}
	const iccp = pngChunk('iCCP', Buffer.concat([Buffer.from(`${name}\0\0`, 'latin1'), zlib.deflateSync(icc)]));
	const tmp = `${file}.icc`;
	const out = createWriteStream(tmp);
	out.write(Buffer.concat([head, iccp]));
	await pipeline(createReadStream(file, { start: PNG_HEAD }), out);
	await fs.rename(tmp, file);
}
