import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, SECRET_ENV, envWithoutSecrets, getConfig, loadConfig, publicOrigin, useLaneConfig } from '#lib/server/config';
import { setEnv, TEST_ADMIN_PASSWORD, TEST_FAMILY_PASSWORD } from '../helpers/env';

const base = { FAMILY_PASSWORD: 'blue lake cabin', ADMIN_PASSWORD: 'admin-test-pass', PUBLIC_URL: 'https://photos.example.com' };

describe('loadConfig()', () => {
	it('requires FAMILY_PASSWORD, ADMIN_PASSWORD and PUBLIC_URL with clear messages', () => {
		try {
			loadConfig({});
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ConfigError);
			const msg = (e as Error).message;
			expect(msg).toMatch(/FAMILY_PASSWORD is not set/);
			expect(msg).toMatch(/ADMIN_PASSWORD is not set/);
			expect(msg).toMatch(/PUBLIC_URL is not set/);
			expect((e as ConfigError).problems).toHaveLength(3);
		}
	});

	it('treats empty strings as unset (Unraid blanks)', () => {
		expect(() => loadConfig({ FAMILY_PASSWORD: '  ', ADMIN_PASSWORD: '' })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, PUBLIC_URL: '' })).toThrow(/PUBLIC_URL is not set/);
		const c = loadConfig({ ...base, SMTP_HOST: '', ADMIN_NAME: '', MAX_UPLOAD_GB: '', TRUSTED_PROXIES: '' });
		expect(c.smtp).toBeNull();
		expect(c.adminName).toBe('the site admin');
		expect(c.maxUploadGb).toBe(50);
		expect(c.trustedProxies).toEqual(['private']);
	});

	it('applies the documented defaults', () => {
		const c = loadConfig(base);
		expect(c).toMatchObject({
			publicUrl: 'https://photos.example.com',
			adminEmail: null,
			adminName: 'the site admin',
			siteTitle: 'Family Photos',
			smtp: null,
			keepOriginals: true,
			maxUploadGb: 50,
			maxUploadBytes: 50 * 1024 ** 3,
			maxVideoMinutes: 120,
			maxVideoSeconds: 7200,
			heifDecBin: null,
			port: 3000,
			host: '0.0.0.0',
			ffmpegBin: 'ffmpeg',
			ffprobeBin: 'ffprobe',
			trustedProxies: ['private']
		});
		expect(c.videoThreads).toBe(Math.max(2, Math.floor(os.availableParallelism() / 2)));
		expect(c.configDir).toBe(path.resolve('data/config'));
		expect(c.photosDir).toBe(path.resolve('data/photos'));
		expect(c.warnings.some((w) => w.includes('PUBLIC_URL'))).toBe(false);
	});

	it('parses every variable', () => {
		const c = loadConfig({
			...base,
			PUBLIC_URL: 'https://photos.example.com/',
			ADMIN_EMAIL: 'me@example.com',
			ADMIN_NAME: 'Michael',
			SITE_TITLE: 'Brewer Photos',
			SMTP_HOST: 'smtp.example.com',
			SMTP_PORT: '465',
			SMTP_USER: 'me@example.com',
			SMTP_PASS: 'secret',
			KEEP_ORIGINALS: 'false',
			MAX_UPLOAD_GB: '2.5',
			MAX_VIDEO_MINUTES: '30',
			VIDEO_THREADS: '3',
			CONFIG_DIR: '/config',
			PHOTOS_DIR: '/photos',
			HEIF_DEC_BIN: '/usr/bin/heif-convert',
			PORT: '8080',
			TRUSTED_PROXIES: ' 172.17.0.0/16, 2001:db8::/32 ,10.0.0.5,Private'
		});
		expect(c.trustedProxies).toEqual(['172.17.0.0/16', '2001:db8::/32', '10.0.0.5', 'private']);
		expect(c.publicUrl).toBe('https://photos.example.com');
		expect(c.smtp).toEqual({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			user: 'me@example.com',
			pass: 'secret',
			from: '"Brewer Photos" <me@example.com>'
		});
		expect(c.keepOriginals).toBe(false);
		expect(c.maxUploadBytes).toBe(Math.floor(2.5 * 1024 ** 3));
		expect(c.maxVideoSeconds).toBe(1800);
		expect(c.videoThreads).toBe(3);
		expect(c.configDir).toBe('/config');
		expect(c.heifDecBin).toBe('/usr/bin/heif-convert');
		expect(c.port).toBe(8080);
		expect(c.warnings).toEqual([]);
	});

	it('TRUSTED_PROXIES accepts the "cloudflare" keyword, alone or with other entries', () => {
		expect(loadConfig({ ...base, TRUSTED_PROXIES: 'Cloudflare' }).trustedProxies).toEqual(['cloudflare']);
		expect(loadConfig({ ...base, TRUSTED_PROXIES: 'private, cloudflare' }).trustedProxies).toEqual(['private', 'cloudflare']);
		expect(() => loadConfig({ ...base, TRUSTED_PROXIES: 'none,cloudflare' })).toThrow(/cannot be combined/);
		expect(() => loadConfig({ ...base, TRUSTED_PROXIES: 'cloudflare/24' })).toThrow(/"private" or "cloudflare"/);
	});

	it('SMTP on 587 is STARTTLS (secure=false)', () => {
		expect(loadConfig({ ...base, SMTP_HOST: 'smtp.example.com' }).smtp).toMatchObject({ port: 587, secure: false });
	});

	it('rejects bad values', () => {
		const bad = (env: Record<string, string>, re: RegExp) => expect(() => loadConfig({ ...base, ...env })).toThrow(re);
		bad({ PUBLIC_URL: 'photos.example.com' }, /PUBLIC_URL/);
		bad({ PUBLIC_URL: 'https://example.com/photos' }, /without a path/);
		bad({ PUBLIC_URL: 'ftp://example.com' }, /PUBLIC_URL/);
		bad({ KEEP_ORIGINALS: 'maybe' }, /KEEP_ORIGINALS/);
		bad({ MAX_UPLOAD_GB: '-1' }, /MAX_UPLOAD_GB/);
		bad({ VIDEO_THREADS: '1.5' }, /VIDEO_THREADS/);
		bad({ ADMIN_PASSWORD: 'short' }, /at least 8/);
		bad({ ADMIN_PASSWORD: 'Blue Lake  Cabin' }, /different from FAMILY_PASSWORD/);
		bad({ ADMIN_EMAIL: 'not-an-email' }, /ADMIN_EMAIL/);
		bad({ TRUSTED_PROXIES: 'npm.lan' }, /TRUSTED_PROXIES/);
		bad({ TRUSTED_PROXIES: '10.0.0.0/33' }, /TRUSTED_PROXIES/);
		bad({ TRUSTED_PROXIES: 'none,10.0.0.1' }, /TRUSTED_PROXIES/);
	});

	it('publicOrigin() is always PUBLIC_URL, whatever Host a request claims', () => {
		setEnv({ PUBLIC_URL: 'https://photos.example.com/' });
		expect(publicOrigin(new URL('http://evil.example/view/1'))).toBe('https://photos.example.com');
		expect(publicOrigin()).toBe('https://photos.example.com');
		setEnv({ PUBLIC_URL: 'http://localhost:3000' });
	});

	it('VIDEO_THREADS=auto uses max(2, cores/2)', () => {
		expect(loadConfig({ ...base, VIDEO_THREADS: 'auto' }).videoThreads).toBe(
			Math.max(2, Math.floor(os.availableParallelism() / 2))
		);
	});
});

