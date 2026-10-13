/**
 * Admin pages end to end. Most tests use the shared server with their own seeded albums and items.
 * Actions that change things for everyone (Reset access, Empty trash, Delete all archived
 * originals, deleting an album into "Everyday Photos") run against a private server started by this
 * file, so they can't disturb tests running in parallel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import Database from 'better-sqlite3';
import { simpleParser, type ParsedMail } from 'mailparser';
import { monotonicFactory } from 'ulid';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { joinToken } from '../../src/lib/server/crypto';
import { ADMIN_PASSWORD, FAMILY_CODE, adminLogin, e2eDir, login } from './helpers';
import { readRows, seedAlbum, seedMedia } from './seed';

type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];

async function seriousViolations(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page: page as unknown as AxePage })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
		.analyze();
	return violations
		.filter((v) => v.impact === 'serious' || v.impact === 'critical')
		.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`);
}

const unique = () => randomBytes(3).toString('hex').toUpperCase();

/** A signed-in admin page in its own context (family code, name, admin password). */
async function adminPage(browser: Browser, baseURL: string): Promise<Page> {
	const context = await browser.newContext({ baseURL });
	const page = await context.newPage();
	await login(page, 'Michael');
	await adminLogin(page);
	return page;
}

/** Parsed .eml files in an outbox whose subject matches. */
async function emails(outbox: string, subject: string | RegExp): Promise<ParsedMail[]> {
	const out: ParsedMail[] = [];
	if (!fs.existsSync(outbox)) return out;
	for (const f of fs.readdirSync(outbox).filter((n) => n.endsWith('.eml'))) {
		const mail = await simpleParser(fs.readFileSync(path.join(outbox, f)), { skipImageLinks: true });
		if (typeof subject === 'string' ? mail.subject === subject : subject.test(mail.subject ?? '')) out.push(mail);
	}
	return out;
}

const sharedOutbox = () => path.join(e2eDir(), 'config', 'outbox');

