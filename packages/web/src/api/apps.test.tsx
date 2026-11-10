import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { stubApi } from '@/test/apiStub';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { useAppsQuery, useProjectAppsQuery } from './apps';
import { appKeys } from './queryKeys';

afterEach(() => vi.unstubAllGlobals());

const page = {
	items: [],
	next_cursor: null,
	project: { id: 'p', name: 'Project', your_role: 'app-user' },
};

describe('project access cache', () => {
	it('does not dispatch a request if the gate unmounts before dispatch', async () => {
		const fetch = vi.fn(async () => jsonOk(page));
		vi.stubGlobal('fetch', fetch);
		const gate = renderHookWithClient(() => useProjectAppsQuery('p'), { toaster: false });
		gate.unmount();
		await act(async () => {});
		expect(fetch).not.toHaveBeenCalled();
		expect(gate.client.getQueryData(appKeys.list('p'))).toBeUndefined();
	});

	it.each([false, true])(
		'aborts abandoned access requests without caching late results (StrictMode=%s)',
		async (reactStrictMode) => {
			const pending = deferred<Response>();
			let signal: AbortSignal | null | undefined;
			const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
				signal = input instanceof Request ? input.signal : init?.signal;
				return pending.promise;
			});
			vi.stubGlobal('fetch', fetch);
			const gate = renderHookWithClient(() => useProjectAppsQuery('p'), {
				toaster: false,
				reactStrictMode,
			});
			await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
			expect(signal?.aborted).toBe(false);
			gate.unmount();
			expect(signal?.aborted).toBe(true);
			await act(async () => pending.resolve(jsonOk(page)));
			expect(gate.client.getQueryData(appKeys.list('p'))).toBeUndefined();
			expect(gate.client.getQueryData(appKeys.projectAccess('p'))).toBeUndefined();
		},
	);

	it('shares the access request until its last observer unmounts', async () => {
		const pending = deferred<Response>();
		let signal: AbortSignal | null | undefined;
		const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			signal = input instanceof Request ? input.signal : init?.signal;
			return pending.promise;
		});
		vi.stubGlobal('fetch', fetch);
		const first = renderHookWithClient(() => useProjectAppsQuery('p'), { toaster: false });
		const second = renderHookWithClient(() => useProjectAppsQuery('p'), {
			toaster: false,
			client: first.client,
		});
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		first.unmount();
		expect(signal?.aborted).toBe(false);
		await act(async () => pending.resolve(jsonOk(page)));
		await waitFor(() => expect(second.result.current.data?.pages[0].project).toEqual(page.project));
		expect(second.client.getQueryData(appKeys.list('p'))).toMatchObject({ pages: [page] });
	});

	it('keeps missing sentinels out of the app list and rechecks restored access', async () => {
		let missing = true;
		const { requests } = stubApi({
			'/api/v1/apps': () => (missing ? jsonError('NOT_FOUND', 'Not found', 404) : page),
		});
		const gate = renderHookWithClient(() => useProjectAppsQuery('p'), { toaster: false });
		await waitFor(() => expect(gate.result.current.data?.pages[0].missing).toBe(true));
		expect(gate.client.getQueryData(appKeys.list('p'))).toBeUndefined();
		gate.unmount();
		const list = renderHookWithClient(() => useAppsQuery('p'), {
			toaster: false,
			client: gate.client,
		});
		await waitFor(() => expect(list.result.current.isError).toBe(true));
		expect(list.result.current.data).toBeUndefined();
		list.unmount();
		missing = false;
		const restored = renderHookWithClient(() => useProjectAppsQuery('p'), {
			toaster: false,
			client: gate.client,
		});
		await waitFor(() => expect(restored.result.current.data?.pages[0].missing).toBe(false));
		expect(requests).toHaveLength(3);
	});

	it('reuses a successful gate response after an app-user redirect', async () => {
		const { requests } = stubApi({ '/api/v1/apps': page });
		const gate = renderHookWithClient(() => useProjectAppsQuery('p'), { toaster: false });
		await waitFor(() => expect(gate.result.current.data?.pages[0].missing).toBe(false));
		gate.unmount();
		const list = renderHookWithClient(() => useAppsQuery('p'), {
			toaster: false,
			client: gate.client,
		});
		expect(list.result.current.data?.pages).toEqual([page]);
		expect(requests).toHaveLength(1);
	});

	it('refreshes the gate when app lists are invalidated', async () => {
		const { requests } = stubApi({ '/api/v1/apps': page });
		const gate = renderHookWithClient(() => useProjectAppsQuery('p'), { toaster: false });
		await waitFor(() => expect(gate.result.current.data?.pages[0].missing).toBe(false));
		await act(async () => {
			await gate.client.invalidateQueries({ queryKey: appKeys.lists() });
		});
		expect(requests).toHaveLength(2);
	});
});
