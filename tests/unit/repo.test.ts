import { beforeEach, describe, expect, it } from 'vitest';
import * as albums from '#lib/server/repo/albums';
import * as media from '#lib/server/repo/media';
import * as memories from '#lib/server/repo/memories';
import * as requests from '#lib/server/repo/requests';
import * as settings from '#lib/server/repo/settings';
import { getDb } from '#lib/server/db';
import { ValidationError } from '#lib/shared/errors';
import { PIPELINE_VERSION, type Kind } from '#lib/shared/media-types';
import { freshDb } from '../helpers/env';

const DEV_A = 'deviceAAAAAAAAAAAAAAAA';
const DEV_B = 'deviceBBBBBBBBBBBBBBBB';
let tokenSeq = 0;

function received(albumId: number, opts: { device?: string; name?: string; sourceName?: string } = {}): string {
	return media.insertReceived({
		uploadToken: `tok${String(++tokenSeq).padStart(20, '0')}`,
		albumId,
		sourceName: opts.sourceName ?? 'IMG_0001.HEIC',
		sourceSize: 1234,
		clientMtimeMs: 1_700_000_000_000,
		uploadedByName: opts.name ?? 'Aunt Linda',
		uploadedByDevice: opts.device ?? DEV_A
	});
}

function queued(albumId: number, sha: string, kind: Kind = 'photo', estCostS: number | null = null): string {
	const id = received(albumId);
	expect(
		media.markQueued(id, { kind, sourceMime: kind === 'photo' ? 'image/heic' : 'video/quicktime', sourceExt: kind === 'photo' ? 'heic' : 'mov', sourceSha256: sha, estCostS })
	).toEqual({ outcome: 'queued' });
	return id;
}

function ready(
	albumId: number,
	sha: string,
	takenMs: number,
	extra: Partial<media.ReadyFields> & { kind?: Kind } = {}
): string {
	const id = queued(albumId, sha, extra.kind ?? 'photo');
	expect(media.claimForProcessing(id)).toBeTruthy();
	expect(
		media.markReady(id, {
			conversion: 'transcode',
			canonicalExt: extra.kind === 'video' ? 'mp4' : 'jpg',
			canonicalSize: 1000,
			width: 4032,
			height: 3024,
			takenMs,
			takenAt: '2024-07-04T11:22:31-07:00',
			sourceKept: true,
			...extra
		})
	).toBe(true);
	return id;
}

let defaultAlbum: number;

beforeEach(() => {
	freshDb();
	defaultAlbum = settings.getDefaultAlbumId()!;
});

describe('settings', () => {
	it('seeds secret, access_gen and the default album', () => {
		expect(settings.getSecret()).toMatch(/^[0-9a-f]{64}$/);
		expect(settings.getAccessGen()).toBe(1);
		expect(albums.get(defaultAlbum)?.title).toBe('Everyday Photos');
		expect(settings.bumpAccessGen()).toBe(2);
		expect(settings.getAccessGen()).toBe(2);
		settings.setSetting('x', 'y');
		settings.setSetting('x', 'z');
		expect(settings.getSetting('x')).toBe('z');
	});
});

