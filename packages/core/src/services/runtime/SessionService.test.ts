import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ACTOR,
	advanceTime,
	expectHeartbeatAdvanced,
	expectNotFound,
	MemoryBucket,
	restoreClock,
	uid,
	useFakeClock,
} from '../../testing';
import { createNotebookId, createProjectId } from '../../ids';
import type { SessionId } from '../../ids';
import { paths } from '../../paths';
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

			const loaded = await sessions.getSession(projectId, created.session_id);
			expect(loaded.session_id).toBe(created.session_id);
			expect(loaded.notebook_id).toBe(notebookId);
			expect(loaded.project_id).toBe(projectId);
			expect(loaded.user_id).toBe(ACTOR);
		});

		it('throws NotFoundError for a missing session', async () => {
			await expectNotFound(() =>
				sessions.getSession(projectId, 'sess_01HXY00000000000000000000' as SessionId),
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

			const updated = await sessions.heartbeat(projectId, created.session_id);
			expect(updated.status).toBe('running');
			expectHeartbeatAdvanced(updated, created);
		});

		it('throws NotFoundError for missing session', async () => {
			await expectNotFound(() =>
				sessions.heartbeat(projectId, 'sess_01HXY00000000000000000000' as SessionId),
			);
		});

		it('coalesces heartbeat writes within the persist interval', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const putSpy = vi.spyOn(bucket, 'put');

			// First heartbeat persists the `starting` → `running` transition.
			await sessions.heartbeat(projectId, created.session_id);
			expect(putSpy).toHaveBeenCalledTimes(1);

			// Second heartbeat is already running and still fresh → coalesced.
			await sessions.heartbeat(projectId, created.session_id);
			expect(putSpy).toHaveBeenCalledTimes(1);

			// Past the interval, it persists again.
			advanceTime(61 * 1000);
			await sessions.heartbeat(projectId, created.session_id);
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
			await sessions.terminate(projectId, created.session_id);

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.heartbeat(projectId, created.session_id);

			expect(result.status).toBe('terminated');
			expect(putSpy).not.toHaveBeenCalled();

			const stored = await sessions.getSession(projectId, created.session_id);
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
			await sessions.heartbeat(projectId, session.session_id);
			advanceTime(6 * 60 * 1000);
			expect(await sessions.expireStale()).toBe(1);
			restoreClock();

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.heartbeat(projectId, session.session_id);

			expect(result.status).toBe('expired');
			expect(putSpy).not.toHaveBeenCalled();

			const stored = await sessions.getSession(projectId, session.session_id);
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

			const updated = await sessions.heartbeat(projectId, created.session_id);
			expect(updated.status).toBe('running');
			expectHeartbeatAdvanced(updated, created, { strict: true });

			const stored = await sessions.getSession(projectId, created.session_id);
			expect(stored.status).toBe('running');

			clock.restore();
		});
	});

	describe('setRunning', () => {
		it('does not revive a terminated session (stays terminated, no write)', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(projectId, created.session_id);

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.setRunning(
				projectId,
				created.session_id,
				'http://kernel',
				false,
			);

			expect(result.status).toBe('terminated');
			expect(putSpy).not.toHaveBeenCalled();

			// Confirm the stored record is also unchanged
			const stored = await sessions.getSession(projectId, created.session_id);
			expect(stored.status).toBe('terminated');

			putSpy.mockRestore();
		});

		it('does not revive an expired session (stays expired, no write)', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.heartbeat(projectId, session.session_id);
			advanceTime(6 * 60 * 1000);
			expect(await sessions.expireStale()).toBe(1);
			restoreClock();

			const putSpy = vi.spyOn(bucket, 'put');
			const result = await sessions.setRunning(
				projectId,
				session.session_id,
				'http://kernel',
				false,
			);

			expect(result.status).toBe('expired');
			expect(putSpy).not.toHaveBeenCalled();

			const stored = await sessions.getSession(projectId, session.session_id);
			expect(stored.status).toBe('expired');

			putSpy.mockRestore();
		});

		it('stamps expires_at when provided', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			const deadline = new Date(Date.now() + 60_000).toISOString();

			const result = await sessions.setRunning(
				projectId,
				created.session_id,
				'http://kernel',
				false,
				undefined,
				deadline,
			);

			expect(result.status).toBe('running');
			expect(result.expires_at).toBe(deadline);
		});
	});

	describe('lifecycle mutators', () => {
		it('extendExpiry slides the deadline on a live session', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			const later = new Date(Date.now() + 120_000).toISOString();

			const updated = await sessions.extendExpiry(projectId, created.session_id, later);
			expect(updated.expires_at).toBe(later);
		});

		it('extendExpiry does not touch a terminated session', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(projectId, created.session_id);

			const result = await sessions.extendExpiry(
				projectId,
				created.session_id,
				new Date().toISOString(),
			);
			expect(result.status).toBe('terminated');
			expect(result.expires_at).toBeUndefined();
		});

		it('markSnapshotted records the save time, including on an expired record', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.heartbeat(projectId, created.session_id);
			advanceTime(6 * 60 * 1000);
			expect(await sessions.expireStale()).toBe(1);
			restoreClock();

			const at = new Date().toISOString();
			const updated = await sessions.markSnapshotted(projectId, created.session_id, at);
			expect(updated.last_snapshot_at).toBe(at);
			expect(updated.status).toBe('expired'); // bookkeeping never touches status
		});

		it('markSandboxReclaimed records the reclaim time', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			const at = new Date().toISOString();

			const updated = await sessions.markSandboxReclaimed(projectId, created.session_id, at);
			expect(updated.sandbox_reclaimed_at).toBe(at);
		});
	});

	describe('terminate', () => {
		it('sets status to terminated', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			const terminated = await sessions.terminate(projectId, created.session_id);
			expect(terminated.status).toBe('terminated');
		});

		it('throws NotFoundError for missing session', async () => {
			await expectNotFound(() =>
				sessions.terminate(projectId, 'sess_01HXY00000000000000000000' as SessionId),
			);
		});
	});

	describe('terminating lifecycle + failure', () => {
		it('beginTerminating → markTerminated moves through the visible stopping state', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.setRunning(projectId, created.session_id, 'https://sandbox.example');

			const stopping = await sessions.beginTerminating(projectId, created.session_id);
			expect(stopping.session.status).toBe('terminating');
			expect(stopping.transitioned).toBe(true);

			// A second stop loses the transition race — it must not claim the teardown.
			const again = await sessions.beginTerminating(projectId, created.session_id);
			expect(again.session.status).toBe('terminating');
			expect(again.transitioned).toBe(false);

			const stopped = await sessions.markTerminated(projectId, created.session_id);
			expect(stopped.status).toBe('terminated');
		});

		it('markFailed marks a live session failed, but never overrides a terminal/terminating one', async () => {
			const a = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			expect((await sessions.markFailed(projectId, a.session_id)).status).toBe('failed');
			// Sticky: a second markFailed/terminate can't change a terminal session.
			expect((await sessions.markTerminated(projectId, a.session_id)).status).toBe('failed');

			const b = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.beginTerminating(projectId, b.session_id); // → terminating
			expect((await sessions.markFailed(projectId, b.session_id)).status).toBe('terminating'); // not downgraded
		});

		it('CAS: setRunning racing a terminate cannot resurrect the session', async () => {
			// Models a stop that lands while provisioning is still resolving: the user
			// terminates, then the saga's setRunning commits. CAS must let the terminate win.
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			// Sneak a terminate in *before* setRunning's conditional write commits,
			// changing the ETag so setRunning loses the CAS race, re-reads the terminal
			// state, and no-ops instead of reviving the session.
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			const putSpy = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, opts) => {
				if (!raced && opts?.onlyIfEtagMatches) {
					raced = true;
					await sessions.markTerminated(projectId, created.session_id);
				}
				return realPut(key, value, opts);
			});

			const result = await sessions.setRunning(
				projectId,
				created.session_id,
				'https://sandbox.example',
			);
			expect(result.status).toBe('terminated');
			const stored = await sessions.getSession(projectId, created.session_id);
			expect(stored.status).toBe('terminated');
			expect(stored.sandbox_url).toBeUndefined(); // the racing url write never landed

			putSpy.mockRestore();
		});
	});

	describe('listSessions (>1000 sessions, pagination)', () => {
		it('returns all sessions when count exceeds a single page (1050 sessions)', async () => {
			// Creating 1050 sessions — safely above the 1000-object page limit.
			// This validates that listSessions (and countActiveForUser, which delegates to it)
			// follows pagination cursors rather than stopping at the first page.
			const COUNT = 1050;
			for (let i = 0; i < COUNT; i++) {
				await sessions.createSession({
					notebook_id: notebookId,
					project_id: projectId,
					user_id: ACTOR,
				});
			}

			const list = await sessions.listSessions();
			expect(list).toHaveLength(COUNT);

			// countActiveForUser must also see all sessions (all are in 'starting' status).
			const count = await sessions.countActiveForUser(ACTOR);
			expect(count).toBe(COUNT);
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

		it('does not let one corrupt session record abort the whole scan', async () => {
			const valid = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			// A garbage record under the sessions prefix (e.g. a partial/legacy write)
			// must not blow up a deployment-wide scan — the good record should survive.
			await bucket.put(
				`${paths.sessionsForProject(projectId)}corrupt.json`,
				JSON.stringify({ session_id: 'not-a-valid-id', status: 'bogus' }),
			);

			const list = await sessions.listSessions();
			expect(list.map((s) => s.session_id)).toEqual([valid.session_id]);
		});
	});

	describe('listActiveByProject', () => {
		it('returns only the project’s active (non-terminal) sessions', async () => {
			const otherProject = createProjectId();

			// Active in the target project: starting (as created) + running.
			const starting = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			const running = await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.setRunning(projectId, running.session_id, 'https://sandbox.example');

			// Terminal in the target project — must be excluded.
			const doomed = await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(projectId, doomed.session_id);

			// Active, but in a different project — must be excluded.
			await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: otherProject,
				user_id: ACTOR,
			});

			const active = await sessions.listActiveByProject(projectId);
			expect(active.map((s) => s.session_id).sort()).toEqual(
				[starting.session_id, running.session_id].sort(),
			);
			expect(active.every((s) => s.project_id === projectId)).toBe(true);
		});

		it('returns empty when the project has no active sessions', async () => {
			expect(await sessions.listActiveByProject(projectId)).toEqual([]);
		});

		it('lists only the project prefix, not the whole sessions tree', async () => {
			const otherProject = createProjectId();
			await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			// A session in another project — its object lives under a different prefix.
			await sessions.createSession({
				notebook_id: createNotebookId(),
				project_id: otherProject,
				user_id: ACTOR,
			});

			// The scoped read must only ever list this project's partition.
			const listSpy = vi.spyOn(bucket, 'list');
			await sessions.listActiveByProject(projectId);
			for (const call of listSpy.mock.calls) {
				expect(call[0]?.prefix).toBe(`_system/sessions/${projectId}/`);
			}
			listSpy.mockRestore();
		});
	});

	describe('findReusable', () => {
		it('returns a running session with a sandbox_url for the same user/notebook', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.setRunning(projectId, created.session_id, 'https://sandbox.example');

			const found = await sessions.findReusable(projectId, notebookId, ACTOR);
			expect(found?.session_id).toBe(created.session_id);
			expect(found?.sandbox_url).toBe('https://sandbox.example');
		});

		it('reuses a fresh starting session so a refresh attaches instead of provisioning again', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			const found = await sessions.findReusable(projectId, notebookId, ACTOR);
			expect(found?.session_id).toBe(created.session_id);
			expect(found?.status).toBe('starting');
		});

		it('does not reuse a terminated session, or one for another user/notebook', async () => {
			const doomed = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.setRunning(projectId, doomed.session_id, 'https://sandbox.example');
			await sessions.terminate(projectId, doomed.session_id);

			const otherUser = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: uid('someone-else'),
			});
			await sessions.setRunning(projectId, otherUser.session_id, 'https://other.example');

			expect(await sessions.findReusable(projectId, notebookId, ACTOR)).toBeUndefined();
			expect(await sessions.findReusable(projectId, createNotebookId(), ACTOR)).toBeUndefined();
		});

		it('does not reuse a wedged starting session past the provision window', async () => {
			await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});

			// The provision never resolved (still `starting`) and the window elapsed —
			// reusing it would attach a client to a dead provision forever.
			advanceTime(6 * 60 * 1000); // past HEARTBEAT_TTL_MS (5m)
			const found = await sessions.findReusable(projectId, notebookId, ACTOR);
			restoreClock();

			expect(found).toBeUndefined();
		});

		it('does not reuse a running session that has no sandbox_url', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			// A heartbeat promotes starting → running WITHOUT stamping a sandbox_url;
			// there is no live kernel to reconnect to, so it must not be reused.
			await sessions.heartbeat(projectId, created.session_id);

			expect(await sessions.findReusable(projectId, notebookId, ACTOR)).toBeUndefined();
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
			await sessions.heartbeat(projectId, session.session_id);

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
			await sessions.heartbeat(projectId, session.session_id);

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
				await sessions.terminate(projectId, session.session_id);
			}

			advanceTime(6 * 60 * 1000);

			const expiredCount = await sessions.expireStale();
			// terminated sessions should not be re-expired
			if (status === 'terminated') {
				expect(expiredCount).toBe(0);
			}

			restoreClock();
		});

		it('skips a session whose ETag changed between scan and conditional PUT', async () => {
			const created = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.setRunning(projectId, created.session_id, 'https://sandbox.example');
			const running = await sessions.getSession(projectId, created.session_id);

			advanceTime(6 * 60 * 1000); // heartbeat now stale → reaper wants to expire it

			// Sneak a concurrent transition in *between* the reaper's scan (which captured
			// the old ETag) and its conditional PUT. That other write wins; the reaper's
			// stale-ETag PUT must fail its precondition and be skipped, not clobbered.
			const realPut = bucket.put.bind(bucket);
			let raced = false;
			const putSpy = vi.spyOn(bucket, 'put').mockImplementation(async (key, value, opts) => {
				if (opts?.onlyIfEtagMatches && !raced) {
					raced = true;
					await realPut(key, JSON.stringify({ ...running, status: 'terminated' }));
				}
				return realPut(key, value, opts);
			});

			const expired = await sessions.expireStale();

			putSpy.mockRestore();
			restoreClock();

			// The concurrent terminate must stand; the reaper must not have expired it.
			expect(expired).toBe(0);
			const stored = await sessions.getSession(projectId, created.session_id);
			expect(stored.status).toBe('terminated');
		});
	});

	describe('reapTerminated', () => {
		it('deletes terminal records older than the retention window', async () => {
			const session = await sessions.createSession({
				notebook_id: notebookId,
				project_id: projectId,
				user_id: ACTOR,
			});
			await sessions.terminate(projectId, session.session_id);

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
			await sessions.terminate(projectId, session.session_id);

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
			await sessions.heartbeat(projectId, session.session_id);

			advanceTime(25 * 60 * 60 * 1000);

			const reaped = await sessions.reapTerminated();
			expect(reaped).toBe(0);

			restoreClock();
		});
	});
});
