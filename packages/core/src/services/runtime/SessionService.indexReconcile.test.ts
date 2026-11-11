import { describe, expect, it } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '../../testing';
import { createNotebookId, createProjectId } from '../../ids';
import { paths } from '../../paths';
import { SessionIndex } from './SessionIndex';
import { SessionService } from './SessionService';

describe.each([false, true])('missing-index reconciliation in %s mode', (mode) => {
	async function fixture() {
		const bucket = new MemoryBucket();
		const sessions = new SessionService(bucket, undefined, undefined, () => mode);
		const input = {
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			user_id: ACTOR,
		};
		const first = await sessions.createSession(input);
		await sessions.setRunning(input.project_id, first.session_id, 'https://kernel.example');
		const scanned = await sessions.listSessions();
		const second = await sessions.createSession(input);
		await sessions.setRunning(input.project_id, second.session_id, 'https://kernel.example');
		await bucket.delete(paths.sessionIndexForUser(ACTOR));
		return { bucket, sessions, scanned, first, second, index: new SessionIndex(bucket) };
	}

	it('restores sessions admitted after the sweep snapshot when the index is lost', async () => {
		const { sessions, scanned, first, second, index } = await fixture();
		await sessions.reconcileSessionIndexes(scanned, { failOnError: true });
		expect((await index.read(ACTOR))?.entries).toEqual(
			expect.arrayContaining([
				{ session_id: first.session_id, project_id: first.project_id },
				{ session_id: second.session_id, project_id: second.project_id },
			]),
		);
		expect(await sessions.countActiveForUser(ACTOR)).toBe(2);
	});

	it('does not publish a partial index when a record outside the sweep snapshot is corrupt', async () => {
		const { bucket, sessions, scanned, second, index } = await fixture();
		await bucket.put(paths.session(second.project_id, second.session_id), 'not json');
		await expect(
			sessions.reconcileSessionIndexes(scanned, { failOnError: true }),
		).rejects.toThrow();
		expect(await index.read(ACTOR)).toBeNull();
		await sessions.reconcileSessionIndexes(scanned);
		expect(await index.read(ACTOR)).toBeNull();
	});
});