describe('albums', () => {
	it('creates, lists with counts and cover, orders by updated_at', () => {
		const a = albums.create({ title: '  Retreat 2023 ', whenText: 'June 2023', createdByName: 'Bob', createdByDevice: DEV_B });
		expect(a.title).toBe('Retreat 2023');
		expect(a.when_text).toBe('June 2023');

		const p1 = ready(a.id, 'sha-1', 1000);
		const p2 = ready(a.id, 'sha-2', 2000);
		ready(a.id, 'sha-v', 1500, { kind: 'video', durationMs: 10_000 });
		received(a.id); // not visible yet
		const gone = ready(a.id, 'sha-3', 3000);
		media.softDelete(gone, 'test');

		const list = albums.list();
		expect(list[0].id).toBe(a.id); // touched by markReady → most recent
		const s = list.find((x) => x.id === a.id)!;
		expect(s.item_count).toBe(3);
		expect(s.photo_count).toBe(2);
		expect(s.video_count).toBe(1);
		expect(s.cover_id).toBe(p2); // newest visible
		expect(s.cover_kind).toBe('photo');

		albums.update(a.id, { coverMediaId: p1 });
		expect(albums.getSummary(a.id)!.cover_id).toBe(p1);
		media.softDelete(p1, 'test');
		expect(albums.getSummary(a.id)!.cover_id).toBe(p2); // falls back when the cover is trashed

		const empty = list.find((x) => x.id === defaultAlbum)!;
		expect(empty.item_count).toBe(0);
		expect(empty.cover_id).toBeNull();
	});

	it('updates, validates, touches, soft-deletes and restores', () => {
		const a = albums.create({ title: 'Trip', createdByName: 'Bob', createdByDevice: DEV_B });
		expect(() => albums.create({ title: '   ', createdByName: null, createdByDevice: null })).toThrow(ValidationError);
		const u = albums.update(a.id, { title: 'Big trip', description: 'Fun', whenText: null })!;
		expect(u).toMatchObject({ title: 'Big trip', description: 'Fun', when_text: null });
		expect(() => albums.update(a.id, { title: '' })).toThrow(ValidationError);
		const before = albums.get(a.id)!.updated_at;
		albums.touch(a.id, before + 5000);
		expect(albums.get(a.id)!.updated_at).toBe(before + 5000);
		albums.touch(a.id, before); // never goes backwards
		expect(albums.get(a.id)!.updated_at).toBe(before + 5000);

		expect(albums.softDelete(a.id)).toBe(true);
		expect(albums.get(a.id)).toBeUndefined();
		expect(albums.get(a.id, { includeDeleted: true })).toBeTruthy();
		expect(albums.list().some((x) => x.id === a.id)).toBe(false);
		expect(albums.listDeleted().map((x) => x.id)).toEqual([a.id]);
		expect(albums.restore(a.id)).toBe(true);
		expect(albums.get(a.id)).toBeTruthy();
	});

	it('canEdit: creator device or admin', () => {
		const a = albums.create({ title: 'Trip', createdByName: 'Bob', createdByDevice: DEV_B });
		expect(albums.canEdit(a, { role: 'family', deviceId: DEV_B })).toBe(true);
		expect(albums.canEdit(a, { role: 'family', deviceId: DEV_A })).toBe(false);
		expect(albums.canEdit(a, { role: 'admin', deviceId: null })).toBe(true);
	});
});

