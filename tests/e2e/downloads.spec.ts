import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { e2eDir, login } from './helpers';
import { seedAlbum, seedMedia } from './seed';

test.describe('downloads', () => {
	test('files download under friendly names, never as HEIC', async ({ page }) => {
		const album = seedAlbum('Names');
		const heic = await seedMedia(album, { name: 'IMG_1234.HEIC', takenAt: '2024-07-04T11:22:31-07:00' });
		const generic = await seedMedia(album, { name: 'image.jpg', takenAt: '2024-07-04T11:22:31-07:00' });
		await login(page, 'Grandma Jo');

		const res = await page.request.get(`/media/${heic}/file?dl=1`);
		expect(res.status()).toBe(200);
		const headers = res.headers();
		expect(headers['content-type']).toBe('image/jpeg');
		expect(headers['content-disposition']).toBe(`attachment; filename="IMG_1234.jpg"; filename*=UTF-8''IMG_1234.jpg`);
		expect(JSON.stringify(headers)).not.toMatch(/heic/i);
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['cache-control']).toBe('private, max-age=31536000, immutable');
		expect(headers['etag']).toBe(`"${heic}-1-file"`);
		expect(headers['last-modified']).toBe('Thu, 04 Jul 2024 11:22:31 GMT');

		const inline = await page.request.get(`/media/${generic}/file`);
		expect(inline.headers()['content-disposition']).toBe(
			`inline; filename="Photo_2024-07-04_11-22-31.jpg"; filename*=UTF-8''Photo_2024-07-04_11-22-31.jpg`
		);

		// "Save to my phone" on a computer/Android is a plain download of the full file.
		await page.goto(`/view/${heic}`);
		const save = page.getByRole('group', { name: 'What would you like to do?' }).getByRole('link', { name: 'Save to my phone' });
		test.skip(!(await save.isVisible()), 'this device shares files instead of downloading them');
		const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
		expect(download.suggestedFilename()).toBe('IMG_1234.jpg');
	});

	test('byte ranges, revalidation and access rules', async ({ page, request }) => {
		const album = seedAlbum('Ranges');
		const id = await seedMedia(album, { name: 'IMG_0100.MOV', kind: 'video', takenAt: '2024-07-04T12:00:00-07:00' });
		const trashed = await seedMedia(album, { name: 'IMG_0101.HEIC', takenAt: '2024-07-04T12:00:00', deletedAt: Date.now() });
		const processing = await seedMedia(album, { name: 'IMG_0102.MOV', kind: 'video', status: 'processing', takenAt: '2024-07-04T12:00:00' });

		// Not signed in: nothing.
		expect((await request.get(`/media/${id}/file`)).status()).toBe(401);

		await login(page, 'Grandma Jo');
		const full = await page.request.get(`/media/${id}/file`);
		const size = Number(full.headers()['content-length']);
		expect(full.headers()['accept-ranges']).toBe('bytes');
		expect(full.headers()['content-type']).toBe('video/mp4');
		const body = await full.body();
		expect(body.length).toBe(size);

		const part = await page.request.get(`/media/${id}/file`, { headers: { range: 'bytes=0-99' } });
		expect(part.status()).toBe(206);
		expect(part.headers()['content-range']).toBe(`bytes 0-99/${size}`);
		expect((await part.body()).equals(body.subarray(0, 100))).toBe(true);

		const tail = await page.request.get(`/media/${id}/file`, { headers: { range: 'bytes=-10' } });
		expect(tail.status()).toBe(206);
		expect((await tail.body()).equals(body.subarray(size - 10))).toBe(true);

		expect((await page.request.get(`/media/${id}/file`, { headers: { range: `bytes=${size}-` } })).status()).toBe(416);
		const stale = await page.request.get(`/media/${id}/file`, { headers: { range: 'bytes=0-9', 'if-range': '"old"' } });
		expect(stale.status()).toBe(200);
		const head = await page.request.head(`/media/${id}/file`, { headers: { range: 'bytes=0-9' } });
		expect(head.status()).toBe(206);
		expect(head.headers()['content-length']).toBe('10');

		const etag = full.headers()['etag'];
		expect((await page.request.get(`/media/${id}/file`, { headers: { 'if-none-match': etag } })).status()).toBe(304);

		// Derivatives: the poster exists while a video is still processing; the file doesn't.
		expect((await page.request.get(`/media/${processing}/poster`)).status()).toBe(200);
		expect((await page.request.get(`/media/${processing}/file`)).status()).toBe(404);
		expect((await page.request.get(`/media/${id}/thumb`)).headers()['content-type']).toBe('image/webp');
		// Trashed: hidden from the family. Junk ids and variants: 404.
		expect((await page.request.get(`/media/${trashed}/thumb`)).status()).toBe(404);
		expect((await page.request.get(`/media/${id}/original`)).status()).toBe(404);
		expect((await page.request.get('/media/..%2F..%2Fetc/file')).status()).toBe(404);
	});

	test('a photo whose previews went missing still opens: its file stands in for display, uncached', async ({ page }) => {
		const album = seedAlbum('Lost previews');
		const id = await seedMedia(album, { name: 'IMG_2001.HEIC', takenAt: '2024-07-04T11:22:31-07:00' });
		const cached = (variant: string) => path.join(e2eDir(), 'config', 'cache', id.slice(-2), id, `${variant}.webp`);
		fs.rmSync(cached('display'));
		fs.rmSync(cached('thumb'));
		await login(page, 'Grandma Jo');

		const display = await page.request.get(`/media/${id}/display`);
		expect(display.status()).toBe(200);
		expect(display.headers()['content-type']).toBe('image/jpeg');
		expect(display.headers()['cache-control']).toBe('private, no-cache');
		expect((await display.body()).equals(await (await page.request.get(`/media/${id}/file`)).body())).toBe(true);
		// A grid tile never gets the full file.
		expect((await page.request.get(`/media/${id}/thumb`)).status()).toBe(404);
	});

	test('"Download all" is a ZIP with friendly names and memories.txt, without hidden Live Photo videos', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'phones get "Save all" instead of the ZIP');
		const album = seedAlbum(`Retreat ${testInfo.project.name}`);
		const photo = await seedMedia(album, { name: 'IMG_0001.HEIC', takenAt: '2023-07-01T10:00:00-07:00' });
		await seedMedia(album, { name: 'IMG_0001.MOV', kind: 'video', takenAt: '2023-07-01T10:00:00-07:00', livePhotoOf: photo });
		await seedMedia(album, { name: 'img_0001.jpg', takenAt: '2023-07-02T10:00:00-07:00' });
		await seedMedia(album, { name: 'trim.ABCD.MOV', kind: 'video', takenAt: '2023-07-03T09:08:07' });

		await login(page, 'Grandma Jo');
		await page.goto(`/view/${photo}`);
		await page.getByLabel('Write a memory').fill('Everyone squinting into the sun.');
		await page.getByRole('button', { name: 'Save memory' }).click();
		await expect(page.getByText('Everyone squinting into the sun.')).toBeVisible();

		await page.goto(`/album/${album}`);
		const zipLink = page.getByRole('link', { name: 'Download all (for computers)' });
		const [download] = await Promise.all([page.waitForEvent('download'), zipLink.click()]);
		expect(download.suggestedFilename()).toBe(`Retreat ${testInfo.project.name}.zip`);
		const file = path.join(testInfo.outputDir, 'album.zip');
		await download.saveAs(file);
		const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
		expect(names).toEqual(['IMG_0001.jpg', 'img_0001 (2).jpg', 'Video_2023-07-03_09-08-07.mp4', 'memories.txt']);
		expect(execFileSync('unzip', ['-l', file], { encoding: 'utf8' })).not.toMatch(/\.mov|\.heic/i);
		const memories = execFileSync('unzip', ['-p', file, 'memories.txt'], { encoding: 'utf8' });
		expect(memories).toContain(`Retreat ${testInfo.project.name}`);
		expect(memories).toContain('IMG_0001.jpg (taken 2023-07-01)');
		expect(memories).toContain('Everyone squinting into the sun.');
		fs.rmSync(file);
	});

	test('"Save all" on a phone downloads every file', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'computers get the ZIP');
		const album = seedAlbum('Save all');
		await seedMedia(album, { name: 'IMG_0001.HEIC', takenAt: '2023-07-01T10:00:00' });
		await seedMedia(album, { name: 'IMG_0002.HEIC', takenAt: '2023-07-02T10:00:00' });
		await login(page, 'Grandma Jo');
		await page.goto(`/album/${album}`);
		await expect(page.getByRole('link', { name: 'Download all (for computers)' })).toHaveCount(0);

		const names: string[] = [];
		page.on('download', (d) => names.push(d.suggestedFilename()));
		await page.getByRole('button', { name: 'Save all to my phone' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'All 2 are in your Downloads.' })).toBeVisible();
		await expect.poll(() => names.sort()).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg']);
	});

	test('"Save all" on a phone stops when you leave the album', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'computers get the ZIP');
		const album = seedAlbum('Leave half-way');
		for (let i = 1; i <= 8; i++) await seedMedia(album, { name: `IMG_000${i}.HEIC`, takenAt: `2023-07-0${i}T10:00:00` });
		await login(page, 'Grandma Jo');
		await page.goto(`/album/${album}`);

		let count = 0;
		page.on('download', () => (count += 1));
		await page.getByRole('button', { name: 'Save all to my phone' }).click();
		await expect.poll(() => count).toBeGreaterThan(0);
		await page.getByRole('link', { name: 'All albums' }).click();
		await expect(page).toHaveURL(/\/$/);
		const atLeave = count;
		await page.waitForTimeout(2500); // five more would have started by now
		expect(count).toBeLessThanOrEqual(atLeave + 1);
		expect(count).toBeLessThan(8);
	});
});
