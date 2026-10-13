/**
 * The whole family journey on a phone, through the real pipeline (no seeding): the real tus
 * upload, intake, and both worker lanes (heif-dec/heif-convert, sharp, ffmpeg, exiftool).
 *
 *   family code → name → new album "Lake Retreat 2023" → the Uploader sends
 *     - a JPEG with EXIF Orientation 6,
 *     - an iPhone HEIC (vendored fixture),
 *     - a 2 s HEVC .MOV, 10-bit HLG with a −90° rotation, made here with the local ffmpeg
 *   → all three ready → the album shows 3 → the HEIC's viewer: display image, "Save to my phone"
 *   gives a .jpg (JPEG bytes) → the video is an MP4 with byte ranges → a memory → Ask to remove →
 *   the admin (own browser) sees the request, removes it (the family gets 404), restores it from the
 *   trash (visible again) → the removal email in the outbox links to the item.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import { adminLogin, e2eDir, login } from './helpers';
import { readRows } from './seed';

const ALBUM = 'Lake Retreat 2023';
const FAMILY = 'Aunt Linda';
const NAMES = { jpeg: 'IMG_0601.JPG', heic: 'IMG_4021.HEIC', video: 'IMG_4022.MOV' } as const;

const fixture = (...p: string[]) => path.join(fileURLToPath(new URL('../fixtures/', import.meta.url)), ...p);
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
/** ISO BMFF: the first box is `ftyp`; returns its major brand. */
const ftypBrand = (b: Buffer) => (b.subarray(4, 8).toString('latin1') === 'ftyp' ? b.subarray(8, 12).toString('latin1') : null);

function hasEncoder(name: string): boolean {
	try {
		return new RegExp(`^ V\\S* ${name}\\s`, 'm').test(execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }));
	} catch {
		return false;
	}
}

/**
 * An iPhone-like clip: 2 s of 640×360 HEVC Main 10, tagged HLG (BT.2020), stereo AAC, in a .mov
 * with a −90° display matrix (shot in portrait) and Apple's creation date key.
 */
function makeHlgMov(dir: string): Buffer {
	const tmp = path.join(dir, 'hlg-src.mov');
	const out = path.join(dir, NAMES.video);
	const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
	ff([
		'-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2',
		'-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000',
		'-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc',
		'-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
		'-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
		'-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000', '-shortest', tmp
	]);
	ff([
		'-display_rotation:v:0', '-90', '-i', tmp, '-map', '0', '-c', 'copy',
		'-metadata', 'com.apple.quicktime.creationdate=2023-07-15T10:20:30-0700',
		'-metadata', 'com.apple.quicktime.make=Apple',
		'-movflags', 'use_metadata_tags', out
	]);
	return fs.readFileSync(out);
}

interface Row {
	id: string;
	source_name: string;
	status: string;
	kind: string | null;
	conversion: string | null;
	canonical_ext: string | null;
	width: number | null;
	height: number | null;
	hdr_tonemapped: number;
	source_kept: number;
	error_detail: string | null;
}

const rowsOf = (albumId: number) =>
	readRows<Row>(
		`SELECT id, source_name, status, kind, conversion, canonical_ext, width, height, hdr_tonemapped, source_kept, error_detail
		 FROM media WHERE album_id = ? ORDER BY source_name`,
		albumId
	);

async function displayLoaded(page: Page): Promise<number> {
	const img = page.locator('figure.stage img.media');
	await expect(img).toHaveAttribute('src', /\/media\/[0-9A-Z]{26}\/display\?v=\d+/);
	await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 15_000 }).toBeGreaterThan(0);
	return img.evaluate((el: HTMLImageElement) => el.naturalWidth);
}

