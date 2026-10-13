/**
 * Admin operations (#lib/server/admin) and the admin routes' server code, called with minimal
 * events: deleting files only inside app dirs, trash purge vs restore, archived originals, retry and
 * reprocess, album deletion, removal-request decisions and the original-file download.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	countOutdated,
	daysLeftInTrash,
	deleteAlbum,
	deleteArchivedOriginals,
	deleteItemFiles,
	emptyTrash,
	listOutdated,
	removeInside,
	reprocessOutdated,
	restoreItem,
	retryItem
} from '#lib/server/admin';
import { getDb } from '#lib/server/db';
import { cacheDir, cacheFile, incomingPath, libraryPath, libraryRoot, originalsPath, originalsRoot } from '#lib/server/paths';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as requests from '#lib/server/repo/requests';
import * as adminRepo from '#lib/server/repo/admin';
import { getDefaultAlbumId } from '#lib/server/repo/settings';
import { wakeIntake } from '#lib/server/intake';
import { wakeQueue } from '#lib/server/queue';
import { GET as getOriginal } from '../../src/routes/admin/original/[id]/+server';
import { actions as requestActions, load as requestLoad } from '../../src/routes/admin/requests/[id]/+page.server';
import { actions as trashActions } from '../../src/routes/admin/trash/+page.server';
import { actions as dashboardActions } from '../../src/routes/admin/+page.server';
import { FakeCookies } from '../helpers/cookies';
import { freshDb, testEnv } from '../helpers/env';

vi.mock('#lib/server/intake', () => ({ wakeIntake: vi.fn(async () => {}) }));
vi.mock('#lib/server/queue', () => ({ wakeQueue: vi.fn() }));

const ADMIN = { role: 'admin', deviceId: 'deviceAAAAAAAAAAAAAAAA', name: 'Michael' } as const;
const FAMILY = { role: 'family', deviceId: 'deviceBBBBBBBBBBBBBBBB', name: 'Jo' } as const;
let seq = 0;

function touchFile(file: string, body = 'x'): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return file;
}

function received(albumId: number, name = 'IMG_0001.HEIC'): string {
	return media.insertReceived({
		uploadToken: `tok${String(++seq).padStart(20, '0')}`,
		albumId,
		sourceName: name,
		sourceSize: 100,
		clientMtimeMs: null,
		uploadedByName: 'Aunt Linda',
		uploadedByDevice: 'deviceAAAAAAAAAAAAAAAA'
	});
}

function ready(albumId: number, opts: { sha?: string; pipelineVersion?: number } = {}): string {
	const id = received(albumId);
	media.markQueued(id, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: opts.sha ?? `sha${++seq}`, estCostS: null });
	media.claimForProcessing(id);
	media.markReady(id, {
		conversion: 'transcode',
		canonicalExt: 'jpg',
		canonicalSize: 1,
		width: 1,
		height: 1,
		takenMs: 1,
		sourceKept: true,
		pipelineVersion: opts.pipelineVersion
	});
	media.sourceSettled(id); // as the lane does once the source is archived
	touchFile(libraryPath(id, 'jpg'));
	touchFile(originalsPath(id, 'heic'), 'original bytes');
	touchFile(cacheFile(id, 'thumb'));
	return id;
}

/** A minimal RequestEvent for the route functions under test. */
function event(locals: App.Locals, opts: { params?: Record<string, string>; form?: Record<string, string>; method?: string } = {}) {
	const url = new URL('http://localhost:3000/admin');
	const body = new URLSearchParams(opts.form ?? {});
	const method = opts.method ?? (opts.form ? 'POST' : 'GET');
	return {
		locals,
		params: opts.params ?? {},
		url,
		cookies: new FakeCookies().asCookies(),
		request: new Request(url, method === 'POST' ? { method, body } : { method })
	} as never;
}

/** Runs a (sync or async) route function and returns what it threw. */
async function thrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('it did not throw');
}

let album: number;
let defaultAlbum: number;

beforeEach(() => {
	freshDb();
	vi.mocked(wakeIntake).mockClear();
	vi.mocked(wakeQueue).mockClear();
	album = albums.create({ title: 'Beach', createdByName: 'Jo', createdByDevice: null }).id;
	defaultAlbum = getDefaultAlbumId()!;
});

