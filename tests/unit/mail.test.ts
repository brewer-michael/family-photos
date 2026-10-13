/**
 * Outgoing email: the outbox (.eml files, no SMTP_HOST, pruned after 90 days) and SMTP against a
 * tiny fake SMTP server on 127.0.0.1 that records the AUTH line, the envelope and the message, and
 * can offer STARTTLS with a throwaway self-signed certificate (made with openssl and trusted for
 * this file only).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { simpleParser } from 'mailparser';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '#lib/server/config';
import { OUTBOX_KEEP_MS, mailHealth, pruneOutbox, sendMail, smtpOptions, type MailMessage } from '#lib/server/mail';
import { outboxDir } from '#lib/server/paths';
import { freshDb, setEnv } from '../helpers/env';

/** A 1×1 baseline JPEG. */
const JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
	'base64'
);

const MESSAGE: MailMessage = {
	to: 'admin@example.com',
	subject: 'Removal request:\r\nphoto in "Beach"',
	text: 'Grandma Jo asked.\nÜnïcödé too.',
	html: '<p>Grandma Jo asked.</p><img src="cid:pic@family-photos" alt="">',
	attachments: [{ filename: 'photo.jpg', content: JPEG, contentType: 'image/jpeg', cid: 'pic@family-photos' }]
};

interface Received {
	auth: string | null;
	/** Whether the session had switched to TLS (STARTTLS) when the message came. */
	secure: boolean;
	from: string;
	to: string[];
	data: string;
}

