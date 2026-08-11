import { ofetch } from 'ofetch';
import type { Notification, NotificationDeliveryOutcome, Notifier } from '@marimo-hub/core';

interface SlackRequestOptions {
	method: 'POST';
	body: { text: string; unfurl_links: false; unfurl_media: false };
	retry: number;
	timeout: number;
}

type SlackFetch = (url: string, options: SlackRequestOptions) => Promise<unknown>;

export interface SlackNotifierOptions {
	webhookUrl: string;
	fetcher?: SlackFetch;
}

function httpsUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid Slack webhook URL');
	}
	if (url.protocol !== 'https:') throw new Error('Slack webhook URL must use HTTPS');
	return value;
}

export function escapeSlackText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export class SlackNotifier implements Notifier {
	private readonly webhookUrl: string;
	private readonly fetcher: SlackFetch;

	constructor(options: SlackNotifierOptions) {
		this.webhookUrl = httpsUrl(options.webhookUrl);
		this.fetcher = options.fetcher ?? ofetch;
	}

	async deliver(notification: Notification): Promise<NotificationDeliveryOutcome> {
		if (notification.audience !== 'broadcast') return 'skipped';
		const parts = [`*${escapeSlackText(notification.title)}*`, escapeSlackText(notification.body)];
		if (notification.link) parts.push(escapeSlackText(notification.link));
		try {
			await this.fetcher(this.webhookUrl, {
				method: 'POST',
				body: { text: parts.join('\n'), unfurl_links: false, unfurl_media: false },
				retry: 0,
				timeout: 10_000,
			});
			return 'delivered';
		} catch {
			throw new Error('Slack notification delivery failed');
		}
	}
}
