import nodemailer from 'nodemailer';
import type { Notification, NotificationDeliveryOutcome, Notifier } from '@marimo-hub/core';

interface Mailer {
	sendMail(options: {
		from: string;
		to: { address: string; name?: string }[];
		subject: string;
		text: string;
	}): Promise<unknown>;
}

export interface SmtpNotifierOptions {
	url: string;
	from: string;
	adminTo?: string[];
	mailer?: Mailer;
}

function rejectHeaderBreaks(value: string, field: string): void {
	if (/\r|\n/.test(value)) throw new Error(`Invalid ${field}: line breaks are not allowed`);
}

function smtpUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid SMTP URL');
	}
	if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
		throw new Error('Invalid SMTP URL protocol');
	}
	return value;
}

export class SmtpNotifier implements Notifier {
	private readonly from: string;
	private readonly adminTo: string[];
	private readonly mailer: Mailer;

	constructor(options: SmtpNotifierOptions) {
		const url = smtpUrl(options.url);
		rejectHeaderBreaks(options.from, 'SMTP sender');
		for (const email of options.adminTo ?? []) rejectHeaderBreaks(email, 'SMTP admin recipient');
		this.from = options.from;
		this.adminTo = options.adminTo ?? [];
		if (options.mailer) {
			this.mailer = options.mailer;
		} else {
			try {
				this.mailer = nodemailer.createTransport(url);
			} catch {
				throw new Error('Invalid SMTP transport configuration');
			}
		}
	}

	async deliver(notification: Notification): Promise<NotificationDeliveryOutcome> {
		rejectHeaderBreaks(notification.title, 'notification title');
		const recipients: { address: string; name?: string }[] =
			notification.recipients.length > 0
				? notification.recipients.map((recipient) => ({
						address: recipient.email,
						...(recipient.name ? { name: recipient.name } : {}),
					}))
				: this.adminTo.map((address) => ({ address }));
		for (const recipient of recipients) {
			rejectHeaderBreaks(recipient.address, 'notification recipient');
			if (recipient.name) rejectHeaderBreaks(recipient.name, 'notification recipient name');
		}
		if (recipients.length === 0) return 'skipped';

		const text = notification.link
			? `${notification.body}\n\n${notification.link}`
			: notification.body;
		try {
			await this.mailer.sendMail({
				from: this.from,
				to: recipients,
				subject: notification.title,
				text,
			});
			return 'delivered';
		} catch {
			throw new Error('SMTP notification delivery failed');
		}
	}
}
