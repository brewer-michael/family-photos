/**
 * Outgoing email (docs/PLAN.md "Configuration" → Email).
 *
 *   SMTP_HOST set   → nodemailer SMTP (implicit TLS iff port 465, otherwise STARTTLS when offered;
 *                     auth when SMTP_USER is set; From = SMTP_FROM) → 'sent'
 *   SMTP_HOST unset → the same RFC 822 message, built by nodemailer's buffer transport, is written to
 *                     CONFIG_DIR/outbox/<timestamp>-<rand>.eml → 'saved' (also the test mode); the
 *                     daily maintenance deletes saved emails older than OUTBOX_KEEP_MS
 *
 * The SMTP login is only ever sent encrypted: with SMTP_USER on a port other than 465 the server
 * must offer STARTTLS (requireTLS), or the email fails instead of the password going out in the
 * clear, where anyone on the way could strip STARTTLS and read it. A relay on the LAN without
 * encryption still works when it needs no login (leave SMTP_USER empty).
 *
 * Failures reject; callers record them (removal requests keep email_status/email_error). The last
 * success and failure are also kept in settings so the admin page can say when email isn't working.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { SendMailOptions, SMTPTransportOptions, Transporter } from 'nodemailer';
import { getConfig, type SmtpConfig } from './config';
import { outboxDir } from './paths';
import { getNumber, getSetting, setNumber, setSetting } from './repo/settings';

export interface MailAttachment {
	filename: string;
	content: Buffer;
	contentType: string;
	/** Content-ID for inline images: reference as <img src="cid:…">. */
	cid?: string;
}

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
	attachments?: MailAttachment[];
}

export type MailResult = 'sent' | 'saved';

export interface MailHealth {
	lastSuccessAt: number | null;
	lastFailure: { at: number; error: string } | null;
}

const SETTING_OK_AT = 'mail_ok_at';
const SETTING_FAILED_AT = 'mail_failed_at';
const SETTING_FAILED_ERROR = 'mail_failed_error';

const DAY_MS = 24 * 3600_000;
/** Saved emails (outbox mode) are deleted after this long. */
export const OUTBOX_KEEP_MS = 90 * DAY_MS;
/** A leftover .partial older than this was abandoned by a crash. */
const PARTIAL_KEEP_MS = DAY_MS;
const OUTBOX_EML = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}\.eml$/;
const OUTBOX_PARTIAL = /^\.\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}\.eml\.partial$/;

/** nodemailer SMTP options for SMTP_* settings. */
export function smtpOptions(smtp: SmtpConfig): SMTPTransportOptions {
	return {
		host: smtp.host,
		port: smtp.port,
		secure: smtp.secure,
		...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
		// A login goes over TLS or not at all (see the top of this file).
		requireTLS: !smtp.secure && !!smtp.user,
		connectionTimeout: 20_000,
		greetingTimeout: 20_000,
		socketTimeout: 60_000
	};
}

/** One SMTP transporter per configuration (the config object only changes in tests). */
let smtpTransport: { config: SmtpConfig; transporter: Transporter } | null = null;

function smtpTransporter(smtp: SmtpConfig): Transporter {
	if (smtpTransport?.config !== smtp) {
		smtpTransport?.transporter.close();
		smtpTransport = { config: smtp, transporter: nodemailer.createTransport(smtpOptions(smtp)) };
	}
	return smtpTransport.transporter;
}

const outboxTransport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

/** SMTP_FROM, or (outbox mode) the site title at ADMIN_EMAIL. */
function fromAddress(): string | { name: string; address: string } {
	const c = getConfig();
	return c.smtp?.from ?? { name: c.siteTitle, address: c.adminEmail ?? 'family-photos@localhost' };
}

function toNodemailer(msg: MailMessage): SendMailOptions {
	return {
		from: fromAddress(),
		to: msg.to,
		// Headers are one line; album titles and names may contain newlines.
		subject: msg.subject.replace(/\s+/g, ' ').trim(),
		text: msg.text,
		...(msg.html ? { html: msg.html } : {}),
		attachments: (msg.attachments ?? []).map((a) => ({
			filename: a.filename,
			content: a.content,
			contentType: a.contentType,
			...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {})
		}))
	};
}

