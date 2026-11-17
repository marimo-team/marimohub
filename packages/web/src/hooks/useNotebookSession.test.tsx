import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import type { Session } from '@/types';
import { deferred } from '@/test/deferred';
import { jsonError, jsonOk, renderHookWithClient } from '@/test/render';
import {
	SESSION_START_POLL_INTERVAL_MS,
	SESSION_START_SLOW_POLL_AFTER_MS,
	EDITOR_HEARTBEAT_INTERVAL_MS,
	sessionStartPollDelayMs,
} from '@/lib/sessions';
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

async function setupAppHeartbeat(
	heartbeat: (init?: RequestInit) => Response | Promise<Response>,
	initial: Partial<Session> = {},
) {
	vi.useFakeTimers();
	const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
		String(url).endsWith('/heartbeat')
			? heartbeat(init)
			: jsonOk(
					makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined, ...initial }),
				),
	);
	vi.stubGlobal('fetch', fetchMock);
	const hook = renderHookWithClient(
		() => useNotebookSession(PID, NID, { mode: 'app', appHeartbeatIntervalSeconds: 1 }),
		{ toaster: false },
	);
	await settleHook();
	const heartbeatBodies = () =>
		fetchMock.mock.calls
			.filter(([url]) => String(url).endsWith('/heartbeat'))
			.map(([, init]) => JSON.parse(init!.body as string));
	return { ...hook, fetchMock, heartbeatBodies };
}

/**
 * Offsets from the start of startup at which the backoff schedule polls, up to `untilMs`.
 * Each delay runs from the previous response; mocked responses settle without advancing
 * the clock, so these are also the request offsets.
 */
