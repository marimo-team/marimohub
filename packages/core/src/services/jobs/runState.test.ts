import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '../../schema';
import {
	SANDBOX_HOLDING_RUN_STATUSES,
	isSandboxHoldingRunStatus,
	isTerminalRunStatus,
	nextRunStatus,
	TERMINAL_RUN_STATUSES,
} from './runState';

describe('run state machine', () => {
	it('walks the happy path', () => {
		expect(nextRunStatus('queued', 'provision')).toBe('provisioning');
		expect(nextRunStatus('provisioning', 'start')).toBe('running');
		expect(nextRunStatus('running', 'succeed')).toBe('succeeded');
	});

	it('allows cancel from every non-terminal status', () => {
		expect(nextRunStatus('queued', 'cancel')).toBe('cancelled');
		expect(nextRunStatus('provisioning', 'cancel')).toBe('cancelled');
		expect(nextRunStatus('running', 'cancel')).toBe('cancelled');
	});

	it('rejects illegal edges', () => {
		expect(nextRunStatus('queued', 'succeed')).toBeNull();
		expect(nextRunStatus('queued', 'start')).toBeNull();
		expect(nextRunStatus('running', 'provision')).toBeNull();
	});

	it('keeps terminal statuses sticky', () => {
		for (const status of TERMINAL_RUN_STATUSES) {
			expect(isTerminalRunStatus(status)).toBe(true);
			for (const event of ['provision', 'start', 'succeed', 'fail', 'timeout', 'cancel'] as const) {
				expect(nextRunStatus(status, event)).toBeNull();
			}
		}
	});

	it('classifies every status', () => {
		for (const status of RUN_STATUSES) {
			expect(isSandboxHoldingRunStatus(status)).toBe(
				(SANDBOX_HOLDING_RUN_STATUSES as readonly (typeof status)[]).includes(status),
			);
			expect(
				isTerminalRunStatus(status) || status === 'queued' || isSandboxHoldingRunStatus(status),
			).toBe(true);
		}
	});
});
