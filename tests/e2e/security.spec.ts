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

	test("the hook's own responses carry the security headers", async ({ request }) => {
		const redirect = await request.get('/', { maxRedirects: 0 });
		expect(redirect.status()).toBe(303);
		const unauthorized = await request.get('/api/status?ids=x', { maxRedirects: 0 });
		expect(unauthorized.status()).toBe(401);
		const override = await request.get('/healthz', { headers: { 'x-http-method-override': 'DELETE' } });
		expect(override.status()).toBe(400);
		for (const res of [redirect, unauthorized, override]) {
			for (const h of SECURITY_HEADERS) expect(res.headers()[h], `${res.url()} ${h}`).toBeTruthy();
		}
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
});
