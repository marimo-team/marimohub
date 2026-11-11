import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { useSaveToBranch, useWorkingBranch, workingBranchKey } from './workingBranches';
import { useCreateSyncedNotebook } from './hooks';

afterEach(() => vi.unstubAllGlobals());
const keys = (fetch: ReturnType<typeof vi.fn>) =>
	fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));

describe('working branch mutations', () => {
	it('does not poll idle status and refreshes on invalidation', async () => {
		vi.useFakeTimers();
		try {
			const fetch = vi
				.fn()
				.mockImplementation(async () => jsonOk({ branch: 'working', commit: 'base' }));
			vi.stubGlobal('fetch', fetch);
			const { client, unmount } = renderHookWithClient(() => useWorkingBranch('proj-1', 'nb-1'), {
				toaster: false,
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(fetch).toHaveBeenCalledTimes(1);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(120_000);
			});
			expect(fetch).toHaveBeenCalledTimes(1);
			await act(async () => {
				await client.invalidateQueries({ queryKey: workingBranchKey('proj-1', 'nb-1') });
			});
			expect(fetch).toHaveBeenCalledTimes(2);
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});
	it('reuses the capture key after a lost response and rotates it after completion', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonError('UNAVAILABLE', 'Response lost', 503))
			.mockResolvedValueOnce(
				jsonOk({
					state: 'complete',
					project_id: 'proj-1',
					notebook_id: 'nb-1',
					session_id: 'sess-1',
				}),
			)
			.mockResolvedValueOnce(
				jsonOk({
					state: 'no_changes',
					project_id: 'proj-1',
					notebook_id: 'nb-1',
					session_id: 'sess-1',
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useSaveToBranch('proj-1', 'nb-1'), {
			toaster: false,
		});
		await act(async () => {
			await expect(result.current.mutateAsync({ sessionId: 'sess-1' })).rejects.toThrow();
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1' });
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1' });
		});
		const [first, retry, next] = keys(fetch);
		expect(first).toBeTruthy();
		expect(retry).toBe(first);
		expect(next).not.toBe(first);
	});
	it.each([400, 403, 409, 422])('starts a fresh capture after a %s response', async (status) => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonError('CONFLICT', 'Capture did not complete', status))
			.mockResolvedValueOnce(
				jsonOk({
					state: 'complete',
					project_id: 'proj-1',
					notebook_id: 'nb-1',
					session_id: 'sess-1',
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useSaveToBranch('proj-1', 'nb-1'), {
			toaster: false,
		});
		await act(async () => {
			await expect(result.current.mutateAsync({ sessionId: 'sess-1' })).rejects.toThrow(
				'Capture did not complete',
			);
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1' });
		});
		const [first, next] = keys(fetch);
		expect(first).toBeTruthy();
		expect(next).toBeTruthy();
		expect(next).not.toBe(first);
	});
	it('retains the capture key when the network fails without a response', async () => {
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(
				jsonOk({
					state: 'complete',
					project_id: 'proj-1',
					notebook_id: 'nb-1',
					session_id: 'sess-1',
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useSaveToBranch('proj-1', 'nb-1'), {
			toaster: false,
		});
		await act(async () => {
			await expect(result.current.mutateAsync({ sessionId: 'sess-1' })).rejects.toThrow();
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-1' });
		});
		const [first, retry] = keys(fetch);
		expect(first).toBeTruthy();
		expect(retry).toBe(first);
	});
	it('does not clear another session attempt when an earlier request fails late', async () => {
		let respond!: (response: Response) => void;
		const delayed = new Promise<Response>((resolve) => {
			respond = resolve;
		});
		const fetch = vi
			.fn()
			.mockReturnValueOnce(delayed)
			.mockResolvedValueOnce(jsonError('UNAVAILABLE', 'Response lost', 503))
			.mockResolvedValueOnce(
				jsonOk({
					state: 'complete',
					project_id: 'proj-1',
					notebook_id: 'nb-1',
					session_id: 'sess-2',
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useSaveToBranch('proj-1', 'nb-1'), {
			toaster: false,
		});
		let earlier!: Promise<unknown>;
		await act(async () => {
			earlier = result.current
				.mutateAsync({ sessionId: 'sess-1' })
				.catch((error: unknown) => error);
		});
		await act(async () => {
			await expect(result.current.mutateAsync({ sessionId: 'sess-2' })).rejects.toThrow();
		});
		await act(async () => {
			respond(jsonError('CONFLICT', 'Capture failed', 409));
			await earlier;
		});
		await act(async () => {
			await result.current.mutateAsync({ sessionId: 'sess-2' });
		});
		const [first, second, retry] = keys(fetch);
		expect(second).not.toBe(first);
		expect(retry).toBe(second);
	});
	it('resumes an existing receipt without starting a new session capture', async () => {
		const fetch = vi.fn().mockResolvedValue(
			jsonOk({
				state: 'complete',
				project_id: 'proj-1',
				notebook_id: 'nb-1',
				session_id: 'sess-1',
			}),
		);
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useSaveToBranch('proj-1', 'nb-1'), {
			toaster: false,
		});
		await act(async () => {
			await result.current.mutateAsync({ operationId: 'saved-op' });
		});
		expect(String(fetch.mock.calls[0][0])).toBe(
			'/api/v1/projects/proj-1/notebooks/nb-1/working-branch/saves/saved-op/retry',
		);
		expect(keys(fetch)).toEqual([null]);
	});
	it('retains a creation key on failure but gives a later identical creation a new identity', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonError('UNAVAILABLE', 'Response lost', 503))
			.mockResolvedValueOnce(jsonOk({ notebook: { id: 'nb-1' } }))
			.mockResolvedValueOnce(jsonOk({ notebook: { id: 'nb-2' } }));
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useCreateSyncedNotebook('proj-1'), {
			toaster: false,
		});
		const body = {
			title: 'App',
			description: '',
			repo: 'owner/repo',
			entry_notebook: 'app.py',
			fork: { base_branch: 'main' },
		};
		await act(async () => {
			await expect(result.current.mutateAsync(body)).rejects.toThrow();
		});
		await act(async () => {
			await result.current.mutateAsync(body);
		});
		await act(async () => {
			await result.current.mutateAsync(body);
		});
		const [first, retry, next] = keys(fetch);
		expect(first).toBeTruthy();
		expect(retry).toBe(first);
		expect(next).not.toBe(first);
	});
});
