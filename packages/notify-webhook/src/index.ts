import { ofetch } from 'ofetch';
import { NotificationSchema } from '@marimo-hub/core';
import type { Notification, NotificationDeliveryOutcome, Notifier } from '@marimo-hub/core';

interface WebhookRequestOptions {
	method: 'POST';
	body: string;
	headers: Record<string, string>;
	retry: number;
	timeout: number;
}

type WebhookFetch = (url: string, options: WebhookRequestOptions) => Promise<unknown>;

export interface WebhookNotifierOptions {
	url: string;
	secret: string;
	fetcher?: WebhookFetch;
	now?: () => number;
}

function httpsUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid notification webhook URL');
	}
	if (url.protocol !== 'https:') throw new Error('Notification webhook URL must use HTTPS');
	return value;
}

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signWebhook(
	secret: string,
	timestamp: number,
	body: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
	return `t=${timestamp},v1=${toHex(signature)}`;
}

export class WebhookNotifier implements Notifier {
	private readonly url: string;
	private readonly secret: string;
	private readonly fetcher: WebhookFetch;
	private readonly now: () => number;

	constructor(options: WebhookNotifierOptions) {
		this.url = httpsUrl(options.url);
		if (!options.secret) throw new Error('Notification webhook secret is required');
		this.secret = options.secret;
		this.fetcher = options.fetcher ?? ofetch;
		this.now = options.now ?? Date.now;
	}

	async deliver(notification: Notification): Promise<NotificationDeliveryOutcome> {
		const body = JSON.stringify(NotificationSchema.parse(notification));
		const timestamp = Math.floor(this.now() / 1000);
		const signature = await signWebhook(this.secret, timestamp, body);
		try {
			await this.fetcher(this.url, {
				method: 'POST',
				body,
				headers: {
					'content-type': 'application/json',
					'X-Marimohub-Signature': signature,
				},
				retry: 1,
				timeout: 10_000,
			});
			return 'delivered';
		} catch {
			throw new Error('Webhook notification delivery failed');
		}
	}
}
