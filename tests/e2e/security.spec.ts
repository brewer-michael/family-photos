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

	test('behind a proxy the limit follows the visitor: made-up headers do not escape it, other visitors are not locked out', async ({ request, baseURL }, testInfo) => {
		// Wrong codes from browsers that never signed in share one allowance (100 per 15 minutes)
		// with every other test's first sign-in, so this test spends only 11 of them. More header
		// combinations are covered in tests/unit/ratelimit.test.ts.
		// 127.0.0.1 is a trusted proxy peer, so it can play Nginx Proxy Manager or cloudflared.
		const base = (testInfo.project.name === 'mobile' ? 10 : 20) + 2 * testInfo.retry;
		const visitor = `192.0.2.${base}`;
		const attempt = (headers: Record<string, string>) =>
			request.post('/login', {
				form: { code: 'not the code' },
				headers: { origin: baseURL!, accept: 'text/html', ...headers },
				maxRedirects: 0
			});
		// Cloudflare → NPM: X-Real-IP is the Cloudflare edge, CF-Connecting-IP the visitor.
		const viaEdge = (ip: string) => attempt({ 'x-real-ip': '162.158.99.1', 'cf-connecting-ip': ip });
		for (let i = 1; i <= 10; i++) expect((await viaEdge(visitor)).status(), `attempt ${i}`).toBe(400);
		expect((await viaEdge(visitor)).status()).toBe(429);
		// NPM alone: X-Real-IP is the visitor, who makes up a new CF-Connecting-IP.
		expect((await attempt({ 'x-real-ip': visitor, 'cf-connecting-ip': `203.0.113.${base}` })).status()).toBe(429);
		// cloudflared: CF-Connecting-IP is the visitor, who makes up a new X-Real-IP.
		expect((await attempt({ 'cf-connecting-ip': visitor, 'x-real-ip': `198.51.100.${base + 100}` })).status()).toBe(429);
		// Another visitor behind the same Cloudflare edge can still try.
		expect((await viaEdge(`192.0.2.${base + 1}`)).status()).toBe(400);
	});
});