describe('files', () => {
	it('refuses to delete anything outside its root and tolerates missing files', async () => {
		const outside = touchFile(path.join(testEnv().root, 'keep.txt'));
		await expect(removeInside(libraryRoot(), outside)).rejects.toThrow(/not inside/);
		await expect(removeInside(libraryRoot(), path.join(libraryRoot(), '..', 'keep.txt'))).rejects.toThrow(/not inside/);
		await expect(removeInside(libraryRoot(), libraryRoot())).rejects.toThrow(/not inside/);
		expect(fs.existsSync(outside)).toBe(true);
		await expect(removeInside(libraryRoot(), path.join(libraryRoot(), 'ZZ', 'missing.jpg'))).resolves.toBeUndefined();
	});

	it("deleteItemFiles removes an item's canonical file, original, upload and cache", async () => {
		const id = ready(album);
		const token = 'uploadTokenAAAAAAAAAAA';
		touchFile(incomingPath(token));
		touchFile(`${incomingPath(token)}.json`);
		await deleteItemFiles({ id, canonical_ext: 'jpg', source_ext: 'heic', upload_token: token });
		for (const f of [libraryPath(id, 'jpg'), originalsPath(id, 'heic'), cacheDir(id), incomingPath(token), `${incomingPath(token)}.json`]) {
			expect(fs.existsSync(f), f).toBe(false);
		}
	});
});

describe('trash', () => {
	it('"Empty trash now" deletes every trashed item for good', async () => {
		const a = ready(album);
		const b = ready(album);
		media.softDelete(a, 'x');
		expect(await emptyTrash()).toBe(1);
		expect(media.getById(a)).toBeUndefined();
		expect(fs.existsSync(libraryPath(a, 'jpg'))).toBe(false);
		expect(media.getById(b)?.deleted_at).toBeNull();
	});

	it('leaves items that intake or a lane is still working on for the next purge', async () => {
		const setStatus = (id: string, status: string) => getDb().prepare('UPDATE media SET status = ? WHERE id = ?').run(status, id);
		const taking = received(album); // intake may be reading its upload
		const converting = ready(album); // e.g. "Redo them", then removed: a lane is writing it
		const waiting = ready(album); // queued, but the queue never claims trashed rows
		const withVideo = ready(album); // its Live Photo video is being converted
		const video = ready(album);
		getDb().prepare('UPDATE media SET live_photo_of = ? WHERE id = ?').run(withVideo, video);
		setStatus(converting, 'processing');
		setStatus(waiting, 'queued');
		setStatus(video, 'processing');
		for (const id of [taking, converting, waiting, withVideo]) media.softDelete(id, 'x');

		expect(await emptyTrash()).toBe(1);
		expect(media.getById(waiting)).toBeUndefined();
		expect(fs.existsSync(libraryPath(waiting, 'jpg'))).toBe(false);
		for (const id of [taking, converting, withVideo, video]) expect(media.getById(id), id).toBeDefined();
		expect(fs.existsSync(libraryPath(converting, 'jpg'))).toBe(true);

		// Once they have settled, the next purge takes them (the video with its photo).
		for (const id of [taking, converting, video]) setStatus(id, 'failed');
		expect(await emptyTrash()).toBe(3);
		for (const id of [taking, converting, withVideo, video]) expect(media.getById(id), id).toBeUndefined();
		expect(fs.existsSync(libraryPath(video, 'jpg'))).toBe(false);
	});

	it('deletes rows before files: a file that cannot be deleted leaves nothing to restore, and the next purge deletes it', async () => {
		const [a, b, c] = [ready(album), ready(album), ready(album)];
		for (const id of [a, b, c]) media.softDelete(id, 'x');
		const stuck = libraryPath(b, 'jpg');
		const realRm = fs.promises.rm;
		const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
			if (p === stuck) throw Object.assign(new Error(`EACCES: permission denied, unlink '${stuck}'`), { code: 'EACCES' });
			return realRm(p, opts);
		});
		try {
			expect(await emptyTrash()).toBe(3);
		} finally {
			rm.mockRestore();
		}
		for (const id of [a, b, c]) expect(media.getById(id), id).toBeUndefined();
		expect(media.listTrash()).toEqual([]);
		expect(await restoreItem(b)).toEqual({ ok: false, reason: 'not_found' });
		for (const id of [a, c]) expect(fs.existsSync(libraryPath(id, 'jpg')), id).toBe(false);
		expect(fs.existsSync(stuck)).toBe(true);
		expect(fs.existsSync(originalsPath(b, 'heic'))).toBe(false); // its other files went
		expect(adminRepo.fileDeletionProblems()).toEqual({ count: 1, lastError: expect.stringContaining('EACCES') });

		// Fixed: the next purge (the daily one, or "Empty trash") finishes the job.
		expect(await emptyTrash()).toBe(0);
		expect(fs.existsSync(stuck)).toBe(false);
		expect(adminRepo.fileDeletionProblems()).toEqual({ count: 0, lastError: null });
		expect(adminRepo.queuedFileDeletions()).toEqual([]);
	});

	it('files whose rows went just before a crash are deleted by the next purge', async () => {
		const a = ready(album);
		media.softDelete(a, 'x');
		// What a purge has done when the process dies right after its transaction.
		adminRepo.deleteMediaQueueingFiles(adminRepo.trashedBefore(Date.now() + 1));
		expect(media.getById(a)).toBeUndefined();
		expect(fs.existsSync(libraryPath(a, 'jpg'))).toBe(true);
		expect(await emptyTrash()).toBe(0);
		for (const f of [libraryPath(a, 'jpg'), originalsPath(a, 'heic'), cacheDir(a)]) expect(fs.existsSync(f), f).toBe(false);
	});

	it('refuses to restore a ready item whose file is gone from library/', async () => {
		const a = ready(album);
		media.softDelete(a, 'x');
		fs.rmSync(libraryPath(a, 'jpg'));
		expect(await restoreItem(a)).toEqual({ ok: false, reason: 'file_missing' });
		expect(media.getById(a)?.deleted_at).not.toBeNull();
		expect(await trashActions.restore(event(ADMIN, { form: { id: a } }))).toMatchObject({
			status: 410,
			data: { section: 'trash', ok: false, message: "The file of IMG_0001.HEIC is gone from the photos folder, so it can't come back." }
		});
		// A failed upload in the trash has no file in library/ and comes back as it was.
		const f = received(album);
		media.markFailed(f, 'corrupt', 'broken');
		media.softDelete(f, 'x');
		expect(await restoreItem(f)).toEqual({ ok: true });
	});

	it('a restore asked for during a purge waits for it (and finds the item gone)', async () => {
		const a = ready(album);
		media.softDelete(a, 'x');
		const purge = emptyTrash();
		const restore = restoreItem(a);
		expect(await purge).toBe(1);
		expect(await restore).toEqual({ ok: false, reason: 'not_found' });
	});

	it('counts the days an item has left', () => {
		const now = Date.UTC(2026, 9, 13);
		expect(daysLeftInTrash(now, now)).toBe(30);
		expect(daysLeftInTrash(now - 29.5 * 86_400_000, now)).toBe(1);
		expect(daysLeftInTrash(now - 40 * 86_400_000, now)).toBe(0);
	});
});

