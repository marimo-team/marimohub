import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_FIXTURE } from '@marimo-hub/core/testing';
import { escapeSlackText, SlackNotifier } from './index';

describe('SlackNotifier', () => {
	it('escapes Slack metacharacters and disables unfurls', async () => {
		const fetcher = vi.fn(async () => ({}));
		const notifier = new SlackNotifier({
			webhookUrl: 'https://hooks.slack.com/services/example',
			fetcher,
		});
		await expect(
			notifier.deliver({
				...NOTIFICATION_FIXTURE,
				title: 'A < B & C',
				body: 'Open > close',
			}),
		).resolves.toBe('delivered');
		expect(fetcher).toHaveBeenCalledWith('https://hooks.slack.com/services/example', {
			method: 'POST',
			body: {
				text: '*A &lt; B &amp; C*\nOpen &gt; close\nhttps://hub.example.com/projects/project_01',
				unfurl_links: false,
				unfurl_media: false,
			},
			retry: 1,
			timeout: 10_000,
		});
	});

	it('rejects a malformed webhook URL', () => {
		expect(() => new SlackNotifier({ webhookUrl: 'not-a-url' })).toThrow(
			'Invalid Slack webhook URL',
		);
	});

	it('requires HTTPS and hides request errors', async () => {
		expect(
			() => new SlackNotifier({ webhookUrl: 'http://hooks.example.com/services/example' }),
		).toThrow('must use HTTPS');
		const notifier = new SlackNotifier({
			webhookUrl: 'https://hooks.example.com/services/secret',
			fetcher: async () => {
				throw new Error('https://hooks.example.com/services/secret');
			},
		});
		const delivery = notifier.deliver(NOTIFICATION_FIXTURE);
		await expect(delivery).rejects.toThrow('Slack notification delivery failed');
		await expect(delivery).rejects.not.toThrow('secret');
	});

	it('escapes ampersands before angle brackets', () => {
		expect(escapeSlackText('&<>')).toBe('&amp;&lt;&gt;');
	});
});
