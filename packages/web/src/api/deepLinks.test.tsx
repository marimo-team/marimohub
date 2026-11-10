import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { createTestQueryClient, jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { deferred } from '@/test/deferred';
import { prefetchAppLink, useDeepLinkQuery } from './deepLinks';
import { appKeys, projectKeys } from './queryKeys';

afterEach(() => vi.unstubAllGlobals());

const target = { kind: 'app', project_id: 'project', notebook_id: 'notebook' };
const appKey = appKeys.detail(target.project_id, target.notebook_id);
const summary = { ...target, title: 'App', your_role: 'app-user', can: { run: true } };

describe.each([false, true])('project-read authority (boot=%s)', (boot) => {
	it.each([
		{ role: 'viewer', canRun: false },
		{ role: 'editor', canRun: false },
		{ role: 'manager', canRun: false },
		{ role: null, canRun: false },
		{ role: 'viewer', canRun: true },
	])('does not infer project.read from role=$role or can.run=$canRun', async ({ role, canRun }) => {
		const app = { ...summary, your_role: role, can: { run: canRun } };
		const fetch = vi.fn(async () => jsonOk({ target, app }));
		vi.stubGlobal('fetch', fetch);
		const client = createTestQueryClient();
		if (boot) {
			await prefetchAppLink(client, 'sales');
		} else {
			const { result } = renderHookWithClient(() => useDeepLinkQuery('sales'), {
				client,
				toaster: false,
			});
			await waitFor(() => expect(result.current.isSuccess).toBe(true));
		}
		expect(client.getQueryData(appKey)).toEqual(app);
		expect(client.getQueryState(projectKeys.detail(target.project_id))).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it('replaces a cached run permission with the freshly resolved permission', async () => {
	const pending = deferred<Response>();
	vi.stubGlobal(
		'fetch',
		vi.fn(() => pending.promise),
	);
	const { result, client } = renderHookWithClient(() => useDeepLinkQuery('sales'), {
		toaster: false,
	});
	client.setQueryData(appKey, summary);
	await act(async () => {
		pending.resolve(jsonOk({ target, app: { ...summary, can: { run: false } } }));
	});
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(client.getQueryData(appKey)).toMatchObject({ can: { run: false } });
});

it('does not overwrite app permissions with a late response after unmount', async () => {
	const pending = deferred<Response>();
	const fetch = vi.fn(() => pending.promise);
	vi.stubGlobal('fetch', fetch);
	const { client, unmount } = renderHookWithClient(() => useDeepLinkQuery('sales'), {
		toaster: false,
	});
	await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
	unmount();
	client.setQueryData(appKey, { ...summary, can: { run: false } });
	await act(async () => {
		pending.resolve(jsonOk({ target, app: summary }));
	});
	expect(client.getQueryData(appKey)).toMatchObject({ can: { run: false } });
});

describe('failed deep-link resolutions', () => {
	it.each([403, 404, 503])('does not publish an app summary on HTTP %s', async (status) => {
		const fetch = vi.fn(async () => jsonError('UNAVAILABLE', 'Cannot resolve', status));
		vi.stubGlobal('fetch', fetch);
		const { result, client } = renderHookWithClient(() => useDeepLinkQuery('sales'), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(client.getQueryData(appKey)).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