describe('archived originals and redoing', () => {
	it('deletes the originals of ready items only; failed items keep theirs', async () => {
		const ok = ready(album);
		const bad = received(album);
		media.markFailed(bad, 'corrupt', 'broken', { kind: 'photo', sourceExt: 'heic', sourceKept: true });
		touchFile(originalsPath(bad, 'heic'));

		expect(await deleteArchivedOriginals()).toEqual({ count: 1, bytes: 100 });
		expect(fs.existsSync(originalsPath(ok, 'heic'))).toBe(false);
		expect(media.getById(ok)?.source_kept).toBe(0);
		expect(fs.existsSync(originalsPath(bad, 'heic'))).toBe(true);
		expect(media.getById(bad)?.source_kept).toBe(1);
		expect(fs.existsSync(path.dirname(originalsPath(ok, 'heic')))).toBe(true);
		expect(fs.existsSync(originalsRoot())).toBe(true);
	});

	it('queues items made by an older pipeline again and wakes the lanes', async () => {
		const old = ready(album, { pipelineVersion: 0 });
		ready(album);
		const trashed = ready(album, { pipelineVersion: 0 }); // can't be redone, so not counted
		media.softDelete(trashed, 'x');
		expect(listOutdated().map((r) => r.id)).toEqual([old]);
		expect(await reprocessOutdated()).toBe(1);
		expect(listOutdated()).toEqual([]);
		expect(countOutdated()).toBe(0);
		// Still ready and visible while it waits for its redo.
		expect(media.getById(old)).toMatchObject({ status: 'ready', redo_state: 'queued' });
		expect(media.listByAlbum(album).items.map((r) => r.id)).toContain(old);
		expect(wakeQueue).toHaveBeenCalledTimes(1);
		// Its archived original is kept while it is being redone.
		expect(await deleteArchivedOriginals()).toMatchObject({ count: 2 }); // the up-to-date one and the trashed one
		expect(fs.existsSync(originalsPath(old, 'heic'))).toBe(true);
	});

	it('"Try again" wakes intake or the lanes, depending on where the item goes back to', () => {
		const early = received(album);
		media.markFailed(early, 'retryable', 'hash failed');
		expect(retryItem(early)).toBe('received');
		expect(wakeIntake).toHaveBeenCalledTimes(1);

		const late = received(album);
		media.markQueued(late, { kind: 'photo', sourceMime: 'image/heic', sourceExt: 'heic', sourceSha256: 'shaLate', estCostS: null });
		media.claimForProcessing(late);
		media.markFailed(late, 'retryable', 'timeout');
		expect(retryItem(late)).toBe('queued');
		expect(wakeQueue).toHaveBeenCalledTimes(1);

		// Its upload is gone: nothing to try again with.
		getDb().prepare('UPDATE media SET upload_token = NULL, source_kept = 0 WHERE id = ?').run(early);
		media.markFailed(early, 'retryable', 'again');
		expect(retryItem(early)).toBeNull();
	});
});

