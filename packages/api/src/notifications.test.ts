import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notifier } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { scheduleNotification } from './notifications';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('scheduleNotification', () => {
	it('logs a delivery failure without exposing the provider error message', async () => {
		const deliver = vi.fn(async () => {
			throw new Error('https://hooks.example.com/services/secret');
		});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		scheduleNotification(
			{ notifier: { deliver } as Notifier } as ApiDeps,
			'member.invited',
			{ request_id: 'request-1', event: 'untrusted-event', level: 'info' },
			() => ({
				kind: 'member.invited',
				severity: 'info',
				title: 'Invitation',
				body: 'You were invited.',
				recipients: [{ email: 'member@example.com' }],
				context: { pid: 'project-1' },
				dedupe_key: 'member.invited:project-1:member@example.com',
			}),
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		const record = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
		expect(record).toMatchObject({
			level: 'error',
			event: 'notification_delivery_failed',
			notification_kind: 'member.invited',
			request_id: 'request-1',
			error: { error_name: 'Error' },
		});
		expect(log.mock.calls[0]?.[0]).not.toContain('secret');
	});

	it('handles a renderer failure without calling the notifier', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		scheduleNotification(
			{ notifier: { deliver } as Notifier } as ApiDeps,
			'session.takeover',
			{},
			() => {
				throw new TypeError('Invalid base URL');
			},
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(deliver).not.toHaveBeenCalled();
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			event: 'notification_delivery_failed',
			notification_kind: 'session.takeover',
			error: { error_name: 'TypeError' },
		});
	});

	it('handles an asynchronous renderer failure', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		scheduleNotification(
			{ notifier: { deliver } as Notifier } as ApiDeps,
			'member.added',
			{},
			async () => {
				throw new Error('Identity lookup failed');
			},
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(deliver).not.toHaveBeenCalled();
	});
});
