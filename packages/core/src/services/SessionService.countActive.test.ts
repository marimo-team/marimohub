import { beforeEach, describe, expect, it } from 'vitest';
import { ACTOR, MemoryBucket } from '../testing';
import { createNotebookId, createProjectId } from '../ids';
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

	const create = (userId: string) =>
		sessions.createSession({ notebook_id: notebookId, project_id: projectId, user_id: userId });

	it("counts only the user's non-terminal sessions", async () => {
		const OTHER = 'user_other';

		// ACTOR: one starting, one running, one terminated.
		await create(ACTOR);
		const running = await create(ACTOR);
		await sessions.heartbeat(running.session_id); // -> running
		const dead = await create(ACTOR);
		await sessions.terminate(dead.session_id); // -> terminated (not counted)

		// A different user's live session must not count toward ACTOR.
		const other = await create(OTHER);
		await sessions.heartbeat(other.session_id);

		expect(await sessions.countActiveForUser(ACTOR)).toBe(2);
		expect(await sessions.countActiveForUser(OTHER)).toBe(1);
		expect(await sessions.countActiveForUser('nobody')).toBe(0);
	});
});
