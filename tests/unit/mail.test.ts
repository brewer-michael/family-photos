/**
 * Outgoing email: the outbox (.eml files, no SMTP_HOST) and SMTP against a tiny fake SMTP server
 * on 127.0.0.1 that records the AUTH line, the envelope and the message.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '#lib/server/config';
import { mailHealth, sendMail, smtpOptions, type MailMessage } from '#lib/server/mail';
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
	from: string;
	to: string[];
	data: string;
}

/** Just enough ESMTP for nodemailer: EHLO (AUTH PLAIN), AUTH, MAIL, RCPT, DATA, QUIT. */
async function fakeSmtp(opts: { reject?: boolean } = {}) {
	const received: Received[] = [];
	const server = net.createServer((sock) => {
		let buf = '';
		let inData = false;
		let cur: Received = { auth: null, from: '', to: [], data: '' };
		const reply = (s: string) => sock.write(`${s}\r\n`);
		reply('220 fake.test ESMTP');
		sock.on('data', (chunk) => {
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
						received.push(cur);
						reply('250 2.0.0 Queued');
					}
					cur = { auth: cur.auth, from: '', to: [], data: '' };
					continue;
				}
				const nl = buf.indexOf('\r\n');
				if (nl < 0) return;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 2);
				const cmd = line.split(' ')[0].toUpperCase();
				if (cmd === 'EHLO') reply('250-fake.test\r\n250-AUTH PLAIN\r\n250 8BITMIME');
				else if (cmd === 'AUTH') {
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
					sock.end();
				} else reply('250 OK');
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		received,
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

	it('names never collide and record the success', async () => {
		await Promise.all([sendMail(MESSAGE), sendMail(MESSAGE), sendMail(MESSAGE)]);
		expect(new Set(outboxFiles()).size).toBe(3);
		expect(outboxFiles().every((f) => f.endsWith('.eml'))).toBe(true);
		expect(mailHealth()).toEqual({ lastSuccessAt: expect.any(Number), lastFailure: null });
	});
});

describe('SMTP (SMTP_HOST set)', () => {
	it('uses implicit TLS only on port 465 and logs in only when SMTP_USER is set', () => {
		setEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'me@example.com', SMTP_PASS: 'pw' });
		expect(smtpOptions(getConfig().smtp!)).toMatchObject({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			auth: { user: 'me@example.com', pass: 'pw' }
		});
		setEnv({ SMTP_PORT: '587', SMTP_USER: undefined, SMTP_PASS: undefined });
		const opts = smtpOptions(getConfig().smtp!);
		expect(opts).toMatchObject({ port: 587, secure: false });
		expect(opts.auth).toBeUndefined();
	});

	it('sends through the server with AUTH and SMTP_FROM, and writes nothing to the outbox', async () => {
		const smtp = await fakeSmtp();
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
