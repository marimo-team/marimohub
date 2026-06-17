import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';
import { useStartSession, useStopSession } from '@/api/hooks';
import { useInterval } from '@/hooks/useInterval';
import type { Session } from '@/types';

/** How often a running notebook pings the heartbeat endpoint, in ms. */
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** How often to poll a still-`starting` session until it is running, in ms. */
const START_POLL_INTERVAL_MS = 2_000;

export interface NotebookSession {
	session: Session | null;
	error: string | null;
	/** Provisioning: the start request is in flight, or the kernel is booting. */
	isProvisioning: boolean;
	/** Running with a usable preview URL. */
	isRunning: boolean;
	/** The sandbox iframe URL once running, else undefined. */
	sandboxUrl: string | undefined;
	/** (Re)start the session — fired once on mount and again by the retry button. */
	start: () => void;
	/** Stop the current session (saves files, tears down the sandbox). */
	stop: () => void;
}

/**
 * Own the full runtime lifecycle of a single notebook page: start-on-mount
 * (guarded against React strict-mode double-fire), a heartbeat while running,
 * explicit stop, and retry-after-error. Leaving the page deliberately does NOT
 * stop the session — heartbeats simply cease and the server reaps it on TTL — so
 * re-opening the notebook resumes the live kernel. Extracted from NotebookPage so
 * the component stays presentational and the lifecycle is reusable/inspectable.
 *
 * `enabled: false` holds the auto-start (and everything downstream) — the
 * viewer-mode branch: a viewer must not fire a doomed (static mode) or
 * premature (capabilities still loading) session request. The start fires once,
 * on the first render where `enabled` is true.
 */
export function useNotebookSession(
	projectId: string,
	notebookId: string,
	{ enabled = true }: { enabled?: boolean } = {},
): NotebookSession {
	const startSession = useStartSession(projectId, notebookId);
	const stopSession = useStopSession(projectId, notebookId);

	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sessionRef = useRef<Session | null>(null);
	const startedRef = useRef(false);

	const start = useCallback(() => {
		setError(null);
		startSession.mutate(undefined, {
			onSuccess: (data) => {
				setSession(data);
				sessionRef.current = data;
			},
			onError: (err) => {
				setError(err.message);
			},
		});
	}, [startSession]);

	const stop = useCallback(() => {
		const s = sessionRef.current;
		if (s) {
			stopSession.mutate(s.session_id);
			sessionRef.current = null;
			setSession(null);
		}
	}, [stopSession]);

	// Start once, on the first enabled render (guarded so strict-mode's
	// double-invoke doesn't provision two sandboxes).
	useEffect(() => {
		if (!enabled || startedRef.current) return;
		startedRef.current = true;
		start();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled]);

	// A start that reuses an in-flight `starting` session (a concurrent refresh was
	// already provisioning) returns before the kernel is up. Poll until it is
	// `running` (connect) or terminal (surface an error). Normal starts return
	// `running` directly, so the interval is paused (`null`) and never runs.
	useInterval(
		() => {
			if (session?.status !== 'starting') return;
			const sid = session.session_id;
			apiFetch<Session>(`/api/v1/projects/${projectId}/notebooks/${notebookId}/sessions/${sid}`)
				.then((next) => {
					if (next.status === 'running') {
						setSession(next);
						sessionRef.current = next;
					} else if (next.status !== 'starting' && next.status !== 'terminating') {
						setError('The kernel failed to start.');
						setSession(null);
						sessionRef.current = null;
					}
				})
				.catch(() => {}); // transient; the next tick retries
		},
		session?.status === 'starting' ? START_POLL_INTERVAL_MS : null,
	);

	// Heartbeat while running so the server's TTL reaper keeps the kernel alive.
	// Fire-and-forget: a missed heartbeat is non-fatal (the server reaps on TTL), so
	// swallow errors. Routed through apiFetch for a request timeout so a hung ping
	// can't pile up across intervals.
	useInterval(
		() => {
			if (session?.status !== 'running') return;
			apiFetch(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/sessions/${session.session_id}/heartbeat`,
				{ method: 'POST' },
			).catch(() => {});
		},
		session?.status === 'running' ? HEARTBEAT_INTERVAL_MS : null,
	);

	const isProvisioning = startSession.isPending || session?.status === 'starting';
	const isRunning = session?.status === 'running' && !!session.sandbox_url;

	return {
		session,
		error,
		isProvisioning,
		isRunning,
		sandboxUrl: isRunning ? session?.sandbox_url : undefined,
		start,
		stop,
	};
}
