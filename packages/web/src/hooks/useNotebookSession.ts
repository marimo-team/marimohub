import { APP_HEARTBEAT_INTERVAL_MS } from '@marimo-hub/core/constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, apiData, ApiRequestError } from '@/api/client';
import { useStartSession, useStartSessionWithDefault, useStopSession } from '@/api/hooks';
import { isNotFoundError } from '@/api/request';
import { useGeneration } from '@/hooks/useGeneration';
import { useInterval } from '@/hooks/useInterval';
import type { Session } from '@/types';

/** How often a running notebook pings the heartbeat endpoint, in ms. */
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_APP_HEARTBEAT_INTERVAL_SECONDS = APP_HEARTBEAT_INTERVAL_MS / 1000;

/** How often to poll a still-`starting` session until it is running, in ms. */
const START_POLL_INTERVAL_MS = 2_000;

/** Startup-timeout fallback when capabilities are unavailable (server default). */
const DEFAULT_STARTUP_TIMEOUT_S = 120;

/**
 * Slack past the server's startup timeout before the client fails a
 * still-`starting` session itself. The server enforces the timeout on the
 * kernel wait and returns a richer error, so this only catches a start nothing
 * else concludes (e.g. the provisioning replica died mid-start).
 */
const STARTUP_TIMEOUT_GRACE_MS = 30_000;

/** Editor takeovers need status checks more often than editor heartbeats. */
const RUN_WATCH_INTERVAL_MS = 30_000;

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

function leaveAppVisit(projectId: string, notebookId: string, session: Session | null) {
	if (!session?.app_assignment) return;
	void apiClient
		.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/leave', {
			params: { path: { pid: projectId, nid: notebookId, sid: session.session_id } },
			body: session.app_assignment,
			keepalive: true,
		})
		.catch(() => {});
}

/** Why a watched session stopped being renderable — see `ended` below. */
export type SessionEnded = Session['status'] | 'gone' | 'access_lost' | 'takeover';

