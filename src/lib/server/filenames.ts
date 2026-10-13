/**
 * Friendly download names (docs/media-pipeline.md §7 "Filenames").
 *
 *   IMG_1234.HEIC → IMG_1234.jpg, IMG_5678.MOV → IMG_5678.mp4
 *   image.jpg, trim.4F2A….MOV, 6E1C…-UUID.jpeg → Photo_2024-07-04_11-22-31.jpg / Video_….mp4
 *
 * The stem comes from the uploaded name, the extension is always the canonical one, so a
 * download never says HEIC/MOV. Names are safe on Windows, macOS, iOS and Android.
 */
import type { CanonicalExt, Kind } from '#lib/shared/media-types';

export interface NameSource {
	source_name: string;
	canonical_ext: CanonicalExt | null;
	kind: Kind | null;
	taken_at: string | null;
	taken_ms: number | null;
	created_at: number;
}

const STEM_MAX_CHARS = 100;
/** Windows device names can't be used as file names, whatever the extension. */
const RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const UUID_START = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Names that phones and apps invent ("image", "tempImageXyz", "trim.ABC", a UUID…) and that
 * say nothing about the photo. They are replaced by a date-based name.
 */
export function isGenericStem(stem: string): boolean {
	const s = stem.trim();
	if (s === '' || /^[._\s-]+$/.test(s)) return true;
	if (/^(image|video|blob|upload|file)(?:[\s_-]?\(?\d{1,4}\)?)?$/i.test(s)) return true;
	if (/^tempimage/i.test(s) || /^trim\./i.test(s)) return true;
	return UUID_START.test(s);
}

/** NFC, no control or reserved characters, trimmed (incl. trailing dots), ≤ 100 characters. */
export function cleanStem(stem: string): string {
	let s = stem
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/[\\/:*?"<>|]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '');
	s = Array.from(s).slice(0, STEM_MAX_CHARS).join('');
	s = s.replace(/[\s.]+$/, '');
	return RESERVED_STEM.test(s) ? `_${s}` : s;
}

/** "IMG_1234.HEIC" → "IMG_1234" (any folder part dropped). */
export function stemOf(name: string): string {
	const base = name.replace(/^.*[\\/]/, '');
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(0, dot) : base;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD_HH-MM-SS" from taken_at's wall time, else taken_ms/created_at in the server's time zone. */
export function stampFor(item: Pick<NameSource, 'taken_at' | 'taken_ms' | 'created_at'>): string {
	const m = item.taken_at && /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(item.taken_at);
	if (m) return `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}-${m[6] ?? '00'}`;
	const d = new Date(item.taken_ms ?? item.created_at);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
		`${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
	);
}

/** The name a ready item downloads as, e.g. "IMG_1234.jpg" or "Video_2024-07-04_11-22-31.mp4". */
export function downloadName(item: NameSource): string {
	const ext = item.canonical_ext ?? (item.kind === 'video' ? 'mp4' : 'jpg');
	const stem = cleanStem(stemOf(item.source_name));
	if (stem === '' || isGenericStem(stem)) {
		const prefix = item.kind === 'video' || ext === 'mp4' ? 'Video' : 'Photo';
		return `${prefix}_${stampFor(item)}.${ext}`;
	}
	return `${stem}.${ext}`;
}

/**
 * Returns a function that hands out unique names: the second "IMG_1234.jpg" becomes
 * "IMG_1234 (2).jpg". Comparison ignores case (Windows and macOS file systems do).
 *
 * Each name remembers where its numbering got to, so thousands of files with the same name (a
 * whole album of "Scan.jpg") cost one step each, not a search from "(2)" every time. Names are
 * never given back, so every number below that point is still taken.
 */
export function createNameAllocator(reserved: readonly string[] = []): (name: string) => string {
	const taken = new Set(reserved.map((n) => n.toLowerCase()));
	/** Lower-cased name → the next " (n)" to try for it. */
	const nextNumber = new Map<string, number>();
	return (name) => {
		const key = name.toLowerCase();
		let candidate = name;
		if (taken.has(key)) {
			const dot = name.lastIndexOf('.');
			const stem = dot > 0 ? name.slice(0, dot) : name;
			const ext = dot > 0 ? name.slice(dot) : '';
			let n = nextNumber.get(key) ?? 2;
			for (; taken.has((candidate = `${stem} (${n})${ext}`).toLowerCase()); n++);
			nextNumber.set(key, n + 1);
		}
		taken.add(candidate.toLowerCase());
		return candidate;
	};
}

/** ASCII-only fallback for the plain `filename=` parameter (accents dropped, the rest → "_"). */
export function asciiFallback(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\x20-\x7e]/g, '_')
		.replace(/["\\]/g, '_');
}

/** RFC 5987 value-chars: encodeURIComponent minus the characters it leaves alone but attr-char forbids. */
function encodeRfc5987(name: string): string {
	return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `attachment; filename="IMG_1234.jpg"; filename*=UTF-8''IMG_1234.jpg` (RFC 6266 + RFC 5987). */
export function contentDisposition(type: 'attachment' | 'inline', name: string): string {
	return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
