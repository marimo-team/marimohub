import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ACTOR,
	advanceTime,
	expectHeartbeatAdvanced,
	expectNotFound,
	MemoryBucket,
	restoreClock,
	useFakeClock,
} from '../testing';
import { createNotebookId, createProjectId, type SessionId } from '../ids';
import { SessionService } from './SessionService';

describe('SessionService', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;

	const notebookId = createNotebookId();
	const projectId = createProjectId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
	});

	describe('createSession', () => {
		it('creates a session with starting status', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			expect(session.status).toBe('starting');
			expect(session.notebook_id).toBe(notebookId);
			expect(session.project_id).toBe(projectId);
			expect(session.session_id).toMatch(/^sess-/);
		});
	});

	describe('getSession', () => {
		it('returns a previously created session', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const loaded = await sessions.getSession(created.session_id);
			expect(loaded.session_id).toBe(created.session_id);
			expect(loaded.notebook_id).toBe(notebookId);
			expect(loaded.project_id).toBe(projectId);
			expect(loaded.user_id).toBe(ACTOR);
		});

		it('throws NotFoundError for a missing session', async () => {
			await expectNotFound(() =>
				sessions.getSession('sess_01HXY00000000000000000000' as SessionId),
			);
		});
	});

	describe('heartbeat', () => {
		it('updates status to running and refreshes last_heartbeat', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const updated = await sessions.heartbeat(created.session_id);
			expect(updated.status).toBe('running');
			expectHeartbeatAdvanced(updated, created);
		});

		it('throws NotFoundError for missing session', async () => {
			await expectNotFound(() => sessions.heartbeat('sess_01HXY00000000000000000000' as SessionId));
		});

		it('coalesces heartbeat writes within the persist interval', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const putSpy = vi.spyOn(bucket, 'put');

			// First heartbeat persists the `starting` → `running` transition.
			await sessions.heartbeat(created.session_id);
			expect(putSpy).toHaveBeenCalledTimes(1);

			// Second heartbeat is already running and still fresh → coalesced.
			await sessions.heartbeat(created.session_id);
			expect(putSpy).toHaveBeenCalledTimes(1);

			// Past the interval, it persists again.
			advanceTime(61 * 1000);
			await sessions.heartbeat(created.session_id);
			expect(putSpy).toHaveBeenCalledTimes(2);
			restoreClock();

			putSpy.mockRestore();
		});

		it('does not revive a terminated session (stays terminated, no write)', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(created.session_id);

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.heartbeat(created.session_id);

			expect(result.status).toBe('terminated');
			expect(putSpy).not.toHaveBeenCalled();

			const stored = await sessions.getSession(created.session_id);
			expect(stored.status).toBe('terminated');

			putSpy.mockRestore();
		});

		it('does not revive an expired session (stays expired, no write)', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			// Drive the session to `expired` via the stale reaper.
			await sessions.heartbeat(session.session_id);
			advanceTime(6 * 60 * 1000);
			expect(await sessions.expireStale()).toBe(1);
			restoreClock();

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.heartbeat(session.session_id);

			expect(result.status).toBe('expired');
			expect(putSpy).not.toHaveBeenCalled();

			const stored = await sessions.getSession(session.session_id);
			expect(stored.status).toBe('expired');

			putSpy.mockRestore();
		});

		it('promotes a starting session to running and updates last_heartbeat', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			expect(created.status).toBe('starting');

			const clock = useFakeClock(new Date(created.last_heartbeat).getTime() + 1000);

			const updated = await sessions.heartbeat(created.session_id);
			expect(updated.status).toBe('running');
			expectHeartbeatAdvanced(updated, created, { strict: true });

			const stored = await sessions.getSession(created.session_id);
			expect(stored.status).toBe('running');

			clock.restore();
		});
	});

	describe('terminate', () => {
		it('sets status to terminated', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const terminated = await sessions.terminate(created.session_id);
			expect(terminated.status).toBe('terminated');
		});

		it('throws NotFoundError for missing session', async () => {
			await expectNotFound(() => sessions.terminate('sess_01HXY00000000000000000000' as SessionId));
		});
	});

	describe('listSessions', () => {
		it('returns all sessions', async () => {
			await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: projectId,
				user_id: ACTOR,
			});

			const list = await sessions.listSessions();
			expect(list).toHaveLength(2);
		});

		it('filters by notebookId', async () => {
			await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: projectId,
				user_id: ACTOR,
			});

			const list = await sessions.listSessions(notebookId);
			expect(list).toHaveLength(1);
			expect(list[0].notebook_id).toBe(notebookId);
		});

		it('returns empty list when no sessions exist', async () => {
			const list = await sessions.listSessions();
			expect(list).toEqual([]);
		});
	});

	describe('expireStale', () => {
		it('expires sessions with stale heartbeats', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			// Set to running
			await sessions.heartbeat(session.session_id);

			// Move time forward past TTL (5 minutes)
			advanceTime(6 * 60 * 1000);

			const expired = await sessions.expireStale();
			expect(expired).toBe(1);

			const list = await sessions.listSessions();
			expect(list[0].status).toBe('expired');

			restoreClock();
		});

		it('does not expire sessions with recent heartbeats', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.heartbeat(session.session_id);

			const expired = await sessions.expireStale();
			expect(expired).toBe(0);
		});

		it.each(['terminated', 'expired'] as const)('skips sessions with %s status', async (status) => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			if (status === 'terminated') {
				await sessions.terminate(session.session_id);
			}

			advanceTime(6 * 60 * 1000);

			const expiredCount = await sessions.expireStale();
			// terminated sessions should not be re-expired
			if (status === 'terminated') {
				expect(expiredCount).toBe(0);
			}

			restoreClock();
		});
	});

	describe('reapTerminated', () => {
		it('deletes terminal records older than the retention window', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(session.session_id);

			advanceTime(25 * 60 * 60 * 1000); // 25h later

			const reaped = await sessions.reapTerminated();
			expect(reaped).toBe(1);
			expect(await sessions.listSessions()).toEqual([]);

			restoreClock();
		});

		it('keeps terminal records inside the retention window', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(session.session_id);

			const reaped = await sessions.reapTerminated();
			expect(reaped).toBe(0);
			expect(await sessions.listSessions()).toHaveLength(1);
		});

		it('does not reap active sessions regardless of age', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.heartbeat(session.session_id);

			advanceTime(25 * 60 * 60 * 1000);

			const reaped = await sessions.reapTerminated();
			expect(reaped).toBe(0);

			restoreClock();
		});
	});
});
