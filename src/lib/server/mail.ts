/**
 * Outgoing email (docs/PLAN.md "Configuration" → Email).
 *
 *   SMTP_HOST set   → nodemailer SMTP (implicit TLS iff port 465, otherwise STARTTLS when offered;
 *                     auth when SMTP_USER is set; From = SMTP_FROM) → 'sent'
 *   SMTP_HOST unset → the same RFC 822 message, built by nodemailer's buffer transport, is written to
 *                     CONFIG_DIR/outbox/<timestamp>-<rand>.eml → 'saved' (also the test mode)
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

/** nodemailer SMTP options for SMTP_* settings. */
export function smtpOptions(smtp: SmtpConfig): SMTPTransportOptions {
	return {
		host: smtp.host,
		port: smtp.port,
		secure: smtp.secure,
		...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
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
	await fs.promises.writeFile(partial, info.message as Buffer);
	await fs.promises.rename(partial, file);
	return file;
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
		const error = e instanceof Error ? e.message : String(e);
		note(error);
		console.warn(`[mail] "${options.subject}" to ${msg.to} failed: ${error}`);
		throw e;
	}
}

/** When email last worked and last failed (admin email banner). */
export function mailHealth(): MailHealth {
	const failedAt = getNumber(SETTING_FAILED_AT);
	return {
		lastSuccessAt: getNumber(SETTING_OK_AT) ?? null,
		lastFailure: failedAt === undefined ? null : { at: failedAt, error: getSetting(SETTING_FAILED_ERROR) ?? '' }
	};
}
