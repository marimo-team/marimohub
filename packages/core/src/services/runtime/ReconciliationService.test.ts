import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId, createVersionId } from '../../ids';
import type { SandboxId } from '../../ids';
import { paths } from '../../paths';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import { ACTOR, makeLocalSource, MemoryBucket, RecordingCompute } from '../../testing';
import { CatalogService } from '../catalog/CatalogService';
import { NotebookService } from '../content/NotebookService';
import { ReconciliationService } from './ReconciliationService';
import { SessionService } from './SessionService';

describe('ReconciliationService', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let notebooks: NotebookService;
	let compute: RecordingCompute;
	let reconciler: ReconciliationService;

	const notebookId = createNotebookId();
	const projectId = createProjectId();
	// Sandbox ids must be well-formed: the session schema validates `sandbox_id`,
	// and the reconciler matches it against the provider's reported ids.
	const terminalId = createSandboxId();
	const goneId = createSandboxId();
	const healthyId = createSandboxId();
	const orphanId = createSandboxId();
	const inflightId = createSandboxId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
		notebooks = new NotebookService(bucket, new CatalogService(bucket));
		compute = new RecordingCompute();
		reconciler = new ReconciliationService(sessions, notebooks, compute, bucket, 'source');
		// Rule 1 commits the session's edits before destroying the sandbox; stub the
		// notebook metadata (local source → edits persist) and commitSession so the
		// cases that don't assert it don't need a populated catalog. The teardown
		// wiring itself is asserted in its own test below.
		vi.spyOn(notebooks, 'getNotebook').mockResolvedValue({ source: makeLocalSource() } as never);
		vi.spyOn(notebooks, 'commitSession').mockResolvedValue({
			versionId: createVersionId(),
			newVersion: false,
			capturedHtml: false,
			capturedSession: false,
		});
	});

	const createSession = (sandboxId: SandboxId) =>
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
		const r = new ReconciliationService(sessions, notebooks, noList, bucket, 'source');

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
		const session = await createSession(terminalId);
		await sessions.terminate(projectId, session.session_id);
		compute.active = [{ id: terminalId }];

		const result = await reconciler.reconcile();

		expect(result.reclaimed).toBe(1);
		expect(compute.destroyed).toEqual([terminalId]);
	});

	it('Rule 1: commits the session (with the right actor) before destroying', async () => {
		const session = await createSession(terminalId);
		await sessions.terminate(projectId, session.session_id);
		compute.active = [{ id: terminalId }];

		await reconciler.reconcile();

		// Regression: teardown must receive the NotebookService and the session's
		// user as actor. Previously it got the bucket and a boolean, so the
		// save-on-reap commit silently never ran.
		expect(vi.mocked(notebooks.commitSession)).toHaveBeenCalledWith(
			projectId,
			notebookId,
			expect.anything(),
			ACTOR,
		);
		expect(compute.destroyed).toEqual([terminalId]);
	});

	it('Rule 2: marks a record failed when its sandbox has vanished', async () => {
		const session = await createSession(goneId);
		await sessions.heartbeat(projectId, session.session_id); // -> running
		compute.active = []; // sandbox is no longer live

		const result = await reconciler.reconcile();

		expect(result.markedDead).toBe(1);
		expect(compute.destroyed).toEqual([]);
		const stored = await sessions.getSession(projectId, session.session_id);
		expect(stored.status).toBe('failed');
	});

	it('leaves a healthy running session untouched', async () => {
		const session = await createSession(healthyId);
		await sessions.heartbeat(projectId, session.session_id); // -> running
		compute.active = [{ id: healthyId }];

		const result = await reconciler.reconcile();

		expect(result).toMatchObject({ reclaimed: 0, markedDead: 0, orphansReaped: 0 });
		expect(compute.destroyed).toEqual([]);
		const stored = await sessions.getSession(projectId, session.session_id);
		expect(stored.status).toBe('running');
	});

	it('Rule 3: reaps an orphan sandbox with no record past the grace window', async () => {
		compute.active = [{ id: orphanId, createdAt: new Date(Date.now() - 60_000).toISOString() }];

		const result = await reconciler.reconcile({ orphanGraceMs: 1_000 });

		expect(result.orphansReaped).toBe(1);
		expect(result.orphanSandboxIds).toEqual([orphanId]);
		expect(compute.destroyed).toEqual([orphanId]);
	});

	it('Rule 3: leaves a fresh recordless sandbox alone (within grace window)', async () => {
		compute.active = [{ id: inflightId, createdAt: new Date().toISOString() }];

		const result = await reconciler.reconcile();

		expect(result.orphansReaped).toBe(0);
		expect(compute.destroyed).toEqual([]);
	});

	it('Rule 3: applies the grace window to an orphan with no createdAt', async () => {
		// Provisioning writes the record before creating the sandbox, so a brand-new
		// sandbox the provider has not yet timestamped is an in-flight provision, not
		// a leak. With unknown age we cannot prove it is older than the grace window,
		// so it must be left alone — not reaped on sight.
		compute.active = [{ id: inflightId }];

		const result = await reconciler.reconcile({ orphanGraceMs: 1_000 });

		expect(result.orphansReaped).toBe(0);
		expect(compute.destroyed).toEqual([]);
		// First sighting is recorded durably so the grace is anchored, not forgotten.
		expect(await bucket.get(paths.reconcileOrphan(inflightId))).not.toBeNull();
	});

	it('Rule 3: reaps a timestamp-less orphan once its first-seen marker exceeds the grace', async () => {
		compute.active = [{ id: inflightId }]; // no createdAt
		// A prior sighting old enough that the grace has since elapsed — the leak is
		// bounded, not indefinite.
		await bucket.put(
			paths.reconcileOrphan(inflightId),
			JSON.stringify({ first_seen: Date.now() - 60_000 }),
		);

		const result = await reconciler.reconcile({ orphanGraceMs: 1_000 });

		expect(result.orphansReaped).toBe(1);
		expect(compute.destroyed).toEqual([inflightId]);
		// The marker is cleaned up after the orphan is reaped.
		expect(await bucket.get(paths.reconcileOrphan(inflightId))).toBeNull();
	});

	it('Rule 3: resets a future-dated marker so a bad clock cannot defer reaping forever', async () => {
		compute.active = [{ id: inflightId }]; // no createdAt
		// A marker dated in the future (clock skew / tampering) would otherwise push
		// the grace out indefinitely.
		await bucket.put(
			paths.reconcileOrphan(inflightId),
			JSON.stringify({ first_seen: Date.now() + 3_600_000 }),
		);

		const result = await reconciler.reconcile({ orphanGraceMs: 1_000 });

		// Not reaped on sight, but the marker is rewritten to a non-future time so a
		// later sweep will reap it within one grace window.
		expect(result.orphansReaped).toBe(0);
		const marker = await (await bucket.get(paths.reconcileOrphan(inflightId)))!.json<{
			first_seen: number;
		}>();
		expect(marker.first_seen).toBeLessThanOrEqual(Date.now());
	});

	it('Rule 1: force-destroys and still counts reclaimed when teardown throws', async () => {
		const session = await createSession(terminalId);
		await sessions.terminate(projectId, session.session_id);
		compute.active = [{ id: terminalId }];

		// Save-on-reap can reject (bucket/sandbox RPC failure); the reconciler must
		// still guarantee the sandbox dies and count it reclaimed.
		const provisioner = (
			reconciler as unknown as { provisioner: { teardown: () => Promise<void> } }
		).provisioner;
		vi.spyOn(provisioner, 'teardown').mockRejectedValue(new Error('teardown boom'));

		const result = await reconciler.reconcile();

		expect(result.reclaimed).toBe(1);
		expect(compute.destroyed).toEqual([terminalId]);
	});

	it('Rule 1: reclaims a lingering sandbox behind a terminating record', async () => {
		const session = await createSession(goneId);
		await sessions.heartbeat(projectId, session.session_id); // -> running
		await sessions.beginTerminating(projectId, session.session_id); // -> terminating
		// Teardown stalled/crashed: the sandbox is still live and billing while the
		// record sits in `terminating`. The provider-truth net must destroy it.
		compute.active = [{ id: goneId }];

		const result = await reconciler.reconcile();

		expect(result.reclaimed).toBe(1);
		expect(compute.destroyed).toEqual([goneId]);
	});

	it('Rule 2 does not misfire on a terminating record whose sandbox vanished', async () => {
		const session = await createSession(healthyId);
		await sessions.heartbeat(projectId, session.session_id); // -> running
		await sessions.beginTerminating(projectId, session.session_id); // -> terminating
		compute.active = []; // sandbox already gone

		const result = await reconciler.reconcile();

		// An explicit stop must not be downgraded to `failed`.
		expect(result.markedDead).toBe(0);
		expect(compute.destroyed).toEqual([]);
		const stored = await sessions.getSession(projectId, session.session_id);
		expect(stored.status).toBe('terminating');
	});
});