describe('media lifecycle', () => {
	it('insertReceived returns a ULID, is idempotent per token and sanitises the name', () => {
		const token = 'tokIDEMPOTENT000000000';
		const input = {
			uploadToken: token,
			albumId: defaultAlbum,
			sourceName: '../../evil/IMG_1.HEIC',
			sourceSize: 10,
			clientMtimeMs: null,
			uploadedByName: 'Jo',
			uploadedByDevice: DEV_A
		};
		const id = media.insertReceived(input);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(media.insertReceived(input)).toBe(id);
		const row = media.getByUploadToken(token)!;
		expect(row).toMatchObject({ id, status: 'received', source_name: 'IMG_1.HEIC', attempts: 0, kind: null });
		expect(media.sanitizeSourceName('a:b*c?.jpg')).toBe('a_b_c_.jpg');
		expect(media.sanitizeSourceName('')).toBe('upload');
		expect(media.listReceived().map((r) => r.id)).toEqual([id]);
	});

	it('claimForProcessing sets processing and increments attempts once per claim', () => {
		const id = queued(defaultAlbum, 'sha-claim');
		const row = media.claimForProcessing(id)!;
		expect(row).toMatchObject({ id, status: 'processing', attempts: 1 });
		expect(media.claimForProcessing(id)).toBeUndefined(); // not queued any more
		expect(media.requeue(id, 'crash')).toBe(true);
		expect(media.getById(id)!.status).toBe('queued');
		expect(media.claimForProcessing(id)!.attempts).toBe(2);
	});

	it('markReady fills the canonical fields, clears the token, sets pipeline_version', () => {
		const id = ready(defaultAlbum, 'sha-ready', 1234, { gpsLat: 37.3, gpsLon: -122.0, contentId: 'CID' });
		const row = media.getById(id)!;
		expect(row).toMatchObject({
			status: 'ready',
			conversion: 'transcode',
			canonical_ext: 'jpg',
			width: 4032,
			height: 3024,
			taken_ms: 1234,
			gps_lat: 37.3,
			source_kept: 1,
			upload_token: null,
			pipeline_version: PIPELINE_VERSION,
			error_code: null
		});
		// only from processing
		expect(media.markReady(id, { conversion: 'none', canonicalExt: 'jpg', canonicalSize: 1, width: 1, height: 1, takenMs: 1, sourceKept: false })).toBe(false);
	});

	it('markReady falls back to created_at for a takenMs that is not a valid epoch time', () => {
		for (const [i, bad] of [NaN, Infinity, -Infinity, 1e300, -9e15].entries()) {
			const id = ready(defaultAlbum, `sha-bad-date-${i}`, bad);
			const row = media.getById(id)!;
			expect(row.taken_ms, String(bad)).toBe(row.created_at);
		}
		const edge = ready(defaultAlbum, 'sha-edge-date', -8.64e15); // the earliest a Date can hold
		expect(media.getById(edge)!.taken_ms).toBe(-8.64e15);
		expect(media.listByAlbum(defaultAlbum).items).toHaveLength(6);
	});

	it('markFailed and requeue never touch a ready row (a failure reported after the commit)', () => {
		const id = ready(defaultAlbum, 'sha-done', 1);
		expect(media.markFailed(id, 'retryable', 'timeout after commit')).toBe(false);
		expect(media.requeue(id, 'crash after commit')).toBe(false);
		expect(media.getById(id)).toMatchObject({ status: 'ready', error_code: null, error_detail: null });
		// nor a duplicate or an already failed one
		const dup = received(defaultAlbum);
		media.markQueued(dup, { kind: 'photo', sourceMime: 'image/jpeg', sourceSha256: 'sha-done', estCostS: null });
		expect(media.markFailed(dup, 'corrupt', 'x')).toBe(false);
		const f = queued(defaultAlbum, 'sha-f2');
		expect(media.markFailed(f, 'unsupported', 'first')).toBe(true); // from queued
		expect(media.markFailed(f, 'corrupt', 'second')).toBe(false);
		expect(media.getById(f)).toMatchObject({ error_code: 'unsupported', error_detail: 'first' });
		const r = received(defaultAlbum);
		expect(media.markFailed(r, 'unsupported', 'svg', { sourceMime: 'image/svg+xml' })).toBe(true); // from received
	});

	it('markFailed records code/detail; retry re-queues while the source exists', () => {
		const id = queued(defaultAlbum, 'sha-fail');
		media.claimForProcessing(id);
		expect(media.markFailed(id, 'corrupt', 'heif-dec: broken')).toBe(true);
		expect(media.getById(id)).toMatchObject({ status: 'failed', error_code: 'corrupt', error_detail: 'heif-dec: broken' });
		expect(media.listFailed().map((r) => r.id)).toEqual([id]);
		expect(media.retry(id)).toBe('queued');
		expect(media.getById(id)).toMatchObject({ status: 'queued', attempts: 0, error_code: null });
	});

	it('retry refuses a trashed failed item', () => {
		const id = queued(defaultAlbum, 'sha-fail-trash');
		media.claimForProcessing(id);
		media.markFailed(id, 'retryable', 'timeout');
		expect(media.softDelete(id, 'not wanted')).toBe(true);
		expect(media.retry(id)).toBeNull();
		expect(media.getById(id)).toMatchObject({ status: 'failed', error_code: 'retryable' });
	});

	it('requeueInterrupted re-queues processing rows and fails ones out of attempts', () => {
		const a = queued(defaultAlbum, 'sha-int-a');
		const b = queued(defaultAlbum, 'sha-int-b');
		media.claimForProcessing(a);
		for (let i = 0; i < 3; i++) {
			media.claimForProcessing(b);
			if (i < 2) media.requeue(b);
		}
		const r = media.requeueInterrupted();
		expect(r).toEqual({ requeued: [a], failed: [b] });
		expect(media.getById(a)!.status).toBe('queued');
		expect(media.getById(b)).toMatchObject({ status: 'failed', error_code: 'retryable' });
	});

	it('nextQueued: photos FIFO; videos by est_cost_s − 0.5 × wait_s', () => {
		const db = getDb();
		const setQueued = (id: string, ms: number) => db.prepare('UPDATE media SET queued_ms = ? WHERE id = ?').run(ms, id);
		const now = 10_000_000;

		const p1 = queued(defaultAlbum, 'p1');
		const p2 = queued(defaultAlbum, 'p2');
		setQueued(p1, now - 1000);
		setQueued(p2, now - 5000);
		expect(media.nextQueued('photo', now)!.id).toBe(p2);
		expect(media.queueOrder('photo', now)).toEqual([p2, p1]);

		// A 1-hour 4K job queued 10 minutes ago vs a 20 s clip queued just now:
		const big = queued(defaultAlbum, 'v-big', 'video', 3600);
		const small = queued(defaultAlbum, 'v-small', 'video', 20);
		setQueued(big, now - 600_000); // score 3600 - 300 = 3300
		setQueued(small, now); // score 20
		expect(media.nextQueued('video', now)!.id).toBe(small);
		// ...but long jobs age forward: after 2 hours of waiting the big one wins.
		setQueued(big, now - 2 * 3600_000); // score 3600 - 3600 = 0
		expect(media.nextQueued('video', now)!.id).toBe(big);
		expect(media.queueOrder('video', now)).toEqual([big, small]);
		expect(media.nextQueued('photo', now)!.kind).toBe('photo');
	});

	it('listByAlbum pages newest-first on (taken_ms, id) and hides non-visible items', () => {
		const ids = [ready(defaultAlbum, 's1', 100), ready(defaultAlbum, 's2', 300), ready(defaultAlbum, 's3', 300), ready(defaultAlbum, 's4', 200)];
		received(defaultAlbum);
		const failed = queued(defaultAlbum, 's5');
		media.claimForProcessing(failed);
		media.markFailed(failed, 'unsupported', 'x');

		const first = media.listByAlbum(defaultAlbum, { limit: 2 });
		expect(first.items.map((m) => m.taken_ms)).toEqual([300, 300]);
		expect(first.items[0].id > first.items[1].id).toBe(true); // tie broken by id DESC
		expect(first.next).not.toBeNull();
		const cursor = media.decodeCursor(media.encodeCursor(first.next!));
		const second = media.listByAlbum(defaultAlbum, { limit: 2, before: cursor });
		expect(second.items.map((m) => m.taken_ms)).toEqual([200, 100]);
		expect(second.next).toBeNull();
		expect(new Set([...first.items, ...second.items].map((m) => m.id))).toEqual(new Set(ids));
		expect(media.decodeCursor('garbage')).toBeNull();

		// prev/next follow the same order
		const order = [...first.items, ...second.items].map((m) => m.id);
		expect(media.prevNext(order[0])).toEqual({ prev: null, next: order[1] });
		expect(media.prevNext(order[2])).toEqual({ prev: order[1], next: order[3] });
		expect(media.prevNext(order[3])).toEqual({ prev: order[2], next: null });

		expect(media.listRecent({ limit: 10 }).length).toBe(4);
		expect(media.listAllVisibleInAlbum(defaultAlbum).map((m) => m.taken_ms)).toEqual([100, 200, 300, 300]);
	});

	it('listPending shows unfinished tiles per device; statusForIds reports status', () => {
		const a = received(defaultAlbum, { device: DEV_A });
		const b = queued(defaultAlbum, 'pend-b');
		const c = received(defaultAlbum, { device: DEV_B });
		ready(defaultAlbum, 'pend-ready', 1);
		expect(media.listPending({ device: DEV_A }).map((r) => r.id).sort()).toEqual([a, b].sort());
		expect(media.listPending({ device: null }).map((r) => r.id).sort()).toEqual([a, b, c].sort());
		expect(media.listPending({ device: DEV_A, albumId: 999 })).toEqual([]);

		const st = media.statusForIds([a, b, 'NOPE']);
		expect(st.map((s) => [s.id, s.status]).sort()).toEqual([[a, 'received'], [b, 'queued']].sort());
		expect(media.statusForIds([])).toEqual([]);
	});

	it('soft delete / restore / trash (Live Photo video follows its photo)', () => {
		const photo = ready(defaultAlbum, 'lp-photo', 1000, { contentId: 'ABC' });
		const video = ready(defaultAlbum, 'lp-video', 1000, { kind: 'video', contentId: 'ABC', durationMs: 3000 });
		expect(media.getById(video)!.live_photo_of).toBe(photo); // paired on ready
		expect(media.livePhotoVideoFor(photo)!.id).toBe(video);
		expect(media.listByAlbum(defaultAlbum).items.map((m) => m.id)).toEqual([photo]); // video hidden

		expect(media.softDelete(photo, 'Removed at Aunt Linda’s request')).toBe(true);
		expect(media.getById(video)!.deleted_at).not.toBeNull();
		expect(media.listTrash().map((m) => m.id)).toEqual([photo]);
		expect(media.listByAlbum(defaultAlbum).items).toEqual([]);

		expect(media.restore(photo)).toEqual({ ok: true });
		expect(media.getById(video)!.deleted_at).toBeNull();
		expect(media.listByAlbum(defaultAlbum).items.map((m) => m.id)).toEqual([photo]);
		// Purging the trash for good is admin.purgeTrash (tests/unit/maintenance.test.ts).
	});

	it('pairs Live Photos whichever finishes first, but not long videos', () => {
		const video = ready(defaultAlbum, 'lp2-video', 1000, { kind: 'video', contentId: 'XYZ', durationMs: 2500 });
		const longVideo = ready(defaultAlbum, 'lp2-long', 1000, { kind: 'video', contentId: 'XYZ', durationMs: 60_000 });
		expect(media.getById(video)!.live_photo_of).toBeNull();
		const photo = ready(defaultAlbum, 'lp2-photo', 1000, { contentId: 'XYZ' });
		expect(media.getById(video)!.live_photo_of).toBe(photo);
		expect(media.getById(longVideo)!.live_photo_of).toBeNull();
	});

	it('move() moves to another album and refuses duplicates there', () => {
		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null });
		const a = ready(defaultAlbum, 'mv-1', 1);
		const b = ready(defaultAlbum, 'mv-2', 1);
		ready(other.id, 'mv-2', 1);
		expect(media.move(a, other.id)).toEqual({ ok: true });
		expect(media.getById(a)!.album_id).toBe(other.id);
		const r = media.move(b, other.id);
		expect(r).toMatchObject({ ok: false, reason: 'duplicate' });
		expect(media.move(b, 99999)).toEqual({ ok: false, reason: 'album_not_found' });
	});

	it('move() refuses when the Live Photo video’s bytes are already live in the target album', () => {
		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null });
		const photo = ready(defaultAlbum, 'mvlp-photo', 1, { contentId: 'MV' });
		const video = ready(defaultAlbum, 'mvlp-video', 1, { kind: 'video', contentId: 'MV', durationMs: 2000 });
		expect(media.getById(video)!.live_photo_of).toBe(photo);
		const there = ready(other.id, 'mvlp-video', 1, { kind: 'video', durationMs: 2000 });
		expect(media.move(photo, other.id)).toEqual({ ok: false, reason: 'duplicate', conflictId: there });
		expect([media.getById(photo)!.album_id, media.getById(video)!.album_id]).toEqual([defaultAlbum, defaultAlbum]);
		// Once that copy is trashed, the pair moves together.
		media.softDelete(there, 'gone');
		expect(media.move(photo, other.id)).toEqual({ ok: true });
		expect([media.getById(photo)!.album_id, media.getById(video)!.album_id]).toEqual([other.id, other.id]);
	});

	it('restore() refuses when the Live Photo video’s bytes are live in the album again', () => {
		const photo = ready(defaultAlbum, 'rslp-photo', 1, { contentId: 'RS' });
		const video = ready(defaultAlbum, 'rslp-video', 1, { kind: 'video', contentId: 'RS', durationMs: 2000 });
		media.softDelete(photo, 'oops');
		const reupload = ready(defaultAlbum, 'rslp-video', 1, { kind: 'video', durationMs: 2000 });
		expect(media.restore(photo)).toEqual({ ok: false, reason: 'duplicate', conflictId: reupload });
		expect(media.getById(photo)!.deleted_at).not.toBeNull();
		expect(media.getById(video)!.deleted_at).not.toBeNull();
		media.softDelete(reupload, 'make room');
		expect(media.restore(photo)).toEqual({ ok: true });
		expect(media.livePhotoVideoFor(photo)!.id).toBe(video);
	});

	it('a refused move or restore names the photo, not the hidden Live Photo video it collides with', () => {
		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null });
		// The other album has a Live Photo whose video has the same bytes as ours.
		const theirPhoto = ready(other.id, 'vis-their-photo', 1, { contentId: 'THEIRS' });
		const theirVideo = ready(other.id, 'vis-video', 1, { kind: 'video', contentId: 'THEIRS', durationMs: 2000 });
		expect(media.getById(theirVideo)!.live_photo_of).toBe(theirPhoto);
		const photo = ready(defaultAlbum, 'vis-photo', 1, { contentId: 'OURS' });
		ready(defaultAlbum, 'vis-video', 1, { kind: 'video', contentId: 'OURS', durationMs: 2000 });
		expect(media.move(photo, other.id)).toEqual({ ok: false, reason: 'duplicate', conflictId: theirPhoto });

		// Trashed, then the same Live Photo is uploaded again: restore names the new photo.
		media.softDelete(photo, 'oops');
		const again = ready(defaultAlbum, 'vis-photo-again', 1, { contentId: 'AGAIN' });
		const againVideo = ready(defaultAlbum, 'vis-video', 1, { kind: 'video', contentId: 'AGAIN', durationMs: 2000 });
		expect(media.getById(againVideo)!.live_photo_of).toBe(again);
		expect(media.restore(photo)).toEqual({ ok: false, reason: 'duplicate', conflictId: again });
	});

	it('storage totals', () => {
		ready(defaultAlbum, 'st-1', 1, { canonicalSize: 500 });
		ready(defaultAlbum, 'st-2', 1, { canonicalSize: 700, sourceKept: false });
		const t = media.storageTotals();
		expect(t.canonicalBytes).toBe(1200);
		expect(t.originalsBytes).toBe(1234); // source_size of the one kept original
		expect(t.originalsCount).toBe(1);
		expect(t.readyCount).toBe(2);
		expect(t.photoCount).toBe(2);
	});
});