export interface NotebookSession {
	session: Session | null;
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
	/** Stop the selected session, then re-enter through admission. */
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
		/**
		 * The deployment's sandbox-startup timeout
		 * (`capabilities.sandbox_startup_timeout_seconds`); a still-`starting`
		 * session older than this (plus grace) is failed instead of polled forever.
		 */
		startupTimeoutSeconds?: number;
		appHeartbeatIntervalSeconds?: number;
	} = {},
): NotebookSession {
	const [appVisitId] = useState(() => crypto.randomUUID());
	const startSession = useStartSession(projectId, notebookId, mode, editIntent, appVisitId);
	const startPersistentSession = useStartSession(
		projectId,
		notebookId,
		mode,
		undefined,
		appVisitId,
	);
	const startDefaultSession = useStartSessionWithDefault(
		projectId,
		notebookId,
		mode,
		editIntent,
		appVisitId,
	);
	// Stop/restart failures render inline (session panel), never as a toast.
	const stopSession = useStopSession(projectId, notebookId, { suppressErrorToast: true });

	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<SessionError | null>(null);
	const [ended, setEnded] = useState<SessionEnded | null>(null);
	const [endedByUserId, setEndedByUserId] = useState<string | null>(null);
	const [defaultRetryAttempted, setDefaultRetryAttempted] = useState(false);
	// StrictMode can orphan the mutation observer during its mount/remount cycle,
	// leaving `startSession.isPending` stuck. Track this request independently.
	const [starting, setStarting] = useState(false);
	// True while a restart's stop half runs (which can take tens of seconds for a
	// real save-and-destroy) — the page would otherwise render nothing: no
	// session, no error, and neither mutation pending yet.
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
			const gen = generation.bump();
			setError(null);
			setEnded(null);
			setEndedByUserId(null);
			setStarting(true);
			void mutation.mutateAsync().then(
				(data) => {
					if (!mountedRef.current) {
						leaveAppVisit(projectId, notebookId, data);
						return;
					}
					if (!generation.isCurrent(gen)) return;
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
		[concludeAccessLost, commitSession, generation, projectId, notebookId],
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
			// Await the stop before starting: the create must not attach to the
			// still-terminating sandbox it is meant to replace. A failed stop must
			// NOT silently fall through to start() — the create would re-attach to
			// the very session the restart meant to replace, reading as a restart
			// that did nothing.
			stopSession.mutate(s.session_id, {
				onSuccess: () => {
					if (!generation.isCurrent(gen)) return;
					setRestarting(false);
					start();
				},
				onError: (err) => {
					if (!generation.isCurrent(gen)) return;
					setRestarting(false);
					// Already gone (stopped/reaped underneath us): the restart intent
					// still holds, so start fresh.
					if (isNotFoundError(err)) {
						start();
						return;
					}
					setError(toSessionError(err));
				},
			});
		} else {
			start();
		}
	}, [stopSession, start, commitSession, generation]);

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
		(failure?: Session['error'], code?: string) => {
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
		},
		[startFailedMessage, commitSession, generation],
	);

	/**
	 * Re-read the watched session under a staleness guard. A 404 means the record
	 * is gone — a terminal answer, so it gets its own branch; every other failure
	 * is transient and the next tick retries.
	 */
	const pollSession = useCallback(
		(sessionId: string, onNext: (next: Session) => void, onGone: () => void) => {
			const gen = generation.current();
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
					params: {
						path: { pid: projectId, nid: notebookId, sid: sessionId },
					},
				}),
			)
				.then((next) => {
					if (generation.isCurrent(gen)) onNext(next);
				})
				.catch((err: unknown) => {
					if (generation.isCurrent(gen) && isNotFoundError(err)) onGone();
				});
		},
		[projectId, notebookId, generation],
	);

	// A start that reuses an in-flight `starting` session (a concurrent refresh was
	// already provisioning) returns before the kernel is up. Poll until it is
	// `running` (connect) or terminal (surface an error). Normal starts return
	// `running` directly, so the interval is paused (`null`) and never runs.
	useInterval(
		() => {
			if (session?.status !== 'starting') return;
			// Watched longer than the deployment's startup timeout (plus grace) means
			// whichever request was provisioning has died without failing the record —
			// give up instead of polling forever. The message names the CONFIGURED
			// timeout, matching the server's own timeout error; the grace is an
			// implementation detail.
			const timeoutSeconds = startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_S;
			const deadlineMs = timeoutSeconds * 1000 + STARTUP_TIMEOUT_GRACE_MS;
			if (startingSinceRef.current !== null && Date.now() - startingSinceRef.current > deadlineMs) {
				failStart({
					code: 'STARTUP_TIMEOUT',
					message: `${mode === 'app' ? 'The app' : 'The kernel'} did not start within ${timeoutSeconds}s.`,
				});
				return;
			}
			pollSession(
				session.session_id,
				(next) => {
					if (next.status === 'running' && !next.sandbox_url) {
						concludeAccessLost(next.can?.attach ?? false);
					} else if (next.status === 'running') {
						commitSession(next);
					} else if (next.status !== 'starting' && next.status !== 'terminating') {
						failStart(next.error);
					}
				},
				// The record vanished mid-start (reaped, or the notebook deleted).
				() => failStart(undefined, 'NOT_FOUND'),
			);
		},
		session?.status === 'starting' ? START_POLL_INTERVAL_MS : null,
	);

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
			}
		},
		[commitSession, concludeAccessLost, concludeSession],
	);

	useInterval(
		() => {
			const sid = session?.session_id;
			if (!sid) return;
			pollSession(sid, updateRunningSession, () => concludeSession('gone'));
		},
		mode !== 'app' && session?.status === 'running' ? RUN_WATCH_INTERVAL_MS : null,
	);

	// App heartbeats also return status, avoiding a separate running-session poll.
	useInterval(
		() => {
			if (
				!session ||
				(session.status !== 'running' && !(mode === 'app' && session.status === 'starting'))
			)
				return;
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
					if (mode !== 'app' || !generation.isCurrent(gen) || session.status !== 'running') return;
					updateRunningSession(next);
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
		session && (session.status === 'running' || (mode === 'app' && session.status === 'starting'))
			? mode === 'app'
				? appHeartbeatIntervalSeconds * 1000
				: HEARTBEAT_INTERVAL_MS
			: null,
	);

	useEffect(() => {
		mountedRef.current = true;
		const leave = () => {
			if (mode === 'app') leaveAppVisit(projectId, notebookId, sessionRef.current);
		};
		window.addEventListener('pagehide', leave);
		return () => {
			mountedRef.current = false;
			window.removeEventListener('pagehide', leave);
			leave();
		};
	}, [mode, projectId, notebookId]);

	const isProvisioning = restarting || starting || session?.status === 'starting';
	const isRunning = session?.status === 'running' && !!session.sandbox_url;

	return {
		session,
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
