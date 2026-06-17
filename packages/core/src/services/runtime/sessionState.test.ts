import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../constants';
import { isTerminal, nextStatus, TERMINAL_STATUSES } from './sessionState';
import type { SessionEvent } from './sessionState';

describe('sessionState', () => {
	it('marks terminated/failed/expired as terminal', () => {
		expect(TERMINAL_STATUSES).toEqual(['terminated', 'failed', 'expired']);
		for (const s of ['terminated', 'failed', 'expired'] as const) expect(isTerminal(s)).toBe(true);
		for (const s of ['starting', 'running', 'terminating'] as const)
			expect(isTerminal(s)).toBe(false);
	});

	it('allows the expected live edges', () => {
		expect(nextStatus('starting', 'running')).toBe('running');
		expect(nextStatus('starting', 'terminate')).toBe('terminating');
		expect(nextStatus('starting', 'fail')).toBe('failed');
		expect(nextStatus('starting', 'expire')).toBe('expired');
		expect(nextStatus('running', 'terminate')).toBe('terminating');
		expect(nextStatus('running', 'expire')).toBe('expired');
		expect(nextStatus('running', 'fail')).toBe('failed');
		expect(nextStatus('terminating', 'terminated')).toBe('terminated');
		// A hung teardown past TTL is forced terminal.
		expect(nextStatus('terminating', 'expire')).toBe('terminated');
	});

	it('treats a no-op transition as null (skip the write)', () => {
		expect(nextStatus('running', 'running')).toBeNull(); // already running
		expect(nextStatus('running', 'heartbeat')).toBeNull(); // status unchanged
		expect(nextStatus('terminating', 'terminate')).toBeNull(); // already terminating
	});

	it('never leaves a terminal status (sticky) for any event', () => {
		const events: SessionEvent[] = [
			'running',
			'heartbeat',
			'terminate',
			'terminated',
			'fail',
			'expire',
		];
		for (const from of TERMINAL_STATUSES) {
			for (const event of events) {
				expect(nextStatus(from as SessionStatus, event)).toBeNull();
			}
		}
	});

	it('does not resurrect a terminating session to running', () => {
		expect(nextStatus('terminating', 'running')).toBeNull();
		expect(nextStatus('terminating', 'heartbeat')).toBeNull();
	});
});
