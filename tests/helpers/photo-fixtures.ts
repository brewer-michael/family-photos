/**
 * Shared facts about the photo fixtures: where they live, the colours they were built from and
 * the metadata written into them. Imported by the generator (tests/fixtures/photo/generate.ts,
 * run directly by Node, so only node:* imports and erasable TypeScript here) and by the tests.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Generated fixtures (committed) and vendored HEIF fixtures. */
export const PHOTO_FIXTURES = path.resolve(here, '../fixtures/photo');
export const HEIF_FIXTURES = path.resolve(here, '../fixtures/heif');

export type Rgb = [number, number, number];

/** Four-colour quadrant test image (stored pixel layout before any EXIF orientation). */
export const QUAD = {
	width: 256,
	height: 192,
	tl: [220, 40, 40] as Rgb,
	tr: [40, 180, 60] as Rgb,
	bl: [40, 60, 200] as Rgb,
	br: [240, 220, 40] as Rgb
};

/** The small quadrant image for uncompressed formats (BMP, PSD). */
export const QUAD_SMALL = { width: 64, height: 48 };

/** 24 ColorChecker-like sRGB patches, 6 across × 4 down, PATCH px each; patches.png has no ICC. */
export const PATCH = 32;
export const PATCHES_ACROSS = 6;
export const PATCHES: readonly Rgb[] = [
	[115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
	[214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
	[56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
	[243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52]
];

/** Frame colours of the animated fixtures (GIF, WebP, APNG), 64×48, 100 ms each. */
export const FRAMES: readonly Rgb[] = [[230, 30, 30], [30, 200, 30], [30, 30, 230]];

/** EXIF written into the quadrant JPEGs (and so into the HEICs made from them). */
export const QUAD_EXIF = {
	dateTimeOriginal: '2024:07:04 11:22:31',
	offsetTimeOriginal: '-07:00',
	/** taken_at / taken_ms the lane must derive from the two above. */
	takenAt: '2024-07-04T11:22:31-07:00',
	takenMs: Date.UTC(2024, 6, 4, 18, 22, 31),
	gpsLat: 37.3349,
	gpsLon: -122.009,
	gpsAlt: 10,
	make: 'Apple',
	model: 'iPhone 15 Pro'
};

/** EXIF written into the TIFF and the synthetic DNGs (no offset: local time only). */
export const OTHER_EXIF = {
	dateTimeOriginal: '2023:12:25 09:30:00',
	takenAt: '2023-12-25T09:30:00',
	make: 'Testcam',
	model: 'Model R'
};

/**
 * The stored-pixel point shown at displayed point (x, y) for an EXIF orientation, where (w, h) are
 * the displayed dimensions (swapped relative to the stored ones for orientations 5–8).
 */
export function storedPoint(orientation: number, x: number, y: number, w: number, h: number): [number, number] {
	switch (orientation) {
		case 2: return [w - 1 - x, y];
		case 3: return [w - 1 - x, h - 1 - y];
		case 4: return [x, h - 1 - y];
		case 5: return [y, x];
		case 6: return [y, w - 1 - x];
		case 7: return [h - 1 - y, w - 1 - x];
		case 8: return [h - 1 - y, x];
		default: return [x, y];
	}
}

/** Expected colours of the displayed quadrants (tl, tr, bl, br) for a quadrant source with an orientation. */
export function expectedQuadrants(orientation: number, stored = QUAD): Record<'tl' | 'tr' | 'bl' | 'br', Rgb> {
	const rotated = orientation >= 5;
	const w = rotated ? stored.height : stored.width;
	const h = rotated ? stored.width : stored.height;
	const colourAt = (x: number, y: number): Rgb => {
		const [sx, sy] = storedPoint(orientation, x, y, w, h);
		const right = sx >= stored.width / 2;
		const bottom = sy >= stored.height / 2;
		return bottom ? (right ? QUAD.br : QUAD.bl) : right ? QUAD.tr : QUAD.tl;
	};
	return {
		tl: colourAt(w / 4, h / 4),
		tr: colourAt((3 * w) / 4, h / 4),
		bl: colourAt(w / 4, (3 * h) / 4),
		br: colourAt((3 * w) / 4, (3 * h) / 4)
	};
}
