/**
 * Typed, validated configuration from environment variables.
 *
 * Importable from the web server, the worker bundle and tests: it reads
 * process.env directly (never $env/*) and has no SvelteKit imports.
 *
 * Unraid passes unset template fields as empty strings, so "" means "not set".
 */
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { norm } from './crypto';

export interface SmtpConfig {
	host: string;
	port: number;
	/** Implicit TLS (port 465). Otherwise STARTTLS is negotiated when offered. */
	secure: boolean;
	user: string | null;
	pass: string | null;
	from: string;
}

export interface Config {
	/**
	 * Canonical origin, e.g. "https://photos.example.com" (no trailing slash). Required: every
	 * absolute link (emails, QR codes) uses it, never the request's client-controlled Host header.
	 */
	publicUrl: string;
	familyPassword: string;
	adminPassword: string;
	adminEmail: string | null;
	/** Shown in copy like "We couldn't add this one. Michael has been told." */
	adminName: string;
	siteTitle: string;
	/** null → emails are written as .eml files to /config/outbox. */
	smtp: SmtpConfig | null;
	keepOriginals: boolean;
	maxUploadGb: number;
	maxUploadBytes: number;
	maxVideoMinutes: number;
	maxVideoSeconds: number;
	/** VIDEO_THREADS, or auto = max(2, floor(cores/2)). */
	videoThreads: number;
	configDir: string;
	photosDir: string;
	/** HEIF_DEC_BIN override; null → detect heif-dec, then heif-convert. */
	heifDecBin: string | null;
	/** EXIFTOOL_BIN override; null → worker decides (/usr/bin/exiftool, else vendored). */
	exiftoolBin: string | null;
	ffmpegBin: string;
	ffprobeBin: string;
	port: number;
	host: string;
	/** Absolute path of the built worker entry (WORKER_ENTRY, default <cwd>/build-worker/worker.js). */
	workerEntry: string;
	/**
	 * TRUSTED_PROXIES: socket peers whose cf-connecting-ip / x-real-ip headers are believed
	 * (rate limiting). Entries are IPs, CIDRs, 'private' (loopback + private/link-local/ULA
	 * ranges) or 'none'. Default ['private'].
	 */
	trustedProxies: string[];
	/** Non-fatal problems, shown on the admin page and logged at startup. */
	warnings: string[];
}

export class ConfigError extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(
			'Family Photos cannot start because of its settings:\n' +
				problems.map((p) => `  - ${p}`).join('\n') +
				'\nSet these in the Unraid template (or the container environment) and restart.'
		);
		this.name = 'ConfigError';
		this.problems = problems;
	}
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
	const v = env[name];
	if (v === undefined) return undefined;
	const t = v.trim();
	return t === '' ? undefined : t;
}

export function parseBool(v: string | undefined, fallback: boolean): boolean | null {
	if (v === undefined) return fallback;
	const s = v.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
	if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
	return null;
}

function num(
	env: Env,
	name: string,
	fallback: number,
	problems: string[],
	{ min, max, integer = false }: { min: number; max: number; integer?: boolean }
): number {
	const raw = str(env, name);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
		problems.push(
			`${name}="${raw}" is not valid; use ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`
		);
		return fallback;
	}
	return n;
}

export function autoVideoThreads(): number {
	const cores =
		typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
	return Math.max(2, Math.floor(cores / 2));
}