/** 2026-10-13T14-22-33-123Z-1a2b3c4d.eml: sorts by time, never collides. */
function outboxName(now: Date): string {
	return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.eml`;
}

/** Writes the message to the outbox; the file appears complete or not at all. Returns its path. */
async function saveToOutbox(options: SendMailOptions): Promise<string> {
	const info = await outboxTransport.sendMail(options);
	const dir = outboxDir();
	await fs.promises.mkdir(dir, { recursive: true });
	const name = outboxName(new Date());
	const file = path.join(dir, name);
	const partial = path.join(dir, `.${name}.partial`);
	try {
		await fs.promises.writeFile(partial, info.message as Buffer);
		await fs.promises.rename(partial, file);
	} catch (e) {
		await fs.promises.rm(partial, { force: true }).catch(() => undefined);
		throw e;
	}
	return file;
}

/**
 * Deletes saved emails older than OUTBOX_KEEP_MS (by file time) and .partial files a crash left
 * behind. Only touches names saveToOutbox() makes. Returns how many emails were deleted.
 */
export async function pruneOutbox(now: number = Date.now()): Promise<number> {
	const dir = outboxDir();
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw e;
	}
	let deleted = 0;
	for (const name of names) {
		const eml = OUTBOX_EML.test(name);
		if (!eml && !OUTBOX_PARTIAL.test(name)) continue;
		const file = path.join(dir, name);
		const st = await fs.promises.stat(file).catch(() => null);
		if (!st?.isFile() || st.mtimeMs > now - (eml ? OUTBOX_KEEP_MS : PARTIAL_KEEP_MS)) continue;
		await fs.promises.rm(file, { force: true });
		if (eml) deleted++;
	}
	return deleted;
}

/** Remembers the outcome for mailHealth(); a database problem never fails the email itself. */
function note(error: string | null): void {
	try {
		const now = Date.now();
		if (error === null) {
			setNumber(SETTING_OK_AT, now);
		} else {
			setNumber(SETTING_FAILED_AT, now);
			setSetting(SETTING_FAILED_ERROR, error.slice(0, 500));
		}
	} catch (e) {
		console.warn('[mail] could not record the outcome:', (e as Error).message);
	}
}

/** Sends (SMTP) or saves (outbox) one email. Rejects when it couldn't. */
export async function sendMail(msg: MailMessage): Promise<MailResult> {
	const options = toNodemailer(msg);
	const smtp = getConfig().smtp;
	try {
		if (smtp) {
			await smtpTransporter(smtp).sendMail(options);
			note(null);
			console.log(`[mail] sent "${options.subject}" to ${msg.to}`);
			return 'sent';
		}
		const file = await saveToOutbox(options);
		note(null);
		console.log(`[mail] saved "${options.subject}" to ${file}`);
		return 'saved';
	} catch (e) {
		const error = explain(e, smtp);
		note(error);
		console.warn(`[mail] "${options.subject}" to ${msg.to} failed: ${error}`);
		throw error === (e as Error)?.message ? e : new Error(error, { cause: e });
	}
}

/** The failure in words for the admin (who sees it on the admin page). */
function explain(e: unknown, smtp: SmtpConfig | null): string {
	const err = e as { message?: unknown; code?: unknown; command?: unknown } | null;
	if (smtp?.user && err?.code === 'ETLS' && err.command === 'STARTTLS') {
		return (
			`The email server ${smtp.host}:${smtp.port} did not offer an encrypted connection (STARTTLS), so the ` +
			'password was not sent. Try port 465, or leave SMTP_USER and SMTP_PASS empty if this server needs no login.'
		);
	}
	return e instanceof Error ? e.message : String(e);
}

/** When email last worked and last failed (admin email banner). */
export function mailHealth(): MailHealth {
	const failedAt = getNumber(SETTING_FAILED_AT);
	return {
		lastSuccessAt: getNumber(SETTING_OK_AT) ?? null,
		lastFailure: failedAt === undefined ? null : { at: failedAt, error: getSetting(SETTING_FAILED_ERROR) ?? '' }
	};
}
