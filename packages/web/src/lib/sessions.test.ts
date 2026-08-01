import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { isSessionStale, rankSession, sessionsByNotebook } from './sessions';

function session(
	notebookId: string,
	status: Session['status'],
	id = `${notebookId}-${status}`,
	mode: Session['mode'] = 'edit',
): Session {
	return {
		session_id: id,
		notebook_id: notebookId,
		project_id: 'proj-1',
		status,
		mode,
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

describe('isSessionStale', () => {
	it('is stale only when both versions are known and differ', () => {
		expect(isSessionStale({ source_version_id: 'a' }, 'b')).toBe(true);
		expect(isSessionStale({ source_version_id: 'a' }, 'a')).toBe(false);
		expect(isSessionStale({ source_version_id: undefined }, 'b')).toBe(false);
		expect(isSessionStale({ source_version_id: 'a' }, null)).toBe(false);
		expect(isSessionStale({ source_version_id: 'a' }, undefined)).toBe(false);
	});
});

describe('sessionsByNotebook', () => {
	it('returns an empty map for undefined or empty input', () => {
		expect(sessionsByNotebook(undefined).size).toBe(0);
		expect(sessionsByNotebook([]).size).toBe(0);
	});

	it('keys sessions by notebook id', () => {
		const map = sessionsByNotebook([session('nb-a', 'running'), session('nb-b', 'terminating')]);
		expect(map.get('nb-a')?.edit?.status).toBe('running');
		expect(map.get('nb-b')?.edit?.status).toBe('terminating');
	});

	it('keeps the liveliest session when a notebook has several', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'terminating', 'terminating-one'),
			session('nb-a', 'running', 'running-one'),
			session('nb-a', 'starting', 'starting-one'),
		]);
		expect(map.size).toBe(1);
		expect(map.get('nb-a')?.edit?.session_id).toBe('running-one');
	});

	it('is order-independent (first-seen liveliest still wins)', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'running', 'running-one'),
			session('nb-a', 'terminating', 'terminating-one'),
		]);
		expect(map.get('nb-a')?.edit?.session_id).toBe('running-one');
	});

	it('partitions edit and app sessions per notebook', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'running', 'edit-one'),
			session('nb-a', 'running', 'app-one', 'app'),
		]);
		expect(map.size).toBe(1);
		expect(map.get('nb-a')?.edit?.session_id).toBe('edit-one');
		expect(map.get('nb-a')?.app?.session_id).toBe('app-one');
	});

	it('prefers the persistent editor over an equally live temporary session', () => {
		const temporary = { ...session('nb-a', 'running', 'temporary'), ephemeral: true };
		const persistent = session('nb-a', 'running', 'persistent');
		const map = sessionsByNotebook([temporary, persistent]);
		expect(map.get('nb-a')?.edit?.session_id).toBe('persistent');
		expect(map.get('nb-a')?.persistentEdit?.session_id).toBe('persistent');
	});

	it('keeps temporary editors visible without marking them as persistent edits', () => {
		const temporary = { ...session('nb-a', 'running', 'temporary'), ephemeral: true };
		const map = sessionsByNotebook([temporary]);
		expect(map.get('nb-a')?.edit?.session_id).toBe('temporary');
		expect(map.get('nb-a')?.persistentEdit).toBeUndefined();
	});

	it('tracks a less-live persistent editor separately from a temporary editor', () => {
		const temporary = { ...session('nb-a', 'running', 'temporary'), ephemeral: true };
		const persistent = session('nb-a', 'starting', 'persistent');
		const map = sessionsByNotebook([temporary, persistent]);
		expect(map.get('nb-a')?.edit?.session_id).toBe('temporary');
		expect(map.get('nb-a')?.persistentEdit?.session_id).toBe('persistent');
	});

	it('ranks liveliness within a mode, not across modes', () => {
		const map = sessionsByNotebook([
			session('nb-a', 'starting', 'edit-one'),
			session('nb-a', 'running', 'app-one', 'app'),
			session('nb-a', 'terminating', 'app-two', 'app'),
		]);
		expect(map.get('nb-a')?.edit?.session_id).toBe('edit-one');
		expect(map.get('nb-a')?.app?.session_id).toBe('app-one');
	});
});