describe('duplicates (partial UNIQUE index on album_id, source_sha256)', () => {
	it('a second upload of the same bytes becomes a duplicate row', () => {
		const first = ready(defaultAlbum, 'same-bytes', 1);
		const second = received(defaultAlbum);
		expect(media.findDuplicate(defaultAlbum, 'same-bytes', second)!.id).toBe(first);
		expect(media.markQueued(second, { kind: 'photo', sourceMime: 'image/jpeg', sourceSha256: 'same-bytes', estCostS: null })).toEqual({
			outcome: 'duplicate',
			duplicateOf: first
		});
		expect(media.getById(second)).toMatchObject({ status: 'duplicate', duplicate_of: first, source_sha256: 'same-bytes', upload_token: null });
		// a third one too — duplicate rows never collide with each other
		const third = received(defaultAlbum);
		expect(media.markDuplicate(third, first, 'same-bytes')).toBe(true);
		expect(media.markDuplicate(third, first, 'same-bytes')).toBe(false); // only from received
		expect(media.markDuplicate(first, third, 'same-bytes')).toBe(false); // never a ready item
		expect(media.getById(first)!.status).toBe('ready');
		expect(media.purgeDuplicatesOlderThan(60_000)).toEqual([]); // too recent
		const purged = media.purgeDuplicatesOlderThan(0, Date.now() + 1);
		expect(purged.map((r) => r.id).sort()).toEqual([second, third].sort());
		expect(media.getById(second)).toBeUndefined();
	});

	it('the same bytes are fine in another album', () => {
		const other = albums.create({ title: 'Other', createdByName: null, createdByDevice: null });
		ready(defaultAlbum, 'cross', 1);
		const id = received(other.id);
		expect(media.markQueued(id, { kind: 'photo', sourceMime: 'image/jpeg', sourceSha256: 'cross', estCostS: null })).toEqual({ outcome: 'queued' });
	});

	it('the database itself rejects two live rows with the same hash', () => {
		const a = ready(defaultAlbum, 'raw-dup', 1);
		const b = received(defaultAlbum);
		expect(() => getDb().prepare(`UPDATE media SET status = 'queued', source_sha256 = 'raw-dup' WHERE id = ?`).run(b)).toThrow(/UNIQUE/);
		expect(a).toBeTruthy();
	});

	it('failed and trashed rows are exempt; restoring a trashed copy that is live again is a conflict', () => {
		const failed = queued(defaultAlbum, 'retry-bytes');
		media.claimForProcessing(failed);
		media.markFailed(failed, 'retryable', 'timeout');
		const again = queued(defaultAlbum, 'retry-bytes'); // allowed: the failed attempt is exempt
		expect(media.retry(failed)).toBe('duplicate'); // can't come back while `again` is live
		// the upload token is released (the .incoming sweep deletes the file)
		expect(media.getById(failed)).toMatchObject({ duplicate_of: again, upload_token: null });
		expect(media.tokensInUse().size).toBe(1);

		const trashed = ready(defaultAlbum, 'trash-bytes', 1);
		media.softDelete(trashed, 'oops');
		const reupload = queued(defaultAlbum, 'trash-bytes');
		expect(media.restore(trashed)).toEqual({ ok: false, reason: 'duplicate', conflictId: reupload });
	});

	it('markQueued only accepts received rows', () => {
		const id = queued(defaultAlbum, 'only-once');
		expect(() => media.markQueued(id, { kind: 'photo', sourceMime: 'image/jpeg', sourceSha256: 'x', estCostS: null })).toThrow(/not received/);
	});
});

