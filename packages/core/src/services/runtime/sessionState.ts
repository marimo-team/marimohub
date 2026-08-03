import type { SessionMode, SessionStatus } from '../../constants';
import { createStateMachine } from '../../fsm';
import type { Session } from '../../schema';

// Session lifecycle as a `createStateMachine` config, shared by every writer (API
// routes, reaper, reconciliation). With CAS writes in SessionService, a terminal
// session can never be revived by a racing heartbeat / setRunning.

/** Events that drive a transition (named for intent, not the target status). */
export type SessionEvent =
	| 'running' // provisioning succeeded (setRunning)
	| 'heartbeat' // keep-alive while running
	| 'terminate' // user requested stop (→ terminating)
	| 'terminated' // teardown finished (terminating → terminated)
	| 'fail' // provisioning or kernel error
	| 'expire'; // heartbeat TTL exceeded

/** Terminal states never transition again — they are sticky. */
export const TERMINAL_STATUSES = ['terminated', 'failed', 'expired'] as const;

/** Live (occupying a sandbox), excludes `terminating` which is on its way out. */
export const ACTIVE_STATUSES = ['starting', 'running'] as const;

/** What the UI shows as a present session (a dot in the notebook table). */
export const PRESENT_STATUSES = ['starting', 'running', 'terminating'] as const;

// Allowed edges. A terminal `from` maps to nothing (sticky); anything not listed
// is a no-op (returns null). `terminating` only proceeds to `terminated`.
const machine = createStateMachine<SessionStatus, SessionEvent>({
	transitions: {
		starting: {
			running: 'running',
			heartbeat: 'running',
			terminate: 'terminating',
			fail: 'failed',
			expire: 'expired',
		},
		running: { heartbeat: 'running', terminate: 'terminating', fail: 'failed', expire: 'expired' },
		// A stop wins over a still-resolving provision; once terminating, only the
		// teardown's `terminated` (or an `expire` fallback if teardown hangs) applies.
		// A `fail` must NOT downgrade it — mirrors SessionService.markFailed, which
		// refuses to fail a terminating session.
		terminating: { terminated: 'terminated', expire: 'terminated' },
		terminated: {},
		failed: {},
		expired: {},
	},
	terminal: TERMINAL_STATUSES,
});

/** Whether a status is terminal (sticky). */
export function isTerminal(status: SessionStatus): boolean {
	return machine.isTerminal(status);
}

/**
 * The status after applying `event` to `current`, or `null` when the event is a
 * no-op or illegal (including any event on a terminal status), so callers can skip
 * the write.
 */
export function nextStatus(current: SessionStatus, event: SessionEvent): SessionStatus | null {
	return machine.next(current, event);
}

/** A session's mode with the backward-compatible default: absent = `edit`. */
export function sessionMode(session: Pick<Session, 'mode'>): SessionMode {
	return session.mode ?? 'edit';
}

export interface SessionModePolicy {
	/** Base reuse key. Persistent editors add claim-based sharing in SessionService. */
	reuseScope: 'per-user' | 'per-notebook';
	/** Which concurrency cap the create route enforces. */
	capScope: 'user' | 'project';
	/** May teardown/snapshot paths write edits back (for a non-discard-only session)? */
	persistsEdits: boolean;
	/**
	 * `source-policy` honors the notebook source's load mode (may mount the
	 * bucket read-write); `copy-only` forbids the mount — required whenever the
	 * sandbox must not write through to the workspace mirror.
	 */
	workspaceLoad: 'source-policy' | 'copy-only';
	/** App sessions skip this because `marimo run` has no editor surface. */
	injectEditorConfig: boolean;
	/** Anchored by the per-notebook claim object (`claimApp`/`releaseApp`). */
	singleton: boolean;
	/**
	 * What a viewer-admitted session of this mode is (`VIEWER_SESSION_MODES`
	 * says whether one is admitted at all): `ephemeral` — their own throwaway,
	 * no WIF credentials or integration secrets, discarded at teardown; `shared` —
	 * the same session an editor would get (a per-viewer app would be incoherent).
	 */
	viewerSession: 'ephemeral' | 'shared';
}

/**
 * The full semantic surface of a session mode, in one auditable place. Every
 * mode-dependent branch keys off this table (or a helper derived from it), so
 * adding a mode is one row plus its genuinely new behavior — not a grep for
 * scattered conditionals.
 */
export const MODE_POLICY: Record<SessionMode, SessionModePolicy> = {
	edit: {
		reuseScope: 'per-user',
		capScope: 'user',
		persistsEdits: true,
		workspaceLoad: 'source-policy',
		injectEditorConfig: true,
		singleton: false,
		viewerSession: 'ephemeral',
	},
	// The shared app: one sandbox per notebook, owned by no one, never written
	// back. Copy-only because a mounted workspace would let app code write
	// through to the mirror the edit session owns. Viewer admission is the
	// deployment's call (MARIMOHUB_VIEWER_MODE=applications and up): a
	// viewer-reachable app holding WIF credentials or integration secrets can be
	// prompted (via app inputs) to exfiltrate them, so it stays off by default.
	app: {
		reuseScope: 'per-notebook',
		capScope: 'project',
		persistsEdits: false,
		workspaceLoad: 'copy-only',
		injectEditorConfig: false,
		singleton: true,
		viewerSession: 'shared',
	},
};

/** The mode policy for a stored session record. */
export function sessionModePolicy(session: Pick<Session, 'mode'>): SessionModePolicy {
	return MODE_POLICY[sessionMode(session)];
}

/**
 * Whether teardown/snapshot paths may write this session's edits back — the one
 * predicate every persistence call site keys off. False for discard-only
 * sessions and for modes that never persist (an app sandbox must never cut a
 * version, mirror the workspace, or advance the FS-snapshot pointer).
 */
export function sessionPersistsEdits(session: Pick<Session, 'mode' | 'ephemeral'>): boolean {
	return !session.ephemeral && sessionModePolicy(session).persistsEdits;
}
