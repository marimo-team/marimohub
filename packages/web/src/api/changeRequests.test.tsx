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

afterEach(() => {
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

		const idempotencyKeys = fetch.mock.calls.map(([, init]) =>
			new Headers(init?.headers).get('idempotency-key'),
		);
		expect(idempotencyKeys).toHaveLength(2);
		expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
	});
});