function startPollOffsets(untilMs: number): number[] {
	const offsets: number[] = [];
	for (let attempt = 0, at = 0; ; attempt++) {
		at += sessionStartPollDelayMs(attempt, at);
		if (at > untilMs) return offsets;
		offsets.push(at);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('useNotebookSession', () => {
	it('cancels a scheduled app admission retry on unmount', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'Busy' },
					}),
					{ status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } },
				),
		);
		vi.stubGlobal('fetch', fetch);
		const { unmount } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		expect(fetch).toHaveBeenCalledOnce();
		unmount();
		await act(() => vi.advanceTimersByTimeAsync(5000));
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('receives a late app admission after unmount so its assignment can be released', async () => {
		const held = deferred<Response>();
		let visitId = '';
		let admissionSignal: AbortSignal | undefined;
		const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url).endsWith('/sessions')) {
				visitId = (JSON.parse(init!.body as string) as { app_visit_id: string }).app_visit_id;
				admissionSignal = init?.signal ?? undefined;
				return held.promise;
			}
			return jsonOk(undefined);
		});
		vi.stubGlobal('fetch', fetch);
		const { unmount } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		unmount();
		await settleHook();
		expect(admissionSignal?.aborted).toBe(false);
		await act(async () =>
			held.resolve(
				jsonOk(
					makeSession({
						mode: 'app',
						app_assignment: { visit_id: visitId, generation: 'lease-generation' },
					}),
				),
			),
		);
		await settleHook();
		const leave = fetch.mock.calls.find(([url]) => String(url).endsWith('/sess-1/leave'));
		expect(leave).toBeDefined();
		expect(JSON.parse(leave![1]!.body as string)).toEqual({
			visit_id: visitId,
			generation: 'lease-generation',
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each(['stop', 'unmount', 'restart', 'persistent', 'default'] as const)(
		'cancels a pending admission retry on %s',
		async (action) => {
			vi.useFakeTimers();
			const fetch = vi.fn(async (..._args: Parameters<typeof globalThis.fetch>) =>
				jsonOk(makeSession()),
			);
			fetch.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: false,
						error: { code: 'SERVICE_UNAVAILABLE', message: 'Busy' },
					}),
					{ status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } },
				),
			);
			vi.stubGlobal('fetch', fetch);
			const { result, unmount } = renderHookWithClient(() => useNotebookSession(PID, NID), {
				toaster: false,
			});
			await settleHook();
			expect(fetch).toHaveBeenCalledOnce();
			act(() => {
				if (action === 'unmount') unmount();
				else if (action === 'stop') void result.current.stop();
				else if (action === 'restart') result.current.restart();
				else if (action === 'persistent') result.current.startPersistent();
				else result.current.startWithDefault();
			});
			await settleHook();
			await act(() => vi.advanceTimersByTimeAsync(5000));
			const replaced = action !== 'stop' && action !== 'unmount';
			expect(fetch).toHaveBeenCalledTimes(replaced ? 2 : 1);
			if (replaced) expect(result.current.isRunning).toBe(true);
			if (action === 'stop') expect(result.current.isProvisioning).toBe(false);
		},
	);

	it('keeps an in-flight admission alive through StrictMode effect reconnection', async () => {
		const held = deferred<Response>();
		let signal: AbortSignal | undefined;
		const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return held.promise;
		});
		vi.stubGlobal('fetch', fetch);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
			toaster: false,
			reactStrictMode: true,
		});
		await settleHook();
		expect(fetch).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(false);
		await act(async () => held.resolve(jsonOk(makeSession())));
		await waitFor(() => expect(result.current.isRunning).toBe(true));
	});

	it('acknowledges a save only for the current running session', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(makeSession({ source_version_id: 'a' }))),
		);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(result.current.isRunning).toBe(true));
		await act(async () => result.current.acknowledgeWorkingBranchSave('other-session', 'b'));
		expect(result.current.session?.working_branch_version_id).toBeUndefined();
		await act(async () => result.current.acknowledgeWorkingBranchSave('sess-1', 'b'));
		expect(result.current.session).toMatchObject({
			source_version_id: 'a',
			working_branch_version_id: 'b',
		});
		await act(async () => result.current.acknowledgeWorkingBranchSave('sess-1', 'a'));
		expect(result.current.session?.working_branch_version_id).toBe('b');
	});
	it('preserves the saved baseline when an older session poll completes', async () => {
		vi.useFakeTimers();
		const pending = deferred<Response>();
		const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
			String(url).endsWith('/sessions')
				? jsonOk(makeSession({ source_version_id: 'a' }))
				: pending.promise,
		);
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(EDITOR_HEARTBEAT_INTERVAL_MS));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await act(async () => result.current.acknowledgeWorkingBranchSave('sess-1', 'b'));
		await act(async () => {
			pending.resolve(jsonOk(makeSession({ source_version_id: 'a' })));
		});
		expect(result.current.session).toMatchObject({
			source_version_id: 'a',
			working_branch_version_id: 'b',
		});
	});
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

	it('releases an admission that completes after the page unmounts', async () => {
		const pending = deferred<Response>();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/leave') ? jsonOk({}) : pending.promise,
		);
		vi.stubGlobal('fetch', fetchMock);
		const { unmount } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		unmount();
		await act(async () =>
			pending.resolve(
				jsonOk(makeSession({ app_assignment: { visit_id: 'tab', generation: 'generation' } })),
			),
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(String(fetchMock.mock.calls[1][0])).toContain('/sess-1/leave');
	});

	it.each([true, false])(
		'releases a superseded admission without releasing the winning visit (stale first: %s)',
		async (staleFirst) => {
			const admissions: { visitId: string; complete: () => void }[] = [];
			const departures: unknown[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					if (String(input).endsWith('/leave')) {
						departures.push(JSON.parse(init!.body as string));
						return jsonOk({});
					}
					const { app_visit_id: visitId } = JSON.parse(init!.body as string) as {
						app_visit_id: string;
					};
					return new Promise<Response>((resolve) => {
						admissions.push({
							visitId,
							complete: () =>
								resolve(
									jsonOk(
										makeSession({
											app_assignment: { visit_id: visitId, generation: 'shared-generation' },
										}),
									),
								),
						});
					});
				}),
			);
			const { result, unmount } = renderHookWithClient(
				() => useNotebookSession(PID, NID, { mode: 'app' }),
				{ toaster: false },
			);
			await waitFor(() => expect(admissions).toHaveLength(1));
			act(() => result.current.start());
			await waitFor(() => expect(admissions).toHaveLength(2));
			expect(admissions[0].visitId).not.toBe(admissions[1].visitId);
			for (const index of staleFirst ? [0, 1] : [1, 0]) {
				await act(async () => admissions[index].complete());
				await settleHook();
			}
			expect(departures).toEqual([
				{ visit_id: admissions[0].visitId, generation: 'shared-generation' },
			]);
			expect(result.current.session?.app_assignment?.visit_id).toBe(admissions[1].visitId);
			expect(result.current.isRunning).toBe(true);
			unmount();
			await settleHook();
		},
	);

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

	it('starts an app from its heartbeat and preserves the visit lease', async () => {
		const assignment = { visit_id: 'visit', generation: 'generation' };
		const { result, fetchMock } = await setupAppHeartbeat(() => jsonOk(makeSession()), {
			app_assignment: assignment,
		});
		expect(result.current.isProvisioning).toBe(true);

		await act(() => vi.advanceTimersByTimeAsync(1_000));

		expect(result.current.isRunning).toBe(true);
		expect(result.current.session?.app_assignment).toEqual(assignment);
		const heartbeat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/heartbeat'));
		expect(JSON.parse(heartbeat![1]!.body as string)).toEqual(assignment);
	});

	it.each([
		{ response: { status: 'failed' }, ended: 'failed' },
		{ response: { status: 'terminated' }, ended: 'terminated' },
		{ response: { status: 'expired' }, ended: 'expired' },
		{ response: { status: 'running', sandbox_url: undefined }, ended: 'access_lost' },
	] satisfies { response: Partial<Session>; ended: string }[])(
		'ends startup when a heartbeat reports $ended',
		async ({ response, ended }) => {
			const { result, fetchMock } = await setupAppHeartbeat(() => jsonOk(makeSession(response)));
			await act(() => vi.advanceTimersByTimeAsync(1_000));
			expect(result.current.ended).toBe(ended);
			expect(result.current.session).toBeNull();
			expect(result.current.isProvisioning).toBe(false);
			fetchMock.mockClear();
			await act(() => vi.advanceTimersByTimeAsync(30_000));
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(['network', 'server'])(
		'recovers from a transient %s error in a startup heartbeat',
		async (failure) => {
			let heartbeats = 0;
			const { result } = await setupAppHeartbeat(() => {
				if (++heartbeats > 1) return jsonOk(makeSession());
				if (failure === 'network') throw new TypeError('Failed to fetch');
				return jsonError('UNAVAILABLE', 'Try again', 503);
			});
			await act(() => vi.advanceTimersByTimeAsync(1_000));
			expect(result.current.isProvisioning).toBe(true);
			expect(result.current.error).toBeNull();
			expect(result.current.ended).toBeNull();
			await act(() => vi.advanceTimersByTimeAsync(1_000));
			expect(result.current.isRunning).toBe(true);
		},
	);

	it.each(['edit', 'app'] as const)(
		'resets %s polling backoff for a new startup attempt',
		async (mode) => {
			vi.useFakeTimers();
			let creates = 0;
			const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).endsWith('/sessions') && init?.method === 'POST') creates++;
				return jsonOk(
					makeSession({
						session_id: `sess-${creates}`,
						status: 'starting',
						sandbox_url: undefined,
					}),
				);
			});
			vi.stubGlobal('fetch', fetchMock);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode }), {
				toaster: false,
			});
			await settleHook();
			await act(() => vi.advanceTimersByTimeAsync(SESSION_START_SLOW_POLL_AFTER_MS + 1_000));
			act(() => {
				void result.current.stop();
			});
			await settleHook();
			act(() => result.current.start());
			await settleHook();
			expect(result.current.session?.session_id).toBe('sess-2');
			fetchMock.mockClear();
			const polls = () =>
				fetchMock.mock.calls
					.map(([url]) => String(url))
					.filter((url) => new URL(url, 'http://localhost').pathname.endsWith('/sessions/sess-2'));
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(polls()).toHaveLength(1);
			await act(() => vi.advanceTimersByTimeAsync(249));
			expect(polls()).toHaveLength(1);
			await act(() => vi.advanceTimersByTimeAsync(1));
			expect(polls()).toHaveLength(2);
		},
	);

	it.each(['edit', 'app'] as const)(
		'backs off %s startup polling, slows after 30 seconds, and stops once running under StrictMode',
		async (mode) => {
			vi.useFakeTimers();
			const pollTimes: number[] = [];
			const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1'))
					pollTimes.push(Date.now());
				return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
			});
			vi.stubGlobal('fetch', fetchMock);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode }), {
				toaster: false,
				reactStrictMode: true,
			});
			await settleHook();
			const startedAt = Date.now();
			const horizon = SESSION_START_SLOW_POLL_AFTER_MS + 12_000;
			await act(() => vi.advanceTimersByTimeAsync(horizon));
			const expected = startPollOffsets(horizon);
			expect(expected.slice(0, 6)).toEqual([0, 250, 750, 1_750, 3_750, 5_750]);
			expect(expected.slice(-3)).toEqual([31_750, 36_750, 41_750]);
			expect(pollTimes.map((at) => at - startedAt)).toEqual(expected);

			fetchMock.mockResolvedValue(jsonOk(makeSession()));
			await act(() => vi.advanceTimersByTimeAsync(5_000));
			expect(result.current.isRunning).toBe(true);
			const settled = pollTimes.length;
			await act(() => vi.advanceTimersByTimeAsync(10_000));
			expect(pollTimes).toHaveLength(settled);
		},
	);

	it('keeps a newer running poll when an earlier slow starting poll answers late', async () => {
		vi.useFakeTimers();
		const slowStarting = deferred<Response>();
		let polls = 0;
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
			}
			if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
				polls += 1;
				return polls === 1 ? slowStarting.promise : jsonOk(makeSession());
			}
			throw new Error(`unexpected fetch: ${String(url)}`);
		});
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();

		await act(() => vi.advanceTimersByTimeAsync(5_000));
		await act(async () => {
			slowStarting.resolve(jsonOk(makeSession({ status: 'starting', sandbox_url: undefined })));
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(result.current.isRunning).toBe(true);
		const settled = polls;
		await act(() => vi.advanceTimersByTimeAsync(10_000));
		expect(polls).toBe(settled);
		expect(result.current.session?.status).toBe('running');
	});

	it('ignores a startup poll that answers after an app heartbeat reports running', async () => {
		const slowStarting = deferred<Response>();
		let polls = 0;
		const { result, fetchMock } = await setupAppHeartbeat(() =>
			jsonOk(makeSession({ mode: 'app' })),
		);
		fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
			if (String(url).endsWith('/heartbeat')) return jsonOk(makeSession({ mode: 'app' }));
			polls += 1;
			return slowStarting.promise;
		});
		await act(() => vi.advanceTimersByTimeAsync(1_000));
		expect(polls).toBe(1);
		expect(result.current.isRunning).toBe(true);
		await act(async () => {
			slowStarting.resolve(
				jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined })),
			);
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(result.current.session?.status).toBe('running');
		expect(polls).toBe(1);
	});

	it('never has more than one startup poll in flight', async () => {
		vi.useFakeTimers();
		let inFlight = 0;
		let maxInFlight = 0;
		let polls = 0;
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') {
				return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
			}
			polls += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Slower than every early backoff delay.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			inFlight -= 1;
			return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
		});
		vi.stubGlobal('fetch', fetchMock);
		renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();

		await act(() => vi.advanceTimersByTimeAsync(20_000));
		expect(polls).toBeGreaterThan(3);
		expect(maxInFlight).toBe(1);
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
		const defaultResponse = deferred<Response>();
		const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== 'POST') throw new Error('unexpected request');
			postCount += 1;
			if (postCount === 1) return jsonError('RESOURCE_EXHAUSTED', 'profile too large', 429);
			return defaultResponse.promise;
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
			defaultResponse.resolve(jsonError('RESOURCE_EXHAUSTED', 'default unavailable', 429));
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

		act(() => {
			void result.current.stop();
		});

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

		act(() => {
			void result.current.stop();
		});

		await waitFor(() => expect(result.current.error?.message).toBe('teardown failed'));
		expect(result.current.session?.session_id).toBe('sess-1');
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

		act(() => {
			void result.current.stop();
		});
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
			if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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
		expect(
			fetchMock.mock.calls.some(([url]) =>
				new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1'),
			),
		).toBe(true);
	});

	it('surfaces a terminal startup state while polling', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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
				if (
					init?.method === 'POST' ||
					new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')
				) {
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
			message: 'The kernel did not start within 1s.',
			kind: 'startup',
		});
		expect(result.current.session).toBeNull();
	});

	it('falls back to the 120s server default when no capability timeout is provided', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (
					init?.method === 'POST' ||
					new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')
				) {
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
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(result.current.error).toEqual({
			code: 'STARTUP_TIMEOUT',
			message: 'The kernel did not start within 120s.',
			kind: 'startup',
		});
	});

	it('says "The app" for app-mode startup timeouts, and a retry recovers', async () => {
		vi.useFakeTimers();
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST' && String(url).endsWith('/sessions')) {
					posts += 1;
					// First start wedges in `starting`; the retry comes up immediately.
					return posts === 1
						? jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }))
						: jsonOk(makeSession());
				}
				if (
					new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1') ||
					String(url).endsWith('/heartbeat')
				) {
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
			message: 'The app did not start within 1s.',
			kind: 'startup',
		});

		act(() => result.current.start());
		await settleHook();
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('uses the editor heartbeat for status without a separate status poll', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonOk(makeSession()));
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		fetchMock.mockClear();
		await act(() => vi.advanceTimersByTimeAsync(EDITOR_HEARTBEAT_INTERVAL_MS - 1));
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockResolvedValue(jsonOk(makeSession({ status: 'terminated' })));
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/heartbeat');
		expect(result.current.ended).toBe('terminated');
	});

	it('honors Retry-After before retrying an unavailable heartbeat', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const sentAt: number[] = [];
		await setupAppHeartbeat(
			() => {
				sentAt.push(Date.now());
				const response = jsonError('SERVICE_UNAVAILABLE', 'Try later', 503);
				response.headers.set('Retry-After', '12');
				return response;
			},
			makeSession({ mode: 'app' }),
		);
		await act(() => vi.advanceTimersByTimeAsync(900));
		expect(sentAt).toHaveLength(1);
		await act(() => vi.advanceTimersByTimeAsync(11_999));
		expect(sentAt).toHaveLength(1);
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(sentAt[1] - sentAt[0]).toBe(12_000);
	});

	it('uses one heartbeat/status request per interval for running apps', async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async () => jsonOk(makeSession({ mode: 'app' })));
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		fetchMock.mockClear();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(result.current.isRunning).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url, init] of vi.mocked(fetch).mock.calls) {
			expect(String(url)).toContain('/heartbeat');
			expect(init?.method).toBe('POST');
		}
	});

	it.each(
		(['starting', 'running'] as const).flatMap((sessionStatus) =>
			[
				{ status: 403, code: 'FORBIDDEN', ended: 'access_lost' },
				{ status: 404, code: 'NOT_FOUND', ended: 'gone' },
				{ status: 409, code: 'APP_ASSIGNMENT_EXPIRED', ended: 'expired' },
			].map((failure) => ({ sessionStatus, ...failure })),
		),
	)(
		'ends a $sessionStatus app on heartbeat rejection $status',
		async ({ sessionStatus, status, code, ended }) => {
			const { result, fetchMock } = await setupAppHeartbeat(
				() =>
					jsonError(
						code,
						status === 409 ? 'This wording may change.' : 'assignment unavailable',
						status,
					),
				makeSession({ mode: 'app', status: sessionStatus }),
			);
			await act(() => vi.advanceTimersByTimeAsync(1_000));
			expect(result.current.session).toBeNull();
			expect(result.current.ended).toBe(ended);
			expect(result.current.isProvisioning).toBe(false);
			fetchMock.mockClear();
			await act(() => vi.advanceTimersByTimeAsync(30_000));
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		[409, 'CONFLICT'],
		[503, 'SERVICE_UNAVAILABLE'],
	] as const)('retries a heartbeat %s without ending the visit', async (status, code) => {
		const assignment = { visit_id: 'same-visit', generation: 'same-generation' };
		let attempts = 0;
		const { result, heartbeatBodies } = await setupAppHeartbeat(
			() => {
				attempts++;
				return attempts === 1
					? jsonError(code, 'Write conflict: max retries exceeded', status)
					: jsonOk(makeSession({ mode: 'app' }));
			},
			makeSession({ mode: 'app', app_assignment: assignment }),
		);
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(result.current.ended).toBeNull();
		expect(result.current.isRunning).toBe(true);
		await act(() => vi.advanceTimersByTimeAsync(2000));
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(result.current.ended).toBeNull();
		expect(heartbeatBodies()).toEqual(Array(attempts).fill(assignment));
	});

	it.each([
		{ nativeAny: false, nativeTimeout: true },
		{ nativeAny: true, nativeTimeout: false },
		{ nativeAny: false, nativeTimeout: false },
	])(
		'sends heartbeats without native abort helpers (any: $nativeAny, timeout: $nativeTimeout)',
		async ({ nativeAny, nativeTimeout }) => {
			vi.stubGlobal(
				'AbortSignal',
				new Proxy(AbortSignal, {
					get(target, property, receiver) {
						if (property === 'any' && !nativeAny) return;
						if (property === 'timeout' && !nativeTimeout) return;
						return Reflect.get(target, property, receiver);
					},
				}),
			);
			const heartbeat = vi.fn(() => jsonOk(makeSession({ mode: 'app' })));
			const { result } = await setupAppHeartbeat(heartbeat, makeSession({ mode: 'app' }));
			await act(() => vi.advanceTimersByTimeAsync(1000));
			expect(heartbeat).toHaveBeenCalledOnce();
			expect(result.current.isRunning).toBe(true);
			expect(result.current.ended).toBeNull();
		},
	);

	it('backs off repeated network failures and resets the schedule after recovery', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const assignment = { visit_id: 'same-visit', generation: 'same-generation' };
		const sentAt: number[] = [];
		const { result, heartbeatBodies } = await setupAppHeartbeat(
			() => {
				sentAt.push(Date.now());
				if (sentAt.length <= 6) throw new TypeError('Failed to fetch');
				return jsonOk(makeSession({ mode: 'app', app_assignment: assignment }));
			},
			makeSession({ mode: 'app', app_assignment: assignment }),
		);
		const startedAt = Date.now();
		await act(() => vi.advanceTimersByTimeAsync(96_150));
		expect(sentAt.map((at) => at - startedAt)).toEqual([
			900, 1650, 3150, 6150, 36_150, 66_150, 96_150,
		]);
		expect(result.current.ended).toBeNull();
		expect(result.current.isRunning).toBe(true);
		await act(() => vi.advanceTimersByTimeAsync(899));
		expect(sentAt).toHaveLength(7);
		await act(() => vi.advanceTimersByTimeAsync(1));
		expect(sentAt[7] - startedAt).toBe(97_050);
		expect(heartbeatBodies()).toEqual(Array(sentAt.length).fill(assignment));
	});

	it('restarts the heartbeat cadence and ignores a cancelled request after configuration changes', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const held = deferred<Response>();
		const signals: AbortSignal[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).endsWith('/heartbeat')) {
					signals.push(init!.signal!);
					if (signals.length === 1) return held.promise;
				}
				return jsonOk(makeSession({ mode: 'app' }));
			}),
		);
		const { result, rerender } = renderHookWithClient(
			({ interval }) =>
				useNotebookSession(PID, NID, { mode: 'app', appHeartbeatIntervalSeconds: interval }),
			{ toaster: false, initialProps: { interval: 10 } },
		);
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(9000));
		expect(signals).toHaveLength(1);
		rerender({ interval: 1 });
		expect(signals[0].aborted).toBe(true);
		await act(() => vi.advanceTimersByTimeAsync(900));
		expect(signals).toHaveLength(2);
		await act(async () => held.resolve(jsonError('FORBIDDEN', 'Old access result', 403)));
		expect(result.current.isRunning).toBe(true);
		expect(result.current.ended).toBeNull();
		expect(result.current.error).toBeNull();
	});

	it.each(['timeout', 'unmount'] as const)(
		'cancels an in-flight heartbeat on %s',
		async (action) => {
			vi.spyOn(Math, 'random').mockReturnValue(0.5);
			const timeout = new AbortController();
			const createTimeout = AbortSignal.timeout.bind(AbortSignal);
			let intercepted = false;
			const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
				if (ms !== 10_000 || intercepted) return createTimeout(ms);
				intercepted = true;
				return timeout.signal;
			});
			const assignment = { visit_id: 'same-visit', generation: 'same-generation' };
			let attempts = 0;
			let aborted = false;
			const { result, unmount, heartbeatBodies } = await setupAppHeartbeat(
				(init) => {
					attempts++;
					if (attempts > 1) return jsonOk(makeSession({ mode: 'app', app_assignment: assignment }));
					return new Promise<Response>((_resolve, reject) => {
						init!.signal!.addEventListener(
							'abort',
							() => {
								aborted = true;
								reject(new DOMException('Request aborted', 'AbortError'));
							},
							{ once: true },
						);
					});
				},
				makeSession({ mode: 'app', app_assignment: assignment }),
			);
			await act(() => vi.advanceTimersByTimeAsync(1000));
			expect(attempts).toBe(1);
			expect(timeoutSpy).toHaveBeenCalledWith(10_000);
			if (action === 'unmount') {
				unmount();
				await act(() => vi.advanceTimersByTimeAsync(30_000));
				expect(attempts).toBe(1);
			} else {
				await act(async () => timeout.abort(new DOMException('Timed out', 'TimeoutError')));
				await act(() => vi.advanceTimersByTimeAsync(1000));
				expect(attempts).toBe(2);
				expect(result.current.isRunning).toBe(true);
				expect(result.current.ended).toBeNull();
				expect(heartbeatBodies()).toEqual(Array(attempts).fill(assignment));
			}
			expect(aborted).toBe(true);
		},
	);

	it('sends fenced app presence during startup and releases the visit on departure', async () => {
		vi.useFakeTimers();
		let visitId = '';
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url).endsWith('/sessions') && init?.method === 'POST') {
				const body = JSON.parse(init.body as string) as { app_visit_id: string };
				visitId = body.app_visit_id;
				return jsonOk(
					makeSession({
						mode: 'app',
						status: 'starting',
						sandbox_url: undefined,
						app_assignment: { visit_id: visitId, generation: 'generation-1' },
					}),
				);
			}
			return jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined }));
		});
		vi.stubGlobal('fetch', fetchMock);
		const { unmount } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		const heartbeat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/heartbeat'));
		expect(JSON.parse(heartbeat![1]!.body as string)).toEqual({
			visit_id: visitId,
			generation: 'generation-1',
		});
		unmount();
		await settleHook();
		const leave = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/leave'));
		expect(JSON.parse(leave![1]!.body as string)).toEqual({
			visit_id: visitId,
			generation: 'generation-1',
		});
		expect(leave![1]!.keepalive).toBe(true);
	});

	it('preserves the visit across back-forward cache restoration', async () => {
		vi.useFakeTimers();
		const session = makeSession({
			mode: 'app',
			app_assignment: { visit_id: 'tab', generation: 'generation-1' },
		});
		const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonOk(session));
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await settleHook();
		await act(async () => {
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
			window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
			`/api/v1/projects/${PID}/notebooks/${NID}/sessions`,
			`/api/v1/projects/${PID}/notebooks/${NID}/sessions/sess-1/heartbeat`,
		]);
		expect(result.current.isRunning).toBe(true);
		expect(result.current.ended).toBeNull();
	});

	it('releases the visit when the page is discarded', async () => {
		const assignment = { visit_id: 'tab', generation: 'generation-1' };
		const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
			jsonOk(makeSession({ mode: 'app', app_assignment: assignment })),
		);
		vi.stubGlobal('fetch', fetchMock);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));
		await act(async () => {
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
		});
		const leave = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sess-1/leave'));
		expect(leave).toBeDefined();
		const init = leave![1];
		expect(init?.keepalive).toBe(true);
		expect(JSON.parse(init!.body as string)).toEqual(assignment);
	});

	it('a late poll response cannot resurrect a session after the startup timeout', async () => {
		vi.useFakeTimers();
		const held = deferred<Response>();
		let polls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
					polls += 1;
					// The first poll hangs until after the timeout has concluded.
					return polls === 1
						? held.promise
						: jsonOk(makeSession({ status: 'starting', sandbox_url: undefined }));
				}
				throw new Error(`unexpected fetch: ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { startupTimeoutSeconds: 1 }),
			{ toaster: false },
		);
		await settleHook();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(33_000);
		});
		expect(result.current.error?.code).toBe('STARTUP_TIMEOUT');

		// The stale in-flight poll finally answers `running` — and must be ignored.
		await act(async () => {
			held.resolve(jsonOk(makeSession()));
			await Promise.resolve();
		});
		await settleHook();
		expect(result.current.session).toBeNull();
		expect(result.current.error?.code).toBe('STARTUP_TIMEOUT');
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
			if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(polls).toBe(1);
		expect(result.current.session?.status).toBe('starting');

		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
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
				if (init?.method === 'POST' && String(url).endsWith('/sessions'))
					return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
					return jsonOk(makeSession({ mode: 'app', status: stopped ? 'terminated' : 'running' }));
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

		stopped = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
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
				if (init?.method === 'POST' && String(url).endsWith('/sessions'))
					return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
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
			await vi.advanceTimersByTimeAsync(30_000);
		});

		expect(result.current.ended).toBe('gone');
		expect(result.current.error).toBeNull();
	});

	// Left unhandled this state renders nothing: not running, not provisioning.
	it('flips to access_lost when a heartbeat withholds sandbox_url on a running app', async () => {
		vi.useFakeTimers();
		let revoked = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST' && String(url).endsWith('/sessions'))
					return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
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
			await vi.advanceTimersByTimeAsync(30_000);
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
				if (init?.method === 'POST' && String(url).endsWith('/sessions'))
					return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
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
			await vi.advanceTimersByTimeAsync(30_000);
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
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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

	it("requires readmission when another user's restart ends the assigned session", async () => {
		vi.useFakeTimers();
		let swapped = false;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST' && String(url).endsWith('/sessions'))
					return jsonOk(makeSession({ mode: 'app' }));
				if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
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
			await vi.advanceTimersByTimeAsync(30_000);
		});
		await settleHook();

		expect(result.current.session).toBeNull();
		expect(result.current.ended).toBe('gone');
		expect(
			vi
				.mocked(fetch)
				.mock.calls.some(([url]) => String(url).endsWith(`/projects/${PID}/sessions`)),
		).toBe(false);
	});

	it('a session that vanishes mid-start surfaces an error, not an endless spinner', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined }));
				}
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
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

	it('replaces the selected app before readmitting this page with a new visit', async () => {
		const replacement = deferred();
		const requests: { method: string; body: Record<string, string> }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url).endsWith('/leave')) return jsonOk({});
				const body = JSON.parse(String(init?.body)) as Record<string, string>;
				requests.push({ method: init?.method ?? 'GET', body });
				if (body.replace_app_session_id) {
					await replacement.promise;
					return jsonOk(makeSession({ session_id: 'replacement', mode: 'app' }));
				}
				return jsonOk(
					makeSession({
						session_id: requests.length === 1 ? 'original' : 'admitted',
						mode: 'app',
						app_assignment: { visit_id: body.app_visit_id, generation: 'assignment' },
					}),
				);
			}),
		);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));
		act(() => result.current.restart());
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1].body).toEqual({ mode: 'app', replace_app_session_id: 'original' });
		expect(result.current.isProvisioning).toBe(true);
		expect(result.current.session).toBeNull();
		await act(async () => replacement.resolve());
		await waitFor(() => expect(result.current.session?.session_id).toBe('admitted'));
		expect(requests).toHaveLength(3);
		expect(requests.map((request) => request.method)).toEqual(['POST', 'POST', 'POST']);
		expect(requests[2].body.app_visit_id).not.toBe(requests[0].body.app_visit_id);
		expect(requests[2].body).not.toHaveProperty('replace_app_session_id');
	});

	it.each([404, 429, 500])(
		'surfaces app replacement failure %s without fallback admission',
		async (status) => {
			const requests: unknown[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
					if (String(url).endsWith('/leave')) return jsonOk({});
					const body = JSON.parse(String(init?.body)) as Record<string, string>;
					requests.push(body);
					return body.replace_app_session_id
						? jsonError('REPLACEMENT_FAILED', 'replacement failed', status)
						: jsonOk(makeSession({ mode: 'app' }));
				}),
			);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'app' }), {
				toaster: false,
			});
			await waitFor(() => expect(result.current.isRunning).toBe(true));
			act(() => result.current.restart());
			await waitFor(() => expect(result.current.error?.message).toBe('replacement failed'));
			expect(requests).toHaveLength(2);
			expect(result.current.isProvisioning).toBe(false);
			expect(result.current.session).toBeNull();
		},
	);

	it.each(['edit', 'app'] as const)(
		'stops %s provisioning while replacement is still in flight',
		async (mode) => {
			const replacement = deferred<Response>();
			const fetch = vi.fn(async (..._args: Parameters<typeof globalThis.fetch>) =>
				jsonOk(makeSession({ mode })),
			);
			fetch.mockImplementationOnce(async () => jsonOk(makeSession({ mode })));
			fetch.mockImplementationOnce(() => replacement.promise);
			vi.stubGlobal('fetch', fetch);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode }), {
				toaster: false,
			});
			await waitFor(() => expect(result.current.isRunning).toBe(true));
			act(() => result.current.restart());
			await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
			expect(result.current.isProvisioning).toBe(true);
			act(() => {
				void result.current.stop();
			});
			expect(result.current.isProvisioning).toBe(false);
			await act(async () =>
				replacement.resolve(jsonOk(makeSession({ mode, session_id: 'replacement' }))),
			);
			await settleHook();
			expect(result.current.isProvisioning).toBe(false);
			expect(result.current.session).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);

	it('reports provisioning while a restart’s stop half is still in flight', async () => {
		const deletePending = deferred();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'DELETE') {
					await deletePending.promise;
					return jsonOk(undefined);
				}
				return jsonOk(makeSession({ mode: 'edit' }));
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'edit' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		// A real teardown takes tens of seconds; the page must show a spinner,
		// not a blank body, until the stop settles and the fresh start begins.
		await waitFor(() => expect(result.current.isProvisioning).toBe(true));
		expect(result.current.session?.session_id).toBe('sess-1');
		expect(result.current.error).toBeNull();

		deletePending.resolve();
		await waitFor(() => expect(result.current.isRunning).toBe(true));
	});

	it('editor restart stops the current session, then starts a fresh one', async () => {
		const calls: string[] = [];
		let creates = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				calls.push(`${method} ${String(url)}`);
				if (method === 'POST') {
					creates += 1;
					return jsonOk(makeSession({ session_id: `sess-${creates}`, mode: 'edit' }));
				}
				if (method === 'DELETE') return jsonOk(undefined);
				throw new Error(`unexpected fetch: ${method} ${String(url)}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'edit' }), {
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

	it('editor restart surfaces a failed stop instead of silently re-attaching', async () => {
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') {
					posts += 1;
					return jsonOk(makeSession({ mode: 'edit' }));
				}
				if (method === 'GET') return jsonOk(makeSession({ mode: 'edit' }));
				if (method === 'DELETE') return jsonError('INTERNAL_ERROR', 'teardown failed', 500);
				throw new Error(`unexpected fetch: ${method}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'edit' }), {
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

	it.each(['app', 'edit'] as const)(
		'ignores a late running response after a %s session ends',
		async (mode) => {
			vi.useFakeTimers();
			const pending = deferred<Response>();
			let watches = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: RequestInfo | URL) => {
					if (String(url).endsWith('/sessions')) return jsonOk(makeSession({ mode }));
					watches++;
					if (watches === 1) return pending.promise;
					return jsonOk(
						makeSession({
							mode,
							status: 'terminated',
							...(mode === 'edit'
								? { ended_reason: 'takeover', ended_by_user_id: 'new-owner' }
								: {}),
						}),
					);
				}),
			);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode }), {
				toaster: false,
			});
			await settleHook();
			await act(async () =>
				vi.advanceTimersByTimeAsync(mode === 'app' ? 60_000 : EDITOR_HEARTBEAT_INTERVAL_MS),
			);
			await settleHook();
			{
				expect(watches).toBe(1);
				await act(async () => pending.resolve(jsonOk(makeSession({ mode }))));
				await act(async () =>
					vi.advanceTimersByTimeAsync(mode === 'app' ? 30_000 : EDITOR_HEARTBEAT_INTERVAL_MS),
				);
			}
			expect(watches).toBe(2);
			expect(result.current.ended).toBe(mode === 'edit' ? 'takeover' : 'terminated');
			expect(result.current.endedByUserId).toBe(mode === 'edit' ? 'new-owner' : null);
			expect(result.current.session).toBeNull();
			await act(async () => pending.resolve(jsonOk(makeSession({ mode }))));
			await settleHook();
			expect(result.current.session).toBeNull();
			expect(result.current.isRunning).toBe(false);
		},
	);

	it.each(['starting', 'running'] as const)(
		'a late %s heartbeat cannot resurrect a session after restart',
		async (initialStatus) => {
			vi.useFakeTimers();
			const watchGate = deferred();
			let creates = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
					const method = init?.method ?? 'GET';
					if (String(url).endsWith('/sessions/sess-1/heartbeat')) {
						await watchGate.promise;
						return jsonOk(makeSession({ session_id: 'sess-1', mode: 'app' }));
					}
					if (
						method === 'POST' &&
						(JSON.parse(String(init?.body)) as { replace_app_session_id?: string })
							.replace_app_session_id
					)
						return jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
					if (method === 'POST') {
						creates += 1;
						return jsonOk(
							makeSession({
								session_id: `sess-${creates}`,
								mode: 'app',
								status: creates === 1 ? initialStatus : 'running',
							}),
						);
					}
					if (method === 'DELETE') return jsonOk(undefined);
					return jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
				}),
			);

			const { result } = renderHookWithClient(
				() => useNotebookSession(PID, NID, { mode: 'app', appHeartbeatIntervalSeconds: 1 }),
				{
					toaster: false,
				},
			);
			await settleHook();
			expect(result.current.session?.session_id).toBe('sess-1');

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1_000);
			});

			act(() => result.current.restart());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});
			await settleHook();
			expect(result.current.session?.session_id).toBe('sess-2');

			watchGate.resolve();
			await settleHook();

			expect(result.current.session?.session_id).toBe('sess-2');
			expect(result.current.ended).toBeNull();
			expect(result.current.error).toBeNull();
		},
	);

	it('a start poll that lands after a restart does not fail the fresh session', async () => {
		vi.useFakeTimers();
		const pollGate = deferred();
		let creates = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (String(url).endsWith('/heartbeat')) return jsonOk(undefined);
				if (
					method === 'POST' &&
					(JSON.parse(String(init?.body)) as { replace_app_session_id?: string })
						.replace_app_session_id
				)
					return jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
				if (method === 'POST') {
					creates += 1;
					return creates === 1
						? jsonOk(makeSession({ mode: 'app', status: 'starting', sandbox_url: undefined }))
						: jsonOk(makeSession({ session_id: 'sess-2', mode: 'app' }));
				}
				if (method === 'DELETE') return jsonOk(undefined);
				if (new URL(String(url), 'http://localhost').pathname.endsWith('/sessions/sess-1')) {
					await pollGate.promise;
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
		pollGate.resolve();
		await settleHook();

		expect(result.current.session?.session_id).toBe('sess-2');
		expect(result.current.error).toBeNull();
		expect(result.current.isRunning).toBe(true);
	});

	it('editor restart proceeds to a fresh start when the session is already gone (404)', async () => {
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				if (method === 'POST') {
					posts += 1;
					return jsonOk(makeSession({ session_id: `sess-${posts}`, mode: 'edit' }));
				}
				if (method === 'DELETE') return jsonError('NOT_FOUND', 'Session not found', 404);
				throw new Error(`unexpected fetch: ${method}`);
			}),
		);

		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID, { mode: 'edit' }), {
			toaster: false,
		});
		await waitFor(() => expect(result.current.isRunning).toBe(true));

		act(() => result.current.restart());
		await waitFor(() => expect(result.current.session?.session_id).toBe('sess-2'));
		expect(result.current.error).toBeNull();
	});
});

describe('session diagnostic links', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	function linkedSession(overrides: Partial<Session> = {}): Session {
		return makeSession({
			mode: 'edit',
			status: 'starting',
			sandbox_url: undefined,
			can: { attach: true, stop: true },
			links: [{ id: 'logs', label: 'Logs', href: 'https://logs.example/old' }],
			...overrides,
		});
	}

	it.each(['starting', 'running'] as const)(
		'keeps the final links after a %s session fails and clears them on retry',
		async (status) => {
			const failed = linkedSession({
				status: 'failed',
				links: [{ id: 'lookout', label: 'Lookout', href: 'https://lookout.example/final-job' }],
			});
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: RequestInfo | URL) =>
					jsonOk(
						String(url).endsWith('/sessions')
							? makeSession({
									mode: 'edit',
									status,
									sandbox_url: status === 'running' ? 'https://kernel.example' : undefined,
								})
							: failed,
					),
				),
			);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
				toaster: false,
			});
			await settleHook();
			await act(() => vi.advanceTimersByTimeAsync(EDITOR_HEARTBEAT_INTERVAL_MS));
			expect(result.current.session).toBeNull();
			expect(result.current.isRunning).toBe(false);
			expect(result.current.diagnosticSession).toEqual(failed);

			act(() => result.current.start());
			expect(result.current.diagnosticSession).toBeNull();
			await settleHook();
		},
	);

	it('replaces links during startup and removes them when access is revoked', async () => {
		const next = linkedSession({
			links: [{ id: 'lookout', label: 'Lookout', href: 'https://lookout.example/warm-sandbox' }],
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
				jsonOk(init?.method === 'POST' ? { ...next, links: [] } : next),
			),
		);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(SESSION_START_POLL_INTERVAL_MS));
		expect(result.current.session?.links).toEqual(next.links);

		next.status = 'running';
		next.can.attach = false;
		next.links = undefined;
		await act(() => vi.advanceTimersByTimeAsync(SESSION_START_POLL_INTERVAL_MS));
		expect(result.current.session).toBeNull();
		expect(result.current.diagnosticSession).toBeNull();
		expect(result.current.error?.code).toBe('FORBIDDEN');
	});

	it.each(['terminated', 'expired', 'missing'] as const)(
		'discards diagnostic links when the session becomes %s',
		async (outcome) => {
			const starting = linkedSession();
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
					if (init?.method === 'POST') return jsonOk(starting);
					return outcome === 'missing'
						? jsonError('NOT_FOUND', 'Session not found', 404)
						: jsonOk({ ...starting, status: outcome });
				}),
			);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
				toaster: false,
			});
			await settleHook();
			expect(result.current.session?.links).toEqual(starting.links);
			await act(() => vi.advanceTimersByTimeAsync(SESSION_START_POLL_INTERVAL_MS));
			expect(result.current.session).toBeNull();
			expect(result.current.diagnosticSession).toBeNull();
		},
	);

	it('retains the last known links after the local startup timeout', async () => {
		const starting = linkedSession({
			links: [{ id: 'logs', label: 'Logs', href: 'https://logs.example/queued' }],
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonOk(starting)),
		);
		const { result } = renderHookWithClient(
			() => useNotebookSession(PID, NID, { startupTimeoutSeconds: 1 }),
			{ toaster: false },
		);
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(33_000));
		expect(result.current.error?.code).toBe('STARTUP_TIMEOUT');
		expect(result.current.session).toBeNull();
		expect(result.current.isProvisioning).toBe(false);
		expect(result.current.sandboxUrl).toBeUndefined();
		expect(result.current.diagnosticSession?.links).toEqual(starting.links);
	});

	it.each(['stop', 'start'] as const)(
		'does not restore old links when a failure response arrives after %s',
		async (action) => {
			const pending = deferred<Response>();
			let starts = 0;
			const starting = linkedSession();
			const fresh = { ...starting, session_id: 'sess-2', links: [] };
			const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'DELETE') return jsonOk({});
				if (init?.method === 'POST') return jsonOk(++starts === 1 ? starting : fresh);
				return pending.promise;
			});
			vi.stubGlobal('fetch', fetchMock);
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
				toaster: false,
			});
			await settleHook();
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(fetchMock).toHaveBeenCalledTimes(2);
			act(() => {
				void result.current[action]();
			});
			await settleHook();
			pending.resolve(jsonOk({ ...starting, status: 'failed' }));
			await settleHook();
			expect(result.current.diagnosticSession).toBeNull();
			expect(result.current.error).toBeNull();
			expect(result.current.session).toEqual(action === 'start' ? fresh : null);
		},
	);

	it('does not restore the previous failure links when the retry request fails', async () => {
		let starts = 0;
		const starting = linkedSession();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') {
					return ++starts === 1
						? jsonOk(starting)
						: jsonError('SERVICE_UNAVAILABLE', 'Compute unavailable', 503);
				}
				return jsonOk({ ...starting, status: 'failed' });
			}),
		);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(SESSION_START_POLL_INTERVAL_MS));
		expect(result.current.diagnosticSession?.links).toEqual(starting.links);
		act(() => result.current.start());
		await settleHook();
		await act(() => vi.advanceTimersByTimeAsync(1_500));
		expect(result.current.error?.message).toBe('Compute unavailable');
		expect(result.current.session).toBeNull();
		expect(result.current.diagnosticSession).toBeNull();
	});
});

describe('retained stop recovery', () => {
	it.each(['stop', 'restart'] as const)(
		'keeps the iframe after a heartbeat overlaps %s and the user keeps running',
		async (action) => {
			const { currentStopDecision, decideStop } = await import('@/api/sessionStop');
			const pending = deferred<Response>();
			const stop = {
				id: crypto.randomUUID(),
				force: false,
				trigger: 'interactive' as const,
				requested_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				outcome: 'capturing' as const,
				runtime_state: 'paused' as const,
			};
			const retained = makeSession({
				stop: {
					...stop,
					outcome: 'retained',
					runtime_state: 'running',
					failure: { code: 'SOURCE_MISSING', retryable: false },
				},
			});
			let starts = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
					if (String(url).endsWith('/heartbeat'))
						return jsonOk(makeSession({ status: 'terminating', stop }));
					if (init?.method === 'DELETE') return pending.promise;
					if (init?.method === 'POST') {
						starts++;
						return jsonOk(makeSession());
					}
					return jsonOk(retained);
				}),
			);
			vi.useFakeTimers();
			const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), {
				toaster: false,
			});
			await settleHook();
			act(() => {
				void result.current[action]();
			});
			await act(async () => vi.advanceTimersByTimeAsync(EDITOR_HEARTBEAT_INTERVAL_MS));
			expect(result.current.session?.status).toBe('terminating');
			expect(result.current.sandboxUrl).toBe('https://sandbox.example/kernel');
			await act(async () =>
				pending.resolve(jsonError('SESSION_PERSISTENCE_REQUIRED', 'Retained', 409)),
			);
			await settleHook();
			expect(currentStopDecision()?.session.session_id).toBe('sess-1');
			act(() => decideStop('keep'));
			await settleHook();
			expect(result.current.session?.status).toBe('running');
			expect(result.current.isRunning).toBe(true);
			expect(result.current.error).toBeNull();
			expect(starts).toBe(1);
		},
	);

	it('recovers a retained stop after reload when admission is still terminating', async () => {
		const { currentStopDecision, decideStop } = await import('@/api/sessionStop');
		const retained = makeSession({
			notebook_id: NID,
			can: { attach: true, stop: true },
			stop: {
				id: crypto.randomUUID(),
				outcome: 'retained',
				force: false,
				trigger: 'interactive',
				runtime_state: 'running',
				requested_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === 'POST') return jsonError('EDIT_SESSION_RETIRING', 'Pending stop', 409);
				if (init?.method === 'DELETE')
					return jsonError('CONFLICT', 'Acknowledge prior attempt', 409);
				if (String(url).endsWith(`/projects/${PID}/sessions`)) return jsonOk({ items: [retained] });
				return jsonOk(retained);
			}),
		);
		const { result } = renderHookWithClient(() => useNotebookSession(PID, NID), { toaster: false });
		await waitFor(() => expect(currentStopDecision()?.session.session_id).toBe('sess-1'));
		act(() => decideStop('keep'));
		await waitFor(() => expect(result.current.isRunning).toBe(true));
		expect(result.current.session?.session_id).toBe('sess-1');
		expect(result.current.error).toBeNull();
	});
});
