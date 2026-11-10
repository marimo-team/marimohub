import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { stubApi } from '@/test/apiStub';
import { jsonError, renderHookWithClient } from '@/test/render';
import { useAppsQuery, useProjectAppsQuery } from './apps';
import { appKeys } from './queryKeys';

afterEach(() => vi.unstubAllGlobals());

const page = {
	items: [],
	next_cursor: null,
	project: { id: 'p', name: 'Project', your_role: 'app-user' },
};

describe('project access cache', () => {
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
