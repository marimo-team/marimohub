import { beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, advanceTime, MemoryBucket, restoreClock, uid } from '../../testing';
import { createNotebookId, createProjectId, SessionId } from '../../ids';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { SessionService } from './SessionService';

/**
 * `countActiveForUser` backs the create-session cost-DoS cap: it must count only
 * a single user's non-terminal sessions.
 */
describe('SessionService.countActiveForUser', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;

	const notebookId = createNotebookId();
	const projectId = createProjectId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
	});

	const create = (userId: UserId) =>
		sessions.createSession({ notebook_id: notebookId, project_id: projectId, user_id: userId });

	it("counts only the user's non-terminal sessions", async () => {
		const OTHER = uid('user_other');

		// ACTOR: one starting, one running, one terminated.
		await create(ACTOR);
		const running = await create(ACTOR);
		await sessions.setRunning(projectId, running.session_id, 'https://sandbox.example');
		const dead = await create(ACTOR);
		await sessions.terminate(projectId, dead.session_id); // -> terminated (not counted)

		// A different user's live session must not count toward ACTOR.
		const other = await create(OTHER);
		await sessions.setRunning(projectId, other.session_id, 'https://sandbox.example');

		expect(await sessions.countActiveForUser(ACTOR)).toBe(2);
		expect(await sessions.countActiveForUser(OTHER)).toBe(1);
		expect(await sessions.countActiveForUser(uid('nobody'))).toBe(0);
	});

	it('excludes terminating, failed, and expired sessions', async () => {
		// expired: reaped by the TTL sweep — terminal, must not count. Driven to
		// `expired` first, in isolation, so the time-advance doesn't reap the others.
		const gone = await create(ACTOR);
		await sessions.setRunning(projectId, gone.session_id, 'https://sandbox.example');
		advanceTime(6 * 60 * 1000);
		expect(await sessions.expireStale()).toBe(1); // -> expired
		restoreClock();

		// One genuinely-active session that must be counted.
		const live = await create(ACTOR);
		await sessions.setRunning(projectId, live.session_id, 'https://sandbox.example');

		// terminating: on its way out — a stop should immediately free the slot.
		const stopping = await create(ACTOR);
		await sessions.setRunning(projectId, stopping.session_id, 'https://sandbox.example');
		await sessions.beginTerminating(projectId, stopping.session_id); // -> terminating

		// failed: provision/runtime error — terminal, must not count.
		const broken = await create(ACTOR);
		await sessions.markFailed(projectId, broken.session_id); // -> failed

		// Only the single live (running) session should be counted.
		expect(await sessions.countActiveForUser(ACTOR)).toBe(1);
	});

	it('ranks a running incumbent before a same-millisecond starting candidate', async () => {
		const incumbent = await sessions.createSession({
			notebook_id: notebookId,
			project_id: projectId,
			user_id: ACTOR,
			session_id: SessionId.parse('sess-zzzzzzzzzzzzzzzz'),
		});
		await sessions.setRunning(projectId, incumbent.session_id, 'https://sandbox.example');
		const candidate = await sessions.createSession({
			notebook_id: createNotebookId(),
			project_id: projectId,
			user_id: ACTOR,
			session_id: SessionId.parse('sess-0000000000000000'),
		});
		const startedAt = '2026-08-26T17:54:00.135Z';
		for (const session of [incumbent, candidate]) {
			const stored = await sessions.getSession(projectId, session.session_id);
			await bucket.put(
				paths.session(projectId, session.session_id),
				JSON.stringify({ ...stored, started_at: startedAt }),
			);
		}

		expect((await sessions.listActiveForUser(ACTOR)).map((session) => session.session_id)).toEqual([
			incumbent.session_id,
			candidate.session_id,
		]);
	});
});
