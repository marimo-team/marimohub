import type { SessionStatus } from '../../constants';
import { createStateMachine } from '../../fsm';

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
