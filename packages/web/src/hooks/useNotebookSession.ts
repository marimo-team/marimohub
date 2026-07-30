import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, apiData, ApiRequestError } from '@/api/client';
import { useStartSession, useStartSessionWithDefault, useStopSession } from '@/api/hooks';
import { isNotFoundError } from '@/api/request';
import { useGeneration } from '@/hooks/useGeneration';
import { useInterval } from '@/hooks/useInterval';
import type { Session } from '@/types';

/** How often a running notebook pings the heartbeat endpoint, in ms. */
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** How often to poll a still-`starting` session until it is running, in ms. */
const START_POLL_INTERVAL_MS = 2_000;

/**
 * How often a running APP page re-checks its session, in ms. The shared app can
 * be stopped by any editor (or expire) underneath an open page; this poll is
 * what flips the page to its terminal "App stopped" state instead of leaving a
 * dead iframe. Edit pages don't poll — an editor's own kernel dying surfaces in
 * the iframe itself.
 */
const RUN_WATCH_INTERVAL_MS = 10_000;

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
export type SessionEnded = Session['status'] | 'gone' | 'access_lost';

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
	 * App pages only: the session ended underneath the page (stopped by another
	 * editor, expired, failed). Carries the last-seen terminal status —
	 * `'gone'` when the record had already been reaped, `'access_lost'` when the
	 * app runs on without this caller. Render the terminal panel, never an error
	 * toast loop.
	 */
	ended: SessionEnded | null;
	/** (Re)start the session — fired once on mount and again by the retry button. */
	start: () => void;
	startWithDefault: () => void;
	defaultRetryAttempted: boolean;
	/** Stop the current session (saves files, tears down the sandbox). */
	stop: () => void;
	/** Stop (if live) then start fresh — the staleness banner's "Restart app". */
	restart: () => void;
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
 *
 * `mode: 'app'` drives the app page: the create request starts (or attaches to)
 * the notebook's shared app singleton, and a watch poll surfaces the session
 * ending underneath the page (see `ended`).
 */