test.describe('admin', () => {
	test('sign in leads to the overview with every section', async ({ page, isMobile }) => {
		await login(page, 'Michael');
		await adminLogin(page);
		await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
		for (const name of ['Removal requests', "Uploads that didn't work", 'Email', 'Media tools', 'Storage', 'Albums', 'QR cards', 'Reset access']) {
			await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
		}
		// Outbox mode in e2e: the config warning and the Email section both say so.
		await expect(page.getByText(/^SMTP_HOST is not set, so emails are saved as \.eml files/)).toBeVisible();
		await expect(page.locator('#email')).toContainText('are saved as files instead of being sent');
		if (isMobile) expect(await seriousViolations(page)).toEqual([]);
	});

	test('a removal request is emailed, reviewed, removed to the trash and restored', async ({ page, browser, baseURL, isMobile }) => {
		const title = `Retreat ${unique()}`;
		const album = seedAlbum(title);
		const name = `IMG_${unique()}.HEIC`;
		const id = await seedMedia(album, { name, takenAt: '2024-07-04T11:22:31-07:00', by: 'Uncle Bob' });

		// A family member asks.
		await login(page, 'Aunt Linda');
		await page.goto(`/view/${id}`);
		await page.getByRole('button', { name: 'Ask to remove' }).click();
		const dialog = page.getByRole('dialog', { name: 'Ask to remove this photo' });
		await dialog.getByRole('radio', { name: "I'm in it and don't want it shared" }).check();
		await dialog.getByRole('button', { name: 'Send request' }).click();
		await expect(page.getByRole('dialog', { name: 'Thank you' })).toBeVisible();
		const [{ id: rid }] = readRows<{ id: number }>('SELECT id FROM deletion_requests WHERE media_id = ?', id);

		// The admin's email: subject, both links and the inline JPEG.
		const subject = `Removal request: photo in "${title}" from Aunt Linda`;
		await expect.poll(async () => (await emails(sharedOutbox(), subject)).length, { timeout: 15_000 }).toBe(1);
		const [mail] = await emails(sharedOutbox(), subject);
		for (const link of [`${baseURL}/view/${id}`, `${baseURL}/admin/requests/${rid}`]) {
			expect(mail.text).toContain(link);
			expect(mail.html || '').toContain(link);
		}
		expect(mail.html || '').toContain('src="cid:thumb@family-photos"');
		expect(mail.attachments.map((a) => [a.contentType, a.cid])).toEqual([['image/jpeg', 'thumb@family-photos']]);
		expect(readRows('SELECT email_status FROM deletion_requests WHERE id = ?', rid)).toEqual([{ email_status: 'saved' }]);

		// Review → Remove.
		const admin = await adminPage(browser, baseURL!);
		const row = admin.getByRole('listitem').filter({ hasText: `from “${title}”` });
		await expect(row).toContainText("Why: I'm in it and don't want it shared");
		await row.getByRole('link', { name: /^Review/ }).click();
		await expect(admin).toHaveURL(new RegExp(`/admin/requests/${rid}$`));
		await expect(admin.getByRole('img', { name: 'The photo Aunt Linda asked about' })).toBeVisible();
		if (isMobile) expect(await seriousViolations(admin), 'request page').toEqual([]);
		await admin.getByRole('button', { name: 'Remove it' }).click();
		await expect(admin.getByRole('status')).toContainText('Removed. It stays in the trash for 30 days');
		await expect(admin.getByText(/^Removed to the trash on/)).toBeVisible();
		await expect(admin.getByRole('button', { name: 'Remove it' })).toHaveCount(0);

		// Hidden from the family.
		expect((await page.goto(`/view/${id}`))?.status()).toBe(404);

		// In the trash → Restore → visible again.
		await admin.goto('/admin/trash');
		const trashed = admin.getByRole('listitem').filter({ hasText: name });
		await expect(trashed).toContainText("Aunt Linda asked: I'm in it and don't want it shared");
		await expect(trashed).toContainText('Deleted for good in 30 days');
		if (isMobile) expect(await seriousViolations(admin), 'trash').toEqual([]);
		await trashed.getByRole('button', { name: /^Restore/ }).click();
		await expect(admin.getByRole('status')).toContainText(`${name} is back in its album.`);
		await expect(admin.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
		expect((await page.goto(`/view/${id}`))?.status()).toBe(200);
		await admin.context().close();
	});

	test('Dismiss and Move to album resolve a request', async ({ browser, baseURL }) => {
		const title = `Picnic ${unique()}`;
		const album = seedAlbum(title);
		const other = `Garden ${unique()}`;
		const otherId = seedAlbum(other);
		const a = await seedMedia(album, { name: `IMG_${unique()}.HEIC`, takenAt: '2024-05-01T10:00:00' });
		const b = await seedMedia(album, { name: `IMG_${unique()}.HEIC`, takenAt: '2024-05-02T10:00:00' });
		const insert = (mediaId: string, reason: string) =>
			readRows<{ id: number }>(
				`INSERT INTO deletion_requests(media_id, requester_name, requester_device, reason, status, email_status, created_at, updated_at)
				 VALUES (?, 'Cousin Sam', 'seed-device-request00', ?, 'pending', 'saved', ?, ?) RETURNING id`,
				mediaId,
				reason,
				Date.now(),
				Date.now()
			)[0].id;
		const dismissId = insert(a, 'blurry_or_duplicate');
		const moveId = insert(b, 'wrong_album');

		const admin = await adminPage(browser, baseURL!);
		await admin.goto(`/admin/requests/${dismissId}`);
		await admin.getByRole('button', { name: 'Dismiss the request' }).click();
		await expect(admin.getByRole('status')).toHaveText('Dismissed. Nothing was changed.');
		expect(readRows('SELECT status FROM deletion_requests WHERE id = ?', dismissId)).toEqual([{ status: 'dismissed' }]);
		expect(readRows('SELECT deleted_at, album_id FROM media WHERE id = ?', a)).toEqual([{ deleted_at: null, album_id: album }]);

		await admin.goto(`/admin/requests/${moveId}`);
		await admin.getByLabel('Move it to another album').selectOption({ label: other });
		await admin.getByRole('button', { name: 'Move it', exact: true }).click();
		await expect(admin.getByRole('status')).toHaveText(`Moved to “${other}”.`);
		expect(readRows('SELECT status, resolved_action FROM deletion_requests WHERE id = ?', moveId)).toEqual([
			{ status: 'approved', resolved_action: 'moved' }
		]);
		expect(readRows('SELECT album_id FROM media WHERE id = ?', b)).toEqual([{ album_id: otherId }]);
		await admin.context().close();
	});

	test('"Send test email" writes an .eml to the outbox', async ({ browser, baseURL }) => {
		const admin = await adminPage(browser, baseURL!);
		const before = (await emails(sharedOutbox(), 'Test email from Family Photos')).length;
		await admin.getByRole('button', { name: 'Send test email' }).click();
		await expect(admin.getByRole('status')).toContainText('Test email saved as a file in');
		const after = await emails(sharedOutbox(), 'Test email from Family Photos');
		expect(after.length).toBeGreaterThan(before);
		expect(after[0].to && !Array.isArray(after[0].to) ? after[0].to.text : '').toBe('admin@example.com');
		await admin.context().close();
	});

	test('a failed upload is listed with its problem and can be moved to the trash', async ({ browser, baseURL }) => {
		const album = seedAlbum(`Broken ${unique()}`);
		const name = `DOC_${unique()}.PDF`;
		await seedMedia(album, { name, takenAt: '2024-01-01T00:00:00', status: 'failed', errorCode: 'unsupported' });
		const admin = await adminPage(browser, baseURL!);
		const row = admin.locator('#problems').getByRole('listitem').filter({ hasText: name });
		await expect(row).toContainText("It isn't a photo or video we can use.");
		await row.getByRole('button', { name: /^Move to trash/ }).click();
		await expect(admin.locator('#problems').getByRole('status')).toHaveText(`${name} is in the trash now.`);
		await expect(admin.locator('#problems').getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
		await admin.goto('/admin/trash');
		await expect(admin.getByRole('listitem').filter({ hasText: name })).toBeVisible();
		await admin.context().close();
	});

	test('albums can be renamed, and an empty one deleted', async ({ browser, baseURL }) => {
		const title = `Old name ${unique()}`;
		const id = seedAlbum(title);
		const admin = await adminPage(browser, baseURL!);
		const card = () => admin.locator('#albums').getByRole('listitem').filter({ has: admin.getByRole('link', { name: title, exact: true }) });
		await card().getByText('Rename').click();
		const renamed = `New name ${unique()}`;
		await card().getByLabel('New name').fill(renamed);
		await card().getByRole('button', { name: 'Save name' }).click();
		await expect(admin.locator('#albums').getByRole('status')).toHaveText(`Renamed to "${renamed}".`);
		expect(readRows('SELECT title FROM albums WHERE id = ?', id)).toEqual([{ title: renamed }]);

		const row = admin.locator('#albums').getByRole('listitem').filter({ has: admin.getByRole('link', { name: renamed, exact: true }) });
		await row.getByText('Delete album…').click();
		await row.getByRole('button', { name: 'Yes, delete it' }).click();
		await expect(admin.locator('#albums').getByRole('status')).toHaveText(`"${renamed}" is deleted.`);
		expect(readRows<{ gone: number }>('SELECT deleted_at IS NOT NULL AS gone FROM albums WHERE id = ?', id)).toEqual([{ gone: 1 }]);
		await admin.context().close();
	});

	test('the original file: admins download it, family members are sent to the admin sign-in', async ({ page, browser, baseURL }) => {
		const album = seedAlbum(`Originals ${unique()}`);
		const name = `IMG_${unique()}.HEIC`;
		const id = await seedMedia(album, { name, takenAt: '2024-01-01T00:00:00' });
		readRows('UPDATE media SET source_kept = 1 WHERE id = ? RETURNING id', id);
		const file = path.join(e2eDir(), 'photos', 'originals', id.slice(-2), `${id}.heic`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'ftypheic original bytes');

		await login(page, 'Grandma Jo');
		const denied = await page.request.get(`/admin/original/${id}`, { maxRedirects: 0 });
		expect(denied.status()).toBe(303);
		expect(denied.headers()['location']).toMatch(/^\/admin\/login\?next=/);
		expect(await denied.text()).not.toContain('original bytes');

		const admin = await adminPage(browser, baseURL!);
		const res = await admin.request.get(`/admin/original/${id}`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toBe('application/octet-stream');
		expect(res.headers()['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
		expect(res.headers()['content-security-policy']).toBe('sandbox');
		expect(await res.text()).toBe('ftypheic original bytes');
		expect((await admin.request.get('/admin/original/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status()).toBe(404);
		await admin.context().close();
	});

	test('QR cards: one for the whole site and an SVG for each album', async ({ browser, baseURL, isMobile }) => {
		const titles = [`Lake ${unique()}`, `Farm ${unique()}`];
		for (const t of titles) seedAlbum(t);
		const admin = await adminPage(browser, baseURL!);
		await admin.goto('/admin/qr');
		await expect(admin.getByRole('heading', { name: 'QR cards', exact: true })).toBeVisible();
		await expect(admin.getByText('every printed card stops working')).toBeVisible();
		await expect(admin.getByRole('article', { name: 'QR card: the whole site' }).locator('svg')).toHaveCount(1);
		for (const t of titles) {
			const card = admin.getByRole('article', { name: `QR card: ${t}` });
			await expect(card.locator('svg')).toHaveCount(1);
			await expect(card).toContainText("Open your phone's camera and point it here.");
			await expect(card.getByRole('img', { name: `QR code for the album ${t}` })).toBeVisible();
		}
		const cards = await admin.locator('article.qr-card').count();
		expect(await admin.locator('article.qr-card svg').count()).toBe(cards);
		if (isMobile) expect(await seriousViolations(admin), 'qr').toEqual([]);
		else {
			// Printed one card per page: exactly one sheet per card, no blank sheet at the end.
			const pdf = (await admin.pdf({ format: 'A4' })).toString('latin1');
			expect(pdf.match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(cards);
		}
		await admin.context().close();
	});

	test('standalone links are as easy to tap as buttons', async ({ browser, baseURL }) => {
		const title = `Tap ${unique()}`;
		const albumId = seedAlbum(title);
		const name = `IMG_${unique()}.HEIC`;
		const id = await seedMedia(albumId, { name, takenAt: '2024-01-01T00:00:00' });
		const [{ id: rid }] = readRows<{ id: number }>(
			`INSERT INTO deletion_requests(media_id, requester_name, requester_device, reason, status, email_status, created_at, updated_at)
			 VALUES (?, 'Cousin Sam', 'seed-device-request00', 'in_it', 'pending', 'saved', ?, ?) RETURNING id`,
			id,
			Date.now(),
			Date.now()
		);
		const admin = await adminPage(browser, baseURL!);
		const tall = async (link: Locator) => expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
		await tall(admin.locator('#albums').getByRole('link', { name: title, exact: true }));
		await tall(admin.locator('#storage').getByRole('link', { name: /items?$/ }));
		await admin.goto(`/admin/requests/${rid}`);
		await tall(admin.getByRole('link', { name: 'Open the photo' }));
		await tall(admin.getByRole('link', { name: title, exact: true }));
		await admin.context().close();
	});

	test('"Check again" runs the media tools check', async ({ browser, baseURL, isMobile }) => {
		test.skip(isMobile, 'run once, on the desktop project');
		const admin = await adminPage(browser, baseURL!);
		const tools = admin.locator('#tools');
		await tools.getByRole('button', { name: 'Check again' }).click();
		await expect(tools.getByRole('status')).toContainText('Checked again', { timeout: 30_000 });
		await expect(tools.getByText(/^Versions \(checked /)).toBeVisible();
		await admin.context().close();
	});
});

// ---------------------------------------------------------------------------
// A private server for actions that affect everyone
// ---------------------------------------------------------------------------

interface PrivateServer {
	url: string;
	dir: string;
	child: ChildProcess;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as net.AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

async function startServer(): Promise<PrivateServer> {
	const port = await freePort();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-e2e-admin-'));
	const url = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, ['server.js'], {
		stdio: ['ignore', 'ignore', 'pipe'],
		env: {
			...process.env,
			PORT: String(port),
			HOST: '127.0.0.1',
			CONFIG_DIR: path.join(dir, 'config'),
			PHOTOS_DIR: path.join(dir, 'photos'),
			FAMILY_PASSWORD: FAMILY_CODE,
			ADMIN_PASSWORD,
			PUBLIC_URL: url,
			ADMIN_EMAIL: 'admin@example.com',
			ADMIN_NAME: 'Michael',
			SMTP_HOST: '',
			NODE_ENV: 'production'
		}
	});
	let stderr = '';
	child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`The private server exited: ${stderr}`);
		try {
			if ((await fetch(`${url}/healthz`)).ok) return { url, dir, child };
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) throw new Error(`The private server did not start: ${stderr}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function stopServer(s: PrivateServer): Promise<void> {
	if (s.child.exitCode === null) {
		const exited = new Promise((r) => s.child.once('exit', r));
		s.child.kill('SIGTERM');
		await exited;
	}
	fs.rmSync(s.dir, { recursive: true, force: true });
}

test.describe('admin actions that affect everyone (private server)', () => {
	test.describe.configure({ mode: 'serial' });
	test.skip(({ isMobile }) => isMobile, 'run once, on the desktop project');

	let server: PrivateServer;
	const db = () => new Database(path.join(server.dir, 'config', 'app.sqlite'), { timeout: 10_000 });
	const newId = monotonicFactory();

	function query<T>(sql: string, ...params: unknown[]): T[] {
		const d = db();
		try {
			return d.prepare(sql).all(...params) as T[];
		} finally {
			d.close();
		}
	}

	/** A ready photo in the private server with its files (canonical, archived original, thumbnail). */
	function item(albumId: number, opts: { trashed?: boolean; sha?: string } = {}): string {
		const id = newId();
		const now = Date.now();
		query(
			`INSERT INTO media(id, album_id, uploaded_by_name, uploaded_by_device, kind, status, source_name, source_ext,
				source_size, source_sha256, source_kept, conversion, canonical_ext, canonical_size, width, height, taken_ms,
				pipeline_version, created_at, updated_at, deleted_at)
			 VALUES (?, ?, 'Aunt Linda', 'seed-device-0000000000', 'photo', 'ready', 'IMG_1.HEIC', 'heic', 11, ?, 1,
				'transcode', 'jpg', 3, 640, 480, ?, 1, ?, ?, ?) RETURNING id`,
			id,
			albumId,
			opts.sha ?? randomBytes(32).toString('hex'),
			now,
			now,
			now,
			opts.trashed ? now : null
		);
		for (const f of Object.values(filesOf(id))) {
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, 'x');
		}
		return id;
	}

	/** Where the pipeline would have put an item's files on the private server. */
	function filesOf(id: string) {
		const sh = id.slice(-2);
		return {
			library: path.join(server.dir, 'photos', 'library', sh, `${id}.jpg`),
			original: path.join(server.dir, 'photos', 'originals', sh, `${id}.heic`),
			thumb: path.join(server.dir, 'config', 'cache', sh, id, 'thumb.webp')
		};
	}

	function joinPathNow(): string {
		const [{ secret }] = query<{ secret: string }>("SELECT value AS secret FROM settings WHERE key = 'secret'");
		const [{ gen }] = query<{ gen: string }>("SELECT value AS gen FROM settings WHERE key = 'access_gen'");
		return `/join/${joinToken(secret, FAMILY_CODE, Number(gen))}`;
	}

	test.beforeAll(async () => {
		server = await startServer();
	});

	test.afterAll(async () => {
		if (server) await stopServer(server);
	});

	test('Reset access signs everyone out and kills old QR codes, but keeps the admin signed in', async ({ browser }) => {
		const familyContext = await browser.newContext({ baseURL: server.url });
		const family = await familyContext.newPage();
		await login(family, 'Grandma Jo');
		const oldQr = joinPathNow();

		const admin = await adminPage(browser, server.url);
		await admin.locator('summary', { hasText: 'Reset access…' }).click();
		await expect(admin.getByText('Every printed QR card stops working')).toBeVisible();
		await admin.getByRole('button', { name: 'Yes, reset access' }).click();
		await expect(admin.locator('#access').getByRole('status')).toContainText('Everyone has to type the family code again');
		await expect(admin.getByRole('link', { name: 'Print new QR cards' })).toBeVisible();

		await admin.reload();
		await expect(admin).toHaveURL(/\/admin$/);
		await expect(admin.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();

		await family.goto('/');
		await expect(family).toHaveURL(/\/login/);

		const strangerContext = await browser.newContext({ baseURL: server.url });
		const stranger = await strangerContext.newPage();
		await stranger.goto(oldQr);
		await expect(stranger).toHaveURL(/\/login\?error=join$/);
		await expect(stranger.getByRole('alert')).toContainText("That QR code doesn't work any more.");
		await stranger.goto(joinPathNow());
		await expect(stranger).toHaveURL(/\/name\?next=/);

		for (const c of [familyContext, strangerContext, admin.context()]) await c.close();
	});

	test('"Empty trash now" deletes trashed items and their files for good', async ({ browser }) => {
		const [{ id: albumId }] = query<{ id: number }>("SELECT CAST(value AS INTEGER) AS id FROM settings WHERE key = 'default_album_id'");
		const trashed = item(albumId, { trashed: true });
		const kept = item(albumId);

		const admin = await adminPage(browser, server.url);
		await admin.goto('/admin/trash');
		await expect(admin.getByText('Items are removed for good after 30 days.')).toBeVisible();
		await admin.locator('summary', { hasText: 'Empty trash now…' }).click();
		await admin.getByRole('button', { name: 'Yes, delete them for good' }).click();
		await expect(admin.getByRole('status')).toHaveText('Deleted 1 item for good.');
		await expect(admin.getByText('The trash is empty.')).toBeVisible();

		expect(query('SELECT id FROM media WHERE id = ?', trashed)).toEqual([]);
		for (const f of Object.values(filesOf(trashed))) expect(fs.existsSync(f), f).toBe(false);
		expect(query('SELECT id FROM media WHERE id = ?', kept)).toEqual([{ id: kept }]);
		expect(fs.existsSync(filesOf(kept).library)).toBe(true);
		await admin.context().close();
	});

	test('"Delete all archived originals" frees them after a confirm step', async ({ browser }) => {
		const [{ id: albumId }] = query<{ id: number }>("SELECT CAST(value AS INTEGER) AS id FROM settings WHERE key = 'default_album_id'");
		const id = item(albumId);
		const admin = await adminPage(browser, server.url);
		const storage = admin.locator('#storage');
		await storage.locator('summary', { hasText: 'Delete all archived originals…' }).click();
		await expect(storage.getByText('Uploads that didn\'t work keep theirs')).toBeVisible();
		await storage.getByRole('button', { name: 'Yes, delete them' }).click();
		await expect(storage.getByRole('status')).toContainText(/archived originals? and freed/);
		expect(fs.existsSync(filesOf(id).original)).toBe(false);
		expect(fs.existsSync(filesOf(id).library)).toBe(true);
		expect(query('SELECT source_kept FROM media WHERE id = ?', id)).toEqual([{ source_kept: 0 }]);
		await admin.context().close();
	});

	test('deleting an album with items moves them to "Everyday Photos" first', async ({ browser }) => {
		const now = Date.now();
		const [{ id: albumId }] = query<{ id: number }>(
			"INSERT INTO albums(title, created_at, updated_at) VALUES ('Old trip', ?, ?) RETURNING id",
			now,
			now
		);
		const [{ id: everyday }] = query<{ id: number }>("SELECT CAST(value AS INTEGER) AS id FROM settings WHERE key = 'default_album_id'");
		const a = item(albumId);
		const b = item(albumId);

		const admin = await adminPage(browser, server.url);
		const row = admin.locator('#albums').getByRole('listitem').filter({ has: admin.getByRole('link', { name: 'Old trip', exact: true }) });
		await row.locator('summary', { hasText: 'Delete album…' }).click();
		await expect(row).toContainText('“Old trip” still has 2 items');
		await row.getByRole('button', { name: 'Yes, move them and delete it' }).click();
		await expect(admin.locator('#albums').getByRole('status')).toHaveText('"Old trip" is deleted. 2 items were moved to "Everyday Photos".');
		expect(query('SELECT album_id FROM media WHERE id IN (?, ?)', a, b)).toEqual([{ album_id: everyday }, { album_id: everyday }]);
		await admin.context().close();
	});
});
