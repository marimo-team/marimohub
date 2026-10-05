import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { useSourceBranchesQuery, useSourceCommitsQuery } from './sourceControl';

const branch = (value: string) => ({ value, label: value, commit: 'a'.repeat(40) });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('GitHub source completion requests', () => {
	it('aborts superseded queries and ignores results arriving out of order', async () => {
		let resolveOld!: (response: Response) => void;
		const oldResponse = new Promise<Response>((resolve) => {
			resolveOld = resolve;
		});
		const fetch = vi
			.fn()
			.mockReturnValueOnce(oldResponse)
			.mockResolvedValueOnce(jsonOk([branch('feature/new')]));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ query }) => useSourceBranchesQuery({ pid: 'project', nid: 'notebook', query }),
			{ initialProps: { query: 'old' }, toaster: false },
		);
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const oldSignal = (fetch.mock.calls[0][1] as RequestInit).signal;
		vi.useFakeTimers();
		rerender({ query: 'new' });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		vi.useRealTimers();
		await waitFor(() => expect(result.current.data).toEqual([branch('feature/new')]));
		expect(oldSignal?.aborted).toBe(true);
		await act(async () => {
			resolveOld(jsonOk([branch('feature/old')]));
		});
		expect(result.current.data).toEqual([branch('feature/new')]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('hides cached suggestions as soon as the input changes, before debounce completes', async () => {
		const fetch = vi.fn().mockResolvedValue(jsonOk([branch('old')]));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ query }) => useSourceBranchesQuery({ pid: 'project', nid: 'notebook', query }),
			{ initialProps: { query: 'old' }, toaster: false },
		);
		await waitFor(() => expect(result.current.data).toEqual([branch('old')]));
		vi.useFakeTimers();
		rerender({ query: 'new' });
		expect(result.current.data).toBeUndefined();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(199);
		});
		expect(result.current.data).toBeUndefined();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('clears previous notebook suggestions when the new scope denies access', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk([branch('private/first')]))
			.mockResolvedValueOnce(jsonError('FORBIDDEN', 'Access denied', 403));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ nid }) => useSourceBranchesQuery({ pid: 'project', nid, query: 'private' }),
			{ initialProps: { nid: 'first' }, toaster: false },
		);
		await waitFor(() => expect(result.current.data).toEqual([branch('private/first')]));
		rerender({ nid: 'second' });
		expect(result.current.data).toBeUndefined();
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('does not reuse branch suggestions as commits when the source mode changes', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonOk([branch('release')]))
			.mockResolvedValueOnce(jsonOk([]));
		vi.stubGlobal('fetch', fetch);
		const { result, rerender } = renderHookWithClient(
			({ type }) => {
				const input = { pid: 'project', nid: 'notebook', query: 'release' };
				const branches = useSourceBranchesQuery({ ...input, enabled: type === 'branch' });
				const commits = useSourceCommitsQuery({ ...input, enabled: type === 'commit' });
				return type === 'branch' ? branches : commits;
			},
			{ initialProps: { type: 'branch' }, toaster: false },
		);
		await waitFor(() => expect(result.current.data).toEqual([branch('release')]));
		expect(fetch).toHaveBeenCalledOnce();
		rerender({ type: 'commit' });
		expect(result.current.data).toBeUndefined();
		await waitFor(() => expect(result.current.data).toEqual([]));
		const requestedTypes = fetch.mock.calls.map(([url]) =>
			new URL(String(url), window.location.origin).searchParams.get('type'),
		);
		expect(requestedTypes).toEqual(['branch', 'commit']);
	});
});
