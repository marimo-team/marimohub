import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { useNotebookChangeRequestPublisher } from './changeRequests';

function publication(proposalId: string, number: number) {
	return {
		proposal_id: proposalId,
		change_request: {
			provider: 'github',
			number,
			url: `https://github.com/owner/repo/pull/${number}`,
			head_branch: `proposal-${proposalId}`,
			head_commit: `commit-${proposalId}`,
		},
	};
}

function idempotencyKeys(fetch: ReturnType<typeof vi.fn>): (string | null)[] {
	return fetch.mock.calls.map(([, init]) =>
		new Headers((init as RequestInit | undefined)?.headers).get('idempotency-key'),
	);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('useNotebookChangeRequestPublisher', () => {
	it('rejects an update before a change request has been opened', async () => {
		const { result } = renderHookWithClient(
			() => useNotebookChangeRequestPublisher('proj-1', 'nb-1'),
			{ toaster: false },
		);

		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'update' }),
			).rejects.toThrow('Cannot update a change request before one has been opened');
		});
	});

	it('does not carry a published change request into another notebook scope', async () => {
		const fetch = vi.fn().mockResolvedValue(jsonOk(publication('prop-1', 17)));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ projectId, notebookId }) => useNotebookChangeRequestPublisher(projectId, notebookId),
			{
				initialProps: { projectId: 'proj-1', notebookId: 'nb-1' },
				toaster: false,
			},
		);

		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		expect(result.current.activeChangeRequest?.proposal_id).toBe('prop-1');

		rerender({ projectId: 'proj-1', notebookId: 'nb-2' });

		expect(result.current.activeChangeRequest).toBeUndefined();
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-2', action: 'update' }),
			).rejects.toThrow('Cannot update a change request before one has been opened');
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('ignores a publication that finishes after navigation to another notebook', async () => {
		let resolveFirst!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => firstResponse)
			.mockResolvedValueOnce(jsonOk(publication('prop-2', 18)));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ projectId, notebookId }) => useNotebookChangeRequestPublisher(projectId, notebookId),
			{
				initialProps: { projectId: 'proj-1', notebookId: 'nb-1' },
				toaster: false,
			},
		);

		let oldRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			oldRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(result.current.isPending).toBe(true);
		rerender({ projectId: 'proj-1', notebookId: 'nb-2' });
		expect(result.current.isPending).toBe(false);
		expect(result.current.status).toBe('idle');
		expect(result.current.data).toBeUndefined();
		await act(async () => {
			resolveFirst(jsonOk(publication('prop-1', 17)));
			await oldRequest;
		});
		expect(result.current.isSuccess).toBe(false);
		expect(result.current.status).toBe('idle');
		expect(result.current.data).toBeUndefined();
		expect(result.current.activeChangeRequest).toBeUndefined();

		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-2', action: 'open' });
		});
		expect(result.current.activeChangeRequest?.proposal_id).toBe('prop-2');
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
			expect.stringContaining('/projects/proj-1/notebooks/nb-1/sessions/sess-1/change-requests'),
			expect.stringContaining('/projects/proj-1/notebooks/nb-2/sessions/sess-2/change-requests'),
		]);
	});

	it('rotates an expired attempt that fails after navigation away and back', async () => {
		let rejectExpired!: (response: Response) => void;
		const expiredResponse = new Promise<Response>((resolve) => {
			rejectExpired = resolve;
		});
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => expiredResponse)
			.mockResolvedValueOnce(jsonOk(publication('prop-2', 18)));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ notebookId }) => useNotebookChangeRequestPublisher('proj-1', notebookId),
			{ initialProps: { notebookId: 'nb-1' }, toaster: false },
		);

		let expiredRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			expiredRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		rerender({ notebookId: 'nb-2' });
		await act(async () => {
			rejectExpired(jsonError('PROPOSAL_RETRY_REQUIRED', 'Proposal payload expired', 409));
			await expect(expiredRequest).rejects.toThrow('Proposal payload expired');
		});
		rerender({ notebookId: 'nb-1' });
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});

		const keys = idempotencyKeys(fetch);
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it('retains each notebook retry key while requests overlap across navigation', async () => {
		let rejectFirst!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			rejectFirst = resolve;
		});
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => firstResponse)
			.mockResolvedValueOnce(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503))
			.mockResolvedValueOnce(jsonOk(publication('prop-1', 17)));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ notebookId }) => useNotebookChangeRequestPublisher('proj-1', notebookId),
			{ initialProps: { notebookId: 'nb-1' }, toaster: false },
		);

		let firstRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			firstRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		rerender({ notebookId: 'nb-2' });
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-2', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});
		await act(async () => {
			rejectFirst(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503));
			await expect(firstRequest).rejects.toThrow('Provider unavailable');
		});
		rerender({ notebookId: 'nb-1' });
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});

		const keys = idempotencyKeys(fetch);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe(keys[2]);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it('replays a stale successful request with its original key after returning', async () => {
		let resolveFirst!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => firstResponse)
			.mockResolvedValueOnce(jsonOk(publication('prop-1', 17)));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ notebookId }) => useNotebookChangeRequestPublisher('proj-1', notebookId),
			{ initialProps: { notebookId: 'nb-1' }, toaster: false },
		);

		let firstRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			firstRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		rerender({ notebookId: 'nb-2' });
		await act(async () => {
			resolveFirst(jsonOk(publication('prop-1', 17)));
			await firstRequest;
		});
		expect(result.current.activeChangeRequest).toBeUndefined();

		rerender({ notebookId: 'nb-1' });
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		expect(result.current.activeChangeRequest?.proposal_id).toBe('prop-1');
		const keys = idempotencyKeys(fetch);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
	});

	it('retains independent retry keys for overlapping actions in one notebook', async () => {
		let rejectUpdate!: (response: Response) => void;
		const updateResponse = new Promise<Response>((resolve) => {
			rejectUpdate = resolve;
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk(publication('prop-1', 17)))
			.mockImplementationOnce(() => updateResponse)
			.mockResolvedValueOnce(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503))
			.mockResolvedValueOnce(jsonOk(publication('prop-2', 17)));
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(
			() => useNotebookChangeRequestPublisher('proj-1', 'nb-1'),
			{ toaster: false },
		);
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});

		let updateRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			updateRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'update' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'create-new' }),
			).rejects.toThrow('Provider unavailable');
		});
		await act(async () => {
			rejectUpdate(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503));
			await expect(updateRequest).rejects.toThrow('Provider unavailable');
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1', action: 'update' });
		});

		const keys = idempotencyKeys(fetch);
		expect(keys).toHaveLength(4);
		expect(keys[1]).toBe(keys[3]);
		expect(keys[1]).not.toBe(keys[2]);
	});

	it('keeps a successful attempt until every same-key request settles', async () => {
		const resolvers: ((response: Response) => void)[] = [];
		const fetch = vi.fn().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolvers.push(resolve);
				}),
		);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(
			() => useNotebookChangeRequestPublisher('proj-1', 'nb-1'),
			{ toaster: false },
		);

		let firstRequest!: Promise<ReturnType<typeof publication>>;
		let secondRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			firstRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
			secondRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(idempotencyKeys(fetch)[0]).toBe(idempotencyKeys(fetch)[1]);

		await act(async () => {
			resolvers[0](jsonOk(publication('prop-1', 17)));
			await firstRequest;
		});
		let thirdRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			thirdRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(idempotencyKeys(fetch)[2]).toBe(idempotencyKeys(fetch)[0]);

		await act(async () => {
			resolvers[1](jsonOk(publication('prop-1', 17)));
			resolvers[2](jsonOk(publication('prop-1', 17)));
			await Promise.all([secondRequest, thirdRequest]);
		});
		let fourthRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			fourthRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		expect(idempotencyKeys(fetch)[3]).not.toBe(idempotencyKeys(fetch)[0]);
		await act(async () => {
			resolvers[3](jsonOk(publication('prop-2', 18)));
			await fourthRequest;
		});
	});

	it('expires a settled retry key after the proposal retention window', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-18T00:00:00Z'));
		const fetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503)),
			);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(
			() => useNotebookChangeRequestPublisher('proj-1', 'nb-1'),
			{ toaster: false },
		);

		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});
		vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});

		const keys = idempotencyKeys(fetch);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[1]).not.toBe(keys[2]);
	});

	it('does not expire an in-flight attempt', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-18T00:00:00Z'));
		let rejectFirst!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			rejectFirst = resolve;
		});
		const fetch = vi
			.fn()
			.mockImplementationOnce(() => firstResponse)
			.mockImplementation(() =>
				Promise.resolve(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503)),
			);
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ notebookId }) => useNotebookChangeRequestPublisher('proj-1', notebookId),
			{ initialProps: { notebookId: 'nb-1' }, toaster: false },
		);

		let firstRequest!: Promise<ReturnType<typeof publication>>;
		act(() => {
			firstRequest = result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' });
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		rerender({ notebookId: 'nb-2' });
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-2', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});
		rerender({ notebookId: 'nb-1' });
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-1', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});

		const keys = idempotencyKeys(fetch);
		expect(keys[0]).toBe(keys[2]);
		await act(async () => {
			rejectFirst(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503));
			await expect(firstRequest).rejects.toThrow('Provider unavailable');
		});
	});

	it('bounds settled attempts while preserving the most recently used retry keys', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-08-18T00:00:00Z'));
		const fetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(jsonError('SERVICE_UNAVAILABLE', 'Provider unavailable', 503)),
			);
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ notebookId }) => useNotebookChangeRequestPublisher('proj-1', notebookId),
			{ initialProps: { notebookId: 'nb-0' }, toaster: false },
		);

		for (let index = 0; index < 33; index += 1) {
			rerender({ notebookId: `nb-${index}` });
			await act(async () => {
				await expect(
					result.current.mutateAsync({ sessionId: `sess-${index}`, action: 'open' }),
				).rejects.toThrow('Provider unavailable');
			});
			vi.advanceTimersByTime(1);
		}
		const firstKey = idempotencyKeys(fetch)[0];
		const latestKey = idempotencyKeys(fetch)[32];

		rerender({ notebookId: 'nb-32' });
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-32', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});
		rerender({ notebookId: 'nb-0' });
		await act(async () => {
			await expect(
				result.current.mutateAsync({ sessionId: 'sess-0', action: 'open' }),
			).rejects.toThrow('Provider unavailable');
		});

		const keys = idempotencyKeys(fetch);
		expect(keys[33]).toBe(latestKey);
		expect(keys[34]).not.toBe(firstKey);
	});
});
