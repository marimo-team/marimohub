import { act, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { jsonOk, renderHookWithClient } from '@/test/render';
import { SURFACE_START_TIMEOUT_MS, useSurfaceActions } from './surfaces';

const PID = 'proj-1';
const NID = 'nb-1';

function stubFetch(handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	const fetchMock = vi.fn(handler);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function jsonError(code: string, message: string, status: number) {
	return new Response(JSON.stringify({ success: false, error: { code, message } }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('keeps the polling window beyond the server startup phase budgets', () => {
	expect(SURFACE_START_TIMEOUT_MS).toBeGreaterThan(150_000);
});

it('polls an OpenCode start until the surface is ready', async () => {
	vi.useFakeTimers();
	const fetchMock = stubFetch(async (url, init) => {
		if (!String(url).endsWith('/surfaces/opencode')) {
			throw new Error(`unexpected fetch: ${String(url)}`);
		}
		if (init?.method === 'POST') {
			return jsonOk({ id: 'opencode', status: 'starting' });
		}
		return jsonOk({ id: 'opencode', status: 'ready', url: 'https://opencode.example/' });
	});
	const { result } = renderHookWithClient(() => useSurfaceActions(PID, NID));
	let completion!: ReturnType<typeof result.current.start.mutateAsync>;
	act(() => {
		completion = result.current.start.mutateAsync({
			surfaceId: 'opencode',
			sessionId: 'sess-1',
		});
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});

	await expect(completion).resolves.toMatchObject({
		id: 'opencode',
		status: 'ready',
		url: 'https://opencode.example/',
	});
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.current.states.opencode).toMatchObject({
		sessionId: 'sess-1',
		surface: { status: 'ready', url: 'https://opencode.example/' },
	});
});

it('reports a terminal polling failure without caching the surface', async () => {
	vi.useFakeTimers();
	stubFetch(async (_url, init) =>
		init?.method === 'POST'
			? jsonOk({ id: 'opencode', status: 'starting' })
			: jsonOk({
					id: 'opencode',
					status: 'failed',
					last_error: 'OpenCode exited before readiness',
				}),
	);
	const { result } = renderHookWithClient(() => useSurfaceActions(PID, NID));
	let completion!: ReturnType<typeof result.current.start.mutateAsync>;
	act(() => {
		completion = result.current.start.mutateAsync({
			surfaceId: 'opencode',
			sessionId: 'sess-1',
		});
	});
	const rejected = expect(completion).rejects.toThrow('OpenCode exited before readiness');
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
		await rejected;
		await vi.advanceTimersByTimeAsync(0);
	});

	expect(result.current.states.opencode).toBeUndefined();
});

it('gives up once the start deadline passes', async () => {
	vi.useFakeTimers();
	const fetchMock = stubFetch(async () => jsonOk({ id: 'vscode', status: 'starting' }));
	const { result } = renderHookWithClient(() => useSurfaceActions(PID, NID));
	let completion!: ReturnType<typeof result.current.start.mutateAsync>;
	act(() => {
		completion = result.current.start.mutateAsync({ surfaceId: 'vscode', sessionId: 'sess-1' });
	});
	const rejected = expect(completion).rejects.toThrow('VS Code did not become ready');
	await act(async () => {
		await vi.advanceTimersByTimeAsync(SURFACE_START_TIMEOUT_MS + 1_000);
		await rejected;
	});

	expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(SURFACE_START_TIMEOUT_MS / 1_000);
	expect(result.current.states.vscode).toBeUndefined();
});

it('stops polling when the hook unmounts mid-start', async () => {
	vi.useFakeTimers();
	const fetchMock = stubFetch(async () => jsonOk({ id: 'vscode', status: 'starting' }));
	const { result, unmount } = renderHookWithClient(() => useSurfaceActions(PID, NID));
	let completion!: ReturnType<typeof result.current.start.mutateAsync>;
	act(() => {
		completion = result.current.start.mutateAsync({ surfaceId: 'vscode', sessionId: 'sess-1' });
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});
	expect(fetchMock).toHaveBeenCalledTimes(2);

	const rejected = expect(completion).rejects.toMatchObject({ name: 'AbortError' });
	unmount();
	await rejected;
	await vi.advanceTimersByTimeAsync(10_000);

	expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('keeps the ready state when stopping the surface fails', async () => {
	stubFetch(async (_url, init) => {
		if (init?.method === 'POST') {
			return jsonOk({ id: 'opencode', status: 'ready', url: 'https://opencode.example/' });
		}
		return jsonError('SERVICE_UNAVAILABLE', 'sandbox is unavailable', 503);
	});
	const { result } = renderHookWithClient(() => useSurfaceActions(PID, NID));

	await act(async () => {
		await result.current.start.mutateAsync({ surfaceId: 'opencode', sessionId: 'sess-1' });
	});
	await act(async () => {
		await expect(
			result.current.stop.mutateAsync({ surfaceId: 'opencode', sessionId: 'sess-1' }),
		).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
	});

	expect(result.current.states.opencode).toMatchObject({
		sessionId: 'sess-1',
		surface: { status: 'ready', url: 'https://opencode.example/' },
	});
	expect(result.current.stopping.size).toBe(0);
});

it('tracks concurrent surface starts independently', async () => {
	let resolveVscode!: (response: Response) => void;
	let resolveOpenCode!: (response: Response) => void;
	stubFetch(async (url) => {
		return new Promise<Response>((resolve) => {
			if (String(url).endsWith('/surfaces/vscode')) resolveVscode = resolve;
			else if (String(url).endsWith('/surfaces/opencode')) resolveOpenCode = resolve;
			else throw new Error(`unexpected fetch: ${String(url)}`);
		});
	});
	const { result } = renderHookWithClient(() => useSurfaceActions(PID, NID));

	act(() => {
		result.current.start.mutate({ surfaceId: 'vscode', sessionId: 'sess-1' });
		result.current.start.mutate({ surfaceId: 'opencode', sessionId: 'sess-1' });
	});
	await waitFor(() => {
		expect(result.current.starting).toEqual(new Set(['vscode', 'opencode']));
		expect(resolveVscode).toBeTypeOf('function');
		expect(resolveOpenCode).toBeTypeOf('function');
	});

	resolveVscode(jsonOk({ id: 'vscode', status: 'ready', url: 'https://vscode.example/' }));
	await waitFor(() => {
		expect(result.current.starting).toEqual(new Set(['opencode']));
		expect(result.current.states.vscode?.surface.status).toBe('ready');
	});

	resolveOpenCode(jsonOk({ id: 'opencode', status: 'ready', url: 'https://opencode.example/' }));
	await waitFor(() => {
		expect(result.current.starting.size).toBe(0);
		expect(result.current.states.opencode?.surface.status).toBe('ready');
	});
});
