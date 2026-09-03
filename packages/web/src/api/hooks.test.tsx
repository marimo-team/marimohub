import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { browseKeys, jobKeys, notebookKeys, projectKeys, sessionKeys } from './queryKeys';
import {
	refreshBrowseQueries,
	resetBrowseRefreshBudgetForTests,
	useBrowseCapabilityQuery,
	useBrowseTablePreview,
	useBrowseTablesQuery,
	useCapabilitiesQuery,
	useDownloadWorkspace,
	useEditorSessionQuery,
	useJobRunQuery,
	useJobsQuery,
	useNotebookHtmlQuery,
	useNotebookQuery,
	useRestartApp,
	useRestartSession,
	useRunSandboxStartupTest,
	useStartSession,
	useStopSession,
	useSyncNotebookNow,
	useUpdateGitSource,
	useUpdateIntegration,
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

describe('useNotebookQuery', () => {
	const notebookDetail = (sourceType: 'local' | 'git') => ({
		meta: { id: NID, title: 'NB', author: 'me' },
		source: { type: sourceType, current_version_id: 'ver-head' },
	});

	it('function-form refetchIntervalMs polls when the fetched detail asks for it', async () => {
		const fetchMock = stubFetch(async () => jsonOk(notebookDetail('git')));

		renderHookWithClient(
			() =>
				useNotebookQuery(PID, NID, {
					refetchIntervalMs: (n) => (n?.source.type === 'git' ? 20 : undefined),
				}),
			{ toaster: false },
		);

		await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
	});

	it('function-form refetchIntervalMs returning undefined never polls', async () => {
		const fetchMock = stubFetch(async () => jsonOk(notebookDetail('local')));

		const { result } = renderHookWithClient(
			() =>
				useNotebookQuery(PID, NID, {
					refetchIntervalMs: (n) => (n?.source.type === 'git' ? 20 : undefined),
				}),
			{ toaster: false },
		);

		await waitFor(() => expect(result.current.data).toBeDefined());
		// Long enough for several 20ms ticks to have fired if polling were armed.
		await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
		expect(result.current.error?.message).toBe('gone');
	});

	it('names the version, not the notebook, when a pinned snapshot 404s', async () => {
		const fetchMock = stubFetch(async () => jsonError('NOT_FOUND', 'gone', 404));

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID, 'ver-old'), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error?.message).toBe('gone');
		expect(urlsOf(fetchMock)[0]).toBe(
			`/api/v1/projects/${PID}/notebooks/${NID}/versions/ver-old/html`,
		);
	});

	it('throws with the status on a server error', async () => {
		stubFetch(async () => new Response('nope', { status: 500 }));

		const { result } = renderHookWithClient(() => useNotebookHtmlQuery(PID, NID), {
			toaster: false,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.error?.message).toBe('Failed to load notebook outputs (HTTP 500)');
	});

	it('returns the html and the captured-at and version headers', async () => {
		stubFetch(
			async () =>
				new Response('<h1>out</h1>', {
					status: 200,
					headers: {
						'content-type': 'text/html',
						'X-Marimohub-Captured-At': '2025-03-05T14:00:00Z',
						'X-Marimohub-Version-Id': 'ver-1',
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
			versionId: 'ver-1',
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

describe('useJobRunQuery', () => {
	it('polls a directly loaded active run until it reaches a terminal status', async () => {
		vi.useFakeTimers();
		try {
			let status: 'running' | 'succeeded' = 'running';
			const fetchMock = stubFetch(async () =>
				jsonOk({
					run_id: 'run-1',
					job_id: 'job-1',
					notebook_id: NID,
					project_id: PID,
					status,
					trigger: 'manual',
					attempt: 1,
					timeout_seconds: 600,
					queued_at: '2026-09-02T10:00:00Z',
					started_at: '2026-09-02T10:00:01Z',
					...(status === 'succeeded' ? { finished_at: '2026-09-02T10:00:02Z', exit_code: 0 } : {}),
				}),
			);

			const { result, client, unmount } = renderHookWithClient(
				() => useJobRunQuery(PID, NID, 'job-1', 'run-1', true),
				{ toaster: false },
			);
			await vi.waitFor(() => expect(result.current.data?.status).toBe('running'));

			status = 'succeeded';
			await act(async () => {
				await vi.advanceTimersByTimeAsync(5_000);
			});
			await vi.waitFor(() => expect(result.current.data?.status).toBe('succeeded'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(15_000);
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(client.getQueryData(jobKeys.run(PID, NID, 'job-1', 'run-1'))).toMatchObject({
				status: 'succeeded',
			});
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('useJobsQuery', () => {
	it('loads every cursor page of jobs', async () => {
		const fetchMock = stubFetch(async (url) => {
			const cursor = new URL(String(url), 'http://test.local').searchParams.get('cursor');
			return cursor
				? jsonOk({ items: [{ id: 'job-2', name: 'Second' }], next_cursor: null })
				: jsonOk({ items: [{ id: 'job-1', name: 'First' }], next_cursor: 'page-2' });
		});

		const { result } = renderHookWithClient(() => useJobsQuery(PID, NID), { toaster: false });

		await waitFor(() =>
			expect(result.current.data?.map((job) => job.id)).toEqual(['job-1', 'job-2']),
		);
		expect(urlsOf(fetchMock)).toHaveLength(2);
		expect(new URL(urlsOf(fetchMock)[1], 'http://test.local').searchParams.get('cursor')).toBe(
			'page-2',
		);
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

describe.each([
	{
		label: 'app',
		useRestart: () => {
			const mutation = useRestartApp(PID, NID);
			return () => mutation.mutateAsync('sess-1');
		},
		expectedBody: '{"mode":"app"}',
	},
	{
		label: 'edit',
		useRestart: () => {
			const mutation = useRestartSession(PID);
			return () => mutation.mutateAsync({ notebookId: NID, sessionId: 'sess-1' });
		},
		expectedBody: '',
	},
])('$label session restart', ({ useRestart, expectedBody }) => {
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

	it('stops the old session, then starts a fresh session', async () => {
		const fetchMock = restartFetch(async () => jsonOk(undefined));

		const { result, client } = renderHookWithClient(useRestart, {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current();
		});

		const methods = fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${requestUrl(url)}`);
		expect(methods).toEqual([`DELETE ${sessionsPath}/sess-1`, `POST ${sessionsPath}`]);
		expect(await requestOf(fetchMock, 1).clone().text()).toBe(expectedBody);
		expect(invalidatedKeys(spy)).toEqual([sessionKeys.listByProject(PID)]);
	});

	it('still starts when the old session is already gone (404)', async () => {
		const fetchMock = restartFetch(async () => jsonError('NOT_FOUND', 'Session not found', 404));

		const { result } = renderHookWithClient(useRestart, { toaster: false });
		let started: { session_id?: string } | undefined;
		await act(async () => {
			started = await result.current();
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(started).toMatchObject({ session_id: 'sess-2' });
	});

	it('aborts without starting when the stop fails for any other reason', async () => {
		const fetchMock = restartFetch(async () => jsonError('INTERNAL_ERROR', 'teardown failed', 500));

		const { result, client } = renderHookWithClient(useRestart, {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await expect(result.current()).rejects.toThrow('teardown failed');
		});

		// A restart that half-ran (stopped, never started) is worse than one that failed.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('session mutation toast suppression', () => {
	// Start/stop failures on the notebook page render as the inline session
	// panel; the meta flag is what keeps the global mutation-cache toast quiet.
	it('useStartSession marks failures to skip the global error toast', async () => {
		stubFetch(async () => jsonError('SERVICE_UNAVAILABLE', 'no capacity', 503));

		const { result, client } = renderHookWithClient(() => useStartSession(PID, NID), {
			toaster: false,
		});
		await act(async () => {
			await result.current.mutateAsync().catch(() => {});
		});

		expect(client.getMutationCache().getAll().at(-1)?.meta).toEqual({ suppressErrorToast: true });
	});

	it('useStopSession suppresses the toast only when asked', async () => {
		stubFetch(async () => jsonError('SERVICE_UNAVAILABLE', 'teardown failed', 503));

		const { result, client } = renderHookWithClient(
			() => ({
				quiet: useStopSession(PID, NID, { suppressErrorToast: true }),
				loud: useStopSession(PID, NID),
			}),
			{ toaster: false },
		);
		await act(async () => {
			await result.current.quiet.mutateAsync('sess-1').catch(() => {});
			await result.current.loud.mutateAsync('sess-2').catch(() => {});
		});

		const metas = client
			.getMutationCache()
			.getAll()
			.map((mutation) => mutation.meta);
		expect(metas).toEqual([{ suppressErrorToast: true }, undefined]);
	});
});

describe('admin diagnostic mutation toast suppression', () => {
	it('keeps startup-test failures inline instead of also showing a global toast', async () => {
		stubFetch(async () => jsonError('RESOURCE_EXHAUSTED', 'already running', 429));

		const { result, client } = renderHookWithClient(() => useRunSandboxStartupTest(), {
			toaster: false,
		});
		await act(async () => {
			await result.current.mutateAsync({}).catch(() => {});
		});

		expect(client.getMutationCache().getAll().at(-1)?.meta).toEqual({
			suppressErrorToast: true,
		});
	});
});

describe('useUpdateIntegration conflict recovery', () => {
	const scope = { pid: PID };

	it('refetches the stale integration after a 412 so a retry gets a fresh ETag', async () => {
		stubFetch(async () => jsonError('PRECONDITION_FAILED', 'stale etag', 412));

		const { result, client } = renderHookWithClient(() => useUpdateIntegration(scope), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');
		await act(async () => {
			await result.current.mutateAsync({ id: 'int-1', etag: 'W/"1"', name: 'n' }).catch(() => {});
		});

		expect(invalidatedKeys(spy)).toEqual([
			projectKeys.integrations(PID),
			[...browseKeys.all, PID],
			projectKeys.integration(PID, 'int-1'),
		]);
	});

	// Browse results embed the config and name (capability, snippets), so a
	// successful edit must drop them project-wide — a rename would otherwise
	// keep serving snippets that load the old instance name.
	it('a successful update also drops the project browse results', async () => {
		stubFetch(async () => jsonOk({ id: 'int-1', name: 'renamed' }));

		const { result, client } = renderHookWithClient(() => useUpdateIntegration(scope), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');
		await act(async () => {
			await result.current.mutateAsync({ id: 'int-1', etag: 'W/"1"', name: 'renamed' });
		});

		expect(invalidatedKeys(spy)).toContainEqual([...browseKeys.all, PID]);
	});

	it('leaves the cache alone on non-conflict failures', async () => {
		stubFetch(async () => jsonError('FORBIDDEN', 'no', 403));

		const { result, client } = renderHookWithClient(() => useUpdateIntegration(scope), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');
		await act(async () => {
			await result.current.mutateAsync({ id: 'int-1', etag: 'W/"1"', name: 'n' }).catch(() => {});
		});

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

		expect(invalidatedKeys(spy)).toEqual([
			notebookKeys.list(PID),
			notebookKeys.detail(PID, NID),
			notebookKeys.sourceDrift(PID, NID),
		]);
	});

	it('useSyncNotebookNow invalidates drift, versions, detail, and the list', async () => {
		stubFetch(async () => jsonOk({ synced: true, commit: 'abc', version_id: 'ver-2' }));

		const { result, client } = renderHookWithClient(() => useSyncNotebookNow(PID), {
			toaster: false,
		});
		const spy = vi.spyOn(client, 'invalidateQueries');

		await act(async () => {
			await result.current.mutateAsync(NID);
		});

		expect(invalidatedKeys(spy)).toEqual([
			notebookKeys.sourceDrift(PID, NID),
			notebookKeys.versions(PID, NID),
			notebookKeys.detail(PID, NID),
			notebookKeys.list(PID),
		]);
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

describe('useEditorSessionQuery', () => {
	it('stops polling after the current user owns the persistent editor session', async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = stubFetch(async () =>
				jsonOk({
					sharing: 'exclusive',
					holder: {
						session_id: 'sess-1',
						user_id: 'me',
						status: 'running',
						started_at: '2026-08-02T12:00:00Z',
						activity: { state: 'active' },
					},
					can_take_over: false,
				}),
			);

			const { result, unmount } = renderHookWithClient(
				() => useEditorSessionQuery(PID, NID, true, 'me'),
				{ toaster: false },
			);
			await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
			unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('browse request cancellation', () => {
	it('forwards the query signal when a browse view unmounts', async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchMock = stubFetch(async (_url, init) => {
			requestSignal = (init instanceof Request ? init.signal : init?.signal) ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener('abort', () =>
					reject(new DOMException('canceled', 'AbortError')),
				);
			});
		});
		const { unmount } = renderHookWithClient(() => useBrowseTablesQuery(PID, 'int-1', ['sales']), {
			toaster: false,
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		unmount();

		expect(requestSignal?.aborted).toBe(true);
	});

	it('aborts an in-flight preview mutation when its owner unmounts', async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchMock = stubFetch(async (_url, init) => {
			requestSignal = (init instanceof Request ? init.signal : init?.signal) ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener('abort', () =>
					reject(new DOMException('canceled', 'AbortError')),
				);
			});
		});
		const { result, unmount } = renderHookWithClient(() => useBrowseTablePreview(PID, 'int-1'), {
			toaster: false,
		});
		act(() => result.current.mutate({ namespace: ['sales'], table: 'orders' }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		unmount();

		expect(requestSignal?.aborted).toBe(true);
	});

	it('does not toast when an abort cancels an in-flight preview', async () => {
		const errorToast = vi.spyOn(toast, 'error');
		let requestSignal: AbortSignal | undefined;
		const fetchMock = stubFetch(async (_url, init) => {
			requestSignal = (init instanceof Request ? init.signal : init?.signal) ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener('abort', () =>
					reject(new DOMException('The user aborted a request.', 'AbortError')),
				);
			});
		});
		const { result, client, unmount } = renderHookWithClient(
			() => useBrowseTablePreview(PID, 'int-1'),
			{ toaster: false },
		);
		act(() => result.current.mutate({ namespace: ['sales'], table: 'orders' }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		unmount();

		await waitFor(() =>
			expect(client.getMutationCache().getAll().at(-1)?.state.status).toBe('error'),
		);
		expect(errorToast).not.toHaveBeenCalled();
	});
});

describe('refreshBrowseQueries', () => {
	beforeEach(() => {
		resetBrowseRefreshBudgetForTests();
	});

	it('freshly refetches mounted queries, drops unmounted ones, then clears the flag', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ items: ['orders'], next_cursor: null }));
		const { result, client } = renderHookWithClient(
			() => useBrowseTablesQuery(PID, 'int-1', ['sales']),
			{ toaster: false },
		);
		await waitFor(() => expect(result.current.data).toBeDefined());

		// A result whose component has unmounted (a collapsed tree node).
		client.setQueryData(browseKeys.schema(PID, 'int-1', ['sales'], 'orders'), { columns: [] });

		fetchMock.mockClear();
		await refreshBrowseQueries(client);

		expect(urlsOf(fetchMock).some((url) => url.includes('fresh=true'))).toBe(true);
		expect(
			client.getQueryState(browseKeys.schema(PID, 'int-1', ['sales'], 'orders')),
		).toBeUndefined();

		// The bypass flag must not leak past the round.
		fetchMock.mockClear();
		await act(async () => {
			await result.current.refetch();
		});
		expect(urlsOf(fetchMock).some((url) => url.includes('fresh=true'))).toBe(false);
	});
});

describe('refreshBrowseQueries budget', () => {
	beforeEach(() => {
		resetBrowseRefreshBudgetForTests();
	});

	it('refetches every retained page of an infinite query, each fresh', async () => {
		const fetchMock = stubFetch(async (url) => {
			const cursor = new URL(String(url), 'http://test.local').searchParams.get('cursor');
			return cursor === null
				? jsonOk({ items: ['orders'], next_cursor: 'p2' })
				: jsonOk({ items: ['refunds'], next_cursor: null });
		});
		const { result, client } = renderHookWithClient(
			() => useBrowseTablesQuery(PID, 'int-1', ['sales']),
			{ toaster: false },
		);
		await waitFor(() => expect(result.current.hasNextPage).toBe(true));
		await act(async () => {
			await result.current.fetchNextPage();
		});
		await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

		fetchMock.mockClear();
		await refreshBrowseQueries(client);

		// Two pages retained → two page fetches, both bypassing the server cache.
		expect(urlsOf(fetchMock).filter((url) => url.includes('fresh=true'))).toHaveLength(2);
	});

	it('the rolling window stops adding fresh at 30 page fetches, then replenishes', async () => {
		const fetchMock = stubFetch(async () => jsonOk({ items: ['orders'], next_cursor: null }));
		const { result, client } = renderHookWithClient(
			() => useBrowseTablesQuery(PID, 'int-1', ['sales']),
			{ toaster: false },
		);
		await waitFor(() => expect(result.current.data).toBeDefined());

		for (let i = 0; i < 30; i++) {
			await refreshBrowseQueries(client);
		}
		const freshCount = urlsOf(fetchMock).filter((url) => url.includes('fresh=true')).length;
		expect(freshCount).toBe(30);

		fetchMock.mockClear();
		await refreshBrowseQueries(client);
		expect(fetchMock).toHaveBeenCalled();
		expect(urlsOf(fetchMock).some((url) => url.includes('fresh=true'))).toBe(false);

		// ROLLING, not a hard cap: once the window passes, the allowance returns.
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
		fetchMock.mockClear();
		await refreshBrowseQueries(client);
		expect(urlsOf(fetchMock).some((url) => url.includes('fresh=true'))).toBe(true);
	});

	it('capability lookups ride along without spending fresh budget', async () => {
		const fetchMock = stubFetch(async (url) =>
			String(url).includes('/browse/tables')
				? jsonOk({ items: ['orders'], next_cursor: null })
				: jsonOk({ surfaces: { tables: { available: true, preview: false } } }),
		);
		const { result, client } = renderHookWithClient(
			() => ({
				capability: useBrowseCapabilityQuery(PID, 'int-1'),
				tables: useBrowseTablesQuery(PID, 'int-1', ['sales']),
			}),
			{ toaster: false },
		);
		await waitFor(() => expect(result.current.tables.data).toBeDefined());

		fetchMock.mockClear();
		// If the capability lookup were charged, only ~15 of these table
		// refetches could carry fresh before the mirror ran dry.
		for (let i = 0; i < 30; i++) {
			await refreshBrowseQueries(client);
		}
		const urls = urlsOf(fetchMock);
		expect(urls.filter((url) => url.includes('fresh=true')).length).toBe(30);
		expect(urls.some((url) => url.endsWith('/browse'))).toBe(true);
	});
});
