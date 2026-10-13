import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { adminLogin, FAMILY_CODE } from './helpers';
import { seedAlbum, seedMedia } from './seed';

// @axe-core/playwright is typed against the top-level playwright-core (a newer peer install than
// @playwright/test's own); the Page object is the same at runtime.
type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];

/** Serious and critical axe violations on the page as it is now (WCAG 2.x A/AA + best practice). */
async function seriousViolations(page: Page) {
	const { violations } = await new AxeBuilder({ page: page as unknown as AxePage }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	return violations
		.filter((v) => v.impact === 'serious' || v.impact === 'critical')
		.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`);
}

test.describe('accessibility (axe: no serious or critical issues)', () => {
	test.skip(({ isMobile }) => !isMobile, 'checked on the phone layout');

	for (const scheme of ['light', 'dark'] as const) {
		test(`login, name, home, album and viewer (${scheme})`, async ({ page }) => {
			// Its own sign-in rate-limit bucket (127.0.0.1 is a trusted proxy, so X-Real-IP is believed).
			await page.setExtraHTTPHeaders({ 'x-real-ip': scheme === 'light' ? '198.51.100.61' : '198.51.100.62' });
			await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			const album = seedAlbum('Accessible album');
			const photo = await seedMedia(album, {
				name: 'IMG_0001.HEIC',
				takenAt: '2024-07-04T12:00:00-07:00',
				original: Buffer.from('original')
			});
			await seedMedia(album, { name: 'IMG_0002.MOV', kind: 'video', takenAt: '2024-07-05T12:00:00-07:00' });

			await page.goto('/login');
			expect(await seriousViolations(page), 'login').toEqual([]);
			await page.getByLabel('Family code').fill('not the code');
			await page.getByRole('button', { name: 'Come in' }).click();
			await expect(page.getByRole('alert')).toBeVisible();
			expect(await seriousViolations(page), 'login with an error').toEqual([]);

			await page.getByLabel('Family code').fill(FAMILY_CODE);
			await page.getByRole('button', { name: 'Come in' }).click();
			await expect(page).toHaveURL(/\/name/);
			expect(await seriousViolations(page), 'name').toEqual([]);
			await page.getByLabel('Your name').fill('Grandma Jo');
			await page.getByRole('button', { name: 'Continue' }).click();
			await expect(page).toHaveURL(/\/$/);
			expect(await seriousViolations(page), 'home').toEqual([]);

			await page.goto(`/album/${album}`);
			expect(await seriousViolations(page), 'album').toEqual([]);

			await page.goto(`/view/${photo}`);
			expect(await seriousViolations(page), 'viewer').toEqual([]);
			await page.getByRole('button', { name: 'Ask to remove' }).click();
			await expect(page.getByRole('dialog')).toBeVisible();
			expect(await seriousViolations(page), 'remove dialog').toEqual([]);

			// The admin's viewer has a "Download the original file" button too.
			await adminLogin(page);
			await page.goto(`/view/${photo}`);
			await expect(page.getByRole('link', { name: 'Download the original file' })).toBeVisible();
			expect(await seriousViolations(page), 'viewer for the admin').toEqual([]);
		});
	}
});