describe('deleteAlbum', () => {
	it('never deletes "Everyday Photos"; deletes an empty album; asks before moving items', () => {
		expect(deleteAlbum(defaultAlbum, { moveItems: true })).toEqual({ ok: false, reason: 'default_album' });
		const empty = albums.create({ title: 'Empty', createdByName: null, createdByDevice: null }).id;
		expect(deleteAlbum(empty, { moveItems: false })).toEqual({ ok: true, moved: 0, trashed: 0 });
		expect(albums.get(empty)).toBeUndefined();
		ready(album);
		expect(deleteAlbum(album, { moveItems: false })).toEqual({ ok: false, reason: 'not_empty', count: 1 });
		expect(deleteAlbum(9999, { moveItems: true })).toEqual({ ok: false, reason: 'not_found' });
	});

	it('moves everything to "Everyday Photos" first; a copy already there goes to the trash', () => {
		const a = ready(album, { sha: 'same' });
		const b = ready(album);
		const failed = received(album);
		media.markFailed(failed, 'corrupt', 'x');
		const existing = ready(defaultAlbum, { sha: 'same' });

		expect(deleteAlbum(album, { moveItems: true })).toEqual({ ok: true, moved: 2, trashed: 1 });
		expect(albums.get(album)).toBeUndefined();
		for (const id of [a, b, failed, existing]) expect(media.getById(id)?.album_id).toBe(defaultAlbum);
		expect(media.getById(a)?.deleted_at).not.toBeNull();
		expect(media.getById(b)?.deleted_at).toBeNull();
	});
});

describe('/admin/requests/[id]', () => {
	function ask(mediaId: string, device: string) {
		return requests.create({ mediaId, requesterName: 'Aunt Linda', requesterDevice: device, reason: 'in_it' }).request.id;
	}

	it('Remove trashes the item and approves every pending request for it', async () => {
		const id = ready(album);
		const r1 = ask(id, 'deviceCCCCCCCCCCCCCCCC');
		const r2 = ask(id, 'deviceDDDDDDDDDDDDDDDD');
		const res = await requestActions.remove(event(ADMIN, { params: { id: String(r1) }, form: {} }));
		expect(res).toMatchObject({ ok: true, section: 'request' });
		expect(media.getById(id)?.deleted_at).not.toBeNull();
		expect(media.getById(id)?.deleted_reason).toBe("Aunt Linda asked: I'm in it and don't want it shared");
		for (const r of [r1, r2]) expect(requests.get(r)).toMatchObject({ status: 'approved', resolved_action: 'removed' });

		const again = await requestActions.remove(event(ADMIN, { params: { id: String(r1) }, form: {} }));
		expect(again).toMatchObject({ status: 409, data: { message: 'This request was already handled.' } });
	});

	it('Move reports a duplicate in the target album and leaves the request pending', async () => {
		const id = ready(album, { sha: 'dup' });
		const there = ready(defaultAlbum, { sha: 'dup' });
		const rid = ask(id, 'deviceCCCCCCCCCCCCCCCC');
		const res = await requestActions.move(event(ADMIN, { params: { id: String(rid) }, form: { album: String(defaultAlbum) } }));
		expect(res).toMatchObject({ status: 409, data: { conflictId: there } });
		expect(requests.get(rid)?.status).toBe('pending');

		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null }).id;
		const ok = await requestActions.move(event(ADMIN, { params: { id: String(rid) }, form: { album: String(other) } }));
		expect(ok).toMatchObject({ ok: true, message: 'Moved to “Other”.' });
		expect(media.getById(id)?.album_id).toBe(other);
		expect(requests.get(rid)).toMatchObject({ status: 'approved', resolved_action: 'moved' });
	});

	it('Move also approves the other "Wrong album" requests for the item, and leaves the rest pending', async () => {
		const id = ready(album);
		const ask2 = (device: string, reason: 'wrong_album' | 'in_it') =>
			requests.create({ mediaId: id, requesterName: 'Cousin Sam', requesterDevice: device, reason }).request.id;
		const reviewed = ask2('deviceCCCCCCCCCCCCCCCC', 'wrong_album');
		const same = ask2('deviceDDDDDDDDDDDDDDDD', 'wrong_album');
		const other = ask2('deviceEEEEEEEEEEEEEEEE', 'in_it');
		const unrelated = requests.create({ mediaId: ready(album), requesterName: 'Jo', requesterDevice: 'deviceFFFFFFFFFFFFFFFF', reason: 'wrong_album' }).request.id;

		const res = await requestActions.move(event(ADMIN, { params: { id: String(reviewed) }, form: { album: String(defaultAlbum) } }));
		expect(res).toMatchObject({ ok: true });
		for (const r of [reviewed, same]) expect(requests.get(r)).toMatchObject({ status: 'approved', resolved_action: 'moved' });
		expect(requests.get(other)?.status).toBe('pending');
		expect(requests.get(unrelated)?.status).toBe('pending');
	});

	it('Dismiss changes nothing but the request; family members are refused', async () => {
		const id = ready(album);
		const rid = ask(id, 'deviceCCCCCCCCCCCCCCCC');
		expect(await thrown(() => requestActions.dismiss(event(FAMILY, { params: { id: String(rid) }, form: {} })))).toMatchObject({ status: 403 });
		expect(await thrown(() => requestLoad(event(FAMILY, { params: { id: String(rid) } })))).toMatchObject({ status: 403 });
		expect(await thrown(() => requestLoad(event(ADMIN, { params: { id: '999' } })))).toMatchObject({ status: 404 });
		await requestActions.dismiss(event(ADMIN, { params: { id: String(rid) }, form: {} }));
		expect(requests.get(rid)).toMatchObject({ status: 'dismissed', resolved_action: null });
		expect(media.getById(id)?.deleted_at).toBeNull();
	});
});

