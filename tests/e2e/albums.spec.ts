import { expect, test } from '@playwright/test';
import { adminLogin, login } from './helpers';
import { deviceIdOf, seedAlbum, seedMedia } from './seed';

test.describe('albums', () => {
	test('create an album, then only its creator (and the admin) can change it', async ({ page, browser, baseURL }, testInfo) => {
		await login(page, 'Aunt Linda');
		await page.getByRole('link', { name: 'New album' }).click();
		await expect(page.getByRole('heading', { name: 'Start a new album' })).toBeVisible();
		const title = `Retreat ${testInfo.project.name} ${Date.now()}`;
		await page.getByLabel('Album name').fill(title);
		await page.getByLabel('When (if you like)').fill('Summer 2023');
		await page.getByRole('button', { name: 'Create album' }).click();

		await expect(page).toHaveURL(/\/album\/\d+\?add$/);
		const albumPath = new URL(page.url()).pathname;
		await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
		await expect(page.getByText('Summer 2023')).toBeVisible();
		await expect(page.getByText('Started by Aunt Linda')).toBeVisible();
		// A new album opens with the uploader showing.
		await expect(page.getByRole('button', { name: 'Add photos & videos' }).first()).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByText('No photos here yet.')).toBeVisible();

		await page.getByRole('link', { name: 'Change name or details' }).click();
		await page.getByLabel('Album name').fill(`${title} (renamed)`);
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page).toHaveURL(new RegExp(`${albumPath}$`));
		await expect(page.getByRole('heading', { level: 1, name: `${title} (renamed)` })).toBeVisible();

		// The album shows on the home page.
		await page.goto('/');
		await expect(page.getByRole('link', { name: new RegExp(`${title} \\(renamed\\)`) })).toBeVisible();

		// Someone else on another device sees it but can't change it.
		const other = await browser.newContext({ ...testInfo.project.use, baseURL });
		const otherPage = await other.newPage();
		await login(otherPage, 'Cousin Sam');
		await otherPage.goto(albumPath);
		await expect(otherPage.getByRole('heading', { level: 1, name: `${title} (renamed)` })).toBeVisible();
		await expect(otherPage.getByRole('link', { name: 'Change name or details' })).toHaveCount(0);
		await otherPage.goto(`${albumPath}?edit`);
		await expect(otherPage.getByLabel('Album name')).toHaveCount(0);
		const res = await otherPage.request.post(`${albumPath}?/edit`, {
			form: { title: 'Hijacked' },
			headers: { origin: baseURL!, accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
		expect(res.status()).toBe(403);

		// The admin may change any album.
		await adminLogin(otherPage);
		await otherPage.goto(albumPath);
		await expect(otherPage.getByRole('link', { name: 'Change name or details' })).toBeVisible();
		await other.close();
	});

	test('a bad album name is explained, not lost', async ({ page }) => {
		await login(page, 'Uncle Bob');
		await page.goto('/album/new');
		await page.getByLabel('Album name').fill('   ');
		await page.getByLabel('When (if you like)').fill('July');
		await page.getByRole('button', { name: 'Create album' }).click();
		await expect(page.getByRole('alert')).toHaveText('Please give the album a name.');
		await expect(page.getByLabel('When (if you like)')).toHaveValue('July');
	});

	test('the grid shows tiles with alt text and video length, and "Show more" pages through', async ({ page }) => {
		const album = seedAlbum('Big album');
		for (let i = 0; i < 64; i++) {
			const day = String(1 + (i % 28)).padStart(2, '0');
			const hour = String(i % 24).padStart(2, '0');
			await seedMedia(album, { name: `IMG_${2000 + i}.HEIC`, takenAt: `2022-05-${day}T${hour}:00:00`, by: 'Grandpa Al' });
		}
		await seedMedia(album, { name: 'clip.MOV', kind: 'video', takenAt: '2022-06-01T10:00:00', by: 'Grandpa Al' });

		await login(page, 'Grandma Jo');
		await page.goto(`/album/${album}`);
		const grid = page.getByRole('list', { name: 'Photos and videos in Big album' });
		await expect(grid.getByRole('listitem')).toHaveCount(60);
		await expect(page.getByText('64 photos · 1 video')).toBeVisible();
		// Newest first: the video (June) leads, with its length on the badge.
		await expect(grid.getByRole('link').first()).toHaveAccessibleName('Video, 0:01, from June 1, 2022, added by Grandpa Al');
		await expect(grid.getByRole('listitem').first()).toContainText('0:01');
		await expect(page.getByRole('button', { name: 'Add photos & videos' }).first()).toHaveAttribute('aria-expanded', 'false');

		await page.getByRole('link', { name: 'Show more' }).click();
		await expect(grid.getByRole('listitem')).toHaveCount(65);
		await expect(page.getByRole('link', { name: 'Show more' })).toHaveCount(0);
		await expect(page.locator(':focus')).toHaveAttribute('href', /^\/view\//);
	});

	test('home lists new photos and albums; /add picks or starts an album', async ({ page }) => {
		const title = `Picnic ${Date.now()}`;
		const album = seedAlbum(title);
		await seedMedia(album, { name: 'IMG_0001.HEIC', takenAt: '2024-07-04T12:00:00-07:00', by: 'Aunt Linda' });

		await login(page, 'Grandma Jo');
		await expect(page.getByRole('list', { name: 'The newest photos and videos' }).getByRole('link').first()).toBeVisible();
		await expect(page.getByRole('link', { name: new RegExp(title) })).toContainText('1 photo');

		await page.getByRole('link', { name: 'Add photos & videos' }).click();
		await expect(page.getByRole('heading', { name: 'Which album?' })).toBeVisible();
		await page.getByRole('link', { name: new RegExp(title) }).click();
		await expect(page).toHaveURL(new RegExp(`/add\\?album=${album}$`));
		await expect(page.getByText(`to ${title}`)).toBeVisible();

		await page.getByRole('link', { name: 'Choose another album' }).click();
		const newTitle = `Brand new ${Date.now()}`;
		await page.getByLabel('Album name').fill(newTitle);
		await page.getByRole('button', { name: 'Create album' }).click();
		await expect(page).toHaveURL(/\/add\?album=\d+$/);
		await expect(page.getByText(`to ${newTitle}`)).toBeVisible();
	});

	test("only the uploader (and the admin) see an album's unfinished uploads", async ({ page, browser, baseURL }, testInfo) => {
		const album = seedAlbum('Uploads in progress');
		await login(page, 'Aunt Linda');
		const device = await deviceIdOf(page.context());
		await seedMedia(album, { name: 'beach.MOV', kind: 'video', status: 'processing', takenAt: '2024-01-01T00:00:00', device });
		await seedMedia(album, { name: 'broken.HEIC', status: 'failed', errorCode: 'unsupported', takenAt: '2024-01-01T00:00:00', device });

		await page.goto(`/album/${album}`);
		const pending = page.getByRole('list', { name: 'Still on their way' });
		await expect(pending.getByRole('listitem')).toHaveCount(2);
		await expect(pending).toContainText('beach.MOV');
		await expect(pending).toContainText('Getting your video ready…');
		await expect(pending).toContainText("We couldn't add this one. Michael has been told.");
		await expect(pending.locator('img')).toHaveCount(1); // the video's early poster

		const other = await browser.newContext({ ...testInfo.project.use, baseURL });
		const otherPage = await other.newPage();
		await login(otherPage, 'Cousin Sam');
		await otherPage.goto(`/album/${album}`);
		await expect(otherPage.getByRole('heading', { level: 1, name: 'Uploads in progress' })).toBeVisible();
		await expect(otherPage.getByRole('list', { name: 'Still on their way' })).toHaveCount(0);
		await adminLogin(otherPage);
		await otherPage.goto(`/album/${album}`);
		await expect(otherPage.getByRole('list', { name: 'Still on their way' }).getByRole('listitem')).toHaveCount(2);
		await other.close();
	});

	test('an unknown album is a friendly 404', async ({ page }) => {
		await login(page, 'Grandma Jo');
		for (const path of ['/album/999999', '/album/abc']) {
			const res = await page.goto(path);
			expect(res?.status()).toBe(404);
			await expect(page.getByRole('heading', { name: "We couldn't find that" })).toBeVisible();
			await expect(page.getByRole('link', { name: 'Go to all albums' })).toBeVisible();
		}
	});
});
