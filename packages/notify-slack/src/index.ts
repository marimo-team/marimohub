import { ofetch } from 'ofetch';
import { requireHttpsUrl } from '@marimo-hub/core';
import type { Notification, NotificationDeliveryOutcome, Notifier } from '@marimo-hub/core';

interface SlackRequestOptions {
	method: 'POST';
	body: { text: string; unfurl_links: false; unfurl_media: false };
	retry: number;
	timeout: number;
}

type SlackFetch = (url: string, options: SlackRequestOptions) => Promise<{ ok: boolean }>;

export interface SlackNotifierOptions {
	webhookUrl: string;
	fetcher?: SlackFetch;
}

export function escapeSlackText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export class SlackNotifier implements Notifier {
	private readonly webhookUrl: string;
	private readonly fetcher: SlackFetch;

	constructor(options: SlackNotifierOptions) {
		this.webhookUrl = requireHttpsUrl(options.webhookUrl, 'Slack webhook URL');
		this.fetcher = options.fetcher ?? ((url, request) => ofetch.raw(url, request));
	}

	async deliver(notification: Notification): Promise<NotificationDeliveryOutcome> {
		if (notification.audience !== 'broadcast') return 'skipped';
		const parts = [`*${escapeSlackText(notification.title)}*`, escapeSlackText(notification.body)];
		if (notification.link) parts.push(escapeSlackText(notification.link));
		try {
			const response = await this.fetcher(this.webhookUrl, {
				method: 'POST',
				body: { text: parts.join('\n'), unfurl_links: false, unfurl_media: false },
				retry: 0,
				timeout: 10_000,
			});
			if (!response.ok) throw new Error('status');
			return 'delivered';
		} catch {
			throw new Error('Slack notification delivery failed');
		}
	}
}