describe('memories', () => {
	it('only the author device can edit; author or admin can delete', () => {
		const id = ready(defaultAlbum, 'mem', 1);
		const m = memories.add({ mediaId: id, authorName: 'Jo', authorDevice: DEV_A, body: '  What a day!\r\n ' });
		expect(m.body).toBe('What a day!');
		expect(memories.update(m.id, 'hacked', { device: DEV_B })).toBeNull();
		expect(memories.update(m.id, 'hacked', { device: null })).toBeNull();
		expect(memories.update(m.id, 'Edited', { device: DEV_A })!.body).toBe('Edited');
		expect(memories.canEdit(m, { device: DEV_A })).toBe(true);
		expect(memories.canEdit(m, { device: DEV_B })).toBe(false);

		expect(memories.remove(m.id, { device: DEV_B, isAdmin: false })).toBe(false);
		expect(memories.list(id)).toHaveLength(1);
		expect(memories.remove(m.id, { device: DEV_A, isAdmin: false })).toBe(true);

		const m2 = memories.add({ mediaId: id, authorName: 'Bob', authorDevice: DEV_B, body: 'Hi' });
		expect(memories.remove(m2.id, { device: DEV_A, isAdmin: true })).toBe(true);
		expect(memories.list(id)).toEqual([]);
	});

	it('validates the body (1–5000 chars)', () => {
		const id = ready(defaultAlbum, 'mem2', 1);
		expect(() => memories.add({ mediaId: id, authorName: 'Jo', authorDevice: DEV_A, body: '   ' })).toThrow(ValidationError);
		expect(() => memories.add({ mediaId: id, authorName: 'Jo', authorDevice: DEV_A, body: 'x'.repeat(5001) })).toThrow(ValidationError);
		memories.add({ mediaId: id, authorName: 'Jo', authorDevice: DEV_A, body: 'x'.repeat(5000) });
		expect(memories.countFor([id]).get(id)).toBe(1);
		expect(memories.listForAlbum(defaultAlbum)).toHaveLength(1);
	});
});

