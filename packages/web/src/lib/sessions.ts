import type { Session } from '@/types';

export const EDITOR_HEARTBEAT_INTERVAL_MS = 120_000;
export const SESSION_STATUS_INTERVAL_MS = 30_000;
export const SESSION_START_POLL_INTERVAL_MS = 2_000;
export const SESSION_START_SLOW_POLL_AFTER_MS = 30_000;
export const SESSION_START_SLOW_POLL_INTERVAL_MS = 5_000;
const SESSION_START_POLL_BACKOFF_MS = [0, 250, 500, 1_000] as const;

/** Delay before 0-based startup poll `attempt` of a session `starting` for `elapsedMs`. */
export function sessionStartPollDelayMs(attempt: number, elapsedMs: number): number {
	if (elapsedMs > SESSION_START_SLOW_POLL_AFTER_MS) return SESSION_START_SLOW_POLL_INTERVAL_MS;
	return SESSION_START_POLL_BACKOFF_MS[attempt] ?? SESSION_START_POLL_INTERVAL_MS;
}

export function sessionStartupDeadlineMs(timeoutSeconds = 120): number {
	// Allow the server time to report its own startup failure before giving up locally.
	return timeoutSeconds * 1000 + 30_000;
}

// Liveliness ordering for a notebook's runtime: a notebook may have several
// sessions, and the row should reflect its strongest live state.
// running > starting > terminating; anything else (terminal/unknown) ranks lowest.
const LIVELINESS_RANK: Record<string, number> = { running: 3, starting: 2, terminating: 1 };

/** Numeric liveliness of a status; unknown/terminal statuses rank 0. */
export function rankSession(status: string | undefined): number {
	// Index with `?? ''` rather than `status && …`: an empty-string status is
	// falsy, so `&&` would short-circuit to `""` (and `?? 0` wouldn't catch it),
	// returning a string from a number-typed function.
	return LIVELINESS_RANK[status ?? ''] ?? 0;
}

/** A notebook's live runtime, split by mode: the caller's-view edit kernel and
 * the app pool. Either side may be absent. */
export interface NotebookSessions {
	edit?: Session;
	persistentEdit?: Session;
	app?: Session;
	apps?: Session[];
}

/**
 * Compare the latest acknowledged working-branch save, or the launch version,
 * with the notebook head. Local app callers suppress the hint while an editor
 * is active, because periodic snapshots would otherwise make it flap.
 * Directional comparison avoids warning when cached notebook detail trails the session.
 */
export function isSessionStale(
	session: Pick<Session, 'source_version_id' | 'working_branch_version_id'>,
	currentVersionId: string | null | undefined,
): boolean {
	const baseline = session.working_branch_version_id ?? session.source_version_id;
	return !!baseline && !!currentVersionId && currentVersionId > baseline;
}

/**
 * "~N people are connected" for shared-session stop and restart warnings. The
 * number is approximate because it comes from the last lifecycle probe.
 */
export function sessionConnectionHint(session: Session | undefined): string {
	const n = session?.active_connections;
	if (typeof n !== 'number' || n <= 0) return '';
	return ` About ${n} ${n === 1 ? 'person is' : 'people are'} connected right now.`;
}

/**
 * Preview runtimes have separate controls and are excluded from parent notebook controls.
 * Reduce a flat list of sessions to the "most alive" session per notebook and
 * per mode, keyed by `notebook_id`. A persistent edit sandbox, a caller-owned
 * temporary sandbox, and the shared app can coexist. At the same liveness rank,
 * the persistent editor takes precedence over a temporary editor.
 */
export function sessionsByNotebook(
	sessions: readonly Session[] | undefined,
): Map<string, NotebookSessions> {
	const map = new Map<string, NotebookSessions>();
	for (const s of sessions ?? []) {
		if (s.origin?.type === 'preview') continue;
		const entry = map.get(s.notebook_id) ?? {};
		const key = s.mode === 'app' ? 'app' : 'edit';
		if (key === 'app' && rankSession(s.status) > 0) (entry.apps ??= []).push(s);
		const current = entry[key];
		const sameRankPersistent =
			key === 'edit' &&
			!!current &&
			rankSession(s.status) === rankSession(current.status) &&
			!!current.ephemeral &&
			!s.ephemeral;
		if (!current || rankSession(s.status) > rankSession(current.status) || sameRankPersistent) {
			entry[key] = s;
		}
		if (
			key === 'edit' &&
			!s.ephemeral &&
			(!entry.persistentEdit || rankSession(s.status) > rankSession(entry.persistentEdit.status))
		) {
			entry.persistentEdit = s;
		}
		map.set(s.notebook_id, entry);
	}
	return map;
}
