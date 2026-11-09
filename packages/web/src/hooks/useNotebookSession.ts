import { useSandboxPreconnect } from './useSandboxPreconnect';
import { leaveAppVisit } from '@/api/sessionVisits';
import { MAX_TIMER_DELAY_MS } from '@marimo-hub/core/async';
import { APP_HEARTBEAT_INTERVAL_MS } from '@marimo-hub/core/constants';
import { sleep } from '@marimo-hub/core/duration';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { apiClient, apiData, ApiRequestError } from '@/api/client';
import {
	useRestartApp,
	useStartSession,
	useStartSessionWithDefault,
	useStopSession,
} from '@/api/hooks';
import { isNotFoundError } from '@/api/request';
import { useGeneration } from '@/hooks/useGeneration';
import { useInterval } from '@/hooks/useInterval';
import type { Session } from '@/types';
import {
	EDITOR_HEARTBEAT_INTERVAL_MS,
	SESSION_STATUS_INTERVAL_MS,
	sessionStartPollDelayMs,
	sessionStartupDeadlineMs,
} from '@/lib/sessions';

const DEFAULT_APP_HEARTBEAT_INTERVAL_SECONDS = APP_HEARTBEAT_INTERVAL_MS / 1000;

/** Startup-timeout fallback when capabilities are unavailable (server default). */
const DEFAULT_STARTUP_TIMEOUT_S = 120;

export interface SessionError {
	message: string;
	/** The API error code (e.g. `FORBIDDEN`), when the failure was an API error. */
	code?: string;
	kind: 'request' | 'startup' | 'access';
	generic?: boolean;
}

function toSessionError(err: Error): SessionError {
	return {
		message: err.message,
		code: err instanceof ApiRequestError ? err.code : undefined,
		kind: 'request',
	};
}

/** Why a watched session stopped being renderable — see `ended` below. */
export type SessionEnded = Session['status'] | 'gone' | 'access_lost' | 'takeover';

export interface NotebookSession {
	session: Session | null;
	diagnosticSession: Session | null;
	error: SessionError | null;
	/** Provisioning: the start request is in flight, or the kernel is booting. */
	isProvisioning: boolean;
	/** Running with a usable preview URL. */
	isRunning: boolean;
	/** The sandbox iframe URL once running, else undefined. */
	sandboxUrl: string | undefined;
	/**
	 * The session ended underneath the page (stopped, taken over, expired, or
	 * failed). Carries the last-seen terminal status —
	 * `'gone'` when the record had already been reaped, `'access_lost'` when the
	 * app runs on without this caller. Render the terminal panel, never an error
	 * toast loop.
	 */
	ended: SessionEnded | null;
	endedByUserId: string | null;
	/** (Re)start the session — fired once on mount and again by the retry button. */
	start: () => void;
	startPersistent: () => void;
	startWithDefault: () => void;
	defaultRetryAttempted: boolean;
	/** Stop the current session (saves files, tears down the sandbox). */
	stop: () => void;
	/** Replace the selected app sandbox or restart the editor, then re-enter through admission. */
	restart: () => void;
}

