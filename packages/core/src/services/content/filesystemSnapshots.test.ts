import { describe, it, expect } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import type { FilesystemSnapshots, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import { ACTOR, makeFakeSandbox, setupTestEnv } from '../../testing';
import {
	captureFilesystemSnapshot,
	createOrRestoreSandbox,
	reapFilesystemSnapshots,
	resolveRestoreSnapshot,
} from './filesystemSnapshots';
import type { NotebookService } from './NotebookService';

/** A provider that implements the optional `FilesystemSnapshots` capability. */
function snapshotProvider(
	instance: SandboxInstance,
	opts: { captureId?: string; failCapture?: boolean } = {},
): SandboxProvider &
	FilesystemSnapshots & {
		created: string[];
		createdFrom: { id: string; snapshotId: string }[];
		deleted: string[];
	} {
	const created: string[] = [];
	const createdFrom: { id: string; snapshotId: string }[] = [];
	const deleted: string[] = [];
	return {
		filesystemSnapshotsEnabled: true,
		create: (id) => {
			created.push(id);
			return instance;
		},
		proxy: async () => null,
		createFromSnapshot(id, snapshotId) {
			createdFrom.push({ id, snapshotId });
			return instance;
		},
		async captureSnapshot() {
			if (opts.failCapture) throw new Error('snapshot api down');
			return { snapshotId: opts.captureId ?? 'snap_new', sizeBytes: 7 };
		},
		async deleteSnapshot(snapshotId) {
			deleted.push(snapshotId);
		},
		created,
		createdFrom,
		deleted,
	};
}

/** A provider WITHOUT the capability (every snapshot function must no-op). */
function plainProvider(instance: SandboxInstance): SandboxProvider & { created: string[] } {
	const created: string[] = [];
	return {
		create: (id) => {
			created.push(id);
			return instance;
		},
		proxy: async () => null,
		created,
	};
}

describe('filesystemSnapshots', () => {
	const sandboxId = createSandboxId();

	describe('createOrRestoreSandbox', () => {
		it('restores via createFromSnapshot when capable and a restore id is given', () => {
			const { instance } = makeFakeSandbox();
			const provider = snapshotProvider(instance);
			expect(createOrRestoreSandbox(provider, sandboxId, 'snap_x')).toBe(instance);
			expect(provider.createdFrom).toEqual([{ id: sandboxId, snapshotId: 'snap_x' }]);
			expect(provider.created).toEqual([]);
		});

		it('plain-creates when capable but no restore id is given', () => {
			const { instance } = makeFakeSandbox();
			const provider = snapshotProvider(instance);
			createOrRestoreSandbox(provider, sandboxId);
			expect(provider.createdFrom).toEqual([]);
			expect(provider.created).toEqual([sandboxId]);
		});

		it('plain-creates on a provider without the capability, even with a restore id', () => {
			const { instance } = makeFakeSandbox();
			const provider = plainProvider(instance);
			createOrRestoreSandbox(provider, sandboxId, 'snap_x');
			expect(provider.created).toEqual([sandboxId]);
		});

		it('passes reuse:false on a fresh plain create (skips the reconnect lookup)', () => {
			const { instance } = makeFakeSandbox();
			const createOpts: unknown[] = [];
			const provider: SandboxProvider = {
				create: (_id, options) => {
					createOpts.push(options);
					return instance;
				},
				proxy: async () => null,
			};
			createOrRestoreSandbox(provider, sandboxId);
			expect(createOpts).toEqual([{ reuse: false }]);
		});
	});

	describe('resolveRestoreSnapshot', () => {
		it('returns the stored pointer id for a capable provider', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			await env.notebooks.setFsSnapshot(project.id, nb.id, {
				snapshot_id: 'snap_1',
				captured_at: '2020-01-01T00:00:00.000Z',
			});

			const provider = snapshotProvider(makeFakeSandbox().instance);
			expect(await resolveRestoreSnapshot(provider, env.notebooks, project.id, nb.id)).toBe(
				'snap_1',
			);
		});

		it('returns undefined when capable but no pointer exists', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			const provider = snapshotProvider(makeFakeSandbox().instance);
			expect(
				await resolveRestoreSnapshot(provider, env.notebooks, project.id, nb.id),
			).toBeUndefined();
		});

		it('never reads the bucket for a provider without the capability', async () => {
			const provider = plainProvider(makeFakeSandbox().instance);
			// A NotebookService whose getFsSnapshot would throw proves it is not called.
			const notebooks = {
				getFsSnapshot: async () => {
					throw new Error('should not be called');
				},
			} as unknown as NotebookService;
			expect(
				await resolveRestoreSnapshot(provider, notebooks, createProjectId(), createNotebookId()),
			).toBeUndefined();
		});
	});

	describe('captureFilesystemSnapshot', () => {
		it('captures, persists the pointer, and GCs the previous snapshot', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			await env.notebooks.setFsSnapshot(project.id, nb.id, {
				snapshot_id: 'snap_old',
				captured_at: '2020-01-01T00:00:00.000Z',
			});

			const { instance } = makeFakeSandbox();
			const provider = snapshotProvider(instance, { captureId: 'snap_new' });
			await captureFilesystemSnapshot(provider, env.notebooks, instance, project.id, nb.id);

			expect((await env.notebooks.getFsSnapshot(project.id, nb.id))?.snapshot_id).toBe('snap_new');
			expect(provider.deleted).toEqual(['snap_old']);
		});

		it('is a no-op for a provider without the capability', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			const { instance } = makeFakeSandbox();
			await captureFilesystemSnapshot(
				plainProvider(instance),
				env.notebooks,
				instance,
				project.id,
				nb.id,
			);
			expect(await env.notebooks.getFsSnapshot(project.id, nb.id)).toBeNull();
		});

		it('swallows a capture failure and leaves the pointer untouched', async () => {
			const env = await setupTestEnv();
			const project = await env.projects.createProject({ name: 'P', description: 'd' }, ACTOR);
			const nb = await env.notebooks.createNotebook(
				project.id,
				{ title: 'N', description: 'd', code: 'c' },
				ACTOR,
			);
			await env.notebooks.setFsSnapshot(project.id, nb.id, {
				snapshot_id: 'snap_old',
				captured_at: '2020-01-01T00:00:00.000Z',
			});
			const { instance } = makeFakeSandbox();
			const provider = snapshotProvider(instance, { failCapture: true });
			await captureFilesystemSnapshot(provider, env.notebooks, instance, project.id, nb.id);

			expect((await env.notebooks.getFsSnapshot(project.id, nb.id))?.snapshot_id).toBe('snap_old');
			expect(provider.deleted).toEqual([]);
		});
	});

	describe('reapFilesystemSnapshots', () => {
		it('deletes every snapshot and returns the count for a capable provider', async () => {
			const provider = snapshotProvider(makeFakeSandbox().instance);
			const reaped = await reapFilesystemSnapshots(provider, [
				{ snapshot_id: 'a', captured_at: '2020-01-01T00:00:00.000Z' },
				{ snapshot_id: 'b', captured_at: '2020-01-02T00:00:00.000Z' },
			]);
			expect(reaped).toBe(2);
			expect(provider.deleted).toEqual(['a', 'b']);
		});

		it('reaps nothing on a provider without the capability', async () => {
			const provider = plainProvider(makeFakeSandbox().instance);
			expect(
				await reapFilesystemSnapshots(provider, [
					{ snapshot_id: 'a', captured_at: '2020-01-01T00:00:00.000Z' },
				]),
			).toBe(0);
		});
	});
});
