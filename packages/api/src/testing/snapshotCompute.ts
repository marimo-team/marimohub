import type { FilesystemSnapshots, SandboxInstance } from '@marimo-hub/core';
import { fakeComputeFrom, makeFakeSandbox } from '@marimo-hub/core/testing';
import { vi } from 'vitest';

export function makeFakeSnapshotCompute(instance: SandboxInstance = makeFakeSandbox().instance) {
	return {
		...fakeComputeFrom(instance),
		filesystemSnapshotsEnabled: true,
		createFromSnapshot: vi.fn<FilesystemSnapshots['createFromSnapshot']>(() => instance),
		captureSnapshot: vi.fn<FilesystemSnapshots['captureSnapshot']>(async () => ({
			snapshotId: 'unused',
		})),
		deleteSnapshot: vi.fn<FilesystemSnapshots['deleteSnapshot']>(async () => {}),
	};
}
