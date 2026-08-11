import { describe, expect, it, vi } from 'vitest';
import type { Metrics } from '@marimo-hub/core';
import { NOTIFICATION_FIXTURE } from '@marimo-hub/core/testing';
import { makeNotifier, notificationBackends } from './notifications';

describe('makeNotifier', () => {
	it('returns a no-op notifier when no backends are configured', async () => {
		await expect(makeNotifier({}).deliver(NOTIFICATION_FIXTURE)).resolves.toBe('skipped');
	});

	it('validates backend names and required backend variables', () => {
		expect(() => makeNotifier({ MARIMOHUB_NOTIFY_BACKENDS: 'email' })).toThrow(
			/Invalid MARIMOHUB_NOTIFY_BACKENDS/,
		);
		expect(() => makeNotifier({ MARIMOHUB_NOTIFY_BACKENDS: 'smtp' })).toThrow(
			/MARIMOHUB_NOTIFY_SMTP_URL/,
		);
		expect(() =>
			makeNotifier({
				MARIMOHUB_NOTIFY_BACKENDS: 'slack',
				MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL: 'http://hooks.example.com',
			}),
		).toThrow(/must use HTTPS/);
	});

	it.each([
		[
			'SMTP sender',
			{
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_URL: 'smtp://localhost:1025',
			},
			'MARIMOHUB_NOTIFY_SMTP_FROM',
		],
		['Slack URL', { MARIMOHUB_NOTIFY_BACKENDS: 'slack' }, 'MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL'],
		['webhook URL', { MARIMOHUB_NOTIFY_BACKENDS: 'webhook' }, 'MARIMOHUB_NOTIFY_WEBHOOK_URL'],
		[
			'webhook secret',
			{
				MARIMOHUB_NOTIFY_BACKENDS: 'webhook',
				MARIMOHUB_NOTIFY_WEBHOOK_URL: 'https://events.example.com/hook',
			},
			'MARIMOHUB_NOTIFY_WEBHOOK_SECRET',
		],
	] as const)('requires the %s when its backend is enabled', (_label, env, variable) => {
		expect(() => makeNotifier(env)).toThrow(variable);
	});

	it('ignores backend variables when notifications are disabled', async () => {
		const notifier = makeNotifier({
			MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL: 'http://insecure.example.com/hook',
			MARIMOHUB_NOTIFY_KINDS: 'unknown.kind',
		});

		await expect(notifier.deliver(NOTIFICATION_FIXTURE)).resolves.toBe('skipped');
	});

	it('selects multiple backends case-insensitively and removes duplicates', () => {
		expect(notificationBackends({ MARIMOHUB_NOTIFY_BACKENDS: 'SMTP, slack,webhook,smtp' })).toEqual(
			['smtp', 'slack', 'webhook'],
		);
	});

	it('filters kinds before delivery', async () => {
		const increment = vi.fn();
		const metrics: Metrics = { increment, gauge: vi.fn() };
		const notifier = makeNotifier(
			{
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_URL: 'smtp://localhost:1025',
				MARIMOHUB_NOTIFY_SMTP_FROM: 'hub@example.com',
				MARIMOHUB_NOTIFY_KINDS: 'session.takeover',
			},
			metrics,
		);
		await notifier.deliver(NOTIFICATION_FIXTURE);
		expect(increment).not.toHaveBeenCalled();
	});

	it('rejects unknown notification kinds', () => {
		expect(() =>
			makeNotifier({
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_URL: 'smtp://localhost:1025',
				MARIMOHUB_NOTIFY_SMTP_FROM: 'hub@example.com',
				MARIMOHUB_NOTIFY_KINDS: 'job.failed',
			}),
		).toThrow(/Invalid MARIMOHUB_NOTIFY_KINDS/);
	});

	it('treats a blank kind allowlist as the default set', () => {
		expect(() =>
			makeNotifier({
				MARIMOHUB_NOTIFY_BACKENDS: 'smtp',
				MARIMOHUB_NOTIFY_SMTP_URL: 'smtp://localhost:1025',
				MARIMOHUB_NOTIFY_SMTP_FROM: 'hub@example.com',
				MARIMOHUB_NOTIFY_KINDS: '  ,  ',
			}),
		).not.toThrow();
	});
});
