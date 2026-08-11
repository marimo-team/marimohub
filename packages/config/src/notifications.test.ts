import { describe, expect, it, vi } from 'vitest';
import type { Metrics } from '@marimo-hub/core';
import { NOTIFICATION_FIXTURE } from '@marimo-hub/core/testing';
import { makeNotifier, notificationBackends, notificationKindsForBackend } from './notifications';

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

	it('filters kinds inside each backend', async () => {
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
		expect(increment).toHaveBeenCalledWith('notify.skipped', 1, {
			adapter: 'smtp',
			kind: 'member.invited',
		});
	});

	it('inherits the global kind allowlist for each backend', () => {
		const env = { MARIMOHUB_NOTIFY_KINDS: 'member.invited' };
		expect([...notificationKindsForBackend(env, 'smtp')]).toEqual(['member.invited']);
		expect([...notificationKindsForBackend(env, 'slack')]).toEqual(['member.invited']);
	});

	it('uses an exact per-backend kind override', () => {
		const env = {
			MARIMOHUB_NOTIFY_KINDS: 'member.invited,member.added',
			MARIMOHUB_NOTIFY_SLACK_KINDS: 'session.takeover',
		};
		expect([...notificationKindsForBackend(env, 'smtp')]).toEqual([
			'member.invited',
			'member.added',
		]);
		expect([...notificationKindsForBackend(env, 'slack')]).toEqual(['session.takeover']);
	});

	it('supports disabling one backend with the none token', () => {
		const env = { MARIMOHUB_NOTIFY_WEBHOOK_KINDS: 'none' };
		expect(notificationKindsForBackend(env, 'webhook')).toEqual(new Set());
		expect([...notificationKindsForBackend(env, 'smtp')]).toEqual([
			'member.invited',
			'member.added',
			'session.takeover',
		]);
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

	it('rejects an unknown kind in a backend override', () => {
		expect(() =>
			notificationKindsForBackend({ MARIMOHUB_NOTIFY_SMTP_KINDS: 'job.failed' }, 'smtp'),
		).toThrow(/Invalid MARIMOHUB_NOTIFY_SMTP_KINDS/);
	});

	it('rejects none when it is combined with a kind', () => {
		expect(() =>
			notificationKindsForBackend(
				{ MARIMOHUB_NOTIFY_SLACK_KINDS: 'none,session.takeover' },
				'slack',
			),
		).toThrow(/Invalid MARIMOHUB_NOTIFY_SLACK_KINDS/);
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
