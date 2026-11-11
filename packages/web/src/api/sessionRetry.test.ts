import { afterEach, expect, it, vi } from 'vitest';
import { ApiRequestError } from './client';
import { retrySessionAdmission } from './sessionRetry';

afterEach(() => vi.useRealTimers());

it('retries unavailable admissions at most twice and honors Retry-After', async () => {
	vi.useFakeTimers();
	const error = new ApiRequestError('SERVICE_UNAVAILABLE', 'Busy', {
		status: 503,
		retryAfterMs: 2000,
	});
	const request = vi.fn().mockRejectedValue(error);
	const pending = expect(retrySessionAdmission(request)).rejects.toBe(error);
	await vi.advanceTimersByTimeAsync(1999);
	expect(request).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(2001);
	await pending;
	expect(request).toHaveBeenCalledTimes(3);
});

it.each([
	new ApiRequestError('NETWORK_ERROR', 'Lost connection'),
	new ApiRequestError('FORBIDDEN', 'Denied', { status: 403 }),
	new ApiRequestError('RESOURCE_EXHAUSTED', 'Capacity full', { status: 503 }),
	new ApiRequestError('RESOURCE_EXHAUSTED', 'Capacity full', { status: 429 }),
	new ApiRequestError('CONFLICT', 'Conflict', { status: 409 }),
	new ApiRequestError('SERVICE_UNAVAILABLE', 'Busy', { status: 503, retryAfterMs: 60_000 }),
])('does not replay ambiguous or non-retryable failures', async (error) => {
	const request = vi.fn().mockRejectedValue(error);
	await expect(retrySessionAdmission(request)).rejects.toBe(error);
	expect(request).toHaveBeenCalledOnce();
});

it('returns a recovered admission', async () => {
	vi.useFakeTimers();
	const request = vi
		.fn()
		.mockRejectedValueOnce(new ApiRequestError('SERVICE_UNAVAILABLE', 'Busy', { status: 503 }))
		.mockResolvedValue('session');
	const pending = retrySessionAdmission(request);
	await vi.advanceTimersByTimeAsync(500);
	await expect(pending).resolves.toBe('session');
	expect(request).toHaveBeenCalledTimes(2);
});
