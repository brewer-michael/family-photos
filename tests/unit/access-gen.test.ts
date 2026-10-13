/**
 * "Reset access" survives restoring an older copy of the database (repo/settings.ts): each reset is
 * recorded in .backups/access-gen, and at startup (restoreAccessGen) a restored database never goes
 * below it, so QR cards and cookies the reset revoked stay revoked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessValue, currentJoinToken, rotateAccess, verifyAccess } from '#lib/server/auth';
import { backupsDir } from '#lib/server/paths';
import { getAccessGen, restoreAccessGen, setSetting } from '#lib/server/repo/settings';
import { freshDb } from '../helpers/env';

const recorded = () => path.join(backupsDir(), 'access-gen');

beforeEach(() => {
	freshDb();
	fs.rmSync(recorded(), { force: true });
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('restoreAccessGen', () => {
	it('keeps a reset made after the copy was taken: old QR cards and cookies stay revoked', () => {
		const oldCard = currentJoinToken();
		const oldCookie = accessValue('family');
		expect(rotateAccess()).toBe(2);
		const newCard = currentJoinToken();
		const newCookie = accessValue('family');

		setSetting('access_gen', '1'); // app.sqlite replaced by a copy from before the reset
		expect(currentJoinToken()).toBe(oldCard);
		expect(restoreAccessGen()).toBe(2);
		expect(getAccessGen()).toBe(2);
		expect(currentJoinToken()).toBe(newCard);
		expect(verifyAccess(oldCookie)).toBeNull();
		expect(verifyAccess(newCookie)).not.toBeNull();
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it('leaves the generation alone when nothing newer is recorded for this database', () => {
		expect(restoreAccessGen()).toBe(1);
		expect(fs.existsSync(recorded())).toBe(false);
		rotateAccess();
		rotateAccess();
		expect(JSON.parse(fs.readFileSync(recorded(), 'utf8'))).toMatchObject({ gen: 3 });
		expect(restoreAccessGen()).toBe(3);

		// Unreadable record.
		fs.writeFileSync(recorded(), 'not json');
		setSetting('access_gen', '1');
		expect(restoreAccessGen()).toBe(1);

		// A record of another database (a different secret) doesn't apply.
		rotateAccess();
		setSetting('secret', 'a-different-database-secret-0123456789');
		setSetting('access_gen', '1');
		expect(restoreAccessGen()).toBe(1);
		expect(console.warn).not.toHaveBeenCalled();
	});
});
