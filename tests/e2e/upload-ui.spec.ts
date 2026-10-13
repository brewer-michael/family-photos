/**
 * The Uploader in a real browser: the picker's accept attribute per platform, instant tiles,
 * "Sending 1 of 1…", skipping non-media, a small JPEG going all the way to a finished tile, and a
 * connection that drops mid-upload (no "Done!" until everything is sent; it carries on by itself).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import sharp from 'sharp';
import { login } from './helpers';
import { readRows, seedAlbum } from './seed';

type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];

/** What a tile may end on: added; or, while the photo lane is unavailable, a failure the admin hears about. */
const FINISHED = /✓ Added|We couldn't add this one\. Michael has been told\.|This one didn't work\./;

async function jpeg(background = '#3b7dc9'): Promise<Buffer> {
	return sharp({ create: { width: 320, height: 240, channels: 3, background } })
		.jpeg({ quality: 85 })
		.toBuffer();
}

async function pick(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: /Choose photos & videos|Add more photos & videos/ }).click();
	await (await chooser).setFiles(files);
}

test('a photo goes from the picker to a finished tile', async ({ page, isMobile }, testInfo) => {
	test.setTimeout(60_000);
	await page.setExtraHTTPHeaders({ 'x-real-ip': testInfo.project.name === 'mobile' ? '198.51.100.71' : '198.51.100.72' });
	await login(page, 'Grandma Rose');
	const album = seedAlbum(`Uploads ${testInfo.project.name}`);
	await page.goto(`/add?album=${album}`);

	const input = page.locator('input[type=file]');
	await expect(input).toHaveAttribute('multiple', '');
	await expect(input).not.toHaveAttribute('capture');
	if (isMobile) {
		// iPhone user agent: wildcards only, never HEIC (Safari would re-encode picked JPEGs).
		await expect(input).toHaveAttribute('accept', 'image/*,video/*');
	} else {
		await expect(input).toHaveAttribute('accept', /^image\/\*,video\/\*,\.jpg,.*\.heic,.*\.mov,/);
	}

	// Hold the upload back a moment so the sending state can be seen.
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r));
	await page.route('**/api/upload/**', async (route) => {
		if (route.request().method() === 'PATCH') await held;
		await route.continue();
	});

	await pick(page, [
		{ name: 'IMG_0420.JPG', mimeType: 'image/jpeg', buffer: await jpeg() },
		{ name: 'Tax return.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%…') }
	]);

	const tiles = page.getByRole('list', { name: 'Your photos and videos' }).getByRole('listitem');
	await expect(tiles).toHaveCount(2);
	// Tiles name files without their extension, like the album page.
	const photo = tiles.filter({ hasText: 'IMG_0420' });
	const pdf = tiles.filter({ hasText: 'Tax return' });
	await expect(pdf).toContainText("That one isn't a photo or video.");
	await expect(pdf).not.toContainText('.pdf');
	await expect(photo).not.toContainText('.JPG');
	await expect(page.getByText('Sending 1 of 1…')).toBeVisible();
	await expect(page.getByText('Keep this screen open until it says Done.')).toBeVisible();
	await expect(photo).toContainText(/Sending… \d+%/);
	const violations = await new AxeBuilder({ page: page as unknown as AxePage }).include('.uploader').analyze();
	expect(violations.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
	release();

	// Sent: the summary says Done, the tile follows the server until it finishes.
	await expect(page.getByText('Done!', { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(photo).toContainText(FINISHED, { timeout: 45_000 });
	// ondone fired: the /add page offers the way to the album.
	await expect(page.getByRole('link', { name: 'Done! See them' })).toBeVisible();

	const rows = readRows<{ status: string; uploaded_by_name: string; source_name: string }>(
		'SELECT status, uploaded_by_name, source_name FROM media WHERE album_id = ?',
		album
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ uploaded_by_name: 'Grandma Rose', source_name: 'IMG_0420.JPG' });
	expect(['ready', 'failed']).toContain(rows[0].status);
	if (rows[0].status === 'ready') await expect(photo.locator('img')).toHaveAttribute('src', /\/media\/[0-9A-Z]{26}\/thumb\?v=\d+/);
	else testInfo.annotations.push({ type: 'note', description: 'The photo lane failed this item; the tile shows the failure copy.' });
});

test('picking the same photo again says it is already in the album', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'one browser is enough');
	await page.setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.73' });
	await login(page, 'Grandpa Ken');
	const album = seedAlbum('Twice');
	await page.goto(`/album/${album}?add`);
	const bytes = await jpeg();
	await pick(page, [{ name: 'IMG_0001.JPG', mimeType: 'image/jpeg', buffer: bytes }]);
	// The album page uses clearOnDone: a finished batch collapses to one summary line, and the photo
	// moves to the grid (or, if it failed, to the page's own "These didn't work" list).
	const uploader = page.locator('.uploader');
	const tiles = uploader.getByRole('list', { name: 'Your photos and videos' }).getByRole('listitem');
	await expect(uploader.locator('.summary')).toContainText(/Done! 1 added\.|1 couldn't be added/, { timeout: 45_000 });
	await expect(tiles).toHaveCount(0);
	// Only a live item (not a failed one) makes the second copy a duplicate.
	const first = readRows<{ status: string }>('SELECT status FROM media WHERE album_id = ?', album)[0].status;
	test.skip(first !== 'ready', 'the photo lane did not add the first copy, so there is nothing to duplicate');
	await expect(page.locator('a[href^="/view/"]')).toHaveCount(1);

	await pick(page, [{ name: 'IMG_0001 copy.JPG', mimeType: 'image/jpeg', buffer: bytes }]);
	// A new batch starts a new summary.
	await expect(uploader.locator('.summary')).toHaveText('Done! 1 already in this album.', { timeout: 30_000 });
	await expect(tiles).toHaveCount(0);
	await expect(page.locator('a[href^="/view/"]')).toHaveCount(1);
});

