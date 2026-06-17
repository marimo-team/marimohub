import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@/types';
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

function jsonOk(data: unknown): Response {
	return new Response(JSON.stringify({ success: true, data }), {
		headers: { 'content-type': 'application/json' },
	});
}

function jsonErr(message: string): Response {
	return new Response(JSON.stringify({ success: false, error: { code: 'FAILED', message } }), {
		status: 500,
		headers: { 'content-type': 'application/json' },
	});
}

/** A fresh QueryClient per render so mutation state never leaks between tests. */
function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('useNotebookSession', () => {
	it('starts a session on mount and exposes the running state', async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
			jsonOk(makeSession()),
		);
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHook(() => useNotebookSession(PID, NID), { wrapper });

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.isRunning).toBe(true);
		expect(result.current.sandboxUrl).toBe('https://sandbox.example/kernel');
		expect(result.current.error).toBeNull();

		// The start request POSTed to the sessions endpoint exactly once.
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`/api/v1/projects/${PID}/notebooks/${NID}/sessions`);
		expect(init?.method).toBe('POST');
	});

	it('holds the auto-start while enabled is false, then starts once when it flips true', async () => {
		const fetchMock = vi.fn(async () => jsonOk(makeSession()));
		vi.stubGlobal('fetch', fetchMock);

		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useNotebookSession(PID, NID, { enabled }),
			{ wrapper, initialProps: { enabled: false } },
		);

		await act(async () => {});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.session).toBeNull();

		rerender({ enabled: true });
		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Flipping back and forth never re-fires the one-shot start.
		rerender({ enabled: false });
		rerender({ enabled: true });
		await act(async () => {});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports a provisioning session (starting, no preview yet) as not running', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }))),
		);

		const { result } = renderHook(() => useNotebookSession(PID, NID), { wrapper });

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.isProvisioning).toBe(true);
		expect(result.current.isRunning).toBe(false);
		expect(result.current.sandboxUrl).toBeUndefined();
	});

	it('captures the error message when start fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonErr('sandbox unavailable')),
		);

		const { result } = renderHook(() => useNotebookSession(PID, NID), { wrapper });

		await waitFor(() => expect(result.current.error).toBe('sandbox unavailable'));
		expect(result.current.session).toBeNull();
		expect(result.current.isRunning).toBe(false);
	});

	it('stop() clears local state and issues a DELETE', async () => {
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'DELETE' ? jsonOk(null) : jsonOk(makeSession()),
		);
		vi.stubGlobal('fetch', fetchMock);

		const { result } = renderHook(() => useNotebookSession(PID, NID), { wrapper });
		await waitFor(() => expect(result.current.session).not.toBeNull());

		act(() => result.current.stop());

		await waitFor(() => expect(result.current.session).toBeNull());
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
	});

	it('retry via start() recovers from an error', async () => {
		// First call (mount) fails; subsequent calls succeed.
		let calls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				calls += 1;
				return calls === 1 ? jsonErr('boom') : jsonOk(makeSession());
			}),
		);

		const { result } = renderHook(() => useNotebookSession(PID, NID), { wrapper });
		await waitFor(() => expect(result.current.error).toBe('boom'));

		act(() => result.current.start());

		await waitFor(() => expect(result.current.session).not.toBeNull());
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});
});
