/**
 * Colour checks for the photo tests: CIEDE2000 between sRGB colours, and mean colours of image
 * regions read through sharp (auto-oriented, converted to sRGB with the file's own ICC profile).
 */
import sharp from 'sharp';
import type { Rgb } from './photo-fixtures';

type Lab = [number, number, number];

const D65 = [0.95047, 1, 1.08883] as const;

function srgbToLab([r, g, b]: Rgb): Lab {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const [R, G, B] = [lin(r), lin(g), lin(b)];
	const xyz = [
		0.4124564 * R + 0.3575761 * G + 0.1804375 * B,
		0.2126729 * R + 0.7151522 * G + 0.072175 * B,
		0.0193339 * R + 0.119192 * G + 0.9503041 * B
	];
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
	const [fx, fy, fz] = xyz.map((v, i) => f(v / D65[i]));
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference between two sRGB colours (Sharma, Wu & Dalal 2005). */
export function deltaE2000(c1: Rgb, c2: Rgb): number {
	const [L1, a1, b1] = srgbToLab(c1);
	const [L2, a2, b2] = srgbToLab(c2);
	const rad = Math.PI / 180;
	const C1 = Math.hypot(a1, b1);
	const C2 = Math.hypot(a2, b2);
	const Cbar = (C1 + C2) / 2;
	const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
	const a1p = (1 + G) * a1;
	const a2p = (1 + G) * a2;
	const C1p = Math.hypot(a1p, b1);
	const C2p = Math.hypot(a2p, b2);
	const hp = (a: number, b: number) => {
		if (a === 0 && b === 0) return 0;
		const h = Math.atan2(b, a) / rad;
		return h < 0 ? h + 360 : h;
	};
	const h1p = hp(a1p, b1);
	const h2p = hp(a2p, b2);
	const dLp = L2 - L1;
	const dCp = C2p - C1p;
	let dhp = 0;
	if (C1p * C2p !== 0) {
		dhp = h2p - h1p;
		if (dhp > 180) dhp -= 360;
		else if (dhp < -180) dhp += 360;
	}
	const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
	const Lbp = (L1 + L2) / 2;
	const Cbp = (C1p + C2p) / 2;
	let hbp = h1p + h2p;
	if (C1p * C2p !== 0) {
		if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
		else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
	}
	const T =
		1 -
		0.17 * Math.cos((hbp - 30) * rad) +
		0.24 * Math.cos(2 * hbp * rad) +
		0.32 * Math.cos((3 * hbp + 6) * rad) -
		0.2 * Math.cos((4 * hbp - 63) * rad);
	const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
	const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
	const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
	const Sc = 1 + 0.045 * Cbp;
	const Sh = 1 + 0.015 * Cbp * T;
	const Rt = -Math.sin(2 * dTheta * rad) * Rc;
	return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export interface Pixels {
	width: number;
	height: number;
	channels: number;
	data: Buffer;
}

/**
 * Decoded 8-bit sRGB pixels of the first frame, auto-oriented. `asCoded` skips the ICC conversion
 * (compare code values exactly as stored, e.g. P3-tagged patches against their source codes).
 */
export async function pixels(file: string | Buffer, opts: { asCoded?: boolean } = {}): Promise<Pixels> {
	let p = sharp(file, { autoOrient: true, ...(opts.asCoded ? { ignoreIcc: true } : {}) });
	p = p.toColourspace('srgb');
	const { data, info } = await p.removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return { width: info.width, height: info.height, channels: info.channels, data };
}

/** Mean colour of a rectangle. */
export function meanRgb(px: Pixels, left: number, top: number, width: number, height: number): Rgb {
	const sum = [0, 0, 0];
	for (let y = Math.round(top); y < Math.round(top + height); y++) {
		for (let x = Math.round(left); x < Math.round(left + width); x++) {
			const i = (y * px.width + x) * px.channels;
			for (let c = 0; c < 3; c++) sum[c] += px.data[i + c];
		}
	}
	const n = Math.round(width) * Math.round(height);
	return sum.map((s) => s / n) as Rgb;
}

/** Mean colours of the central half of each quadrant (avoids chroma bleeding at the edges). */
export function quadrantMeans(px: Pixels): Record<'tl' | 'tr' | 'bl' | 'br', Rgb> {
	const qw = px.width / 2;
	const qh = px.height / 2;
	const at = (cx: number, cy: number) => meanRgb(px, cx * qw + qw / 4, cy * qh + qh / 4, qw / 2, qh / 2);
	return { tl: at(0, 0), tr: at(1, 0), bl: at(0, 1), br: at(1, 1) };
}