/** Pure: builds a Config from an env object. Throws ConfigError listing every problem. */
export function loadConfig(env: Env = process.env): Config {
	const problems: string[] = [];
	const warnings: string[] = [];

	// --- required secrets -------------------------------------------------
	const familyPassword = str(env, 'FAMILY_PASSWORD');
	if (!familyPassword) {
		problems.push(
			'FAMILY_PASSWORD is not set. This is the family code everyone types to get in (three short words work well, e.g. "blue lake cabin").'
		);
	} else if (norm(familyPassword).length < 8) {
		warnings.push('The family code is short. A three-word code like "blue lake cabin" is harder to guess.');
	}

	const adminPassword = str(env, 'ADMIN_PASSWORD');
	if (!adminPassword) {
		problems.push('ADMIN_PASSWORD is not set. It protects the admin page (removal requests, trash, QR codes).');
	} else if (adminPassword.length < 8) {
		problems.push('ADMIN_PASSWORD must be at least 8 characters long.');
	} else if (familyPassword && norm(adminPassword) === norm(familyPassword)) {
		problems.push('ADMIN_PASSWORD must be different from FAMILY_PASSWORD, otherwise everyone would be an admin.');
	}

	// --- public URL -------------------------------------------------------
	let publicUrl = '';
	const rawUrl = str(env, 'PUBLIC_URL');
	if (rawUrl) {
		try {
			const u = new URL(rawUrl);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
			if (u.pathname !== '/' && u.pathname !== '') {
				problems.push(
					`PUBLIC_URL="${rawUrl}" must be just the site address without a path (e.g. https://photos.example.com).`
				);
			}
			publicUrl = u.origin;
		} catch {
			problems.push(`PUBLIC_URL="${rawUrl}" is not a valid address. Use something like https://photos.example.com`);
		}
	} else {
		problems.push(
			'PUBLIC_URL is not set. Set it to the address your family uses, without a path (e.g. https://photos.example.com). Links in emails and QR codes use it.'
		);
	}

	// --- people & site ----------------------------------------------------
	const adminEmail = str(env, 'ADMIN_EMAIL') ?? null;
	if (adminEmail && !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) {
		problems.push(`ADMIN_EMAIL="${adminEmail}" doesn't look like an email address.`);
	}
	if (!adminEmail) {
		warnings.push('ADMIN_EMAIL is not set, so removal requests and problems only show up on the admin page.');
	}
	const adminName = str(env, 'ADMIN_NAME') ?? 'the site admin';
	const siteTitle = str(env, 'SITE_TITLE') ?? 'Family Photos';

	// --- email --------------------------------------------------------------
	let smtp: SmtpConfig | null = null;
	const smtpHost = str(env, 'SMTP_HOST');
	if (smtpHost) {
		const port = num(env, 'SMTP_PORT', 587, problems, { min: 1, max: 65535, integer: true });
		const user = str(env, 'SMTP_USER') ?? null;
		const pass = env.SMTP_PASS && env.SMTP_PASS !== '' ? env.SMTP_PASS : null;
		const fromAddr = user && user.includes('@') ? user : (adminEmail ?? 'family-photos@localhost');
		const from = str(env, 'SMTP_FROM') ?? `"${siteTitle.replace(/"/g, '')}" <${fromAddr}>`;
		smtp = { host: smtpHost, port, secure: port === 465, user, pass, from };
	} else if (adminEmail) {
		warnings.push(
			`SMTP_HOST is not set, so emails are saved as .eml files in ${path.join(str(env, 'CONFIG_DIR') ?? 'data/config', 'outbox')} instead of being sent.`
		);
	}

	// --- media ----------------------------------------------------------------
	const keepOriginals = parseBool(str(env, 'KEEP_ORIGINALS'), true);
	if (keepOriginals === null) problems.push(`KEEP_ORIGINALS="${env.KEEP_ORIGINALS}" must be true or false.`);
	const maxUploadGb = num(env, 'MAX_UPLOAD_GB', 50, problems, { min: 0.001, max: 10_000 });
	const maxVideoMinutes = num(env, 'MAX_VIDEO_MINUTES', 120, problems, { min: 0.1, max: 24 * 60 });

	let videoThreads = autoVideoThreads();
	const rawThreads = str(env, 'VIDEO_THREADS');
	if (rawThreads && rawThreads.toLowerCase() !== 'auto') {
		videoThreads = num(env, 'VIDEO_THREADS', videoThreads, problems, { min: 1, max: 256, integer: true });
	}

	// --- paths & server ---------------------------------------------------------
	const configDir = path.resolve(str(env, 'CONFIG_DIR') ?? 'data/config');
	const photosDir = path.resolve(str(env, 'PHOTOS_DIR') ?? 'data/photos');
	const port = num(env, 'PORT', 3000, problems, { min: 0, max: 65535, integer: true });
	const host = str(env, 'HOST') ?? '0.0.0.0';
	const workerEntry = path.resolve(str(env, 'WORKER_ENTRY') ?? 'build-worker/worker.js');
	const trustedProxies = parseTrustedProxies(str(env, 'TRUSTED_PROXIES'), problems);

	if (problems.length > 0) throw new ConfigError(problems);

	return {
		publicUrl,
		familyPassword: familyPassword!,
		adminPassword: adminPassword!,
		adminEmail,
		adminName,
		siteTitle,
		smtp,
		keepOriginals: keepOriginals!,
		maxUploadGb,
		maxUploadBytes: Math.floor(maxUploadGb * 1024 ** 3),
		maxVideoMinutes,
		maxVideoSeconds: Math.round(maxVideoMinutes * 60),
		videoThreads,
		configDir,
		photosDir,
		heifDecBin: str(env, 'HEIF_DEC_BIN') ?? null,
		exiftoolBin: str(env, 'EXIFTOOL_BIN') ?? null,
		ffmpegBin: str(env, 'FFMPEG_BIN') ?? 'ffmpeg',
		ffprobeBin: str(env, 'FFPROBE_BIN') ?? 'ffprobe',
		port,
		host,
		workerEntry,
		trustedProxies,
		warnings
	};
}

/** Validates TRUSTED_PROXIES (comma-separated IPs, CIDRs, 'private' or 'none'); default ['private']. */
function parseTrustedProxies(raw: string | undefined, problems: string[]): string[] {
	if (raw === undefined) return ['private'];
	const entries = raw
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	for (const e of entries) {
		if (e === 'private' || e === 'none') continue;
		const [addr, bits, extra] = e.split('/');
		const family = isIP(addr);
		const maxBits = family === 6 ? 128 : 32;
		const okBits = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= maxBits);
		if (family === 0 || !okBits || extra !== undefined) {
			problems.push(
				`TRUSTED_PROXIES entry "${e}" is not valid; use IP addresses or ranges like 172.17.0.0/16, or "private".`
			);
		}
	}
	if (entries.includes('none') && entries.length > 1) {
		problems.push('TRUSTED_PROXIES="none" cannot be combined with other entries.');
	}
	return entries.length > 0 ? entries : ['private'];
}

let cached: Config | null = null;

/** Process-wide config, loaded from process.env on first use. Throws ConfigError. */
export function getConfig(): Config {
	cached ??= loadConfig(process.env);
	return cached;
}

/** Tests only: forget the cached config so the next getConfig() re-reads process.env. */
export function resetConfig(): void {
	cached = null;
}

/**
 * Origin for absolute links (emails, QR codes): always PUBLIC_URL (required by loadConfig).
 * The argument is accepted for compatibility and ignored on purpose: the request origin comes
 * from the client-controlled Host header, so a crafted request could otherwise point the
 * admin's email links at another site.
 */
export function publicOrigin(_requestUrl?: URL | string): string {
	void _requestUrl;
	return getConfig().publicUrl;
}
