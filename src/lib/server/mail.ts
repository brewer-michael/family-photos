/**
 * Outgoing email. STUB — the admin track implements this.
 *
 * Final contract: with config.smtp → nodemailer (secure when port 465) and resolve 'sent';
 * without SMTP_HOST → write an .eml file to paths.outboxDir() and resolve 'saved'.
 * Rejects on SMTP failure (callers record email_status='failed').
 */
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

export async function sendMail(msg: MailMessage): Promise<MailResult> {
	void msg;
	// TODO(admin track): nodemailer / .eml outbox.
	return 'saved';
}
