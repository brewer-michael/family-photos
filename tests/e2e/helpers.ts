import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, type Page } from '@playwright/test';
import { joinToken } from '../../src/lib/server/crypto';

export const FAMILY_CODE = 'blue lake cabin';
export const ADMIN_PASSWORD = 'admin-test-pass';

export function e2eDir(): string {
	const d = process.env.FP_E2E_DIR;
	if (!d) throw new Error('FP_E2E_DIR is not set');
	return d;
}

/** Reads settings straight from the server's temp database (read-only; no backdoor routes). */
export function readSettings(): { secret: string; gen: number; defaultAlbumId: number } {
	const db = new Database(path.join(e2eDir(), 'config', 'app.sqlite'), { readonly: true, fileMustExist: true });
	try {
		const get = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(k) as string) ?? '';
		return { secret: get('secret'), gen: Number(get('access_gen')), defaultAlbumId: Number(get('default_album_id')) };
	} finally {
		db.close();
	}
}

/** /join/<token>[?album=<id>] computed with the same derivation as the server. */
export function joinPath(albumId?: number): string {
	const { secret, gen } = readSettings();
	const t = joinToken(secret, FAMILY_CODE, gen);
	return albumId === undefined ? `/join/${t}` : `/join/${t}?album=${albumId}`;
}

/** Signs in with the family code and picks a name; ends on the home page. */
export async function login(page: Page, name: string, opts: { code?: string } = {}): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Family code').fill(opts.code ?? FAMILY_CODE);
	await page.getByRole('button', { name: 'Come in' }).click();
	await expect(page).toHaveURL(/\/name(\?|$)/);
	await page.getByLabel('Your name').fill(name);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page).toHaveURL(/\/$/);
}

/** From a signed-in family page: become admin. */
export async function adminLogin(page: Page): Promise<void> {
	await page.goto('/admin/login');
	await page.getByLabel('Admin password').fill(ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/admin$/);
}