/** A self-signed certificate for 127.0.0.1, or null when openssl isn't installed. */
function selfSignedCert(): { key: string; cert: string } | null {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-mail-cert-'));
	try {
		const key = path.join(dir, 'key.pem');
		const cert = path.join(dir, 'cert.pem');
		execFileSync(
			'openssl',
			['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
				'-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
			{ stdio: 'ignore' }
		);
		return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
	} catch {
		return null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const CERT = typeof tls.setDefaultCACertificates === 'function' ? selfSignedCert() : null;

/**
 * Just enough ESMTP for nodemailer: EHLO (AUTH PLAIN, and STARTTLS when `tls` is given), STARTTLS,
 * AUTH, MAIL, RCPT, DATA, QUIT. Without `tls`, STARTTLS gets the usual "not implemented".
 */
async function fakeSmtp(opts: { reject?: boolean; tls?: { key: string; cert: string } } = {}) {
	const received: Received[] = [];
	/** Every command line, in order (AUTH lines included). */
	const commands: string[] = [];
	const server = net.createServer((raw) => {
		let io: net.Socket | tls.TLSSocket = raw;
		let secure = false;
		let buf = '';
		let inData = false;
		let cur: Received = { auth: null, secure, from: '', to: [], data: '' };
		const reply = (s: string) => io.write(`${s}\r\n`);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString('utf8');
			for (;;) {
				if (inData) {
					const end = buf.indexOf('\r\n.\r\n');
					if (end < 0) return;
					cur.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
					buf = buf.slice(end + 5);
					inData = false;
					if (opts.reject) reply('554 5.7.1 Rejected for testing');
					else {
						received.push({ ...cur, secure });
						reply('250 2.0.0 Queued');
					}
					cur = { auth: cur.auth, secure, from: '', to: [], data: '' };
					continue;
				}
				const nl = buf.indexOf('\r\n');
				if (nl < 0) return;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 2);
				const cmd = line.split(' ')[0].toUpperCase();
				commands.push(line);
				if (cmd === 'EHLO') reply(`250-fake.test\r\n${opts.tls && !secure ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN\r\n250 8BITMIME`);
				else if (cmd === 'STARTTLS') {
					if (!opts.tls || secure) {
						reply('502 5.5.1 Not implemented');
						continue;
					}
					reply('220 2.0.0 Ready to start TLS');
					raw.removeListener('data', onData);
					buf = '';
					io = new tls.TLSSocket(raw, { isServer: true, secureContext: tls.createSecureContext(opts.tls) });
					io.on('data', onData);
					io.on('error', () => raw.destroy());
					secure = true;
					return;
				} else if (cmd === 'AUTH') {
					cur.auth = line;
					reply('235 2.7.0 Accepted');
				} else if (cmd === 'MAIL') {
					cur.from = line;
					reply('250 OK');
				} else if (cmd === 'RCPT') {
					cur.to.push(line);
					reply('250 OK');
				} else if (cmd === 'DATA') {
					inData = true;
					reply('354 Go ahead');
				} else if (cmd === 'QUIT') {
					reply('221 Bye');
					io.end();
				} else reply('250 OK');
			}
		};
		raw.on('data', onData);
		raw.on('error', () => undefined);
		reply('220 fake.test ESMTP');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		received,
		commands,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
	const srv = net.createServer();
	await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address() as net.AddressInfo;
	await new Promise<void>((resolve) => srv.close(() => resolve()));
	return port;
}

const outboxFiles = () => (fs.existsSync(outboxDir()) ? fs.readdirSync(outboxDir()) : []);

beforeEach(() => {
	setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined });
	freshDb();
	fs.rmSync(outboxDir(), { recursive: true, force: true });
});

afterEach(() => {
	setEnv({ SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined });
});

describe('outbox (no SMTP_HOST)', () => {
	it('writes one complete .eml that parses back, inline picture included', async () => {
		expect(await sendMail(MESSAGE)).toBe('saved');
		const files = outboxFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.eml$/);

		const raw = fs.readFileSync(path.join(outboxDir(), files[0]));
		expect(raw.includes('\r\n')).toBe(true); // RFC 822 line endings
		const mail = await simpleParser(raw, { skipImageLinks: true });
		expect(mail.subject).toBe('Removal request: photo in "Beach"');
		expect(mail.to && !Array.isArray(mail.to) ? mail.to.text : '').toBe('admin@example.com');
		expect(mail.from?.value[0]).toEqual({ name: 'Family Photos', address: 'admin@example.com' });
		expect(mail.text).toBe('Grandma Jo asked.\nÜnïcödé too.');
		expect(mail.html).toContain('cid:pic@family-photos');
		expect(mail.attachments).toHaveLength(1);
		expect(mail.attachments[0].contentType).toBe('image/jpeg');
		expect(mail.attachments[0].cid).toBe('pic@family-photos');
		expect(mail.attachments[0].content.equals(JPEG)).toBe(true);
	});

	it('leaves no hidden part-written file behind when saving fails', async () => {
		const write = fs.promises.writeFile;
		const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (file, data) => {
			await write(file, String(data).slice(0, 10));
			throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
		});
		try {
			await expect(sendMail(MESSAGE)).rejects.toThrow(/ENOSPC/);
		} finally {
			spy.mockRestore();
		}
		expect(outboxFiles()).toEqual([]);
		expect(mailHealth().lastFailure?.error).toMatch(/ENOSPC/);
	});

	it('the daily prune deletes saved emails after 90 days and part-written ones after a day, nothing else', async () => {
		await sendMail(MESSAGE);
		await sendMail(MESSAGE);
		const [old, recent] = outboxFiles();
		const dir = outboxDir();
		const now = Date.now();
		const age = (name: string, ms: number) => {
			const file = path.join(dir, name);
			if (!fs.existsSync(file)) fs.writeFileSync(file, 'x');
			const t = new Date(now - ms);
			fs.utimesSync(file, t, t);
		};
		const DAY = 24 * 3600_000;
		age(old, OUTBOX_KEEP_MS + DAY);
		age(recent, OUTBOX_KEEP_MS - DAY);
		age('.2026-01-01T00-00-00-000Z-0badc0de.eml.partial', 2 * DAY);
		age('.2026-01-02T00-00-00-000Z-0badc0de.eml.partial', 3600_000);
		age('notes.eml', OUTBOX_KEEP_MS + DAY); // not a name we make
		age('README.txt', OUTBOX_KEEP_MS + DAY);

		expect(await pruneOutbox(now)).toBe(1);
		expect(outboxFiles().sort()).toEqual(['.2026-01-02T00-00-00-000Z-0badc0de.eml.partial', 'README.txt', 'notes.eml', recent].sort());
		fs.rmSync(dir, { recursive: true });
		expect(await pruneOutbox(now)).toBe(0); // no outbox yet: nothing to do
	});

	it('names never collide and record the success', async () => {
		await Promise.all([sendMail(MESSAGE), sendMail(MESSAGE), sendMail(MESSAGE)]);
		expect(new Set(outboxFiles()).size).toBe(3);
		expect(outboxFiles().every((f) => f.endsWith('.eml'))).toBe(true);
		expect(mailHealth()).toEqual({ lastSuccessAt: expect.any(Number), lastFailure: null });
	});
});

