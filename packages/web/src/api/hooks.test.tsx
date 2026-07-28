import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { notebookKeys, projectKeys, sessionKeys } from './queryKeys';
import {
	useCapabilitiesQuery,
	useDownloadWorkspace,
	useNotebookHtmlQuery,
	useProjectSecretsQuery,
	useRestartApp,
	useStartSession,
	useUpdateGitSource,
	useUpdateNotebook,
	useUpdateProject,
	useUserQuery,
	useUsersQuery,
	useUserSearchQuery,
	useVersionQuery,
} from './hooks';

const PID = 'proj-1';
const NID = 'nb-1';

type FetchHandler = (url: RequestInfo | URL, init?: RequestInit | Request) => Promise<Response>;

function requestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) {
		const url = new URL(input.url);
		return `${url.pathname}${url.search}`;
	}
	return String(input);
}

/** Stub the network with a URL/method router; anything unrouted is a test bug. */
function stubFetch(handler: FetchHandler) {
	const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
		handler(requestUrl(url), url instanceof Request ? url : init),
	);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const urlsOf = (fetchMock: ReturnType<typeof stubFetch>) =>
	fetchMock.mock.calls.map(([url]) => requestUrl(url));

function requestOf(fetchMock: ReturnType<typeof stubFetch>, index = 0): Request {
	const [input, init] = fetchMock.mock.calls[index] ?? [];
	if (input === undefined) throw new Error('expected a request');
	return input instanceof Request
		? input
		: new Request(new URL(String(input), 'http://test.local'), init);
}

/** The query keys passed to `invalidateQueries`, in call order. */
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('useUsersQuery', () => {
	it('dedupes and sorts ids so any input ordering shares one cache entry', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ a: { id: 'a' }, b: { id: 'b' } }));

		const { result } = renderHookWithClient(
			() => ({
				first: useUsersQuery(['b', 'a']),
				second: useUsersQuery(['a', 'b', 'a']),
			}),
			{ toaster: false },
		);

		await waitFor(() => expect(result.current.first.data).toBeDefined());
		expect(result.current.second.data).toBe(result.current.first.data);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('filters out undefined ids and encodes the joined list', async () => {
		const fetchMock = stubFetch(async () => jsonOk({}));

		renderHookWithClient(() => useUsersQuery(['u2', undefined, 'u1', undefined]), {
			toaster: false,
		});

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(urlsOf(fetchMock)[0]).toBe('/api/v1/users?ids=u1%2Cu2');
	});

	it('does not fetch for an empty or all-undefined list', async () => {
		const fetchMock = stubFetch(async () => jsonOk({}));

		const { result } = renderHookWithClient(
			() => ({ empty: useUsersQuery([]), blank: useUsersQuery([undefined, undefined]) }),
			{ toaster: false },
		);

		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.empty.data).toBeUndefined();
		expect(result.current.blank.data).toBeUndefined();
	});
});

describe('useUserSearchQuery', () => {
	it('is disabled below two characters after trimming, and enabled at two', async () => {
		const fetchMock = stubFetch(async () => jsonOk([]));

		const { rerender } = renderHookWithClient(({ q }: { q: string }) => useUserSearchQuery(q), {
			initialProps: { q: ' a ' },
			toaster: false,
		});

		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();

		rerender({ q: ' ab ' });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(urlsOf(fetchMock)[0]).toBe('/api/v1/users/search?q=ab');
	});

	it('keeps the previous results while a new query is in flight', async () => {
		let releaseSecond!: () => void;
		const secondInFlight = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		stubFetch(async (url) => {
			const q = new URL(String(url), 'http://test.local').searchParams.get('q');
			if (q === 'ab') return jsonOk([{ id: 'u1', email: 'a@b.c', name: 'Ada' }]);
			await secondInFlight;
			return jsonOk([{ id: 'u2', email: 'b@b.c', name: 'Bob' }]);
		});

		const { result, rerender } = renderHookWithClient(
			({ q }: { q: string }) => useUserSearchQuery(q),
			{ initialProps: { q: 'ab' }, toaster: false },
		);
		await waitFor(() => expect(result.current.data?.[0]?.id).toBe('u1'));

		rerender({ q: 'abc' });
		await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
		// The option list must not blank out between keystrokes.
		expect(result.current.data?.[0]?.id).toBe('u1');

		releaseSecond();
		await waitFor(() => expect(result.current.data?.[0]?.id).toBe('u2'));
		expect(result.current.isPlaceholderData).toBe(false);
	});
});

