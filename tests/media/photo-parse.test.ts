/**
 * Pure pieces of the photo lane: heif-info and --list-decoders parsing (libheif 1.17 and 1.19
 * output), the taken-date / GPS rules, and the Display P3 profile and PNG iCCP embedding.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { parseHeifInfo } from '../../src/worker/photo/heif';
import { displayP3Icc, embedIccInPng } from '../../src/worker/photo/icc';
import { hasExif, parseExifDate, parseOffset, photoMeta, resolveGps, resolveTaken } from '../../src/worker/photo/metadata';
import { decoderOrder, parseDecoderList, type HeifTools } from '../../src/worker/photo/tools';

const INFO_117 = `MIME type: image/heic
main brand: heic
compatible brands: mif1, heic

image: 64x64 (id=1)
  colorspace: YCbCr, 4:2:0
  bit depth: 8
  thumbnail: 32x32
  color profile: prof
  alpha channel: no
  depth channel: no
metadata:
  none
transformations:
  none
region annotations:
  none
properties:

image: 64x64 (id=6), primary
  colorspace: monochrome
  bit depth: 8
  color profile: no
  alpha channel: yes
  depth channel: yes
    size: 32x32
    bits per pixel: 8
transformations:
  angle (ccw): 270
`;

// libheif 1.19 adds a "tiles:" line for grid images and prints "(premultiplied)" after alpha.
const INFO_119 = `MIME type: image/heic
main brand: heic
compatible brands: mif1, MiHE, MiPr, miaf, MiHB, heic

image: 4032x3024 (id=49), primary
  tiles: 8x6, tile size: 512x512
  colorspace: YCbCr, 4:2:0
  bit depth: 10
  thumbnail: 416x312
  color profile: nclx
  alpha channel: yes (premultiplied)
  depth channel: no
metadata:
  Exif: 2194 bytes
transformations:
  angle (ccw): 0
region annotations:
  none
properties:
`;

describe('parseHeifInfo', () => {
	it('reads libheif 1.17 output: images, the primary and their properties', () => {
		expect(parseHeifInfo(INFO_117)).toEqual({
			images: [
				{ width: 64, height: 64, primary: false, colorProfile: 'prof' },
				{ width: 64, height: 64, primary: true, colorProfile: 'no' }
			],
			primaryIndex: 1
		});
	});

	it('reads libheif 1.19 output (tiles line, premultiplied alpha)', () => {
		expect(parseHeifInfo(INFO_119)).toEqual({
			images: [{ width: 4032, height: 3024, primary: true, colorProfile: 'nclx' }],
			primaryIndex: 0
		});
	});

	it('returns null when no image is listed', () => {
		expect(parseHeifInfo('MIME type: image/heic\nmain brand: heic\n')).toBeNull();
		expect(parseHeifInfo('')).toBeNull();
	});
});

const LIST_117 = `HEIC decoders:
- libde265 = libde265 HEVC decoder, version 1.0.15
- ffmpeg = FFMPEG HEVC decoder 6.1.1-3ubuntu5
AVIF decoders:
- dav1d = dav1d v7.0.0
- aom = AOMedia Project AV1 Decoder v3.8.2
JPEG decoders:
JPEG 2000 decoders:
uncompressed: yes
`;

const LIST_119 = `AVC decoders:
AVIF decoders:
- dav1d = dav1d v1.5.1
HEIC decoders:
- libde265 = libde265 HEVC decoder, version 1.0.15
- ffmpeg = FFMPEG HEVC decoder 7.1.1-1+b1
JPEG decoders:
- libjpeg = libjpeg-turbo 2.1.5 (libjpeg 6.2)
JPEG 2000 decoders:
- openjpeg = OpenJPEG 2.5.3
uncompressed: yes
`;

describe('decoder list', () => {
	const tools = (decoders: HeifTools['decoders']): HeifTools => ({
		decBin: 'heif-dec',
		infoBin: 'heif-info',
		version: '1.19.8',
		decoders,
		decDisableLimits: true,
		infoDisableLimits: true
	});

	it('parses 1.17 and 1.19 --list-decoders output', () => {
		expect(parseDecoderList(LIST_117)).toEqual({ hevc: ['libde265', 'ffmpeg'], av1: ['dav1d', 'aom'] });
		expect(parseDecoderList(LIST_119)).toEqual({ hevc: ['libde265', 'ffmpeg'], av1: ['dav1d'] });
		expect(parseDecoderList('')).toEqual({ hevc: [], av1: [] });
	});

	it('tries ffmpegdec first for HEVC, then libde265, then anything else listed', () => {
		expect(decoderOrder(tools({ hevc: ['libde265', 'ffmpeg'], av1: [] }), 'hevc')).toEqual(['ffmpeg', 'libde265']);
		expect(decoderOrder(tools({ hevc: ['libde265'], av1: [] }), 'hevc')).toEqual(['libde265']);
		expect(decoderOrder(tools({ hevc: ['other', 'libde265'], av1: [] }), 'hevc')).toEqual(['libde265', 'other']);
		expect(decoderOrder(tools({ hevc: [], av1: ['aom', 'dav1d'] }), 'av1')).toEqual(['dav1d', 'aom']);
		expect(decoderOrder(tools({ hevc: [], av1: [] }), 'av1')).toEqual([]);
	});
});

describe('taken date', () => {
	const fallback = { clientMtimeMs: Date.UTC(2023, 0, 2, 3, 4, 5), uploadedMs: Date.UTC(2025, 0, 1) };

	it('parses EXIF and XMP date strings', () => {
		expect(parseExifDate('2024:07:04 11:22:31', '-07:00', '123')).toEqual({
			takenAt: '2024-07-04T11:22:31-07:00',
			takenMs: Date.UTC(2024, 6, 4, 18, 22, 31, 123),
			offset: '-07:00'
		});
		expect(parseExifDate('2024:07:04 11:22:31')).toEqual({ takenAt: '2024-07-04T11:22:31', takenMs: Date.UTC(2024, 6, 4, 11, 22, 31), offset: null });
		expect(parseExifDate('2024:07:04 11:22:31.5+0200')).toMatchObject({ takenAt: '2024-07-04T11:22:31+02:00', takenMs: Date.UTC(2024, 6, 4, 9, 22, 31, 500) });
		expect(parseExifDate('2024-07-04T11:22:31Z')).toMatchObject({ takenAt: '2024-07-04T11:22:31+00:00', offset: '+00:00' });
		expect(parseExifDate('1985:06:01 12:00:00')).toMatchObject({ takenAt: '1985-06-01T12:00:00' });
	});

	it('rejects unset, partial and impossible dates', () => {
		for (const bad of ['0000:00:00 00:00:00', '    :  :     :  :  ', '2024:02:30 10:00:00', '2024:07:04', '1899:12:31 23:59:59', '2024:07:04 25:00:00', '', null, 42]) {
			expect(parseExifDate(bad), String(bad)).toBeNull();
		}
		expect(parseOffset('+15:00')).toBeNull();
		expect(parseOffset('nonsense')).toBeNull();
		expect(parseOffset('-0330')).toBe(-210);
	});

	it('follows the fallback chain: DateTimeOriginal → CreateDate → XMP → lastModified → upload', () => {
		expect(
			resolveTaken(
				{
					'ExifIFD:DateTimeOriginal': '2020:01:01 10:00:00',
					'ExifIFD:OffsetTimeOriginal': '+01:00',
					'ExifIFD:CreateDate': '2021:01:01 10:00:00',
					'XMP-xmp:CreateDate': '2022:01:01 10:00:00'
				},
				fallback
			).takenAt
		).toBe('2020-01-01T10:00:00+01:00');
		expect(resolveTaken({ 'ExifIFD:DateTimeOriginal': '0000:00:00 00:00:00', 'ExifIFD:CreateDate': '2021:01:01 10:00:00', 'ExifIFD:OffsetTimeDigitized': '-05:00' }, fallback).takenAt).toBe(
			'2021-01-01T10:00:00-05:00'
		);
		expect(resolveTaken({ 'XMP-photoshop:DateCreated': '2022:03:04 05:06:07+09:00' }, fallback).takenAt).toBe('2022-03-04T05:06:07+09:00');
		// An XMP DateTimeOriginal never borrows the EXIF offset.
		expect(resolveTaken({ 'XMP-exif:DateTimeOriginal': '2022:03:04 05:06:07', 'ExifIFD:OffsetTimeOriginal': '+01:00' }, fallback).takenAt).toBe('2022-03-04T05:06:07');
		expect(resolveTaken({}, fallback)).toEqual({ takenAt: null, takenMs: fallback.clientMtimeMs, offset: null });
		expect(resolveTaken({}, { clientMtimeMs: null, uploadedMs: fallback.uploadedMs }).takenMs).toBe(fallback.uploadedMs);
		expect(resolveTaken({}, { clientMtimeMs: 0, uploadedMs: fallback.uploadedMs }).takenMs).toBe(fallback.uploadedMs);
	});
});

describe('GPS and other source facts', () => {
	it('prefers the signed composite position', () => {
		expect(resolveGps({ 'Composite:GPSLatitude': -33.85, 'Composite:GPSLongitude': 151.2, 'Composite:GPSAltitude': -3 })).toEqual({ lat: -33.85, lon: 151.2, alt: -3 });
	});

	it('falls back to GPS tags with their references', () => {
		expect(resolveGps({ 'GPS:GPSLatitude': 33.85, 'GPS:GPSLatitudeRef': 'S', 'GPS:GPSLongitude': 70.1, 'GPS:GPSLongitudeRef': 'W' })).toEqual({ lat: -33.85, lon: -70.1, alt: null });
	});

	it('ignores missing, out-of-range and 0,0 positions', () => {
		expect(resolveGps({})).toBeNull();
		expect(resolveGps({ 'Composite:GPSLatitude': 0, 'Composite:GPSLongitude': 0 })).toBeNull();
		expect(resolveGps({ 'Composite:GPSLatitude': 95, 'Composite:GPSLongitude': 10 })).toBeNull();
	});

	it('reads the Apple ContentIdentifier, nclx primaries and file type', () => {
		const meta = photoMeta(
			{ 'Apple:ContentIdentifier': 'A1B2-C3', 'QuickTime:ColorPrimaries': 12, 'File:FileType': 'HEIC' },
			{ clientMtimeMs: null, uploadedMs: 1 }
		);
		expect(meta).toMatchObject({ contentId: 'A1B2-C3', colorPrimaries: 12, fileType: 'HEIC' });
		expect(hasExif({ 'File:FileType': 'PNG' })).toBe(false);
		expect(hasExif({ 'IFD0:Make': 'Apple' })).toBe(true);
	});
});

describe('Display P3 profile', () => {
	it('is a valid ICC profile that sharp/lcms can use, named "Display P3"', async () => {
		const icc = displayP3Icc();
		expect(icc.readUInt32BE(0)).toBe(icc.length);
		expect(icc.toString('latin1', 36, 40)).toBe('acsp');
		expect(icc.includes(Buffer.from('Display P3', 'utf16le').swap16())).toBe(true); // mluc text is UTF-16BE
		// P3 (200,100,50) is sRGB ≈ (215,93,32): converting through the profile must agree.
		const file = path.join(testEnv().root, 'p3-pixels.png');
		await sharp(Buffer.from([200, 100, 50]), { raw: { width: 1, height: 1, channels: 3 } }).png().toFile(file);
		await embedIccInPng(file, icc, 'Display P3');
		const meta = await sharp(file).metadata();
		expect(meta.hasProfile).toBe(true);
		expect(meta.icc?.equals(icc)).toBe(true);
		const srgb = await sharp(file).toColourspace('srgb').raw().toBuffer();
		expect([...srgb].map((v, i) => Math.abs(v - [215, 93, 32][i]) <= 2)).toEqual([true, true, true]);
	});

	it('embeds the profile in a PNG without touching the pixels', async () => {
		const file = path.join(testEnv().root, 'embed.png');
		const raw = Buffer.from(Array.from({ length: 16 * 8 * 3 }, (_, i) => (i * 7) & 255));
		await sharp(raw, { raw: { width: 16, height: 8, channels: 3 } }).png().toFile(file);
		await embedIccInPng(file, displayP3Icc(), 'Display P3');
		expect(await sharp(file, { ignoreIcc: true }).raw().toBuffer()).toEqual(raw);
		expect(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('embed.png.'))).toEqual([]);
	});

	it('refuses a file that is not a PNG', async () => {
		const file = path.join(testEnv().root, 'not.png');
		fs.writeFileSync(file, 'definitely not a png, but long enough to have 33 bytes');
		await expect(embedIccInPng(file, displayP3Icc(), 'Display P3')).rejects.toThrow(/IHDR/);
	});
});