test('a dropped connection waits for the internet and carries on, with no "Done!" until all are sent', async ({ page, context }, testInfo) => {
	test.skip(testInfo.project.name !== 'mobile', 'one browser is enough');
	test.setTimeout(120_000);
	await page.setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.74' });
	await login(page, 'Aunt Linda');
	const album = seedAlbum('Offline for a bit');
	await page.goto(`/add?album=${album}`);

	// The first two files' bytes are held back, then cut off when the phone loses its connection.
	const held: Route[] = [];
	let cutOff = false;
	await page.route('**/api/upload/**', async (route) => {
		if (route.request().method() !== 'PATCH' || cutOff) return route.continue();
		held.push(route); // answered below
	});

	await pick(page, [
		{ name: 'IMG_0201.JPG', mimeType: 'image/jpeg', buffer: await jpeg('#c93b3b') },
		{ name: 'IMG_0202.JPG', mimeType: 'image/jpeg', buffer: await jpeg('#3bc96a') },
		{ name: 'IMG_0203.JPG', mimeType: 'image/jpeg', buffer: await jpeg('#c9b23b') }
	]);
	await expect.poll(() => held.length).toBe(2);
	await context.setOffline(true);
	cutOff = true;
	for (const route of held) await route.abort('internetdisconnected');

	const tiles = page.getByRole('list', { name: 'Your photos and videos' }).getByRole('listitem');
	await expect(tiles.filter({ hasText: 'Waiting for the internet…' })).toHaveCount(2);
	await expect(page.getByText(/Waiting for the internet… It carries on by itself/)).toBeVisible();
	// Offline for a while: still sending, never "Done!" or "didn't send".
	for (let i = 0; i < 4; i++) {
		await expect(page.getByText(/Sending \d of 3…/)).toBeVisible();
		await expect(page.getByText('Done!', { exact: true })).toHaveCount(0);
		await expect(page.getByText(/Everything is sent|didn't send/)).toHaveCount(0);
		await expect(page.getByRole('link', { name: /Done! See them/ })).toHaveCount(0);
		await page.waitForTimeout(2500);
	}

	await context.setOffline(false);
	for (const name of ['IMG_0201', 'IMG_0202', 'IMG_0203']) {
		await expect(tiles.filter({ hasText: name })).toContainText(FINISHED, { timeout: 90_000 });
	}
	await expect(page.getByText('Done!', { exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Done! See them' })).toBeVisible();
	const rows = readRows<{ source_name: string }>('SELECT source_name FROM media WHERE album_id = ? ORDER BY source_name', album);
	expect(rows.map((r) => r.source_name)).toEqual(['IMG_0201.JPG', 'IMG_0202.JPG', 'IMG_0203.JPG']);
});