describe('useProjectSecretsQuery', () => {
	it('resolves null (not an error) when the route 404s as NOT_FOUND', async () => {
		const fetchMock = stubFetch(async () => jsonError('NOT_FOUND', 'secrets disabled', 404));

		const { result } = renderHookWithClient(() => useProjectSecretsQuery(PID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toBeNull();
		expect(result.current.error).toBeNull();
		// A disabled feature is a settled answer — it must not be retried.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('surfaces any other error', async () => {
		stubFetch(async () => jsonError('INTERNAL_ERROR', 'boom', 500));

		const { result } = renderHookWithClient(() => useProjectSecretsQuery(PID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 });
		expect(result.current.error?.message).toBe('boom');
	}, 10_000);

	it('does not fetch while disabled', async () => {
		const fetchMock = stubFetch(async () => jsonOk([]));

		renderHookWithClient(() => useProjectSecretsQuery(PID, false), { toaster: false });

		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('useNotebookHtmlQuery', () => {
	const htmlPath = `/api/v1/projects/${PID}/notebooks/${NID}/html`;

	it('resolves null when the notebook simply has no snapshot yet', async () => {
		const fetchMock = stubFetch(async () => jsonError('NO_HTML_SNAPSHOT', 'no outputs', 404));

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toBeNull();
		expect(urlsOf(fetchMock)[0]).toBe(htmlPath);
	});

	it('throws when the notebook itself is gone', async () => {
		stubFetch(async () => jsonError('NOT_FOUND', 'gone', 404));

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error?.message).toBe('Notebook not found');
	});

	it('throws with the status on a server error', async () => {
		stubFetch(async () => new Response('nope', { status: 500 }));

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error?.message).toBe('Failed to load notebook outputs (HTTP 500)');
	});

	it('returns the html and the captured-at header', async () => {
		stubFetch(
			async () =>
				new Response('<h1>out</h1>', {
					status: 200,
					headers: {
						'content-type': 'text/html',
						'X-Marimohub-Captured-At': '2025-03-05T14:00:00Z',
					},
				}),
		);

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(result.current.data).toEqual({
			html: '<h1>out</h1>',
			capturedAt: '2025-03-05T14:00:00Z',
		});
	});

	it('reports a null capturedAt when the header is absent', async () => {
		stubFetch(
			async () =>
				new Response('<h1>out</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
		);

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(result.current.data?.capturedAt).toBeNull();
	});
});

describe('useStartSession', () => {
	const sessionsPath = `/api/v1/projects/${PID}/notebooks/${NID}/sessions`;

	it('creates an edit session with no body at all', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ session_id: 'sess-1' }));

		const { result } = renderHookWithClient(() => useStartSession(PID, NID), { toaster: false });
		await act(async () => {
			await result.current.mutateAsync();
		});

		const request = requestOf(fetchMock);
		expect(requestUrl(request)).toBe(sessionsPath);
		expect(request.method).toBe('POST');
		expect(await request.clone().text()).toBe('');
	});

	it('creates an app session with a JSON mode body', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ session_id: 'sess-1', mode: 'app' }));

		const { result } = renderHookWithClient(() => useStartSession(PID, NID, 'app'), {
			toaster: false,
		});
		await act(async () => {
			await result.current.mutateAsync();
		});

		const request = requestOf(fetchMock);
		expect(requestUrl(request)).toBe(sessionsPath);
		expect(request.method).toBe('POST');
		expect(await request.clone().text()).toBe('{"mode":"app"}');
		expect(request.headers.get('content-type')).toBe('application/json');
	});
});