describe('/admin/trash and dashboard actions', () => {
	it('Restore reports a duplicate that came back meanwhile', async () => {
		const id = ready(album, { sha: 'again' });
		media.softDelete(id, 'x');
		const back = ready(album, { sha: 'again' });
		const res = await trashActions.restore(event(ADMIN, { form: { id } }));
		expect(res).toMatchObject({ status: 409, data: { conflictId: back } });
		media.softDelete(back, 'x');
		expect(await trashActions.restore(event(ADMIN, { form: { id } }))).toMatchObject({ ok: true });
		expect(media.getById(id)?.deleted_at).toBeNull();
	});

	it('Reset access bumps the generation and keeps the admin signed in', async () => {
		const e = event(ADMIN, { form: {} }) as unknown as { cookies: FakeCookies };
		const before = getDb().prepare("SELECT value FROM settings WHERE key = 'access_gen'").pluck().get();
		expect(await dashboardActions.resetAccess(e as never)).toMatchObject({ ok: true, section: 'access' });
		expect(getDb().prepare("SELECT value FROM settings WHERE key = 'access_gen'").pluck().get()).toBe(String(Number(before) + 1));
		expect(e.cookies.jar.get('fp_access')).toBeTruthy();
		expect(await thrown(() => dashboardActions.resetAccess(event(FAMILY, { form: {} })))).toMatchObject({ status: 403 });
	});
});

describe('/admin/original/[id]', () => {
	it('serves the archived source as a sandboxed attachment to the admin only', async () => {
		const id = ready(album);
		expect((await getOriginal(event(FAMILY, { params: { id } }))).status).toBe(403);

		const res = await getOriginal(event(ADMIN, { params: { id } }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/octet-stream');
		expect(res.headers.get('content-disposition')).toBe(`attachment; filename="IMG_0001.HEIC"; filename*=UTF-8''IMG_0001.HEIC`);
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await res.text()).toBe('original bytes');
	});

	it('is a 404 when no source is kept or the id is bad', async () => {
		const id = ready(album);
		getDb().prepare('UPDATE media SET source_kept = 0 WHERE id = ?').run(id);
		expect((await getOriginal(event(ADMIN, { params: { id } }))).status).toBe(404);
		expect((await getOriginal(event(ADMIN, { params: { id: '../../etc/passwd' } }))).status).toBe(404);
		const kept = ready(album);
		fs.rmSync(originalsPath(kept, 'heic'));
		expect((await getOriginal(event(ADMIN, { params: { id: kept } }))).status).toBe(404);
	});
});
