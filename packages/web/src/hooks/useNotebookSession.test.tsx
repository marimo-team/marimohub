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
		const fetchMock = vi.fn(async () => jsonOk(makeSession()));
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

		await waitFor(() => expect(result.current.error).toBe('sandbox unavailable'));
		expect(result.current.session).toBeNull();
		expect(result.current.isRunning).toBe(false);
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
		await waitFor(() => expect(result.current.error).toBe('boom'));

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

		expect(result.current.error).toBe('The kernel failed to start.');
		expect(result.current.session).toBeNull();
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