describe('useRestartApp', () => {
	const sessionsPath = `/api/v1/projects/${PID}/notebooks/${NID}/sessions`;

	function restartFetch(stop: () => Promise<Response>) {
		return stubFetch(async (url, init) => {
			const method = init?.method ?? 'GET';
			if (method === 'DELETE' && String(url) === `${sessionsPath}/sess-1`) return stop();
			if (method === 'POST' && String(url) === sessionsPath) {
				return jsonOk({ session_id: 'sess-2', mode: 'app' });
			}
			throw new Error(`unexpected fetch: ${method} ${String(url)}`);
		});
	}

	it('stops the old session, then starts a fresh app session', async () => {
		const fetchMock = restartFetch(async () => jsonOk(undefined));

		const { result, client } = renderHookWithClient(() => useRestartApp(PID, NID), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync('sess-1');
		});

		const methods = fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${requestUrl(url)}`);
		expect(methods).toEqual([`DELETE ${sessionsPath}/sess-1`, `POST ${sessionsPath}`]);
		expect(await requestOf(fetchMock, 1).clone().text()).toBe('{"mode":"app"}');
		expect(invalidatedKeys(spy)).toEqual([sessionKeys.listByProject(PID)]);
	});

	it('still starts when the old session is already gone (404)', async () => {
		const fetchMock = restartFetch(async () => jsonError('NOT_FOUND', 'Session not found', 404));

		const { result } = renderHookWithClient(() => useRestartApp(PID, NID), { toaster: false });
		let started: { session_id?: string } | undefined;
		await act(async () => {
			started = await result.current.mutateAsync('sess-1');
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(started).toMatchObject({ session_id: 'sess-2' });
	});

	it('aborts without starting when the stop fails for any other reason', async () => {
		const fetchMock = restartFetch(async () => jsonError('INTERNAL_ERROR', 'teardown failed', 500));

		const { result, client } = renderHookWithClient(() => useRestartApp(PID, NID), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await expect(result.current.mutateAsync('sess-1')).rejects.toThrow('teardown failed');
		});

		// A restart that half-ran (stopped, never started) is worse than one that failed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('list + detail invalidation', () => {
	it('useUpdateNotebook drops both the list and the notebook it patched', async () => {
		stubFetch(async () => jsonOk({ notebook_id: NID }));

		const { result, client } = renderHookWithClient(() => useUpdateNotebook(PID), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync({ notebookId: NID, title: 'Renamed' });
		});

		expect(invalidatedKeys(spy)).toEqual([notebookKeys.list(PID), notebookKeys.detail(PID, NID)]);
	});

	it('useUpdateGitSource invalidates the list and notebook detail it patched', async () => {
		stubFetch(async () => jsonOk({ source: { type: 'git' } }));

		const { result, client } = renderHookWithClient(() => useUpdateGitSource(PID), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync({
				notebookId: NID,
				repo: 'org/repo',
				branch: 'main',
				root_path: 'apps',
				entry_notebook: 'dashboard.py',
			});
		});

		expect(invalidatedKeys(spy)).toEqual([notebookKeys.list(PID), notebookKeys.detail(PID, NID)]);
	});

	it('useUpdateProject drops both the list and the project it patched', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ project_id: PID }));

		const { result, client } = renderHookWithClient(() => useUpdateProject(), { toaster: false });
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync({ projectId: PID, name: 'Renamed' });
		});

		const request = requestOf(fetchMock);
		expect(requestUrl(request)).toBe(`/api/v1/projects/${PID}`);
		expect(request.method).toBe('PATCH');
		// `projectId` addresses the resource; it must not be sent as a patch field.
		expect(await request.clone().text()).toBe('{"name":"Renamed"}');
		expect(invalidatedKeys(spy)).toEqual([projectKeys.list(), projectKeys.detail(PID)]);
	});
});

describe('useDownloadWorkspace', () => {
	it('throws with the status when the zip route fails', async () => {
		stubFetch(async () => new Response('nope', { status: 503 }));

		const { result } = renderHookWithClient(() => useDownloadWorkspace(PID), { toaster: false });

		await act(async () => {
			await expect(
				result.current.mutateAsync({ notebookId: NID, title: 'My Notebook' }),
			).rejects.toThrow('Failed to download workspace (503)');
		});
	});
});

describe('deployment-scoped queries', () => {
	it.each([
		['useVersionQuery', useVersionQuery],
		['useCapabilitiesQuery', useCapabilitiesQuery],
		['useUserQuery', useUserQuery],
	] as const)('%s does not retry a failure', async (_name, useHook) => {
		const fetchMock = stubFetch(async () => jsonError('INTERNAL_ERROR', 'boom', 500));

		const { result } = renderHookWithClient(() => useHook(), { toaster: false });

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
