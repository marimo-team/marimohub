import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { paths } from '../../paths';
import type { FilesystemSnapshots, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import {
	ACTOR,
	makeFakeSandbox,
	makeLocalSource,
	makeSession,
	MemoryBucket,
	uid,
} from '../../testing';
import { CatalogService } from '../catalog/CatalogService';
import { resolveRestoreSnapshot } from '../content/filesystemSnapshots';
import { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { SessionRetirer } from './SessionRetirer';
import { SessionService } from './SessionService';

function snapshotProvider(
	instance: SandboxInstance,
	opts: { failCapture?: boolean } = {},
): SandboxProvider & FilesystemSnapshots {
	return {
		filesystemSnapshotsEnabled: true,
		create: () => instance,
		proxy: async () => null,
		createFromSnapshot: () => instance,
		captureSnapshot: async () => {
			if (opts.failCapture) throw new Error('snapshot unavailable');
			return { snapshotId: 'snapshot-after-takeover' };
		},
		deleteSnapshot: async () => {},
	};
}

describe('SessionRetirer', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let notebooks: NotebookService;
	const projectId = createProjectId();
	const notebookId = createNotebookId();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
		notebooks = new NotebookService(bucket, new CatalogService(bucket));
		vi.spyOn(notebooks, 'getNotebook').mockResolvedValue({ source: makeLocalSource() } as never);
		vi.spyOn(notebooks, 'commitSession').mockResolvedValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function persistentSession(overrides: Partial<Session> = {}): Promise<Session> {
		const session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			sandbox_id: createSandboxId(),
			editor_sandbox_sharing: 'exclusive',
			...overrides,
		});
		await bucket.put(paths.session(projectId, session.session_id), JSON.stringify(session));
		await sessions.claimEditor(projectId, notebookId, session.session_id, 'exclusive');
		return session;
	}

	function retirer(compute: SandboxProvider): SessionRetirer {
		return new SessionRetirer({
			sessions,
			notebooks,
			compute,
			bucket,
			persistWorkspace: 'source',
		});
	}

	async function reserveTakeover(session: Session, takeoverId: string): Promise<void> {
		await sessions.reserveTakeover(projectId, notebookId, {
			takeoverId,
			requestedBy: uid('user_01HXY00000000000000000001'),
			expectedHolder: session.session_id,
			expectedActivity: 'idle',
		});
	}

	it('retains the editor claim until a failed destroy is later confirmed', async () => {
		const { instance } = makeFakeSandbox();
		let destroyFails = true;
		instance.destroy = async () => {
			if (destroyFails) throw new Error('compute unavailable');
		};
		const session = await persistentSession();
		await sessions.beginTerminating(projectId, session.session_id);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await service.retire(session);

		const terminated = await sessions.getSession(projectId, session.session_id);
		expect(terminated.status).toBe('terminated');
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: session.session_id,
		});

		destroyFails = false;
		expect(await service.reclaim(terminated, false)).toBe(true);
		expect(await sessions.getEditorClaim(projectId, notebookId)).toMatchObject({
			session_id: null,
		});
	});

	it('captures an owner-scoped filesystem snapshot during takeover', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const session = await persistentSession();
		const nextOwner = uid('user_01HXY00000000000000000001');

		await retirer(compute).retireForTakeover(session, nextOwner);

		const snapshot = await notebooks.getFsSnapshot(projectId, notebookId);
		expect(snapshot).toMatchObject({
			snapshot_id: 'snapshot-after-takeover',
			owner_user_id: ACTOR,
		});
		expect(
			await resolveRestoreSnapshot(compute, notebooks, projectId, notebookId, {
				sharing: 'exclusive',
				userId: nextOwner,
			}),
		).toBeUndefined();
		expect(
			await resolveRestoreSnapshot(compute, notebooks, projectId, notebookId, {
				sharing: 'exclusive',
				userId: ACTOR,
			}),
		).toEqual(snapshot ?? undefined);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('skips the filesystem snapshot when takeover persistence is ineligible', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = snapshotProvider(instance);
		const captureSnapshot = vi.spyOn(compute, 'captureSnapshot');
		const session = await persistentSession();
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockResolvedValue(false);

		await retirer(compute).retireForTakeover(session, uid('user_01HXY00000000000000000001'));

		expect(captureSnapshot).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(1);
	});

	it('does not continue takeover teardown after losing the terminating transition', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		vi.spyOn(sessions, 'beginTerminating').mockResolvedValue({
			session: { ...session, status: 'terminating' },
			transitioned: false,
		});

		await expect(
			retirer({ create: () => instance, proxy: async () => null }).retireForTakeover(
				session,
				uid('user_01HXY00000000000000000001'),
			),
		).rejects.toThrow('already started terminating');
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(0);
	});

	it('still destroys the takeover sandbox when filesystem snapshot capture fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		await retirer(snapshotProvider(instance, { failCapture: true })).retireForTakeover(
			session,
			uid('user_01HXY00000000000000000001'),
		);

		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('keeps a takeover draining when its final strict capture fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'capture-retry');
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockRejectedValueOnce(new Error('final save failed'));
		const service = retirer({ create: () => instance, proxy: async () => null });

		await expect(
			service.retireForTakeover(session, uid('user_01HXY00000000000000000001')),
		).rejects.toThrow('final save failed');
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminating');
		expect(calls.destroy).toBe(0);

		await sessions.setTakeoverPhase(projectId, notebookId, 'capture-retry', 'draining');
		capture.mockResolvedValueOnce(true);
		expect(await service.completeTakeoverDrain(session, 'capture-retry', 'lease-retry')).toBe(true);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('resumes after destruction when the terminal status write fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'terminal-retry');
		const capture = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');
		vi.spyOn(sessions, 'markTerminated').mockRejectedValueOnce(
			new Error('session record unavailable'),
		);
		const service = retirer({ create: () => instance, proxy: async () => null });

		await expect(
			service.retireForTakeover(session, uid('user_01HXY00000000000000000001')),
		).rejects.toThrow('session record unavailable');
		const draining = await sessions.getSession(projectId, session.session_id);
		expect(draining).toMatchObject({
			status: 'terminating',
			takeover_capture_completed_at: expect.any(String),
			sandbox_reclaimed_at: expect.any(String),
		});

		await sessions.setTakeoverPhase(projectId, notebookId, 'terminal-retry', 'draining');
		expect(await service.completeTakeoverDrain(draining, 'terminal-retry', 'lease-retry')).toBe(
			true,
		);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getSession(projectId, session.session_id)).status).toBe('terminated');
	});

	it('serializes concurrent retries of a draining takeover', async () => {
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'concurrent-retry');
		await sessions.setTakeoverPhase(projectId, notebookId, 'concurrent-retry', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockImplementation(async () => {
				captureStarted();
				await captureGate;
				return true;
			});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'concurrent-retry', 'lease-first');
		await started;
		await expect(
			service.completeTakeoverDrain(session, 'concurrent-retry', 'lease-second'),
		).resolves.toBe(false);
		releaseCapture();
		await expect(first).resolves.toBe(true);

		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
	});

	it('renews the drain lease throughout a capture lasting longer than its deadline', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'long-capture');
		await sessions.setTakeoverPhase(projectId, notebookId, 'long-capture', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		const capture = vi
			.spyOn(SandboxProvisioner.prototype, 'captureSession')
			.mockImplementation(async () => {
				captureStarted();
				await captureGate;
				return true;
			});
		const renew = vi.spyOn(sessions, 'renewTakeoverDrainLease');
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'long-capture', 'lease-first');
		await started;
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		await expect(
			service.completeTakeoverDrain(session, 'long-capture', 'lease-second'),
		).resolves.toBe(false);
		releaseCapture();
		await expect(first).resolves.toBe(true);

		expect(renew).toHaveBeenCalled();
		expect(capture).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer?.phase).toBe('ready');
	});

	it('renews the drain lease throughout sandbox destruction', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const originalDestroy = instance.destroy.bind(instance);
		let releaseDestroy!: () => void;
		let destroyStarted!: () => void;
		const destroyGate = new Promise<void>((resolve) => {
			releaseDestroy = resolve;
		});
		const started = new Promise<void>((resolve) => {
			destroyStarted = resolve;
		});
		instance.destroy = async () => {
			destroyStarted();
			await destroyGate;
			await originalDestroy();
		};
		const session = await persistentSession();
		await reserveTakeover(session, 'long-destroy');
		await sessions.setTakeoverPhase(projectId, notebookId, 'long-destroy', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const first = service.completeTakeoverDrain(session, 'long-destroy', 'lease-first');
		await started;
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		await expect(
			service.completeTakeoverDrain(session, 'long-destroy', 'lease-second'),
		).resolves.toBe(false);
		releaseDestroy();
		await expect(first).resolves.toBe(true);

		expect(notebooks.commitSession).toHaveBeenCalledTimes(1);
		expect(calls.destroy).toBe(1);
	});

	it('yields a drain that makes no progress for thirty minutes', async () => {
		vi.useFakeTimers();
		const { instance, calls } = makeFakeSandbox();
		const session = await persistentSession();
		await reserveTakeover(session, 'stuck-capture');
		await sessions.setTakeoverPhase(projectId, notebookId, 'stuck-capture', 'draining');
		await sessions.beginTerminating(projectId, session.session_id, {
			reason: 'takeover',
			by: uid('user_01HXY00000000000000000001'),
		});
		let releaseCapture!: () => void;
		let captureStarted!: () => void;
		const captureGate = new Promise<void>((resolve) => {
			releaseCapture = resolve;
		});
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve;
		});
		vi.spyOn(SandboxProvisioner.prototype, 'captureSession').mockImplementation(async () => {
			captureStarted();
			await captureGate;
			return true;
		});
		const service = retirer({ create: () => instance, proxy: async () => null });

		const stuck = service.completeTakeoverDrain(session, 'stuck-capture', 'lease-stuck');
		await started;
		await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
		await expect(
			sessions.acquireTakeoverDrainLease(projectId, notebookId, 'stuck-capture', 'lease-recovery'),
		).resolves.toBe(true);

		releaseCapture();
		await expect(stuck).rejects.toThrow('no longer owned');
		expect(calls.destroy).toBe(0);
		expect((await sessions.getEditorClaim(projectId, notebookId))?.transfer).toMatchObject({
			drain_lease_id: 'lease-recovery',
		});
	});
});
