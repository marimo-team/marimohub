import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver } from '@tanstack/react-query';
import { ApiRequestError } from './client';
import { createQueryClient, shouldRetryRequest } from './queryClient';
import { userKeys } from './queryKeys';
import { toastError } from '@/lib/errors';

vi.mock('@/lib/errors', () => ({ toastError: vi.fn() }));

beforeEach(() => {
	vi.mocked(toastError).mockClear();
});

describe('shouldRetryRequest', () => {
	it('does not retry client errors', () => {
		expect(shouldRetryRequest(0, new ApiRequestError('FORBIDDEN', 'no', { status: 403 }))).toBe(
			false,
		);
	});

	it('retries transient failures once', () => {
		const unavailable = new ApiRequestError('SERVICE_UNAVAILABLE', 'later', { status: 503 });
		expect(shouldRetryRequest(0, unavailable)).toBe(true);
		expect(shouldRetryRequest(1, unavailable)).toBe(false);
		expect(shouldRetryRequest(0, new ApiRequestError('NETWORK_ERROR', 'offline'))).toBe(true);
	});
});

describe('createQueryClient', () => {
	it('clears cached identity after an unauthorized query', async () => {
		const client = createQueryClient();
		client.setQueryData(userKeys.me(), { id: 'user-1' });

		await expect(
			client.fetchQuery({
				queryKey: ['unauthorized-test'],
				queryFn: () =>
					Promise.reject(new ApiRequestError('UNAUTHORIZED', 'sign in', { status: 401 })),
			}),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
		expect(client.getQueryData(userKeys.me())).toBeNull();
	});

	it('toasts mutation failures by default', async () => {
		const client = createQueryClient();
		const observer = new MutationObserver(client, {
			mutationFn: () => Promise.reject(new ApiRequestError('CONFLICT', 'nope', { status: 409 })),
		});

		await observer.mutate().catch(() => {});
		expect(toastError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONFLICT' }));
	});

	it('meta.suppressErrorToast opts a mutation out of the default toast', async () => {
		const client = createQueryClient();
		const observer = new MutationObserver(client, {
			mutationFn: () => Promise.reject(new ApiRequestError('CONFLICT', 'nope', { status: 409 })),
			meta: { suppressErrorToast: true },
		});

		await observer.mutate().catch(() => {});
		expect(toastError).not.toHaveBeenCalled();
	});
});
