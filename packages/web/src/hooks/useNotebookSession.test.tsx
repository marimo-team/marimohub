import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import type { Session } from '@/types';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import { useNotebookSession } from './useNotebookSession';

const PID = 'proj-1';
const NID = 'nb-1';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		session_id: 'sess-1',
		notebook_id: NID,
		project_id: PID,
		status: 'running',
		started_at: '2025-03-05T14:00:00Z',
		last_heartbeat: '2025-03-05T14:00:00Z',
		sandbox_url: 'https://sandbox.example/kernel',
		...overrides,
	} as Session;
}

async function settleHook(): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('useNotebookSession', () => {
	it('starts a session on mount and exposes the running state', async () => {
		const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonOk(makeSession()));
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.isRunning).toBe(true);
		expect(result.current.sandboxUrl).toBe('https://sandbox.example/kernel');
		expect(result.current.error).toBeNull();

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`/api/v1/projects/${PID}/notebooks/${NID}/sessions`);
		expect(init?.method).toBe('POST');
	});

	it('reaches running under StrictMode (mount effect fires twice)', async () => {
		const fetchMock = vi.fn(async () => jsonOk(makeSession()));
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
			toaster: false,
			reactStrictMode: true,
		});

		await waitFor(() => expect(result.current.isRunning).toBe(true));
		expect(result.current.isProvisioning).toBe(false);
		expect(result.current.sandboxUrl).toBe('https://sandbox.example/kernel');
		expect(result.current.error).toBeNull();
	});

	it('holds the auto-start while enabled is false, then starts once when it flips true', async () => {
		const fetchMock = vi.fn(async () => jsonOk(makeSession()));
		vi.stubGlobal('fetch', fetchMock);

		const { result, rerender } = renderHookWithClient(
			({ enabled }: { enabled: boolean }) => useNotebookSession(PID, NID, { enabled }),
			{ initialProps: { enabled: false }, toaster: false },
		);

		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.session).toBeNull();

		rerender({ enabled: true });
		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(fetchMock).toHaveBeenCalledTimes(1);

		rerender({ enabled: false });
		rerender({ enabled: true });
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports a provisioning session as not running until it has a preview URL', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }))),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.isProvisioning).toBe(true);
		expect(result.current.isRunning).toBe(false);
		expect(result.current.sandboxUrl).toBeUndefined();
	});

	it('captures the error message when start fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonError('FAILED', 'sandbox unavailable')),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });

		await waitFor(() => expect(result.current.error?.message).toBe('sandbox unavailable'));
		expect(result.current.session).toBeNull();
		expect(result.current.isRunning).toBe(false);
	});

	it('keeps temporary intent and provisioning visible during the one-shot Default retry', async () => {
		let postCount = 0;
		let resolveDefault!: (response: Response) => void;
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') throw new Error('unexpected request');
			postCount += 1;
			if (postCount === 1) return jsonError('RESOURCE_EXHAUSTED', 'profile too large', 429);
			return new Promise<Response>((resolve) => {
				resolveDefault = resolve;
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { editIntent: 'temporary' }),
			{
				toaster: false,
			},
		);
		await waitFor(() => expect(result.current.error?.message).toBe('profile too large'));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});

		act(() => result.current.startWithDefault());
		expect(result.current.defaultRetryAttempted).toBe(true);
		expect(result.current.isProvisioning).toBe(true);
		await waitFor(() => expect(postCount).toBe(2));
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			compute_profile: 'default',
			edit_intent: 'temporary',
		});

		await act(async () => {
			resolveDefault(jsonError('RESOURCE_EXHAUSTED', 'default unavailable', 429));
		});
		await waitFor(() => expect(result.current.error?.message).toBe('default unavailable'));
		expect(result.current.isProvisioning).toBe(false);
		expect(result.current.defaultRetryAttempted).toBe(true);
	});

	it('starts a persistent editor explicitly after a temporary session', async () => {
		let postCount = 0;
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') throw new Error('unexpected request');
			postCount += 1;
			return jsonOk(
				makeSession({
					session_id: postCount === 1 ? 'sess-temporary' : 'sess-persistent',
					ephemeral: postCount === 1 ? true : undefined,
				}),
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { editIntent: 'temporary' }),
			{ toaster: false },
		);
		await waitFor(() => expect(result.current.session?.session_id).toBe('sess-temporary'));

		act(() => result.current.startPersistent());
		await waitFor(() => expect(result.current.session?.session_id).toBe('sess-persistent'));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			edit_intent: 'temporary',
		});
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
	});

	it('stop() clears local state and issues a DELETE', async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'DELETE' ? jsonOk(null) : jsonOk(makeSession()),
		);
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(result.current.session).not.toBeNull());

		act(() => result.current.stop());

		await waitFor(() => expect(result.current.session).toBeNull());
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
	});

	it('stop() surfaces a failed stop inline — the toast is suppressed for this path', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
				init?.method === 'DELETE'
					? jsonError('SERVICE_UNAVAILABLE', 'teardown failed', 503)
					: jsonOk(makeSession()),
			),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(result.current.session).not.toBeNull());

		act(() => result.current.stop());

		await waitFor(() => expect(result.current.error?.message).toBe('teardown failed'));
		expect(result.current.session).toBeNull();
	});

	it('stop() treats an already-reaped (404) session as stopped, with no error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
				init?.method === 'DELETE' ? jsonError('NOT_FOUND', 'gone', 404) : jsonOk(makeSession()),
			),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(result.current.session).not.toBeNull());

		act(() => result.current.stop());
		await settleHook();

		expect(result.current.session).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it('retry via start() recovers from an error', async () => {
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				calls += 1;
				return calls === 1 ? jsonError('FAILED', 'boom') : jsonOk(makeSession());
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(result.current.error?.message).toBe('boom'));

		act(() => result.current.start());

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('polls a starting session until it becomes running', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
			}
			if (String(url).endsWith(`/sessions/sess-1`)) {
				return jsonOk(makeSession({ status: 'running' }));
			}
			throw new Error(`unexpected fetch: ${String(url)}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(result.current.isRunning).toBe(true);
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/sessions/sess-1`))).toBe(
			true,
		);
	});

	it('surfaces a terminal startup state while polling', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				if (String(url).endsWith(`/sessions/sess-1`)) {
					return jsonOk(makeSession({ status: 'failed', sandbox_url: undefined }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(result.current.error?.message).toBe('The kernel failed to start.');
		expect(result.current.error).toMatchObject({ kind: 'startup', generic: true });
		expect(result.current.session).toBeNull();
	});

	it('preserves the structured failure from a polled starting session', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(
						makeSession({
							status: 'failed',
							sandbox_url: undefined,
							error: {
								code: 'RESOURCE_EXHAUSTED',
								message: 'No nodes can schedule this profile',
							},
						}),
					);
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
			toaster: false,
		});
		await settleHook();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(result.current.error).toEqual({
			code: 'RESOURCE_EXHAUSTED',
			message: 'No nodes can schedule this profile',
			kind: 'startup',
		});
		expect(result.current.session).toBeNull();
	});

	it('fails a session stuck in starting once the startup timeout (plus grace) elapses', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST' || String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { startupTimeoutSeconds: 1 }),
			{ toaster: false },
		);
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		// Inside the 1s timeout + 30s grace: still polling, no error.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(result.current.error).toBeNull();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(31_000);
		});
		expect(result.current.error).toEqual({
			code: 'STARTUP_TIMEOUT',
			message: 'The kernel did not start within 31 seconds.',
			kind: 'startup',
		});
		expect(result.current.session).toBeNull();
	});

	it('falls back to the 120s server default when no capability timeout is provided', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST' || String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();

		// 120s default + 30s grace = 150s deadline.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(149_000);
		});
		expect(result.current.error).toBeNull();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_000);
		});
		expect(result.current.error).toEqual({
			code: 'STARTUP_TIMEOUT',
			message: 'The kernel did not start within 150 seconds.',
			kind: 'startup',
		});
	});

	it('says "The app" for app-mode startup timeouts, and a retry recovers', async () => {
		vi.useFakeTimers();
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					posts += 1;
					// First start wedges in `starting`; the retry comes up immediately.
					return posts === 1
						? jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }))
						: jsonOk(makeSession());
				}
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { mode: 'app', startupTimeoutSeconds: 1 }),
			{ toaster: false },
		);
		await settleHook();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(33_000);
		});
		expect(result.current.error).toEqual({
			code: 'STARTUP_TIMEOUT',
			message: 'The app did not start within 31 seconds.',
			kind: 'startup',
		});

		act(() => result.current.start());
		await settleHook();
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('posts heartbeats while running and ignores heartbeat failures', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST' && String(url).endsWith('/heartbeat')) {
				return jsonError('FAILED', 'missed heartbeat');
			}
			return jsonOk(makeSession());
		});
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		});

		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/heartbeat'))).toBe(true);
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('ignores transient polling failures and retries on the next tick', async () => {
		vi.useFakeTimers();
		let polls = 0;
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
			}
			if (String(url).endsWith(`/sessions/sess-1`)) {
				polls += 1;
				if (polls === 1) throw new Error('temporary');
				return jsonOk(makeSession({ status: 'running' }));
			}
			throw new Error(`unexpected fetch: ${String(url)}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(result.current.isRunning).toBe(true);
		expect(polls).toBe(2);
	});
});

describe('useNotebookSession (app mode)', () => {
	it("sends { mode: 'app' } on the create request", async () => {
		const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
			jsonOk(makeSession({ mode: 'app' })),
		);
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		const [, init] = fetchMock.mock.calls[0];
		expect(init?.method).toBe('POST');
		expect(String(init?.body)).toContain('"mode":"app"');
	});

	it('flips to ended when the shared app is stopped underneath the page', async () => {
		vi.useFakeTimers();
		let stopped = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(makeSession({ mode: 'app', status: stopped ? 'terminated' : 'running' }));
				}
				// The replacement check: no other app is running.
				if (String(url).endsWith(`/projects/${PID}/sessions`)) return jsonOk({ items: [] });
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		stopped = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(result.current.ended).toBe('terminated');
		expect(result.current.session).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it('treats a reaped (404) session as gone, not an error', async () => {
		vi.useFakeTimers();
		let reaped = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1')) {
					if (reaped) return jsonError('NOT_FOUND', 'gone', 404);
					return jsonOk(makeSession({ mode: 'app' }));
				}
				if (String(url).endsWith(`/projects/${PID}/sessions`)) return jsonOk({ items: [] });
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		reaped = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(result.current.ended).toBe('gone');
		expect(result.current.error).toBeNull();
	});

	// Left unhandled this state renders nothing: not running, not provisioning.
	it('flips to access_lost when a poll withholds sandbox_url on a running app', async () => {
		vi.useFakeTimers();
		let revoked = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(
						makeSession({ mode: 'app', ...(revoked ? { sandbox_url: undefined } : {}) }),
					);
				}
				if (String(url).endsWith(`/projects/${PID}/sessions`)) return jsonOk({ items: [] });
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		revoked = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		await settleHook();

		expect(result.current.ended).toBe('access_lost');
		expect(result.current.session).toBeNull();
		expect(result.current.isProvisioning).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it('does not adopt a replacement app the caller cannot reach', async () => {
		vi.useFakeTimers();
		let swapped = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1')) {
					return swapped
						? jsonError('NOT_FOUND', 'gone', 404)
						: jsonOk(makeSession({ mode: 'app' }));
				}
				if (String(url).endsWith(`/projects/${PID}/sessions`)) {
					return jsonOk({
						items: swapped
							? [makeSession({ session_id: 'sess-9', mode: 'app', sandbox_url: undefined })]
							: [],
					});
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		swapped = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		await settleHook();

		expect(result.current.session).toBeNull();
		expect(result.current.ended).toBe('gone');
	});

	it('a viewer whose access is revoked mid-start gets an error, not a blank page', async () => {
		vi.useFakeTimers();
		let revoked = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonOk(makeSession(revoked ? { sandbox_url: undefined } : { status: 'starting' }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		expect(result.current.isProvisioning).toBe(true);

		revoked = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		await settleHook();

		expect(result.current.error?.code).toBe('FORBIDDEN');
		expect(result.current.session).toBeNull();
		expect(result.current.isProvisioning).toBe(false);
	});

	it("adopts the replacement app when another user's restart swapped the session", async () => {
		vi.useFakeTimers();
		let swapped = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1')) {
					return swapped
						? jsonError('NOT_FOUND', 'gone', 404)
						: jsonOk(makeSession({ mode: 'app' }));
				}
				if (String(url).endsWith(`/projects/${PID}/sessions`)) {
					return jsonOk({
						items: swapped ? [makeSession({ session_id: 'sess-9', mode: 'app' })] : [],
					});
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		swapped = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		await settleHook();

		// Anyone else's restart must not strand this page on "App stopped".
		expect(result.current.session?.session_id).toBe('sess-9');
		expect(result.current.ended).toBeNull();
	});

	it('a session that vanishes mid-start surfaces an error, not an endless spinner', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined }));
				}
				if (String(url).endsWith('/sessions/sess-1')) {
					return jsonError('NOT_FOUND', 'gone', 404);
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(result.current.error?.message).toBe('The app failed to start.');
		expect(result.current.session).toBeNull();
		expect(result.current.isProvisioning).toBe(false);
	});

	it('reports provisioning while a restart’s stop half is still in flight', async () => {
		let resolveDelete!: () => void;
		const deletePending = new Promise<void>((resolve) => {
			resolveDelete = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'DELETE') {
					await deletePending;
					return jsonOk(undefined);
				}
				return jsonOk(makeSession({ mode: 'app' }));
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		// A real teardown takes tens of seconds; the page must show a spinner,
		// not a blank body, until the stop settles and the fresh start begins.
		await waitFor(() => expect(result.current.isProvisioning).toBe(true));
		expect(result.current.session).toBeNull();
		expect(result.current.error).toBeNull();

		resolveDelete();
		await waitFor(() => expect(result.current.isRunning).toBe(true));
	});

	it('restart stops the current session, then starts a fresh one', async () => {
		const calls: string[] = [];
		let creates = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				calls.push(`${method} ${String(url)}`);
				if (method === 'POST') {
					creates += 1;
					return jsonOk(makeSession({ session_id: `sess-${creates}`, mode: 'app' }));
				}
				if (method === 'DELETE') return jsonOk(undefined);
				throw new Error(`unexpected fetch: ${method} ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		await waitFor(() => expect(result.current.session?.session_id).toBe('sess-2'));

		const deleteIdx = calls.findIndex((c) => c.startsWith('DELETE'));
		const secondCreateIdx = calls.lastIndexOf(
			`POST /api/v1/projects/${PID}/notebooks/${NID}/sessions`,
		);
		expect(deleteIdx).toBeGreaterThan(-1);
		expect(secondCreateIdx).toBeGreaterThan(deleteIdx);
	});

	it('restart surfaces a failed stop instead of silently re-attaching', async () => {
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') {
					posts += 1;
					return jsonOk(makeSession({ mode: 'app' }));
				}
				if (method === 'DELETE') return jsonError('INTERNAL_ERROR', 'teardown failed', 500);
				throw new Error(`unexpected fetch: ${method}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		await waitFor(() => expect(result.current.error?.message).toMatch(/teardown failed/));
		// No second create — re-attaching to the session the restart failed to
		// stop would read as a restart that did nothing.
		expect(posts).toBe(1);
		expect(result.current.isProvisioning).toBe(false);
	});

	it('a watch poll that lands after a restart does not resurrect the old session', async () => {
		vi.useFakeTimers();
		let releaseWatch!: () => void;
		const watchGate = new Promise<void>((resolve) => {
			releaseWatch = resolve;
		});
		let creates = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (String(url).endsWith('/heartbeat')) return jsonOk(undefined);
				if (method === 'POST') {
					creates += 1;
					return jsonOk(makeSession({ session_id: `sess-${creates}`, mode: 'app' }));
				}
				if (method === 'DELETE') return jsonOk(undefined);
				if (String(url).endsWith('/sessions/sess-1')) {
					// Held open across the restart below, then answered with the stale
					// (still `running`) view of the session the restart replaced.
					await watchGate;
					return jsonOk(makeSession({ session_id: 'sess-1', mode: 'app' }));
				}
				return jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.session?.session_id).toBe('sess-1');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		act(() => result.current.restart());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await settleHook();
		expect(result.current.session?.session_id).toBe('sess-2');

		releaseWatch();
		await settleHook();

		expect(result.current.session?.session_id).toBe('sess-2');
		expect(result.current.ended).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it('a start poll that lands after a restart does not fail the fresh session', async () => {
		vi.useFakeTimers();
		let releasePoll!: () => void;
		const pollGate = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		let creates = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (String(url).endsWith('/heartbeat')) return jsonOk(undefined);
				if (method === 'POST') {
					creates += 1;
					return creates === 1
						? jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined }))
						: jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
				}
				if (method === 'DELETE') return jsonOk(undefined);
				if (String(url).endsWith('/sessions/sess-1')) {
					await pollGate;
					return jsonOk(makeSession({ mode: 'app', status: 'failed', sandbox_url: undefined }));
				}
				return jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		act(() => result.current.restart());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		await settleHook();
		expect(result.current.isRunning).toBe(true);

		// The abandoned session's terminal answer must not fail the app that
		// replaced it.
		releasePoll();
		await settleHook();

		expect(result.current.session?.session_id).toBe('sess-2');
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('restart proceeds to a fresh start when the session is already gone (404)', async () => {
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') {
					posts += 1;
					return jsonOk(makeSession({ session_id: `sess-${posts}`, mode: 'app' }));
				}
				if (method === 'DELETE') return jsonError('NOT_FOUND', 'Session not found', 404);
				throw new Error(`unexpected fetch: ${method}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		await waitFor(() => expect(result.current.session?.session_id).toBe('sess-2'));
		expect(result.current.error).toBeNull();
	});
});
