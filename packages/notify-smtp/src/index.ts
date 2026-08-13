import nodemailer from 'nodemailer';
import type { Notification, NotificationDeliveryOutcome, Notifier } from '@marimo-hub/core';

interface Mailer {
	sendMail(options: {
		from: string;
		to: { address: string; name?: string }[];
		subject: string;
		text: string;
	}): Promise<unknown>;
	close?(): void;
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

export function smtpTransportUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid SMTP URL');
	}
	if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
		throw new Error('Invalid SMTP URL protocol');
	}
	if (!url.hostname) throw new Error('Invalid SMTP URL: hostname is required');
	url.searchParams.set('connectionTimeout', '10000');
	url.searchParams.set('greetingTimeout', '10000');
	url.searchParams.set('socketTimeout', '30000');
	return url.toString();
}

export class SmtpNotifier implements Notifier {
	private readonly from: string;
	private readonly adminTo: string[];
	private readonly mailer: Mailer;

	constructor(options: SmtpNotifierOptions) {
		const url = smtpTransportUrl(options.url);
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

	close(): void {
		this.mailer.close?.();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.close();
	}

	async deliver(notification: Notification): Promise<NotificationDeliveryOutcome> {
		rejectHeaderBreaks(notification.title, 'notification title');
		const recipients: { address: string; name?: string }[] =
			notification.audience === 'personal'
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
