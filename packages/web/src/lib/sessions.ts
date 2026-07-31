import type { Session } from '@/types';

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
 * the shared app singleton. Either side may be absent. */
export interface NotebookSessions {
	edit?: Session;
	app?: Session;
}

/**
 * Whether a frozen-snapshot session (the shared app, or any session on a
 * git-synced notebook) is serving an older version than the notebook's current
 * head. NOTE: for app sessions on local notebooks the periodic snapshotter
 * commits a fresh version every ~2 minutes while someone is editing, so callers
 * must also suppress the hint while an edit session is live on the notebook
 * (`editActive`) — otherwise it flaps for the whole editing session. Git-synced
 * heads move only when a push lands, so no such suppression applies there.
 */
export function isSessionStale(
	session: Pick<Session, 'source_version_id'>,
	currentVersionId: string | null | undefined,
): boolean {
	return (
		!!session.source_version_id &&
		!!currentVersionId &&
		currentVersionId !== session.source_version_id
	);
}

/**
 * "~N people are connected" for the stop/restart-app confirms — the number is
 * the lifecycle sweep's last probe, so it's approximate; omitted when unknown
 * or zero.
 */
export function appConnectionHint(session: Session | undefined): string {
	const n = session?.active_connections;
	if (typeof n !== 'number' || n <= 0) return '';
	return ` About ${n} ${n === 1 ? 'person is' : 'people are'} connected right now.`;
}

/**
 * Reduce a flat list of sessions to the "most alive" session per notebook and
 * per mode, keyed by `notebook_id`. Edit and app sessions coexist (one edit
 * sandbox per user + one shared app sandbox), so the row renders both
 * indicators independently. Pure — safe to call with `undefined` (treated as
 * empty) so callers can pass a query result straight through.
 */
export function sessionsByNotebook(
	sessions: readonly Session[] | undefined,
): Map<string, NotebookSessions> {
	const map = new Map<string, NotebookSessions>();
	for (const s of sessions ?? []) {
		const entry = map.get(s.notebook_id) ?? {};
		const key = s.mode === 'app' ? 'app' : 'edit';
		const current = entry[key];
		if (!current || rankSession(s.status) > rankSession(current.status)) {
			entry[key] = s;
			map.set(s.notebook_id, entry);
		}
	}
	return map;
}
