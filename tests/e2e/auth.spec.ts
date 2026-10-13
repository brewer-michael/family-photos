import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD, joinPath, login, readSettings } from './helpers';

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

	test('an invalid join link goes to the family code page', async ({ page }) => {
		await page.goto('/join/not-a-real-token-at-all?album=1');
		await expect(page).toHaveURL(/\/login\?error=join$/);
		await expect(page.getByRole('alert')).toContainText("doesn't work any more");
	});

	test('the 11th wrong code gets the rate-limit message (429)', async ({ browser, baseURL }, testInfo) => {
		// Own rate-limit bucket so other tests from 127.0.0.1 are unaffected: the peer is loopback
		// (a trusted proxy by default), so x-real-ip is believed. It must be a real IP address.
		const n = (testInfo.project.name === 'mobile' ? 10 : 20) + testInfo.retry;
		const context = await browser.newContext({
			...testInfo.project.use,
			baseURL,
			extraHTTPHeaders: { 'x-real-ip': `198.51.100.${n}` }
		});
		const page = await context.newPage();
		await page.goto('/login');
		for (let i = 1; i <= 10; i++) {
			await page.getByLabel('Family code').fill(`wrong code ${i}`);
			const [res] = await Promise.all([
				page.waitForResponse((r) => r.url().includes('/login') && r.request().method() === 'POST'),
				page.getByRole('button', { name: 'Come in' }).click()
			]);
			expect(res.status()).toBe(400);
			await expect(page.getByRole('alert')).toContainText("didn't work");
		}
		await page.getByLabel('Family code').fill('blue lake cabin'); // even the right code is refused now
		const [res] = await Promise.all([
			page.waitForResponse((r) => r.url().includes('/login') && r.request().method() === 'POST'),
			page.getByRole('button', { name: 'Come in' }).click()
		]);
		expect(res.status()).toBe(429);
		await expect(page.getByRole('alert')).toContainText('Too many tries');
		await context.close();
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
