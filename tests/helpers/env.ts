/**
 * Test environment helpers: a temp CONFIG_DIR/PHOTOS_DIR per test file plus the env vars
 * config.ts requires. setup-env.ts calls installTestEnv() for every file automatically.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfig } from '#lib/server/config';
import { closeDb, getDb, type DB } from '#lib/server/db';

export const TEST_FAMILY_PASSWORD = 'blue lake cabin';
export const TEST_ADMIN_PASSWORD = 'admin-test-pass';

export interface TestEnv {
	root: string;
	configDir: string;
	photosDir: string;
}

let current: TestEnv | null = null;

/** Creates temp dirs and sets process.env for config.ts. Returns the paths. */
export function installTestEnv(overrides: Record<string, string | undefined> = {}): TestEnv {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
	const env: TestEnv = {
		root,
		configDir: path.join(root, 'config'),
		photosDir: path.join(root, 'photos')
	};
	const vars: Record<string, string | undefined> = {
		CONFIG_DIR: env.configDir,
		PHOTOS_DIR: env.photosDir,
		FAMILY_PASSWORD: TEST_FAMILY_PASSWORD,
		ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
		PUBLIC_URL: 'http://localhost:3000',
		ADMIN_EMAIL: 'admin@example.com',
		ADMIN_NAME: 'Michael',
		SMTP_HOST: undefined,
		...overrides
	};
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetConfig();
	current = env;
	return env;
}

export function testEnv(): TestEnv {
	if (!current) throw new Error('installTestEnv() has not run');
	return current;
}

/** Sets env vars and forgets the cached config (e.g. to simulate a changed FAMILY_PASSWORD). */
export function setEnv(vars: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetConfig();
}

/** Closes the DB, deletes the database file and opens a freshly migrated + seeded one. */
export function freshDb(): DB {
	closeDb();
	const { configDir } = testEnv();
	for (const f of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm']) {
		fs.rmSync(path.join(configDir, f), { force: true });
	}
	return getDb();
}

export function removeTestEnv(): void {
	closeDb();
	if (current) fs.rmSync(current.root, { recursive: true, force: true });
	current = null;
	resetConfig();
}