describe('SMTP (SMTP_HOST set)', () => {
	let defaultCAs: string[] = [];
	beforeAll(() => {
		if (!CERT) return;
		defaultCAs = tls.getCACertificates('default');
		tls.setDefaultCACertificates([...defaultCAs, CERT.cert]);
	});
	afterAll(() => {
		if (CERT) tls.setDefaultCACertificates(defaultCAs);
	});

	it('uses implicit TLS only on port 465, logs in only when SMTP_USER is set, and never logs in unencrypted', () => {
		setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'me@example.com', SMTP_PASS: 'pw' });
		expect(smtpOptions(getConfig().smtp!)).toMatchObject({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			requireTLS: false, // TLS from the start
			auth: { user: 'me@example.com', pass: 'pw' }
		});
		setEnv({ SMTP_PORT: '587' });
		expect(smtpOptions(getConfig().smtp!)).toMatchObject({ port: 587, secure: false, requireTLS: true });
		setEnv({ SMTP_USER: undefined, SMTP_PASS: undefined });
		const opts = smtpOptions(getConfig().smtp!);
		expect(opts).toMatchObject({ port: 587, secure: false, requireTLS: false });
		expect(opts.auth).toBeUndefined();
	});

	it.skipIf(!CERT)('sends through the server with STARTTLS, AUTH and SMTP_FROM, and writes nothing to the outbox', async () => {
		const smtp = await fakeSmtp({ tls: CERT! });
		try {
			setEnv({
				SMTP_HOST: '127.0.0.1',
				SMTP_PORT: String(smtp.port),
				SMTP_USER: 'mailer@example.com',
				SMTP_PASS: 's3cret',
				SMTP_FROM: '"Our Photos" <photos@example.com>'
			});
			expect(await sendMail(MESSAGE)).toBe('sent');
			expect(smtp.received).toHaveLength(1);
			const [got] = smtp.received;
			expect(got.secure).toBe(true);
			expect(smtp.commands.indexOf('STARTTLS')).toBeLessThan(smtp.commands.findIndex((c) => c.startsWith('AUTH')));
			const plain = Buffer.from(got.auth!.split(' ')[2], 'base64').toString('utf8');
			expect(plain).toBe('\0mailer@example.com\0s3cret');
			expect(got.from).toContain('<photos@example.com>');
			expect(got.to).toEqual([expect.stringContaining('<admin@example.com>')]);
			const mail = await simpleParser(got.data, { skipImageLinks: true });
			expect(mail.subject).toBe('Removal request: photo in "Beach"');
			expect(mail.from?.value[0]).toEqual({ name: 'Our Photos', address: 'photos@example.com' });
			expect(mail.attachments[0].cid).toBe('pic@family-photos');
			expect(outboxFiles()).toEqual([]);
		} finally {
			await smtp.close();
		}
	});

	it('never sends the login to a server that offers no STARTTLS, and says why', async () => {
		const smtp = await fakeSmtp();
		try {
			setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'mailer@example.com', SMTP_PASS: 's3cret' });
			await expect(sendMail(MESSAGE)).rejects.toThrow(/did not offer an encrypted connection/);
			expect(smtp.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(false);
			expect(smtp.commands.join('\n')).not.toContain(Buffer.from('\0mailer@example.com\0s3cret').toString('base64'));
			expect(smtp.received).toEqual([]);
			expect(mailHealth().lastFailure?.error).toMatch(/did not offer an encrypted connection/);
		} finally {
			await smtp.close();
		}
	});

	it('still sends through a relay without encryption when no login is set', async () => {
		const smtp = await fakeSmtp();
		try {
			setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port) });
			expect(await sendMail(MESSAGE)).toBe('sent');
			expect(smtp.received).toMatchObject([{ auth: null, secure: false }]);
		} finally {
			await smtp.close();
		}
	});

	it('rejects when the server refuses the message, and remembers the failure', async () => {
		const smtp = await fakeSmtp({ reject: true });
		try {
			setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port) });
			await expect(sendMail(MESSAGE)).rejects.toThrow(/Rejected for testing/);
			expect(mailHealth().lastFailure?.error).toMatch(/Rejected for testing/);
			expect(smtp.received[0]?.auth ?? null).toBeNull(); // no SMTP_USER → no AUTH
		} finally {
			await smtp.close();
		}
	});

	it('rejects when the server is unreachable', async () => {
		setEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(await closedPort()) });
		await expect(sendMail(MESSAGE)).rejects.toThrow(/ECONNREFUSED/);
		expect(outboxFiles()).toEqual([]);
	});
});
