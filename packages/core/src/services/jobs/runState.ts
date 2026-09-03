import { createStateMachine } from '../../fsm';
import type { RunStatus } from '../../schema';

// Run lifecycle as a `createStateMachine` config, shared by every writer (the
// runner, the scheduler's watchdog, the cancel route). Every transition is a CAS
// write through `JobRunService`, so a cancel racing a completion resolves to
// exactly one terminal state.

export type RunEvent =
	| 'provision' // the runner picked the run up (queued → provisioning)
	| 'start' // the sandbox is prepared and the export command is running
	| 'succeed'
	| 'fail'
	| 'timeout' // the deadline passed (runner-observed or watchdog)
	| 'cancel';

export const TERMINAL_RUN_STATUSES = [
	'succeeded',
	'failed',
	'timed_out',
	'cancelled',
	'skipped',
] as const;

/** Statuses that hold (or are about to hold) a sandbox. */
export const ACTIVE_RUN_STATUSES = ['provisioning', 'running'] as const;

const machine = createStateMachine<RunStatus, RunEvent>({
	transitions: {
		queued: {
			provision: 'provisioning',
			cancel: 'cancelled',
			fail: 'failed',
			timeout: 'timed_out',
		},
		provisioning: { start: 'running', fail: 'failed', timeout: 'timed_out', cancel: 'cancelled' },
		running: { succeed: 'succeeded', fail: 'failed', timeout: 'timed_out', cancel: 'cancelled' },
		succeeded: {},
		failed: {},
		timed_out: {},
		cancelled: {},
		skipped: {},
	},
	terminal: TERMINAL_RUN_STATUSES,
});

export function isTerminalRunStatus(status: RunStatus): boolean {
	return machine.isTerminal(status);
}

export function isActiveRunStatus(status: RunStatus): boolean {
	return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** The status after `event`, or `null` when the edge is illegal (so callers skip the write). */
export function nextRunStatus(current: RunStatus, event: RunEvent): RunStatus | null {
	return machine.next(current, event);
}
