// Generates the PWA / home-screen icons in static/icons/ from one inline SVG (a friendly stack of
// photos). Run after changing the artwork: `node scripts/generate-icons.mjs`. The PNGs are committed.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'static', 'icons');
const BG = '#9c3d1f';

/** The artwork on a 512×512 canvas: two tilted prints behind a polaroid of a sunny hill. */
const ART = `
	<rect x="120" y="128" width="272" height="272" rx="24" fill="#f0d2b8" transform="rotate(-12 256 264)"/>
	<rect x="120" y="128" width="272" height="272" rx="24" fill="#fbe7d3" transform="rotate(9 256 264)"/>
	<rect x="120" y="128" width="272" height="272" rx="24" fill="#ffffff"/>
	<clipPath id="pic"><rect x="144" y="152" width="224" height="184" rx="12"/></clipPath>
	<g clip-path="url(#pic)">
		<rect x="144" y="152" width="224" height="184" fill="#f6c27a"/>
		<circle cx="312" cy="200" r="26" fill="#fff4dc"/>
		<path d="M144 300 L212 238 L268 288 L304 258 L368 314 V336 H144 Z" fill="#3f7d5c"/>
		<path d="M144 336 V316 Q236 282 368 328 V336 Z" fill="#2f5e45"/>
	</g>
	<path d="M256 386 C232 370 226 358 234 350 C240 344 250 346 256 354 C262 346 272 344 278 350 C286 358 280 370 256 386 Z" fill="${BG}"/>`;

/**
 * @param {{ rounded: boolean, scale: number }} o
 *   rounded: rounded-square plate on transparency ("any" icons, favicon) vs. full-bleed square
 *   (apple-touch-icon and maskable, which the OS crops itself); scale: artwork size (maskable
 *   icons keep everything inside the central 80% safe zone).
 */
function svg({ rounded, scale }) {
	const plate = rounded
		? `<rect width="512" height="512" rx="112" fill="${BG}"/>`
		: `<rect width="512" height="512" fill="${BG}"/>`;
	const t = (512 * (1 - scale)) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${plate}<g transform="translate(${t} ${t + 8 * scale}) scale(${scale})">${ART}</g></svg>`;
}

const outputs = [
	{ file: 'icon-192.png', size: 192, rounded: true, scale: 1 },
	{ file: 'icon-512.png', size: 512, rounded: true, scale: 1 },
	{ file: 'icon-maskable-512.png', size: 512, rounded: false, scale: 0.78 },
	{ file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.92 }
];

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg({ rounded: true, scale: 1 }) + '\n');
for (const o of outputs) {
	const png = await sharp(Buffer.from(svg(o)), { density: 72 * (o.size / 512) * 2 })
		.resize(o.size, o.size)
		.flatten(o.rounded ? false : { background: BG })
		.png({ compressionLevel: 9, palette: true, quality: 90 })
		.toBuffer();
	fs.writeFileSync(path.join(OUT, o.file), png);
	console.log(`static/icons/${o.file} (${o.size}×${o.size}, ${png.length} bytes)`);
}