export function useNotebookSession(
	projectId: string,
	notebookId: string,
	{ enabled = true, mode = 'edit' }: { enabled?: boolean; mode?: 'edit' | 'app' } = {},
): NotebookSession {
	const startSession = useStartSession(projectId, notebookId, mode);
	const startDefaultSession = useStartSessionWithDefault(projectId, notebookId, mode);
	const stopSession = useStopSession(projectId, notebookId);

	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<SessionError | null>(null);
	const [ended, setEnded] = useState<SessionEnded | null>(null);
	const [defaultRetryAttempted, setDefaultRetryAttempted] = useState(false);
	// StrictMode can orphan the mutation observer during its mount/remount cycle,
	// leaving `startSession.isPending` stuck. Track this request independently.
	const [starting, setStarting] = useState(false);
	// True while a restart's stop half runs (which can take tens of seconds for a
	// real save-and-destroy) — the page would otherwise render nothing: no
	// session, no error, and neither mutation pending yet.
	const [restarting, setRestarting] = useState(false);
	const sessionRef = useRef<Session | null>(null);
	const startedRef = useRef(false);
	// Bumped by every start/stop/restart: a poll issued before one still lands
	// afterwards, re-arming the dying session or failing the fresh one.
	const generation = useGeneration();

	// The state and the ref must move together: the ref is what handlers entered
	// under an older render read, so a `setSession` without it re-arms a session
	// the user has already left behind.
	const commitSession = useCallback((next: Session | null) => {
		sessionRef.current = next;
		setSession(next);
	}, []);

	// The server withholds `sandbox_url` from a caller who may no longer reach the
	// kernel, so a `running` session without one means access was revoked. That
	// shape satisfies neither `isRunning` nor `isProvisioning` — keeping it would
	// leave the page rendering nothing at all.
	const concludeAccessLost = useCallback(() => {
		commitSession(null);
		if (mode === 'app') setEnded('access_lost');
		else
			setError({
				message: 'You no longer have access to this session.',
				code: 'FORBIDDEN',
				kind: 'access',
			});
	}, [mode, commitSession]);

	const startWithMutation = useCallback(
		(mutation: typeof startSession) => {
			const gen = generation.bump();
			setError(null);
			setEnded(null);
			setStarting(true);
			void mutation.mutateAsync().then(
				(data) => {
					if (!generation.isCurrent(gen)) return;
					setStarting(false);
					if (data.status === 'running' && !data.sandbox_url) {
						concludeAccessLost();
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
		[concludeAccessLost, commitSession, generation],
	);
	const start = useCallback(() => {
		startWithMutation(startSession);
	}, [startWithMutation, startSession]);
	const startWithDefault = useCallback(() => {
		setDefaultRetryAttempted(true);
		startWithMutation(startDefaultSession);
	}, [startWithMutation, startDefaultSession]);

	const stop = useCallback(() => {
		const s = sessionRef.current;
		if (s) {
			generation.bump();
			setStarting(false);
			stopSession.mutate(s.session_id);
			commitSession(null);
		}
	}, [stopSession, commitSession, generation]);

	const restart = useCallback(() => {
		const s = sessionRef.current;
		const gen = generation.bump();
		setError(null);
		setEnded(null);
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled]);

	const startFailedMessage =
		mode === 'app' ? 'The app failed to start.' : 'The kernel failed to start.';

	const failStart = useCallback(
		(failure?: Session['error'], code?: string) => {
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
		[startFailedMessage, commitSession],
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
			pollSession(
				session.session_id,
				(next) => {
					if (next.status === 'running' && !next.sandbox_url) {
						concludeAccessLost();
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

	// The watched session ended — but someone else's restart terminates THIS
	// session id while a fresh app is already serving. Adopt the replacement
	// instead of asserting "App stopped" under a running app. Read-only on
	// purpose: a create here would auto-start a stopped app.
	const adoptReplacementOr = useCallback(
		(fallback: Session['status'] | 'gone') => {
			// Re-taken here: this runs a second async hop, and the caller's guard
			// says nothing about a start/stop/restart landing during THIS request.
			const gen = generation.current();
			const conclude = (next: Session | undefined) => {
				if (!generation.isCurrent(gen)) return;
				commitSession(next ?? null);
				if (!next) setEnded(fallback);
			};
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/sessions', {
					params: { path: { pid: projectId } },
				}),
			)
				.then((page) =>
					conclude(
						page.items.find(
							(s) =>
								s.notebook_id === notebookId &&
								s.mode === 'app' &&
								// A running app this caller cannot reach (no `sandbox_url`) is
								// no more adoptable than a stopped one.
								(s.status === 'starting' || (s.status === 'running' && !!s.sandbox_url)),
						),
					),
				)
				.catch(() => conclude(undefined));
		},
		[projectId, notebookId, commitSession, generation],
	);

	// App pages: watch the running session so a stop by another editor, a
	// lifetime expiry, or a kernel failure lands on the terminal panel (via the
	// replacement check above). A 404 (record already reaped, or the notebook
	// deleted) is `gone`, not an error.
	useInterval(
		() => {
			const sid = session?.session_id;
			if (!sid) return;
			pollSession(
				sid,
				(next) => {
					if (next.status === 'running' && !next.sandbox_url) {
						// The app runs on — this caller just lost their seat, so adopting a
						// "replacement" would only find the same unreachable session.
						concludeAccessLost();
					} else if (next.status === 'running') {
						// Keep connection-count/staleness fields fresh for the banner.
						commitSession(next);
					} else if (next.status !== 'starting') {
						adoptReplacementOr(next.status);
					}
				},
				() => adoptReplacementOr('gone'),
			);
		},
		mode === 'app' && session?.status === 'running' ? RUN_WATCH_INTERVAL_MS : null,
	);

	// Heartbeats are best-effort; the server's TTL handles missed requests.
	useInterval(
		() => {
			if (session?.status !== 'running') return;
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/heartbeat', {
					params: {
						path: {
							pid: projectId,
							nid: notebookId,
							sid: session.session_id,
						},
					},
				}),
			).catch(() => {});
		},
		session?.status === 'running' ? HEARTBEAT_INTERVAL_MS : null,
	);

	const isProvisioning = restarting || starting || session?.status === 'starting';
	const isRunning = session?.status === 'running' && !!session.sandbox_url;

	return {
		session,
		error,
		isProvisioning,
		isRunning,
		sandboxUrl: isRunning ? session?.sandbox_url : undefined,
		ended,
		start,
		startWithDefault,
		defaultRetryAttempted,
		stop,
		restart,
	};
}
