import type { NotebookId, ProjectId, SandboxId } from '../../ids';
import { asFilesystemSnapshots } from '../../ports/sandbox';
import type { ComputeResources, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { FsSnapshot } from '../../schema';
import type { NotebookService } from './NotebookService';

/**
 * Orchestration for the optional `FilesystemSnapshots` capability — free functions
 * composed into the sandbox lifecycle, mirroring `sandboxFiles.ts`
 * (`captureWorkspace` / `restoreWorkspace`). Each is capability-gated via
 * `asFilesystemSnapshots` and a clean no-op on backends that lack it, so the
 * provisioner, the session route, and the maintenance cron stay snapshot-agnostic
 * and just call these by name.
 *
 * The per-notebook pointer is persisted by `NotebookService` (`get/setFsSnapshot`,
 * the `fs_snapshot.json` sidecar); these functions only orchestrate.
 */

/**
 * Create the session sandbox, booting it FROM a snapshot when the provider supports
 * snapshots and a restore id is given; otherwise a plain create. The restore id is
 * resolved earlier by {@link resolveRestoreSnapshot}.
 */
export function createOrRestoreSandbox(
	provider: SandboxProvider,
	id: SandboxId,
	restoreSnapshotId?: string,
	image?: string,
	resources?: ComputeResources,
): SandboxInstance {
	const fs = asFilesystemSnapshots(provider);
	// reuse: false — this id is brand new, so the adapter's reconnect lookup can
	// never match and would just cost a round-trip on the critical path.
	// The snapshot branch ignores `image`: a snapshot boots from the image it was
	// captured on, so a base-image change only applies once no restore pointer exists.
	return fs && restoreSnapshotId
		? fs.createFromSnapshot(id, restoreSnapshotId)
		: provider.create(id, { reuse: false, image, resources });
}

/**
 * Resolve the snapshot id to restore a notebook from, or `undefined`. The pointer is
 * only read when the backend supports snapshots, so a non-snapshot backend never pays
 * a bucket round-trip and a pointer left by a prior backend is simply ignored.
 */
export async function resolveRestoreSnapshot(
	provider: SandboxProvider,
	notebooks: NotebookService,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<FsSnapshot | undefined> {
	if (!asFilesystemSnapshots(provider)) return undefined;
	return (await notebooks.getFsSnapshot(projectId, notebookId)) ?? undefined;
}

/**
 * Capture the sandbox filesystem, persist the new pointer (latest-wins), and GC the
 * previous snapshot. Best-effort and capability-gated: any failure is logged but never
 * thrown, so teardown's `destroy()` is never blocked (a lingering sandbox is the more
 * expensive failure). Call after the session's state is final, before `destroy()`.
 */
export async function captureFilesystemSnapshot(
	provider: SandboxProvider,
	notebooks: NotebookService,
	sandbox: SandboxInstance,
	projectId: ProjectId,
	notebookId: NotebookId,
	compute?: Pick<FsSnapshot, 'compute_profile' | 'compute_resources'>,
): Promise<void> {
	const fs = asFilesystemSnapshots(provider);
	if (!fs) return;
	try {
		const { snapshotId, sizeBytes } = await fs.captureSnapshot(sandbox);
		const { previous } = await notebooks.setFsSnapshot(projectId, notebookId, {
			snapshot_id: snapshotId,
			captured_at: new Date().toISOString(),
			...(sizeBytes !== undefined ? { size_bytes: sizeBytes } : {}),
			...compute,
		});
		if (previous && previous.snapshot_id !== snapshotId) {
			await fs.deleteSnapshot(previous.snapshot_id); // latest-wins GC
		}
	} catch (err) {
		console.error(`fs snapshot capture failed for notebook ${notebookId}:`, err);
	}
}

/**
 * Reclaim provider-native snapshots orphaned by notebook deletion (their ids are not
 * in the bucket, so a subtree wipe can't free them). No-op without the capability.
 * Best-effort per snapshot; returns the number actually reaped.
 */
export async function reapFilesystemSnapshots(
	provider: SandboxProvider,
	snapshots: readonly FsSnapshot[],
): Promise<number> {
	const fs = asFilesystemSnapshots(provider);
	if (!fs) return 0;
	let reaped = 0;
	for (const snap of snapshots) {
		try {
			await fs.deleteSnapshot(snap.snapshot_id);
			reaped++;
		} catch {
			// Best-effort: a later sweep retries if the snapshot survives.
		}
	}
	return reaped;
}
