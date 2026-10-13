import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as paths from '#lib/server/paths';
import { testEnv } from '../helpers/env';

const ID = '01HZX3NDEKTSV4RRFFQ69G5FAV';

describe('paths', () => {
	it('shards by the last two ULID characters', () => {
		expect(paths.sh(ID)).toBe('AV');
	});

	it('maps every location from the storage layout', () => {
		const { configDir, photosDir } = testEnv();
		expect(paths.libraryPath(ID, 'jpg')).toBe(path.join(photosDir, 'library', 'AV', `${ID}.jpg`));
		expect(paths.originalsPath(ID, '.HEIC')).toBe(path.join(photosDir, 'originals', 'AV', `${ID}.heic`));
		expect(paths.incomingDir()).toBe(path.join(photosDir, '.incoming'));
		expect(paths.workDir(ID)).toBe(path.join(photosDir, '.work', ID));
		expect(paths.backupsDir()).toBe(path.join(photosDir, '.backups'));
		expect(paths.backupPath(new Date('2026-10-13T12:00:00Z'))).toBe(path.join(photosDir, '.backups', 'app-2026-10-13.sqlite'));
		expect(paths.cacheDir(ID)).toBe(path.join(configDir, 'cache', 'AV', ID));
		expect(paths.cacheFile(ID, 'thumb')).toBe(path.join(configDir, 'cache', 'AV', ID, 'thumb.webp'));
		expect(paths.cacheFile(ID, 'poster')).toBe(path.join(configDir, 'cache', 'AV', ID, 'poster.webp'));
		expect(paths.tmpDir(ID)).toBe(path.join(configDir, 'tmp', ID));
		expect(paths.outboxDir()).toBe(path.join(configDir, 'outbox'));
		expect(paths.dbPath()).toBe(path.join(configDir, 'app.sqlite'));
		expect(paths.incomingPath('abcdefghijklmnopqrstuv')).toBe(path.join(photosDir, '.incoming', 'abcdefghijklmnopqrstuv'));
	});

	it('rejects ids, extensions and tokens that could escape the root', () => {
		expect(() => paths.libraryPath('../../etc/passwd', 'jpg')).toThrow(/Invalid media id/);
		expect(() => paths.workDir('01HZX3NDEKTSV4RRFFQ69G5FA/')).toThrow();
		expect(() => paths.libraryPath(ID, 'jpg/../../x')).toThrow(/extension/);
		expect(() => paths.incomingPath('../x')).toThrow(/token/);
		expect(() => paths.cacheFile(ID, 'file' as never)).toThrow(/variant/);
	});

	it('ensureDirs() creates every root', () => {
		paths.ensureDirs();
		for (const d of [
			paths.libraryRoot(),
			paths.originalsRoot(),
			paths.incomingDir(),
			paths.workRoot(),
			paths.backupsDir(),
			paths.cacheRoot(),
			paths.tmpRoot(),
			paths.outboxDir()
		]) {
			expect(fs.statSync(d).isDirectory()).toBe(true);
		}
		paths.ensureDirs(); // idempotent
	});
});