describe('removal requests', () => {
	it('one pending request per device per item; resolve; email status', () => {
		const id = ready(defaultAlbum, 'req', 1);
		const r1 = requests.create({ mediaId: id, requesterName: 'Linda', requesterDevice: DEV_A, reason: 'in_it' });
		expect(r1.created).toBe(true);
		expect(r1.request).toMatchObject({ status: 'pending', email_status: 'pending', reason: 'in_it' });
		const again = requests.create({ mediaId: id, requesterName: 'Linda', requesterDevice: DEV_A, reason: 'wrong_album' });
		expect(again).toMatchObject({ created: false, request: { id: r1.request.id } });
		expect(requests.hasPendingFor(id, DEV_A)).toBe(true);
		expect(requests.hasPendingFor(id, DEV_B)).toBe(false);
		const r2 = requests.create({ mediaId: id, requesterName: 'Bob', requesterDevice: DEV_B, reason: 'other', details: 'blurry' });
		expect(requests.countPending()).toBe(2);
		expect(requests.listPending()[0]).toMatchObject({ album_title: 'Everyday Photos', source_name: 'IMG_0001.HEIC' });

		requests.setEmailStatus(r1.request.id, 'failed', 'ECONNREFUSED');
		expect(requests.get(r1.request.id)).toMatchObject({ email_status: 'failed', email_error: 'ECONNREFUSED' });
		expect(requests.listEmailUnsent().map((r) => r.id).sort()).toEqual([r1.request.id, r2.request.id].sort());
		requests.setEmailStatus(r1.request.id, 'saved');
		expect(requests.get(r1.request.id)!.email_error).toBeNull();

		expect(requests.resolve(r1.request.id, 'approved', 'removed')).toBe(true);
		expect(requests.resolve(r1.request.id, 'dismissed')).toBe(false); // no longer pending
		expect(requests.get(r1.request.id)).toMatchObject({ status: 'approved', resolved_action: 'removed' });
		expect(requests.hasPendingFor(id, DEV_A)).toBe(false);
		// a new request is possible after the first one was resolved
		expect(requests.create({ mediaId: id, requesterName: 'Linda', requesterDevice: DEV_A, reason: 'in_it' }).created).toBe(true);
		expect(requests.resolveAllForMedia(id, 'approved', 'removed')).toBe(2);
		expect(requests.listResolved().length).toBe(3);
	});

	it('validates reason and requires details for "other"', () => {
		const id = ready(defaultAlbum, 'req2', 1);
		expect(() => requests.create({ mediaId: id, requesterName: 'L', requesterDevice: DEV_A, reason: 'other' })).toThrow(ValidationError);
		expect(() => requests.create({ mediaId: id, requesterName: 'L', requesterDevice: DEV_A, reason: 'nope' as never })).toThrow(ValidationError);
	});
});

