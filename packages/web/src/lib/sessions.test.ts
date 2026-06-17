import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { rankSession, sessionsByNotebook } from './sessions';

function session(
	notebookId: string,
	status: Session['status'],
	id = `${notebookId}-${status}`,
): Session {
	return {
		session_id: id,
		notebook_id: notebookId,
		project_id: 'proj-1',
		status,
		started_at: '2025-03-05T14:00:00Z',
		last_heartbeat: '2025-03-05T14:00:00Z',
	} as Session;
}

describe('rankSession', () => {
	it('orders running > starting > terminating > everything else', () => {
		expect(rankSession('running')).toBeGreaterThan(rankSession('starting'));
		expect(rankSession('starting')).toBeGreaterThan(rankSession('terminating'));
		expect(rankSession('terminating')).toBeGreaterThan(rankSession('terminated'));
	});

	it('ranks unknown/undefined status as 0', () => {
		expect(rankSession(undefined)).toBe(0);
		expect(rankSession('expired')).toBe(0);
		expect(rankSession('garbage')).toBe(0);
	});
});

describe('sessionsByNotebook', () => {
	it('returns an empty map for undefined or empty input', () => {
		expect(sessionsByNotebook(undefined).size).toBe(0);
		expect(sessionsByNotebook([]).size).toBe(0);
	});

	it('keys sessions by notebook id', () => {
		const map = sessionsByNotebook([session('nb-a', 'running'), session('nb-b', 'terminating')]);
		expect(map.get('nb-a')?.status).toBe('running');
		expect(map.get('nb-b')?.status).toBe('terminating');
	});

	it('keeps the liveliest session when a notebook has several', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'terminating', 'terminating-one'),
			session('nb-a', 'running', 'running-one'),
			session('nb-a', 'starting', 'starting-one'),
		]);
		expect(map.size).toBe(1);
		expect(map.get('nb-a')?.session_id).toBe('running-one');
	});

	it('is order-independent (first-seen liveliest still wins)', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'running', 'running-one'),
			session('nb-a', 'terminating', 'terminating-one'),
		]);
		expect(map.get('nb-a')?.session_id).toBe('running-one');
	});
});
