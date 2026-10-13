import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * The temp dir is created by playwright.config.ts (the web server starts before globalSetup).
 * Here we check the build exists and the server created its directories, and return a
 * teardown that deletes the temp dir after the run.
 */
export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
	const dir = process.env.FP_E2E_DIR;
	if (!dir) throw new Error('FP_E2E_DIR is not set (playwright.config.ts sets it)');
	if (!fs.existsSync('build/handler.js')) throw new Error('Run `npm run build` before `npm run test:e2e`.');
	if (!fs.existsSync(path.join(dir, 'config', 'app.sqlite'))) {
		throw new Error(`The web server did not create ${dir}/config/app.sqlite`);
	}
	return async () => {
		if (!process.env.FP_E2E_KEEP) fs.rmSync(dir, { recursive: true, force: true });
	};
}
