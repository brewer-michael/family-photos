/**
 * What the media pipeline accepts, as file extensions, and the file-picker `accept` attribute
 * built from it (docs/media-pipeline.md §6 "File input"). Shared by the server and the browser:
 * keep it free of Node-only imports.
 *
 * The server always decides from the file's bytes; this list only stops the desktop file dialog
 * from hiding a format we can handle. Phones get wildcards only:
 *   - Apple browsers must never see HEIC listed: Safari 17+ then re-encodes picked JPEGs to HEIC.
 *   - Android drops out of the Photo Picker when anything but wildcards is listed.
 * SVG is deliberately absent (rejected as "not a photo or video").
 */

/** JPEG, HEIF/AVIF, PNG/APNG, GIF, WebP, TIFF, BMP, JPEG XL, JPEG 2000, PSD and camera RAW. */
export const PHOTO_EXTS: readonly string[] = [
	'jpg', 'jpeg', 'jpe', 'jfif',
	'heic', 'heif', 'hif', 'avif',
	'png', 'apng', 'gif', 'webp',
	'tif', 'tiff', 'bmp', 'jxl',
	'jp2', 'j2k', 'jpf', 'jpx', 'psd',
	'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2'
];

/** Containers ffmpeg reads for the codecs in the format rules (H.264/HEVC/VP9/AV1/ProRes/MPEG/DV/MJPEG/WMV). */
export const VIDEO_EXTS: readonly string[] = [
	'mov', 'mp4', 'm4v', '3gp', '3g2',
	'mkv', 'webm', 'avi', 'wmv', 'asf',
	'mpg', 'mpeg', 'mts', 'm2ts', 'ts', 'vob', 'dv'
];

export const ALLOWED_EXTS: readonly string[] = [...PHOTO_EXTS, ...VIDEO_EXTS];

const ALLOWED = new Set(ALLOWED_EXTS);
const VIDEO = new Set(VIDEO_EXTS);

/** Wildcards: what Apple browsers and Android get. */
export const BASE_ACCEPT = 'image/*,video/*';

/** Every iOS browser (all WebKit) and macOS Safari; not Chrome/Edge on a Mac, not Android. */
export function isAppleWebKit(userAgent: string): boolean {
	return /AppleWebKit/.test(userAgent) && !/Chrome\/|Chromium\/|Android/.test(userAgent);
}

export function isAndroid(userAgent: string): boolean {
	return /Android/.test(userAgent);
}

/** iPhone/iPod/iPad, including iPadOS, which reports itself as a Mac with a touch screen. */
export function isIOS(userAgent: string, maxTouchPoints = 0): boolean {
	return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** The `accept` attribute for this browser. Never pair it with `capture`. */
export function acceptFor(userAgent: string): string {
	if (isAppleWebKit(userAgent) || isAndroid(userAgent)) return BASE_ACCEPT;
	return `${BASE_ACCEPT},${ALLOWED_EXTS.map((e) => `.${e}`).join(',')}`;
}

/** Lower-case extension without the dot ('' when there is none). */
export function extensionOf(name: string): string {
	const m = /\.([^./\\]+)$/.exec(name);
	return m ? m[1].toLowerCase() : '';
}

/** "IMG_1234.HEIC" → "IMG_1234", the way tiles name a file (any folder part dropped; ".hidden" stays). */
export function withoutExtension(name: string): string {
	const base = name.replace(/^.*[\\/]/, '');
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(0, dot) : base;
}

/** Documents, archives, audio, apps and SVG: things nobody means to add as a photo or video. */
const NOT_MEDIA_EXTS = new Set([
	'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv',
	'pages', 'numbers', 'key', 'html', 'htm', 'json', 'xml', 'eml', 'msg', 'ics', 'vcf', 'epub',
	'zip', 'rar', '7z', 'gz', 'tar', 'dmg', 'exe', 'msi', 'apk', 'ipa',
	'mp3', 'wav', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aif', 'aiff',
	'svg', 'svgz'
]);
const NOT_MEDIA_TYPE =
	/^(text\/|audio\/|image\/svg|application\/(pdf|zip|x-zip|x-rar|x-7z|gzip|x-tar|msword|rtf|json|xml|epub|x-msdownload|vnd\.ms-|vnd\.openxmlformats|vnd\.oasis|vnd\.apple|vnd\.android))/;

/**
 * True for files the uploader skips with "That one isn't a photo or video." Deliberately narrow:
 * anything that might be media (an allowed extension, any image/* or video/* type, or simply
 * unknown) is sent, and the server decides from its bytes. Empty files are skipped too.
 */
export function isObviouslyNotMedia(file: { name: string; type: string; size: number }): boolean {
	if (file.size === 0) return true;
	const ext = extensionOf(file.name);
	if (ALLOWED.has(ext)) return false;
	const type = file.type.toLowerCase();
	if ((type.startsWith('image/') && !type.startsWith('image/svg')) || type.startsWith('video/')) return false;
	return NOT_MEDIA_EXTS.has(ext) || NOT_MEDIA_TYPE.test(type);
}

/** Best guess for the tile icon before the server has looked at the bytes. */
export function looksLikeVideo(file: { name: string; type: string }): boolean {
	return file.type.toLowerCase().startsWith('video/') || VIDEO.has(extensionOf(file.name));
}
