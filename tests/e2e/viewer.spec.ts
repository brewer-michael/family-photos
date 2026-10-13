import { expect, test } from '@playwright/test';
import { adminLogin, login } from './helpers';
import { readRows, seedAlbum, seedMedia } from './seed';

/** Three photos taken on the 1st, 2nd and 3rd: the grid (and prev/next) goes newest first. */
async function threePhotos(title: string) {
	const album = seedAlbum(title);
	const oldest = await seedMedia(album, { name: 'IMG_0001.HEIC', takenAt: '2024-07-01T09:00:00-07:00', by: 'Aunt Linda' });
	const middle = await seedMedia(album, { name: 'IMG_0002.HEIC', takenAt: '2024-07-02T09:00:00-07:00', by: 'Uncle Bob' });
	const newest = await seedMedia(album, { name: 'IMG_0003.HEIC', takenAt: '2024-07-03T09:00:00-07:00', by: 'Aunt Linda' });
	return { album, oldest, middle, newest };
}

test.describe('viewer', () => {
	test('shows the photo with who added it, and moves with Previous/Next', async ({ page }) => {
		const { album, oldest, middle, newest } = await threePhotos('Prev next');
		await login(page, 'Grandma Jo');
		await page.goto(`/album/${album}`);
		await page.getByRole('link', { name: /from July 2, 2024, added by Uncle Bob/ }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${middle}$`));

		const img = page.getByRole('img', { name: 'Photo from July 2, 2024, added by Uncle Bob' });
		await expect(img).toBeVisible();
		await expect(img).toHaveAttribute('src', new RegExp(`/media/${middle}/display\\?v=1$`));
		await expect(img).toHaveAttribute('draggable', 'false');
		await expect(page.locator('figcaption')).toHaveText(/Added by Uncle Bob.*July 2, 2024/);

		await page.getByRole('link', { name: 'Previous' }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${newest}$`));
		await expect(page.getByRole('link', { name: 'Previous' })).toHaveCount(0); // the newest has none

		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${middle}$`));
		await page.getByRole('link', { name: 'Next' }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${oldest}$`));
		await expect(page.getByRole('link', { name: 'Next' })).toHaveCount(0);

		// Arrow keys are an extra.
		await page.keyboard.press('ArrowLeft');
		await expect(page).toHaveURL(new RegExp(`/view/${middle}$`));

		await page.getByRole('link', { name: 'Back to album' }).click();
		await expect(page).toHaveURL(new RegExp(`/album/${album}$`));
	});

	test('right-click on the photo opens the Save sheet instead of the browser menu', async ({ page }) => {
		const { middle } = await threePhotos('Save sheet');
		await login(page, 'Grandma Jo');
		await page.goto(`/view/${middle}`);
		await page.locator('img.media').click({ button: 'right' });
		const sheet = page.getByRole('dialog', { name: 'Save this photo' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole('link', { name: 'Save to my phone' }).or(sheet.getByRole('button', { name: 'Save to my phone' }))).toBeVisible();
		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(sheet).toBeHidden();
	});

	test('memories: write and edit your own; others can read but not change them', async ({ page, browser, baseURL }, testInfo) => {
		const { middle } = await threePhotos('Memories');
		await login(page, 'Grandma Jo');
		await page.goto(`/view/${middle}`);
		await expect(page.getByText('No memories yet.')).toBeVisible();

		await page.getByRole('link', { name: 'Write a memory' }).click();
		await expect(page.getByLabel('Write a memory')).toBeFocused();
		await page.getByLabel('Write a memory').fill('The day we found the old boat.\nBob fell in!');
		await page.getByRole('button', { name: 'Save memory' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'your memory is saved' })).toBeVisible();
		const memory = page.getByRole('listitem').filter({ hasText: 'The day we found the old boat.' });
		await expect(memory).toContainText('— Grandma Jo,');
		await expect(page.getByLabel('Write a memory')).toHaveValue('');

		await memory.getByRole('link', { name: 'Edit' }).click();
		await page.getByLabel('Change your memory').fill('The day we found the old rowing boat.');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByLabel('Change your memory')).toHaveCount(0);
		const edited = page.getByRole('listitem').filter({ hasText: 'The day we found the old rowing boat.' });
		await expect(edited).toContainText('(edited)');

		const [{ id: memoryId }] = readRows<{ id: number }>('SELECT id FROM memories WHERE media_id = ?', middle);

		// Another device: can read, can't edit or delete.
		const other = await browser.newContext({ ...testInfo.project.use, baseURL });
		const otherPage = await other.newPage();
		await login(otherPage, 'Cousin Sam');
		await otherPage.goto(`/view/${middle}`);
		const seen = otherPage.getByRole('listitem').filter({ hasText: 'old rowing boat' });
		await expect(seen).toBeVisible();
		await expect(seen.getByRole('link', { name: 'Edit' })).toHaveCount(0);
		await expect(seen.getByRole('button', { name: /Delete/ })).toHaveCount(0);
		await otherPage.goto(`/view/${middle}?edit=${memoryId}`);
		await expect(otherPage.getByLabel('Change your memory')).toHaveCount(0);
		for (const action of ['editMemory', 'deleteMemory']) {
			const res = await otherPage.request.post(`/view/${middle}?/${action}`, {
				form: { id: String(memoryId), body: 'Hijacked' },
				headers: { origin: baseURL!, accept: 'text/html' },
				maxRedirects: 0
			});
			expect(res.status(), action).toBe(403);
		}
		expect(readRows<{ body: string }>('SELECT body FROM memories WHERE id = ?', memoryId)[0].body).toBe(
			'The day we found the old rowing boat.'
		);

		// The admin can delete anyone's memory.
		await adminLogin(otherPage);
		await otherPage.goto(`/view/${middle}`);
		otherPage.once('dialog', (d) => void d.accept());
		await otherPage.getByRole('button', { name: "Delete Grandma Jo's memory" }).click();
		await expect(otherPage.getByText('The memory was deleted.')).toBeVisible();
		expect(readRows('SELECT id FROM memories WHERE id = ?', memoryId)).toHaveLength(0);
		await other.close();
	});

	test('"Ask to remove" stores one request per device and reassures', async ({ page }) => {
		const { middle } = await threePhotos('Removal');
		await login(page, 'Aunt Linda');
		await page.goto(`/view/${middle}`);
		await page.getByRole('button', { name: 'Ask to remove' }).click();
		const dialog = page.getByRole('dialog', { name: 'Ask to remove this photo' });
		await expect(dialog).toContainText('Nothing is deleted yet — Michael will look at it.');
		for (const label of ["I'm in it and don't want it shared", 'Blurry or duplicate', 'Wrong album', 'Something else']) {
			await expect(dialog.getByRole('radio', { name: label })).toBeVisible();
		}

		// "Something else" needs a few words.
		await dialog.getByRole('radio', { name: 'Something else' }).check();
		await dialog.getByRole('button', { name: 'Send request' }).click();
		await expect(dialog.getByRole('alert')).toHaveText('Please tell us a little about why.');
		await dialog.getByLabel(/Tell Michael more/).fill('My eyes are closed');
		await dialog.getByRole('button', { name: 'Send request' }).click();

		const thanks = page.getByRole('dialog', { name: 'Thank you' });
		await expect(thanks).toContainText('Nothing is deleted yet — Michael will look at it.');
		await thanks.getByRole('button', { name: 'OK' }).click();
		await expect(page.getByRole('button', { name: 'You already asked' })).toBeVisible();

		const rows = readRows<{ reason: string; details: string; requester_name: string; status: string }>(
			'SELECT reason, details, requester_name, status FROM deletion_requests WHERE media_id = ?',
			middle
		);
		expect(rows).toEqual([{ reason: 'other', details: 'My eyes are closed', requester_name: 'Aunt Linda', status: 'pending' }]);

		await page.reload();
		await page.getByRole('button', { name: 'You already asked' }).click();
		await expect(page.getByRole('dialog', { name: 'You already asked' })).toContainText('Nothing is deleted yet');
	});

	test('trashed, unfinished and unknown items are a friendly 404', async ({ page }) => {
		const album = seedAlbum('Hidden things');
		const trashed = await seedMedia(album, { name: 'IMG_9.HEIC', takenAt: '2024-01-01T00:00:00', deletedAt: Date.now() });
		const processing = await seedMedia(album, { name: 'IMG_8.HEIC', takenAt: '2024-01-01T00:00:00', status: 'processing' });
		await login(page, 'Grandma Jo');
		for (const id of [trashed, processing, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'not-an-id']) {
			const res = await page.goto(`/view/${id}`);
			expect(res?.status(), id).toBe(404);
			await expect(page.getByRole('heading', { name: "We couldn't find that" })).toBeVisible();
		}
		// The admin can still look at a trashed item.
		await adminLogin(page);
		const res = await page.goto(`/view/${trashed}`);
		expect(res?.status()).toBe(200);
		await expect(page.getByText('This photo is in the trash.')).toBeVisible();
	});

	test('videos play the full file inline with a poster', async ({ page }) => {
		const album = seedAlbum('Videos');
		const id = await seedMedia(album, { name: 'IMG_0100.MOV', kind: 'video', takenAt: '2024-07-04T12:00:00-07:00' });
		await login(page, 'Grandma Jo');
		await page.goto(`/view/${id}`);
		const video = page.locator('video');
		await expect(video).toHaveAttribute('src', new RegExp(`/media/${id}/file\\?v=1$`));
		await expect(video).toHaveAttribute('poster', new RegExp(`/media/${id}/poster\\?v=1$`));
		await expect(video).toHaveAttribute('playsinline', '');
		await expect(video).toHaveAttribute('preload', 'metadata');
		await expect(video).toHaveAttribute('controls', '');
	});
});
