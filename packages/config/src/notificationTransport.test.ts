import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationProbe } from '@marimo-hub/core';
import { sendNotificationRequest } from './notificationTransport';

function probe(fetch: IntegrationProbe['fetch']): IntegrationProbe {
	return { fetch, connect: () => Promise.reject(new Error('unused')) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('sendNotificationRequest', () => {
	it('retries transient failures but not permanent HTTP responses', async () => {
		const transient = vi
			.fn<IntegrationProbe['fetch']>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
		await expect(
			sendNotificationRequest(probe(transient), 'https://events.example.com', {}, { retries: 1 }),
		).resolves.toBeUndefined();
		expect(transient).toHaveBeenCalledTimes(2);

		const permanent = vi.fn<IntegrationProbe['fetch']>(async () => ({
			ok: false,
			status: 401,
			json: async () => null,
		}));
		await expect(
			sendNotificationRequest(probe(permanent), 'https://events.example.com', {}, { retries: 1 }),
		).rejects.toThrow('HTTP 401');
		expect(permanent).toHaveBeenCalledOnce();
	});

	it.each([408, 500, 503, 599])('retries HTTP %i immediately', async (status) => {
		const fetch = vi
			.fn<IntegrationProbe['fetch']>()
			.mockResolvedValueOnce({ ok: false, status, json: async () => null })
			.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
		const delay = vi.fn(async () => {});

		await sendNotificationRequest(
			probe(fetch),
			'https://events.example.com',
			{},
			{
				retries: 1,
				delay,
			},
		);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(delay).not.toHaveBeenCalled();
	});

	it.each([
		['0', 1_000],
		['999999', 60_000],
	])('clamps Retry-After %s seconds to %i ms', async (retryAfter, expectedDelay) => {
		const fetch = vi
			.fn<IntegrationProbe['fetch']>()
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { 'retry-after': retryAfter },
				json: async () => null,
			})
			.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
		const delay = vi.fn(async () => {});

		await sendNotificationRequest(
			probe(fetch),
			'https://events.example.com',
			{},
			{
				retries: 1,
				delay,
			},
		);

		expect(delay).toHaveBeenCalledWith(expectedDelay);
	});

	it.each([
		['Mon, 24 Aug 2026 12:00:30 GMT', 30_000],
		['Mon, 24 Aug 2026 11:59:59 GMT', 1_000],
		['Mon, 24 Aug 2026 12:02:00 GMT', 60_000],
	])('clamps Retry-After HTTP date %s to %i ms', async (retryAfter, expectedDelay) => {
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('Mon, 24 Aug 2026 12:00:00 GMT'));
		const fetch = vi
			.fn<IntegrationProbe['fetch']>()
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: { 'retry-after': retryAfter },
				json: async () => null,
			})
			.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });
		const delay = vi.fn(async () => {});

		await sendNotificationRequest(
			probe(fetch),
			'https://events.example.com',
			{},
			{
				retries: 1,
				delay,
			},
		);

		expect(delay).toHaveBeenCalledWith(expectedDelay);
	});
});