test('a family member shares a lake weekend from their phone, and the admin handles a removal request', async ({ page, browser, baseURL }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'the journey runs once, on the phone');
	test.skip(!hasEncoder('libx265'), "the local ffmpeg can't encode HEVC (libx265), so the iPhone clip can't be made");
	test.setTimeout(240_000);
	const started = Date.now();

	const workDir = testInfo.outputPath('journey');
	fs.mkdirSync(workDir, { recursive: true });
	const files = [
		{ name: NAMES.jpeg, mimeType: 'image/jpeg', buffer: fs.readFileSync(fixture('photo', 'o6.jpg')) },
		{ name: NAMES.heic, mimeType: 'image/heic', buffer: fs.readFileSync(fixture('heif', 'heic-iphone7.heic')) },
		{ name: NAMES.video, mimeType: 'video/quicktime', buffer: makeHlgMov(workDir) }
	];

	// --- Family code → name → home -----------------------------------------------------------
	await page.setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.90' });
	await login(page, FAMILY);

	// --- New album ---------------------------------------------------------------------------
	await page.getByRole('link', { name: 'New album' }).click();
	await expect(page).toHaveURL(/\/album\/new$/);
	await page.getByLabel('Album name').fill(ALBUM);
	await page.getByRole('button', { name: 'Create album' }).click();
	await expect(page).toHaveURL(/\/album\/\d+\?add$/);
	const albumId = Number(/\/album\/(\d+)/.exec(page.url())![1]);
	await expect(page.getByRole('heading', { level: 1, name: ALBUM })).toBeVisible();

	// --- Upload through the Uploader ---------------------------------------------------------
	const uploader = page.locator('.uploader');
	const chooser = page.waitForEvent('filechooser');
	await uploader.getByRole('button', { name: 'Choose photos & videos' }).click();
	await (await chooser).setFiles(files);
	await expect(uploader.getByRole('list', { name: 'Your photos and videos' }).getByRole('listitem')).toHaveCount(3);

	// The album page hands finished uploads over to its grid: the tiles collapse to one summary.
	const summary = uploader.locator('.summary');
	await expect(summary, `uploads did not finish: ${JSON.stringify(rowsOf(albumId))}`).toBeVisible({ timeout: 150_000 });
	await expect(summary, JSON.stringify(rowsOf(albumId))).toHaveText('Done! 3 added.');

	const rows = rowsOf(albumId);
	const by = (name: string) => rows.find((r) => r.source_name === name)!;
	expect(rows.map((r) => [r.source_name, r.status])).toEqual([
		[NAMES.jpeg, 'ready'],
		[NAMES.heic, 'ready'],
		[NAMES.video, 'ready']
	]);
	const jpeg = by(NAMES.jpeg);
	const heic = by(NAMES.heic);
	const video = by(NAMES.video);
	// JPEG: original bytes; Orientation 6 makes the 256×192 pixels a 192×256 portrait.
	expect(jpeg).toMatchObject({ kind: 'photo', conversion: 'none', canonical_ext: 'jpg', width: 192, height: 256 });
	// HEIC → JPEG, the source archived for the admin only.
	expect(heic).toMatchObject({ kind: 'photo', conversion: 'transcode', canonical_ext: 'jpg', width: 4032, height: 3024, source_kept: 1 });
	// HLG HEVC → SDR H.264 MP4, rotated upright (640×360 shot in portrait → 360×640).
	expect(video).toMatchObject({ kind: 'video', conversion: 'transcode', canonical_ext: 'mp4', width: 360, height: 640, hdr_tonemapped: 1, source_kept: 1 });

	// --- The album shows all three -----------------------------------------------------------
	const grid = page.locator('a[href^="/view/"]');
	await expect(grid).toHaveCount(3);
	for (const r of rows) await expect(page.locator(`a[href="/view/${r.id}"]`)).toBeVisible();
	// The JPEG's preview is upright (Orientation applied exactly once).
	const jpegDisplay = await sharp(await (await page.request.get(`/media/${jpeg.id}/display`)).body()).metadata();
	expect([jpegDisplay.width, jpegDisplay.height, jpegDisplay.orientation ?? 1]).toEqual([192, 256, 1]);

	// --- Open the HEIC one ---------------------------------------------------------------------
	await page.locator(`a[href="/view/${heic.id}"]`).click();
	await expect(page).toHaveURL(new RegExp(`/view/${heic.id}$`));
	expect(await displayLoaded(page)).toBeGreaterThan(0);

	// "Save to my phone": the full-quality JPEG, never the HEIC (nor the WebP preview).
	const bar = page.getByRole('group', { name: 'What would you like to do?' });
	const saveLink = bar.getByRole('link', { name: 'Save to my phone' });
	if (await saveLink.isVisible()) {
		await expect(saveLink).toHaveAttribute('href', new RegExp(`^/media/${heic.id}/file\\?v=\\d+&dl=1$`));
		await expect(saveLink).toHaveAttribute('download', 'IMG_4021.jpg');
		const download = page.waitForEvent('download');
		await saveLink.click();
		const saved = await download;
		expect(saved.suggestedFilename()).toBe('IMG_4021.jpg');
		expect(isJpeg(fs.readFileSync((await saved.path())!))).toBe(true);
	} else {
		// A browser that shares files (iOS Safari) fetches the same canonical file into the share sheet.
		await expect(bar.getByRole('button', { name: /Save to my phone|Tap to save/ })).toBeVisible();
	}
	const dl = await page.request.get(`/media/${heic.id}/file?dl=1`);
	expect(dl.status()).toBe(200);
	expect(dl.headers()['content-type']).toBe('image/jpeg');
	expect(dl.headers()['content-disposition']).toMatch(/^attachment; filename="IMG_4021\.jpg"; filename\*=UTF-8''IMG_4021\.jpg$/);
	expect(isJpeg(await dl.body())).toBe(true);
	// The previews are WebP; the archived HEIC is the admin's alone.
	for (const variant of ['display', 'thumb']) {
		const res = await page.request.get(`/media/${heic.id}/${variant}`);
		expect(res.headers()['content-type'], variant).toBe('image/webp');
	}
	expect((await page.request.get(`/admin/original/${heic.id}`, { maxRedirects: 0 })).status()).toBe(303);

	// --- The video is an MP4 that plays in ranges ---------------------------------------------
	const mp4 = await page.request.get(`/media/${video.id}/file`);
	expect(mp4.status()).toBe(200);
	expect(mp4.headers()['content-type']).toBe('video/mp4');
	const mp4Bytes = await mp4.body();
	expect(['isom', 'mp42', 'mp41', 'iso2', 'avc1']).toContain(ftypBrand(mp4Bytes));
	expect(mp4.headers()['content-disposition']).toMatch(/filename="IMG_4022\.mp4"/);
	// H.264 SDR, upright: nothing HEVC, HDR or rotated reaches the family.
	const mp4File = path.join(workDir, 'served.mp4');
	fs.writeFileSync(mp4File, mp4Bytes);
	const probe = JSON.parse(
		execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', mp4File], { encoding: 'utf8' })
	) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; color_transfer?: string; side_data_list?: unknown[] }[] };
	const [v, ...more] = probe.streams.filter((st) => st.codec_type === 'video');
	expect(more).toEqual([]);
	expect(v).toMatchObject({ codec_name: 'h264', width: 360, height: 640, color_transfer: 'bt709' });
	expect(v.side_data_list ?? []).toEqual([]);
	expect(probe.streams.filter((st) => st.codec_type === 'audio').map((st) => st.codec_name)).toEqual(['aac']);
	const part = await page.request.get(`/media/${video.id}/file`, { headers: { range: 'bytes=100-1123' } });
	expect(part.status()).toBe(206);
	expect(part.headers()['content-range']).toBe(`bytes 100-1123/${mp4Bytes.length}`);
	expect((await part.body()).equals(mp4Bytes.subarray(100, 1124))).toBe(true);

	// --- A memory ------------------------------------------------------------------------------
	const memory = 'We swam out to the little island and Grandpa timed us.';
	await page.getByLabel('Write a memory').fill(memory);
	await page.getByRole('button', { name: 'Save memory' }).click();
	await expect(page.getByText('Thank you — your memory is saved.')).toBeVisible();
	const memories = page.locator('section.memories ol');
	await expect(memories.getByRole('listitem').filter({ hasText: memory })).toContainText(`— ${FAMILY}`);

	// --- Ask to remove -------------------------------------------------------------------------
	await bar.getByRole('button', { name: 'Ask to remove' }).click();
	const ask = page.getByRole('dialog', { name: 'Ask to remove this photo' });
	await ask.getByRole('radio', { name: "I'm in it and don't want it shared" }).check();
	await ask.getByLabel(/^Tell Michael more/).fill('My eyes are closed in this one.');
	await ask.getByRole('button', { name: 'Send request' }).click();
	const thanks = page.getByRole('dialog', { name: 'Thank you' });
	await expect(thanks).toBeVisible();
	await expect(thanks.getByRole('status')).toHaveText("We've passed your request on. Nothing is deleted yet — Michael will look at it.");
	await thanks.getByRole('button', { name: 'OK' }).click();
	const [{ id: requestId }] = readRows<{ id: number }>('SELECT id FROM deletion_requests WHERE media_id = ?', heic.id);

	// --- The admin, on their own browser -------------------------------------------------------
	const adminContext = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-real-ip': '198.51.100.91' } });
	try {
		const admin = await adminContext.newPage();
		await login(admin, 'Michael');
		await adminLogin(admin);
		const request = admin.locator('#requests').getByRole('listitem').filter({ has: admin.locator(`a[href="/admin/requests/${requestId}"]`) });
		await expect(request).toContainText(`${FAMILY} asked to remove a photo from “${ALBUM}”`);
		await expect(request).toContainText("Why: I'm in it and don't want it shared");
		await expect(request).toContainText('“My eyes are closed in this one.”');
		await request.getByRole('link', { name: /^Review/ }).click();
		await expect(admin).toHaveURL(new RegExp(`/admin/requests/${requestId}$`));
		await admin.getByRole('button', { name: 'Remove it' }).click();
		await expect(admin.getByRole('status')).toContainText('Removed. It stays in the trash for 30 days');

		// Gone for the family: the page, its files, and the album grid.
		expect((await page.goto(`/view/${heic.id}`))?.status()).toBe(404);
		for (const variant of ['file', 'display', 'thumb']) {
			expect((await page.request.get(`/media/${heic.id}/${variant}`)).status(), variant).toBe(404);
		}
		await page.goto(`/album/${albumId}`);
		await expect(grid).toHaveCount(2);

		// Trash → Restore → back for everyone.
		await admin.goto('/admin/trash');
		const trashed = admin.getByRole('listitem').filter({ hasText: NAMES.heic });
		await expect(trashed).toContainText("Aunt Linda asked: I'm in it and don't want it shared");
		await trashed.getByRole('button', { name: /^Restore/ }).click();
		await expect(admin.getByRole('status')).toContainText(`${NAMES.heic} is back in its album.`);
	} finally {
		await adminContext.close();
	}
	expect((await page.goto(`/view/${heic.id}`))?.status()).toBe(200);
	expect(await displayLoaded(page)).toBeGreaterThan(0);
	await expect(page.locator('section.memories')).toContainText(memory);
	await page.goto(`/album/${albumId}`);
	await expect(grid).toHaveCount(3);

	// --- The removal email (outbox mode) links to the item ------------------------------------
	const outbox = path.join(e2eDir(), 'config', 'outbox');
	const viewLink = `${baseURL}/view/${heic.id}`;
	const findMail = async () => {
		if (!fs.existsSync(outbox)) return null;
		for (const f of fs.readdirSync(outbox).filter((n) => n.endsWith('.eml'))) {
			const mail = await simpleParser(fs.readFileSync(path.join(outbox, f)), { skipImageLinks: true });
			if (mail.text?.includes(viewLink)) return mail;
		}
		return null;
	};
	await expect.poll(async () => (await findMail())?.subject ?? null, { timeout: 20_000 }).toBe(
		`Removal request: photo in "${ALBUM}" from ${FAMILY}`
	);
	const mail = (await findMail())!;
	expect(mail.text).toContain(`${baseURL}/admin/requests/${requestId}`);
	expect(mail.html || '').toContain(viewLink);
	expect(mail.attachments.map((a) => a.contentType)).toEqual(['image/jpeg']);

	testInfo.annotations.push({ type: 'duration', description: `${Math.round((Date.now() - started) / 1000)} s` });
});
