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

/**
 * Reduce a flat list of sessions to one "most alive" session per notebook,
 * keyed by `notebook_id`. Pure — safe to call with `undefined` (treated as
 * empty) so callers can pass a query result straight through.
 */
export function sessionsByNotebook(sessions: readonly Session[] | undefined): Map<string, Session> {
	const map = new Map<string, Session>();
	for (const s of sessions ?? []) {
		const current = map.get(s.notebook_id);
		if (!current || rankSession(s.status) > rankSession(current.status)) {
			map.set(s.notebook_id, s);
		}
	}
	return map;
}
