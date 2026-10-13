import { expect, test } from '@playwright/test';
import { FAMILY_CODE, login } from './helpers';

const SECURITY_HEADERS = ['x-robots-tag', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];

test.describe('access gate hardening', () => {
	test('percent-encoded /admin paths are gated like /admin for a family cookie', async ({ page }) => {
		await login(page, 'Cousin Sam');
		for (const path of ['/%61dmin', '/adm%69n', '/%61dmin/x', '/%61dmin/__data.json']) {
			const res = await page.request.get(path, { maxRedirects: 0 });
			const body = await res.text();
			expect(body, path).not.toContain('pendingRequests');
			expect(body, path).not.toContain('<h1>Admin</h1>');
			if (path.endsWith('__data.json')) {
				expect(res.status(), path).toBe(200); // Kit's JSON redirect for data requests
				expect(body, path).toContain('"type":"redirect"');
				expect(body, path).toContain('/admin/login');
			} else {
				expect(res.status(), path).toBe(303);
				expect(res.headers()['location'], path).toMatch(/^\/admin\/login\?next=/);
			}
		}
	});

	test('remote function endpoints are not public', async ({ request }) => {
		const res = await request.get('/_app/remote/abc/def', { maxRedirects: 0 });
		expect(res.status()).toBe(401);
	});

	test("every response carries the security headers, including Kit's own and static files", async ({ request }) => {
		const responses = {
			// built by the hook
			redirect: [await request.get('/', { maxRedirects: 0 }), 303],
			unauthorized: [await request.get('/api/status?ids=x', { maxRedirects: 0 }), 401],
			override: [await request.get('/healthz', { headers: { 'x-http-method-override': 'DELETE' } }), 400],
			// answered by Kit before or outside the hook
			trailingSlash: [await request.get('/login/', { maxRedirects: 0 }), 308],
			csrf: [
				await request.post('/login', { form: { code: 'x' }, headers: { origin: 'https://evil.example' }, maxRedirects: 0 }),
				403
			],
			thrownRedirect: [await request.get('/__data.json', { maxRedirects: 0 }), 200],
			// static file (adapter-node, before Kit) and a rendered page
			staticFile: [await request.get('/robots.txt'), 200],
			page: [await request.get('/login'), 200]
		} as const;
		for (const [what, [res, status]] of Object.entries(responses)) {
			expect(res.status(), what).toBe(status);
			for (const h of SECURITY_HEADERS) expect(res.headers()[h], `${what} ${h}`).toBeTruthy();
			expect(res.headers()['x-frame-options'], what).toBe('DENY');
		}
		expect(await responses.thrownRedirect[0].text()).toContain('"type":"redirect"');
		expect(responses.page[0].headers()['content-security-policy']).toContain("frame-ancestors 'none'");
	});

	test('a crafted ?next= cannot break sign-in or leave the site', async ({ page, baseURL }) => {
		const crafted = ['/.//evil.example', '/a/..//evil.example', '/%2e//evil.example', '/..//evil.example'];
		for (const next of crafted) {
			const res = await page.request.post('/login', {
				form: { code: FAMILY_CODE, next },
				headers: { origin: baseURL!, accept: 'text/html' },
				maxRedirects: 0
			});
			expect(res.status(), next).toBe(303);
			expect(res.headers()['location'], next).toBe('/name?next=%2F');
		}
		// The page itself renders and carries a safe next value.
		const page1 = await page.request.get(`/login?next=${encodeURIComponent('/.//evil.example')}`, { maxRedirects: 0 });
		expect(page1.status()).toBe(303); // already signed in (cookie from the POST above) → /name
		expect(page1.headers()['location']).toBe('/name?next=%2F');
		const named = await page.request.post('/name', {
			form: { name: 'Cousin Kim', next: '/.//evil.example' },
			headers: { origin: baseURL!, accept: 'text/html' },
			maxRedirects: 0
		});
		expect(named.status()).toBe(303);
		expect(named.headers()['location']).toBe('/');
	});

	test('rotating a spoofed CF-Connecting-IP behind a proxy does not escape the rate limit', async ({ request, baseURL }, testInfo) => {
		// 127.0.0.1 is a trusted proxy peer: it plays Nginx Proxy Manager, which sets X-Real-IP and
		// passes the client's own CF-Connecting-IP through.
		const realIp = `198.51.100.${(testInfo.project.name === 'mobile' ? 30 : 40) + testInfo.retry}`;
		const attempt = (i: number) =>
			request.post('/login', {
				form: { code: `wrong guess ${i}` },
				headers: { origin: baseURL!, accept: 'text/html', 'x-real-ip': realIp, 'cf-connecting-ip': `203.0.113.${i}` },
				maxRedirects: 0
			});
		for (let i = 1; i <= 10; i++) expect((await attempt(i)).status(), `attempt ${i}`).toBe(400);
		expect((await attempt(11)).status()).toBe(429);
		expect((await attempt(12)).status()).toBe(429);
	});

	test('Cloudflare → NPM: visitors behind the same Cloudflare edge are limited separately', async ({ request, baseURL }, testInfo) => {
		// 127.0.0.1 plays Nginx Proxy Manager behind Cloudflare: X-Real-IP is a Cloudflare edge,
		// CF-Connecting-IP the visitor.
		const base = (testInfo.project.name === 'mobile' ? 10 : 20) + 2 * testInfo.retry;
		const attempt = (visitor: string) =>
			request.post('/login', {
				form: { code: 'not the code' },
				headers: { origin: baseURL!, accept: 'text/html', 'x-real-ip': '162.158.99.1', 'cf-connecting-ip': visitor },
				maxRedirects: 0
			});
		const noisy = `192.0.2.${base}`;
		for (let i = 1; i <= 10; i++) expect((await attempt(noisy)).status(), `attempt ${i}`).toBe(400);
		expect((await attempt(noisy)).status()).toBe(429);
		expect((await attempt(`192.0.2.${base + 1}`)).status()).toBe(400); // not locked out by the noisy one
	});

	test('a known device rotating spoofed IPs is still limited (by its device cookie)', async ({ page, baseURL }, testInfo) => {
		await login(page, 'Cousin Lee'); // the device cookie is set on /name
		await page.context().clearCookies({ name: 'fp_access' }); // e.g. after "Reset access"
		const net = testInfo.project.name === 'mobile' ? 100 : 150;
		const attempt = (i: number) =>
			page.request.post('/login', {
				form: { code: `wrong ${i}` },
				headers: { origin: baseURL!, accept: 'text/html', 'x-real-ip': `192.0.2.${net + i}`, 'cf-connecting-ip': `192.0.2.${net + 25 + i}` },
				maxRedirects: 0
			});
		for (let i = 1; i <= 10; i++) expect((await attempt(i)).status(), `attempt ${i}`).toBe(400);
		expect((await attempt(11)).status()).toBe(429);
	});
});
