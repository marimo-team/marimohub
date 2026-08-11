import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_FIXTURE } from '@marimo-hub/core/testing';
import { signWebhook, WebhookNotifier } from './index';

describe('WebhookNotifier', () => {
	it('posts the full notification with a verifiable HMAC signature', async () => {
		const fetcher = vi.fn(async () => ({}));
		const now = 1_786_446_400_000;
		const notifier = new WebhookNotifier({
			url: 'https://events.example.com/marimohub',
			secret: 'webhook-secret',
			fetcher,
			now: () => now,
		});
		await expect(notifier.deliver(NOTIFICATION_FIXTURE)).resolves.toBe('delivered');

		const body = JSON.stringify(NOTIFICATION_FIXTURE);
		const timestamp = Math.floor(now / 1000);
		const expected = createHmac('sha256', 'webhook-secret')
			.update(`${timestamp}.${body}`)
			.digest('hex');
		expect(fetcher).toHaveBeenCalledWith('https://events.example.com/marimohub', {
			method: 'POST',
			body,
			headers: {
				'content-type': 'application/json',
				'X-Marimohub-Signature': `t=${timestamp},v1=${expected}`,
			},
			retry: 1,
			timeout: 10_000,
		});
	});

	it('matches a fixed HMAC vector', async () => {
		await expect(signWebhook('secret', 1_700_000_000, '{"ok":true}')).resolves.toBe(
			't=1700000000,v1=c1afc7c2df3db0690d7d75954610ed1a1d959ce96355ccb8c0a8bc09fd0cfc27',
		);
	});

	it('rejects a malformed URL and an empty secret', () => {
		expect(() => new WebhookNotifier({ url: 'not-a-url', secret: 'secret' })).toThrow(
			'Invalid notification webhook URL',
		);
		expect(
			() => new WebhookNotifier({ url: 'https://events.example.com/hook', secret: '' }),
		).toThrow('Notification webhook secret is required');
	});

	it('rejects an invalid notification before making a request', async () => {
		const fetcher = vi.fn(async () => ({}));
		const notifier = new WebhookNotifier({
			url: 'https://events.example.com/hook',
			secret: 'secret',
			fetcher,
		});

		await expect(
			notifier.deliver({
				...NOTIFICATION_FIXTURE,
				recipients: [{ email: 'not-an-email' }],
			}),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('requires HTTPS and hides request errors', async () => {
		expect(() => new WebhookNotifier({ url: 'http://localhost/hook', secret: 'secret' })).toThrow(
			'must use HTTPS',
		);
		const notifier = new WebhookNotifier({
			url: 'https://events.example.com/secret-path',
			secret: 'secret',
			fetcher: async () => {
				throw new Error('https://events.example.com/secret-path');
			},
		});
		const delivery = notifier.deliver(NOTIFICATION_FIXTURE);
		await expect(delivery).rejects.toThrow('Webhook notification delivery failed');
		await expect(delivery).rejects.not.toThrow('secret-path');
	});
});