describe('admin helpers', () => {
	it('markForReprocess re-queues ready items with an archived original only', () => {
		const kept = ready(defaultAlbum, 'rp-kept', 1, { sourceKept: true });
		const notKept = ready(defaultAlbum, 'rp-gone', 1, { sourceKept: false });
		expect(media.markForReprocess(kept)).toBe(true);
		expect(media.getById(kept)).toMatchObject({ status: 'queued', attempts: 0 });
		expect(media.markForReprocess(notKept)).toBe(false);
		expect(media.listBelowPipelineVersion(PIPELINE_VERSION + 1).map((r) => r.id)).toEqual([notKept]);
	});

	it('markForReprocess refuses a failed item whose bytes are live in the album again', () => {
		const failed = queued(defaultAlbum, 'rp-dup');
		media.claimForProcessing(failed);
		media.markFailed(failed, 'corrupt', 'x', { sourceKept: true });
		expect(media.getById(failed)).toMatchObject({ status: 'failed', source_kept: 1 });
		const live = ready(defaultAlbum, 'rp-dup', 1);
		expect(media.markForReprocess(failed)).toBe(false); // no SQLITE_CONSTRAINT_UNIQUE
		expect(media.getById(failed)!.status).toBe('failed');
		media.softDelete(live, 'gone');
		expect(media.markForReprocess(failed)).toBe(true); // the live copy is in the trash now
		expect(media.markForReprocess('NOPE')).toBe(false);
	});

	it('listFailed({ sinceMs }) filters by failure time', () => {
		const id = queued(defaultAlbum, 'lf');
		media.claimForProcessing(id);
		media.markFailed(id, 'unsupported', 'svg');
		expect(media.listFailed({ sinceMs: Date.now() - 60_000 }).map((r) => r.id)).toEqual([id]);
		expect(media.listFailed({ sinceMs: Date.now() + 60_000 })).toEqual([]);
		expect(media.countByStatus().failed).toBe(1);
	});
});