describe('secrets and the worker lanes', () => {
	it('envWithoutSecrets() drops the family code, admin password and SMTP password, and nothing else', () => {
		const env = { ...base, SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', SMTP_PASS: 'mail-secret', PATH: '/usr/bin' };
		expect(envWithoutSecrets(env)).toEqual({ PUBLIC_URL: base.PUBLIC_URL, SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', PATH: '/usr/bin' });
		expect(env.FAMILY_PASSWORD).toBe(base.FAMILY_PASSWORD); // a copy
		expect([...SECRET_ENV]).toEqual(['FAMILY_PASSWORD', 'ADMIN_PASSWORD', 'SMTP_PASS']);
	});

	it('a lane loads its config without the secrets, and ignores them if it was given them anyway', () => {
		const lane = loadConfig({ PUBLIC_URL: base.PUBLIC_URL, SMTP_HOST: 'smtp.example.com' }, { lane: true });
		expect(lane).toMatchObject({ familyPassword: '', adminPassword: '', publicUrl: base.PUBLIC_URL });
		expect(lane.smtp?.pass).toBeNull();
		const given = loadConfig({ ...base, SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'mail-secret' }, { lane: true });
		expect(given).toMatchObject({ familyPassword: '', adminPassword: '' });
		expect(given.smtp?.pass).toBeNull();
		// Everything else is still checked.
		expect(() => loadConfig({}, { lane: true })).toThrow(/PUBLIC_URL is not set/);
		// The web process still needs them.
		expect(() => loadConfig({ PUBLIC_URL: base.PUBLIC_URL })).toThrow(/FAMILY_PASSWORD is not set/);
	});

	it('useLaneConfig() also drops the secrets from the process environment, for the tools it runs', () => {
		setEnv({ SMTP_PASS: 'mail-secret' });
		try {
			const c = useLaneConfig();
			expect(c.familyPassword).toBe('');
			expect(getConfig()).toBe(c);
			for (const key of SECRET_ENV) expect(process.env[key]).toBeUndefined();
		} finally {
			setEnv({ FAMILY_PASSWORD: TEST_FAMILY_PASSWORD, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD, SMTP_PASS: undefined });
		}
		expect(getConfig().familyPassword).toBe(TEST_FAMILY_PASSWORD);
	});
});
