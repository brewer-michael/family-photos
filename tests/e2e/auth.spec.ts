import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD, joinPath, login, readSettings } from './helpers';
import { deviceIdOf, seedAlbum, seedMedia } from './seed';

test.describe('access over plain HTTP', () => {
	test('family code (odd casing/spaces) → name → home shows Everyday Photos', async ({ page, context, baseURL }) => {
		const res = await page.goto('/');
		await expect(page).toHaveURL(/\/login\?next=%2F$/);
		expect(res?.headers()['x-robots-tag']).toContain('noindex');

		const code = page.getByLabel('Family code');
		await expect(code).toHaveAttribute('type', 'text');
		await expect(code).toHaveAttribute('autocapitalize', 'off');
		await expect(code).toHaveAttribute('autocomplete', 'off');
		await code.fill('  Blue  LAKE cabin ');
		// The form POST passes SvelteKit's CSRF origin check only because server.js fills in
		// x-forwarded-proto from the socket (adapter-node would assume https).
		await page.getByRole('button', { name: 'Come in' }).click();

		await expect(page).toHaveURL(/\/name\?next=%2F$/);
		await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
		await expect(page.getByText('Grandma Jo')).toBeVisible();
		await page.getByLabel('Your name').fill('Grandma Jo');
		await page.getByRole('button', { name: 'Continue' }).click();

		await expect(page).toHaveURL(`${baseURL}/`);
		await expect(page.getByRole('link', { name: 'Everyday Photos' })).toBeVisible();
		await expect(page.getByText('Hi Grandma Jo')).toBeVisible();

		const cookies = await context.cookies();
		const access = cookies.find((c) => c.name === 'fp_access')!;
		expect(access).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: false, path: '/' });
		expect(access.expires - Date.now() / 1000).toBeGreaterThan(399 * 86400);
		expect(cookies.find((c) => c.name === 'fp_device')).toMatchObject({ httpOnly: true });
	});

	test('"Not Jo?" on a shared tablet: the next person gets a device of their own', async ({ page, context }) => {
		const album = seedAlbum('Shared iPad');
		const photo = await seedMedia(album, { name: 'IMG_0001.HEIC', takenAt: '2024-07-04T12:00:00-07:00' });
		await login(page, 'Grandma Jo');
		const jo = await deviceIdOf(context);
		await page.goto(`/view/${photo}`);
		await page.getByLabel('Write a memory').fill('Jo wrote this');
		await page.getByRole('button', { name: 'Save memory' }).click();
		await expect(page.getByRole('status').filter({ hasText: 'your memory is saved' })).toBeVisible();
		await page.getByRole('button', { name: 'Ask to remove' }).click();
		const ask = page.getByRole('dialog', { name: 'Ask to remove this photo' });
		await ask.getByRole('radio', { name: 'Blurry or duplicate' }).check();
		await ask.getByRole('button', { name: 'Send request' }).click();
		await page.getByRole('dialog', { name: 'Thank you' }).getByRole('button', { name: 'OK' }).click();

		// Jo taps it by mistake and types her own name again (any case): still Jo's device.
		await page.getByRole('link', { name: 'Not Grandma Jo?' }).click();
		await expect(page.getByLabel('Your name')).toHaveValue('');
		await expect(page.getByRole('link', { name: "Go back, I'm Grandma Jo" })).toHaveAttribute('href', `/view/${photo}`);
		await page.getByLabel('Your name').fill('grandma  JO');
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${photo}$`));
		expect(await deviceIdOf(context)).toBe(jo);
		await expect(page.getByRole('listitem').filter({ hasText: 'Jo wrote this' }).getByRole('link', { name: 'Edit' })).toHaveCount(1);

		// Uncle Bob takes the tablet: Jo's memory and request stay hers.
		await page.getByRole('link', { name: 'Not grandma JO?' }).click();
		await page.getByLabel('Your name').fill('Uncle Bob');
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(new RegExp(`/view/${photo}$`));
		await expect(page.getByRole('link', { name: 'Not Uncle Bob?' })).toBeVisible();
		expect(await deviceIdOf(context)).not.toBe(jo);
		const memory = page.getByRole('listitem').filter({ hasText: 'Jo wrote this' });
		await expect(memory).toContainText('— Grandma Jo,');
		await expect(memory.getByRole('link', { name: 'Edit' })).toHaveCount(0);
		await expect(memory.getByRole('button', { name: /Delete/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Ask to remove' })).toBeVisible();
	});

	test('a QR join URL lands on the album after choosing a name', async ({ page }) => {
		const { defaultAlbumId } = readSettings();
		await page.goto(joinPath(defaultAlbumId));
		await expect(page).toHaveURL(new RegExp(`/name\\?next=%2Falbum%2F${defaultAlbumId}$`));
		await page.getByLabel('Your name').fill('Uncle Bob');
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(new RegExp(`/album/${defaultAlbumId}$`));
		await expect(page.getByRole('heading', { name: 'Everyday Photos' })).toBeVisible();
		expect(page.url()).not.toContain('/join/');

		// With a name already set, the join link goes straight to the album.
		await page.goto(joinPath(defaultAlbumId));
		await expect(page).toHaveURL(new RegExp(`/album/${defaultAlbumId}$`));
	});

	test('a wrong code stays in the field, focused, so a typo can be fixed', async ({ page }, testInfo) => {
		// One wrong code, from an address of its own (the limit counts failures per address).
		await page.setExtraHTTPHeaders({ 'x-real-ip': testInfo.project.name === 'mobile' ? '198.51.100.81' : '198.51.100.82' });
		await page.goto('/login');
		const code = page.getByLabel('Family code');
		await code.fill('blue lakes cabin');
		await page.getByRole('button', { name: 'Come in' }).click();
		await expect(page.getByRole('alert')).toHaveText("That code didn't work. Check the spelling and try again.");
		await expect(code).toHaveValue('blue lakes cabin');
		await expect(code).toBeFocused();
		await code.press('End');
		for (let i = 0; i < 'cabin'.length + 2; i++) await code.press('Backspace');
		await code.pressSequentially(' cabin');
		await expect(code).toHaveValue('blue lake cabin');
		await page.getByRole('button', { name: 'Come in' }).click();
		await expect(page).toHaveURL(/\/name\?next=%2F$/);
	});

	test('an invalid join link goes to the family code page, then on to its album', async ({ page }) => {
		await page.goto('/join/not-a-real-token-at-all');
		await expect(page).toHaveURL(/\/login\?error=join$/);
		const { defaultAlbumId } = readSettings();
		await page.goto(`/join/not-a-real-token-at-all?album=${defaultAlbumId}`);
		await expect(page).toHaveURL(new RegExp(`/login\\?error=join&next=%2Falbum%2F${defaultAlbumId}$`));
		await expect(page.getByRole('alert')).toContainText("doesn't work any more");
		await page.getByLabel('Family code').fill('blue lake cabin');
		await page.getByRole('button', { name: 'Come in' }).click();
		await page.getByLabel('Your name').fill('Aunt Linda');
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(new RegExp(`/album/${defaultAlbumId}$`));
		await expect(page.getByRole('heading', { level: 1, name: 'Everyday Photos' })).toBeVisible();
	});

	test('the 11th wrong code gets the rate-limit message (429), even from a new address', async ({ page, context }, testInfo) => {
		// A browser that has signed in before (it keeps its device cookie, e.g. after "Reset access").
		// It is limited by device as well as by address, and its wrong codes count in the allowance
		// of known devices, not in the one strangers share with every other test's first sign-in.
		// The peer is loopback (a trusted proxy by default), so x-real-ip is believed. It must be a
		// real IP address; a new one for every try shows the device limit holds anyway.
		const net = (testInfo.project.name === 'mobile' ? 100 : 150) + 12 * testInfo.retry;
		const from = (i: number) => page.setExtraHTTPHeaders({ 'x-real-ip': `192.0.2.${net + i}` });
		await from(0);
		await login(page, 'Cousin Lee'); // the device cookie is set on /name
		await context.clearCookies({ name: 'fp_access' });
		await page.goto('/login');
		const submit = async () => {
			const [res] = await Promise.all([
				page.waitForResponse((r) => r.url().includes('/login') && r.request().method() === 'POST'),
				page.getByRole('button', { name: 'Come in' }).click()
			]);
			return res.status();
		};
		for (let i = 1; i <= 10; i++) {
			await from(i);
			await page.getByLabel('Family code').fill(`wrong code ${i}`);
			expect(await submit(), `attempt ${i}`).toBe(400);
			await expect(page.getByRole('alert')).toContainText("didn't work");
		}
		await from(11);
		await page.getByLabel('Family code').fill('blue lake cabin'); // even the right code is refused now
		expect(await submit()).toBe(429);
		await expect(page.getByRole('alert')).toContainText('Too many tries');
	});

	test('an address that matches no page: the family code first, then a friendly not-found page', async ({ page }) => {
		await page.goto('/no-such-page');
		await expect(page).toHaveURL(/\/login\?next=%2Fno-such-page$/);
		await login(page, 'Cousin Max');
		const res = await page.goto('/no-such-page');
		expect(res?.status()).toBe(404);
		await expect(page.getByRole('heading', { name: "We couldn't find that" })).toBeVisible();
		await expect(page.getByText("It may have been moved or removed, or it isn't ready yet.")).toBeVisible();
		await page.getByRole('link', { name: 'Go to all albums' }).click();
		await expect(page.getByRole('link', { name: 'Everyday Photos' })).toBeVisible();
	});

	test('/admin requires the admin password; leaving admin mode keeps family access', async ({ page }) => {
		await login(page, 'Michael');

		await page.goto('/admin');
		await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin$/);
		await page.getByLabel('Admin password').fill('wrong-password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toContainText("didn't work");

		await page.getByLabel('Admin password').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/admin$/);
		await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();

		await page.getByRole('button', { name: 'Leave admin mode' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('link', { name: 'Everyday Photos' })).toBeVisible();
		await page.goto('/admin');
		await expect(page).toHaveURL(/\/admin\/login/);
	});

	test('the admin password alone also grants family access', async ({ page }) => {
		await page.goto('/admin/login');
		await page.getByLabel('Admin password').fill(ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/name\?next=%2Fadmin$/);
		await page.getByLabel('Your name').fill('Michael');
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(/\/admin$/);
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'Everyday Photos' })).toBeVisible();
	});

	test('unauthenticated API calls get 401, cross-site form posts 403', async ({ request }) => {
		expect((await request.get('/api/status?ids=x', { maxRedirects: 0 })).status()).toBe(401);
		expect((await request.get('/healthz')).status()).toBe(200);
		const res = await request.post('/login', {
			form: { code: 'blue lake cabin' },
			headers: { origin: 'http://evil.example' },
			maxRedirects: 0
		});
		expect(res.status()).toBe(403);
	});
});
