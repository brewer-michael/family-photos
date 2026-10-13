import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The built app (`npm run build` first) runs via `node server.js` on a free port with a temp
// CONFIG_DIR/PHOTOS_DIR, plain HTTP and no SMTP (outbox mode). The port and dir are chosen once in
// the runner process and inherited by workers through the environment.
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

process.env.FP_E2E_PORT ||= String(await freePort());
process.env.FP_E2E_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'fp-e2e-'));

const port = Number(process.env.FP_E2E_PORT);
const dir = process.env.FP_E2E_DIR;
const baseURL = `http://127.0.0.1:${port}`;

export const E2E = {
	familyCode: 'blue lake cabin',
	adminPassword: 'admin-test-pass'
};

export default defineConfig({
	testDir: 'tests/e2e',
	globalSetup: './tests/e2e/global-setup.ts',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	timeout: 30_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			// iPhone viewport/UA/touch, but Chromium (the only browser installed; WebKit is the preset default).
			name: 'mobile',
			use: { ...devices['iPhone 13'], browserName: 'chromium' }
		},
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'] }
		}
	],
	webServer: {
		command: 'node server.js',
		url: `${baseURL}/healthz`,
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PORT: String(port),
			HOST: '127.0.0.1',
			CONFIG_DIR: path.join(dir, 'config'),
			PHOTOS_DIR: path.join(dir, 'photos'),
			FAMILY_PASSWORD: E2E.familyCode,
			ADMIN_PASSWORD: E2E.adminPassword,
			PUBLIC_URL: baseURL,
			ADMIN_EMAIL: 'admin@example.com',
			ADMIN_NAME: 'Michael',
			SMTP_HOST: '',
			NODE_ENV: 'production'
		}
	}
});
