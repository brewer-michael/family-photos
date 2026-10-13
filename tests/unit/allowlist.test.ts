import { describe, expect, it } from 'vitest';
import {
	ALLOWED_EXTS,
	BASE_ACCEPT,
	PHOTO_EXTS,
	VIDEO_EXTS,
	acceptFor,
	extensionOf,
	isAndroid,
	isAppleWebKit,
	isIOS,
	isObviouslyNotMedia,
	looksLikeVideo,
	withoutExtension
} from '#lib/media/allowlist';

const UA = {
	iPhoneSafari:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	iPhoneChrome:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
	iPhoneFirefox:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
	iPadDesktopMode:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
	macChrome:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	androidChrome:
		'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
	androidSamsung:
		'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
	windowsEdge:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
	windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
	linuxChromium: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/126.0.0.0 Chrome/126.0.0.0 Safari/537.36'
};

describe('accept attribute', () => {
	it('gives every Apple WebKit browser wildcards only (never HEIC)', () => {
		for (const ua of [UA.iPhoneSafari, UA.iPhoneChrome, UA.iPhoneFirefox, UA.iPadDesktopMode]) {
			expect(isAppleWebKit(ua), ua).toBe(true);
			expect(acceptFor(ua), ua).toBe('image/*,video/*');
			expect(acceptFor(ua).toLowerCase(), ua).not.toContain('heic');
		}
	});

	it('gives Android wildcards only, so the Photo Picker stays', () => {
		for (const ua of [UA.androidChrome, UA.androidSamsung]) {
			expect(isAndroid(ua)).toBe(true);
			expect(isAppleWebKit(ua)).toBe(false);
			expect(acceptFor(ua)).toBe(BASE_ACCEPT);
		}
	});

	it('lists every allowed extension on desktops', () => {
		for (const ua of [UA.macChrome, UA.windowsEdge, UA.windowsFirefox, UA.linuxChromium]) {
			expect(isAppleWebKit(ua), ua).toBe(false);
			const accept = acceptFor(ua);
			expect(accept.startsWith('image/*,video/*,'), ua).toBe(true);
			const listed = accept.split(',').slice(2);
			expect(listed).toEqual(ALLOWED_EXTS.map((e) => `.${e}`));
			for (const e of ['.heic', '.jpg', '.png', '.mov', '.mp4', '.dng', '.avif', '.webp']) expect(listed, ua).toContain(e);
			expect(accept).not.toMatch(/capture/);
		}
	});

	it('detects iOS, including iPadOS posing as a Mac with touch', () => {
		expect(isIOS(UA.iPhoneSafari)).toBe(true);
		expect(isIOS(UA.iPadDesktopMode, 5)).toBe(true);
		expect(isIOS(UA.iPadDesktopMode, 0)).toBe(false);
		expect(isIOS(UA.androidChrome, 5)).toBe(false);
		expect(isIOS(UA.macChrome, 0)).toBe(false);
	});
});

describe('allowlist', () => {
	it('is lower-case, unique and never lists SVG, PDF or documents', () => {
		expect(new Set(ALLOWED_EXTS).size).toBe(ALLOWED_EXTS.length);
		for (const e of ALLOWED_EXTS) expect(e).toMatch(/^[a-z0-9]+$/);
		for (const bad of ['svg', 'svgz', 'pdf', 'docx', 'zip', 'mp3']) expect(ALLOWED_EXTS).not.toContain(bad);
		expect(PHOTO_EXTS.filter((e) => VIDEO_EXTS.includes(e))).toEqual([]);
	});

	it('extensionOf takes the last extension, lower-cased', () => {
		expect(extensionOf('IMG_1234.HEIC')).toBe('heic');
		expect(extensionOf('archive.tar.gz')).toBe('gz');
		expect(extensionOf('no-extension')).toBe('');
		expect(extensionOf('.hidden')).toBe('hidden');
		expect(extensionOf('dir.d/file')).toBe('');
	});
});

describe('withoutExtension', () => {
	it('drops the last extension and any folder, like the album page does', () => {
		expect(withoutExtension('IMG_1234.HEIC')).toBe('IMG_1234');
		expect(withoutExtension('beach.day.MOV')).toBe('beach.day');
		expect(withoutExtension('photos/2024/IMG_1.jpg')).toBe('IMG_1');
		expect(withoutExtension('C:\\Users\\Rose\\Lake.png')).toBe('Lake');
		expect(withoutExtension('no extension')).toBe('no extension');
		expect(withoutExtension('.hidden')).toBe('.hidden');
		expect(withoutExtension('')).toBe('');
	});
});

describe('isObviouslyNotMedia', () => {
	const f = (name: string, type = '', size = 1000) => ({ name, type, size });

	it('skips documents, archives, audio and SVG', () => {
		for (const file of [
			f('Tax return.pdf', 'application/pdf'),
			f('letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
			f('photos.zip', 'application/zip'),
			f('notes.txt', 'text/plain'),
			f('voice memo.m4a', 'audio/x-m4a'),
			f('logo.svg', 'image/svg+xml'),
			f('statement', 'application/pdf'),
			f('report.pdf', '')
		]) {
			expect(isObviouslyNotMedia(file), file.name).toBe(true);
		}
	});

	it('skips empty files', () => {
		expect(isObviouslyNotMedia(f('IMG_0001.JPG', 'image/jpeg', 0))).toBe(true);
	});

	it('never skips anything that might be a photo or video', () => {
		for (const file of [
			f('IMG_0001.HEIC', ''),
			f('IMG_0001.HEIC', 'image/heic'),
			f('IMG_0002.JPG', 'image/jpeg'),
			f('clip.MOV', 'video/quicktime'),
			f('clip.3gp', 'audio/3gpp'), // some browsers label 3GP videos as audio
			f('scan.tif', 'image/tiff'),
			f('RAW_0001.DNG', 'image/x-adobe-dng'),
			f('image', ''), // no name, no type: the server decides
			f('mystery.xyz', 'application/octet-stream'),
			f('screenshot.png.pdf.jpg', 'image/jpeg')
		]) {
			expect(isObviouslyNotMedia(file), `${file.name} ${file.type}`).toBe(false);
		}
	});

	it('guesses videos for the tile icon', () => {
		expect(looksLikeVideo(f('a.MOV'))).toBe(true);
		expect(looksLikeVideo(f('a', 'video/mp4'))).toBe(true);
		expect(looksLikeVideo(f('a.HEIC', 'image/heic'))).toBe(false);
	});
});