/** Synchronize a notebook page with session startup, presence, and termination. */
export function useNotebookSession(
	projectId: string,
	notebookId: string,
	{
		enabled = true,
		mode = 'edit',
		editIntent,
		startupTimeoutSeconds,
		appHeartbeatIntervalSeconds = DEFAULT_APP_HEARTBEAT_INTERVAL_SECONDS,
	}: {
		enabled?: boolean;
		mode?: 'edit' | 'app';
		editIntent?: 'temporary';
		/** Fail startup after this deployment timeout plus the grace in `sessionStartupDeadlineMs`. */
		startupTimeoutSeconds?: number;
		appHeartbeatIntervalSeconds?: number;
	} = {},
): NotebookSession {
	const startSession = useStartSession(projectId, notebookId, mode, editIntent);
	const startPersistentSession = useStartSession(projectId, notebookId, mode);
	const startDefaultSession = useStartSessionWithDefault(projectId, notebookId, mode, editIntent);
	// Stop/restart failures render inline (session panel), never as a toast.
	const stopSession = useStopSession(projectId, notebookId, { suppressErrorToast: true });
	const restartApp = useRestartApp(projectId, notebookId, { suppressErrorToast: true });

	const [session, setSession] = useState<Session | null>(null);
	useSandboxPreconnect(session?.sandbox_url);
	const [diagnosticSession, setDiagnosticSession] = useState<Session | null>(null);
	const [error, setError] = useState<SessionError | null>(null);
	const [ended, setEnded] = useState<SessionEnded | null>(null);
	const [endedByUserId, setEndedByUserId] = useState<string | null>(null);
	const [defaultRetryAttempted, setDefaultRetryAttempted] = useState(false);
	// StrictMode can orphan the mutation observer during its mount/remount cycle,
	// leaving `startSession.isPending` stuck. Track this request independently.
	const [starting, setStarting] = useState(false);
	// Keep the loading panel visible while teardown or replacement precedes admission.
	const [restarting, setRestarting] = useState(false);
	const sessionRef = useRef<Session | null>(null);
	const mountedRef = useRef(true);
	const startedRef = useRef(false);
	// Bumped by every start/stop/restart: a poll issued before one still lands
	// afterwards, re-arming the dying session or failing the fresh one.
	const generation = useGeneration();
	// When this client began watching a still-`starting` session (client clock, so
	// server/client skew can't fail a fresh start). Null while nothing is starting.
	const startingSinceRef = useRef<number | null>(null);

	// The state and the ref must move together: the ref is what handlers entered
	// under an older render read, so a `setSession` without it re-arms a session
	// the user has already left behind.
	const commitSession = useCallback((next: Session | null) => {
		setDiagnosticSession(null);
		// Polls for the same startup must not reset its timeout.
		if (next?.status !== 'starting') {
			startingSinceRef.current = null;
		} else if (
			startingSinceRef.current === null ||
			sessionRef.current?.session_id !== next.session_id
		) {
			startingSinceRef.current = Date.now();
		}
		const committed =
			next && next.session_id === sessionRef.current?.session_id && !next.app_assignment
				? { ...next, app_assignment: sessionRef.current.app_assignment }
				: next;
		sessionRef.current = committed;
		setSession(committed);
	}, []);

	// A missing URL can mean revoked access or an expired pool assignment.
	const concludeAccessLost = useCallback(
		(admitted = false) => {
			generation.bump();
			commitSession(null);
			if (mode === 'app') setEnded(admitted ? 'expired' : 'access_lost');
			else
				setError({
					message: 'You no longer have access to this session.',
					code: 'FORBIDDEN',
					kind: 'access',
				});
		},
		[mode, commitSession, generation],
	);

	const startWithMutation = useCallback(
		(mutation: typeof startSession) => {
			setDiagnosticSession(null);
			const gen = generation.bump();
			setError(null);
			setEnded(null);
			setEndedByUserId(null);
			setStarting(true);
			// Separate attempts need separate visits so late cleanup cannot release the winner.
			void mutation.mutateAsync(mode === 'app' ? crypto.randomUUID() : undefined).then(
				(data) => {
					if (!mountedRef.current || !generation.isCurrent(gen)) {
						leaveAppVisit(projectId, notebookId, data);
						return;
					}
					setStarting(false);
					if (data.status === 'running' && !data.sandbox_url) {
						concludeAccessLost(data.can?.attach ?? false);
						return;
					}
					commitSession(data);
				},
				(err) => {
					if (!generation.isCurrent(gen)) return;
					setStarting(false);
					setError(toSessionError(err));
				},
			);
		},
		[concludeAccessLost, commitSession, generation, projectId, notebookId, mode],
	);
	const start = useCallback(() => {
		startWithMutation(startSession);
	}, [startWithMutation, startSession]);
	const startPersistent = useCallback(() => {
		startedRef.current = true;
		startWithMutation(startPersistentSession);
	}, [startWithMutation, startPersistentSession]);
	const startWithDefault = useCallback(() => {
		setDefaultRetryAttempted(true);
		startWithMutation(startDefaultSession);
	}, [startWithMutation, startDefaultSession]);

	const stop = useCallback(() => {
		const s = sessionRef.current;
		if (s) {
			const gen = generation.bump();
			setStarting(false);
			// The global toast is suppressed for this mutation, so a failed stop must
			// surface inline — otherwise the page shows no session AND no error.
			stopSession.mutate(s.session_id, {
				onError: (err) => {
					if (!generation.isCurrent(gen)) return;
					// Already gone (stopped/reaped underneath us): the stop succeeded in effect.
					if (isNotFoundError(err)) return;
					setError(toSessionError(err));
				},
			});
			commitSession(null);
		}
	}, [stopSession, commitSession, generation]);

	const restart = useCallback(() => {
		const s = sessionRef.current;
		const gen = generation.bump();
		setError(null);
		setEnded(null);
		setEndedByUserId(null);
		if (s) {
			commitSession(null);
			setRestarting(true);
			const mutation = mode === 'app' ? restartApp : stopSession;
			mutation.mutate(s.session_id, {
				onSuccess: () => {
					if (!mountedRef.current || !generation.isCurrent(gen)) return;
					setRestarting(false);
					start();
				},
				onError: (err) => {
					if (!mountedRef.current || !generation.isCurrent(gen)) return;
					setRestarting(false);
					// Already gone (stopped/reaped underneath us): the restart intent
					// still holds, so start fresh.
					if (mode !== 'app' && isNotFoundError(err)) {
						start();
						return;
					}
					setError(toSessionError(err));
				},
			});
		} else {
			start();
		}
	}, [stopSession, restartApp, mode, start, commitSession, generation]);

	// Start once, on the first enabled render (guarded so strict-mode's
	// double-invoke doesn't provision two sandboxes).
	useEffect(() => {
		if (!enabled || startedRef.current) return;
		startedRef.current = true;
		start();
	}, [enabled, start]);

	const startFailedMessage =
		mode === 'app' ? 'The app failed to start.' : 'The kernel failed to start.';

	const failStart = useCallback(
		(failure?: Session['error'], code?: string, failedSession?: Session) => {
			// Terminal: invalidate in-flight polls so a late `running` response
			// cannot resurrect the session after the failure is shown.
			generation.bump();
			setError(
				failure
					? { message: failure.message, code: failure.code, kind: 'startup' }
					: {
							message: startFailedMessage,
							...(code ? { code } : {}),
							kind: 'startup',
							generic: true,
						},
			);
			commitSession(null);
			setDiagnosticSession(failedSession ?? null);
		},
		[startFailedMessage, commitSession, generation],
	);

	// Ignore stale responses. Retry request failures except 404 on the next tick.
	// The promise settles once the response has been handled and never rejects.
	const pollSession = useCallback(
		(
			sessionId: string,
			onNext: (next: Session) => void,
			onGone: () => void,
			isLive: () => boolean = () => true,
		): Promise<void> => {
			const gen = generation.current();
			const current = () => generation.isCurrent(gen) && isLive();
			return apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
					params: {
						path: { pid: projectId, nid: notebookId, sid: sessionId },
					},
				}),
			)
				.then((next) => {
					if (current()) onNext(next);
				})
				.catch((err: unknown) => {
					if (current() && isNotFoundError(err)) onGone();
				});
		},
		[projectId, notebookId, generation],
	);

	// A lost provisioning request can leave the record starting indefinitely. Returns the
	// ms left before the deadline, or null once startup is over or has been failed.
	const enforceStartupDeadline = useEffectEvent((): number | null => {
		// These timers can fire after a commit but before its re-render, so read the ref.
		const session = sessionRef.current;
		if (session?.status !== 'starting' || startingSinceRef.current === null) return null;
		// Match the server's timeout message, which excludes the grace period.
		const timeoutSeconds = startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_S;
		const remaining =
			sessionStartupDeadlineMs(timeoutSeconds) - (Date.now() - startingSinceRef.current);
		if (remaining >= 0) return remaining;
		failStart(
			{
				code: 'STARTUP_TIMEOUT',
				message: `${mode === 'app' ? 'The app' : 'The kernel'} did not start within ${timeoutSeconds}s.`,
			},
			undefined,
			session,
		);
		return null;
	});

	// Reused sessions can return before provisioning finishes, so watch them until ready.
	const pollStartingSession = useEffectEvent(
		(sessionId: string, isLive: () => boolean): Promise<void> => {
			const current = sessionRef.current;
			if (current?.session_id !== sessionId || current.status !== 'starting')
				return Promise.resolve();
			return pollSession(
				sessionId,
				(next) => {
					if (next.status === 'running' && !next.sandbox_url) {
						concludeAccessLost(next.can?.attach ?? false);
					} else if (next.status === 'running' || next.status === 'starting') {
						commitSession(next);
					} else if (next.status !== 'terminating') {
						failStart(next.error, undefined, next.status === 'failed' ? next : undefined);
					}
				},
				// The record vanished mid-start (reaped, or the notebook deleted).
				() => failStart(undefined, 'NOT_FOUND'),
				isLive,
			);
		},
	);
	const startingSessionId = session?.status === 'starting' ? session.session_id : null;
	useEffect(() => {
		if (startingSessionId === null) return;
		const controller = new AbortController();
		const { signal } = controller;
		// Drops responses after cleanup too, e.g. once an app heartbeat reports `running`.
		const isLive = () => !signal.aborted;
		const pause = (ms: number) =>
			sleep(ms, signal).catch((error: unknown) => {
				if (isLive()) throw error;
			});
		// Each delay starts when the previous response is handled: overlapping polls can
		// answer out of order, and a late `starting` would undo a newer `running`.
		const pollWhileStarting = async () => {
			for (let attempt = 0; ; attempt += 1) {
				const since = startingSinceRef.current;
				await pause(sessionStartPollDelayMs(attempt, since === null ? 0 : Date.now() - since));
				if (!isLive()) return;
				await pollStartingSession(startingSessionId, isLive);
			}
		};
		// Timed separately from polling so a hung poll cannot postpone the deadline.
		// Re-armed rather than set once because the timeout can change while starting.
		const watchDeadline = async () => {
			for (let wait = 0; ; ) {
				await pause(wait);
				if (!isLive()) return;
				const remaining = enforceStartupDeadline();
				if (remaining === null) return;
				// sleep() rejects fractional or over-long delays, which a capability timeout can produce.
				wait = Math.min(Math.ceil(remaining) + 1, MAX_TIMER_DELAY_MS);
			}
		};
		void pollWhileStarting();
		void watchDeadline();
		return () => controller.abort();
	}, [startingSessionId]);

	const concludeSession = useCallback(
		(status: SessionEnded, endedBy: string | null = null) => {
			generation.bump();
			commitSession(null);
			setEnded(status);
			setEndedByUserId(endedBy);
		},
		[commitSession, generation],
	);

	const updateRunningSession = useCallback(
		(next: Session) => {
			if (next.status === 'running') {
				if (next.sandbox_url) commitSession(next);
				else concludeAccessLost(next.can?.attach ?? false);
			} else if (next.status !== 'starting') {
				concludeSession(
					next.ended_reason === 'takeover' ? 'takeover' : next.status,
					next.ended_by_user_id ?? null,
				);
				if (next.status === 'failed') setDiagnosticSession(next);
			}
		},
		[commitSession, concludeAccessLost, concludeSession],
	);

	useInterval(
		() => {
			const sid = session?.session_id;
			if (!sid) return;
			void pollSession(sid, updateRunningSession, () => concludeSession('gone'));
		},
		mode !== 'app' && session?.status === 'running' ? SESSION_STATUS_INTERVAL_MS : null,
	);

	const heartbeatActive =
		session?.status === 'running' || (mode === 'app' && session?.status === 'starting');

	// App heartbeats also return status, avoiding a separate running-session poll.
	useInterval(
		() => {
			if (!session || !heartbeatActive) return;
			const gen = generation.current();
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat', {
					...(mode === 'app' && session.app_assignment ? { body: session.app_assignment } : {}),
					params: {
						path: {
							pid: projectId,
							nid: notebookId,
							sid: session.session_id,
						},
					},
				}),
			)
				.then((next) => {
					if (mode === 'app' && generation.isCurrent(gen)) updateRunningSession(next);
				})
				.catch((error: unknown) => {
					if (mode !== 'app' || !generation.isCurrent(gen)) return;
					if (isNotFoundError(error)) concludeSession('gone');
					else if (error instanceof ApiRequestError) {
						if (error.status === 409) concludeSession('expired');
						else if (error.status === 403) concludeAccessLost();
					}
				});
		},
		heartbeatActive
			? mode === 'app'
				? appHeartbeatIntervalSeconds * 1000
				: EDITOR_HEARTBEAT_INTERVAL_MS
			: null,
	);

	useEffect(() => {
		mountedRef.current = true;
		const leave = () => {
			if (mode === 'app') leaveAppVisit(projectId, notebookId, sessionRef.current);
		};
		const onPageHide = (event: PageTransitionEvent) => {
			if (!event.persisted) leave();
		};
		window.addEventListener('pagehide', onPageHide);
		return () => {
			mountedRef.current = false;
			window.removeEventListener('pagehide', onPageHide);
			leave();
		};
	}, [mode, projectId, notebookId]);

	const isProvisioning = restarting || starting || session?.status === 'starting';
	const isRunning = session?.status === 'running' && !!session.sandbox_url;

	return {
		session,
		diagnosticSession,
		error,
		isProvisioning,
		isRunning,
		sandboxUrl: isRunning ? session?.sandbox_url : undefined,
		ended,
		endedByUserId,
		start,
		startPersistent,
		startWithDefault,
		defaultRetryAttempted,
		stop,
		restart,
	};
}
