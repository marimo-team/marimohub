import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notification, Notifier } from '@marimo-hub/core';
import {
	BROADCAST_NOTIFICATION_FIXTURE,
	MemoryBucket,
	NOTIFICATION_FIXTURE,
} from '@marimo-hub/core/testing';
import type { ApiDeps } from './context';
import { scheduleNotification } from './notifications';
import { makeTestDeps } from './testing';

function notificationDeps(overrides: Partial<ApiDeps>): ApiDeps {
	return makeTestDeps(new MemoryBucket(), overrides);
}

const PERSONAL_TAKEOVER_NOTIFICATION: Notification = {
	...BROADCAST_NOTIFICATION_FIXTURE,
	audience: 'personal',
	title: 'Your editor session was taken over',
	body: 'Owner took over Revenue in Forecasts.',
	recipients: [{ email: 'editor@example.com', name: 'Editor' }],
	dedupe_key: 'session.takeover:takeover-fixture:personal',
};

const TAKEOVER_NOTIFICATIONS = [
	PERSONAL_TAKEOVER_NOTIFICATION,
	BROADCAST_NOTIFICATION_FIXTURE,
] as const;

afterEach(() => {
	vi.restoreAllMocks();
});

describe('scheduleNotification', () => {
	it('registers delivery with the request background-task scheduler', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		let deferred: Promise<unknown> | undefined;
		const defer = vi.fn((task: Promise<unknown>) => {
			deferred = task;
		});
		const render = vi.fn(() => NOTIFICATION_FIXTURE);

		scheduleNotification(
			notificationDeps({
				notifier: { deliver } as Notifier,
				backgroundTasks: { defer },
			}),
			'member.invited',
			{},
			render,
		);

		expect(defer).toHaveBeenCalledOnce();
		expect(render).not.toHaveBeenCalled();
		await deferred;
		expect(deliver).toHaveBeenCalledOnce();
	});

	it('logs a partial fan-out outcome', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const deliver = vi.fn(async () => 'partial' as const);

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
			'member.invited',
			{ request_id: 'request-partial' },
			() => NOTIFICATION_FIXTURE,
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			level: 'warn',
			event: 'notification_delivery_partial',
			notification_kind: 'member.invited',
			request_id: 'request-partial',
		});
	});

	it('logs a delivery failure without exposing the provider error message', async () => {
		const deliver = vi.fn(async () => {
			throw Object.assign(new Error('https://hooks.example.com/services/secret'), {
				code: 'ECONNRESET',
				status: 503,
			});
		});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
			'member.invited',
			{ request_id: 'request-1', event: 'untrusted-event', level: 'info' },
			() => NOTIFICATION_FIXTURE,
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		const record = JSON.parse(log.mock.calls[0]?.[0] as string) as Record<string, unknown>;
		expect(record).toMatchObject({
			level: 'error',
			event: 'notification_delivery_failed',
			notification_kind: 'member.invited',
			request_id: 'request-1',
			error: {
				error_name: 'Error',
				error_code: 'ECONNRESET',
				error_status: 503,
			},
		});
		expect(log.mock.calls[0]?.[0]).not.toContain('secret');
	});

	it('handles a renderer failure without calling the notifier', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
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
			notificationDeps({ notifier: { deliver } as Notifier }),
			'member.added',
			{},
			async () => {
				throw new Error('Identity lookup failed');
			},
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(deliver).not.toHaveBeenCalled();
	});

	it('delivers every audience variant', async () => {
		const deliver = vi.fn(async () => 'delivered' as const);

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
			'session.takeover',
			{},
			() => TAKEOVER_NOTIFICATIONS,
		);

		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
		expect(deliver).toHaveBeenNthCalledWith(1, PERSONAL_TAKEOVER_NOTIFICATION);
		expect(deliver).toHaveBeenNthCalledWith(2, BROADCAST_NOTIFICATION_FIXTURE);
	});

	it('logs a partial result when one audience variant fails', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const deliver = vi
			.fn()
			.mockResolvedValueOnce('delivered' as const)
			.mockRejectedValueOnce(new Error('offline'));

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
			'session.takeover',
			{ request_id: 'request-variants' },
			() => TAKEOVER_NOTIFICATIONS,
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			event: 'notification_delivery_partial',
			notification_kind: 'session.takeover',
			request_id: 'request-variants',
		});
	});

	it('logs a failure when no audience variant delivers', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const deliver = vi.fn(async () => {
			throw new Error('offline');
		});

		scheduleNotification(
			notificationDeps({ notifier: { deliver } as Notifier }),
			'session.takeover',
			{},
			() => TAKEOVER_NOTIFICATIONS,
		);

		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			event: 'notification_delivery_failed',
			notification_kind: 'session.takeover',
		});
	});
});
