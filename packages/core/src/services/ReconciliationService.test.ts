import { beforeEach, describe, expect, it } from 'vitest';
import { createNotebookId, createProjectId, type SandboxId } from '../ids';
import type { SandboxInstance, SandboxProvider } from '../ports/sandbox';
import { ACTOR, MemoryBucket, RecordingCompute } from '../testing';
import { ReconciliationService } from './ReconciliationService';
import { SessionService } from './SessionService';

describe('ReconciliationService', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let compute: RecordingCompute;
	let reconciler: ReconciliationService;

	const notebookId = createNotebookId();
	const projectId = createProjectId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
		compute = new RecordingCompute();
		reconciler = new ReconciliationService(sessions, compute, bucket);
	});

	const createSession = (sandboxId: string) =>
		sessions.createSession({
			notebook_id: notebookId,
			project_id: projectId,
			user_id: ACTOR,
			sandbox_id: sandboxId,
		});

	it('skips cleanly when the provider cannot enumerate', async () => {
		const noList: SandboxProvider = {
			create: () => ({}) as unknown as SandboxInstance,
			async proxy() {
				return null;
			},
		};
		const r = new ReconciliationService(sessions, noList, bucket);

		const result = await r.reconcile();
		expect(result).toEqual({
			skipped: true,
			reclaimed: 0,
			markedDead: 0,
			orphansReaped: 0,
			orphanSandboxIds: [],
		});
	});

	it('Rule 1: tears down a still-running sandbox behind a terminal record', async () => {
		const session = await createSession('sbx-terminal');
		await sessions.terminate(session.session_id);
		compute.active = [{ id: 'sbx-terminal' as SandboxId }];

		const result = await reconciler.reconcile();

		expect(result.reclaimed).toBe(1);
		expect(compute.destroyed).toEqual(['sbx-terminal']);
	});

	it('Rule 2: marks a record terminated when its sandbox has vanished', async () => {
		const session = await createSession('sbx-gone');
		await sessions.heartbeat(session.session_id); // -> running
		compute.active = []; // sandbox is no longer live

		const result = await reconciler.reconcile();

		expect(result.markedDead).toBe(1);
		expect(compute.destroyed).toEqual([]);
		const stored = await sessions.getSession(session.session_id);
		expect(stored.status).toBe('terminated');
	});

	it('leaves a healthy running session untouched', async () => {
		const session = await createSession('sbx-healthy');
		await sessions.heartbeat(session.session_id); // -> running
		compute.active = [{ id: 'sbx-healthy' as SandboxId }];

		const result = await reconciler.reconcile();

		expect(result).toMatchObject({ reclaimed: 0, markedDead: 0, orphansReaped: 0 });
		expect(compute.destroyed).toEqual([]);
		const stored = await sessions.getSession(session.session_id);
		expect(stored.status).toBe('running');
	});

	it('Rule 3: reaps an orphan sandbox with no record past the grace window', async () => {
		compute.active = [
			{ id: 'orphan' as SandboxId, createdAt: new Date(Date.now() - 60_000).toISOString() },
		];

		const result = await reconciler.reconcile({ orphanGraceMs: 1_000 });

		expect(result.orphansReaped).toBe(1);
		expect(result.orphanSandboxIds).toEqual(['orphan']);
		expect(compute.destroyed).toEqual(['orphan']);
	});

	it('Rule 3: leaves a fresh recordless sandbox alone (within grace window)', async () => {
		compute.active = [{ id: 'inflight' as SandboxId, createdAt: new Date().toISOString() }];

		const result = await reconciler.reconcile();

		expect(result.orphansReaped).toBe(0);
		expect(compute.destroyed).toEqual([]);
	});
});
