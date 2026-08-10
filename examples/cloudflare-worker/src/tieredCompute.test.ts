import { describe, expect, it, vi } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import type { ActiveSandbox, SandboxInstance, SandboxProvider } from '@marimo-hub/core/ports';
import { TieredComputeProvider } from './tieredCompute';

const SANDBOX_ID = 'sb-test' as SandboxId;

function fakeInstance(supportsBucketMount: boolean): SandboxInstance {
	return {
		supportsBucketMount,
		exec: async () => ({ success: true as const, stdout: '', stderr: '' }),
	} as unknown as SandboxInstance;
}

function fakeProvider(opts: { flag: boolean; reachable?: boolean }): SandboxProvider {
	return {
		create: () => fakeInstance(opts.flag),
		proxy: async () => null,
		listActive: async (): Promise<ActiveSandbox[]> => {
			if (opts.reachable === false) throw new Error('unreachable');
			return [];
		},
	} as SandboxProvider;
}

// The provisioner reads `supportsBucketMount` to decide between hard-failing a
// mount and copying files. The tiered wrapper must forward the pinned backend's
// answer — a wrapper that erases it silently re-enables mount-failure fallback
// on the mount-capable (Cloudflare) branch.
describe('TieredSandboxInstance supportsBucketMount', () => {
	it('is undefined until the backend is pinned (legacy provisioner path)', () => {
		const tiered = new TieredComputeProvider(
			fakeProvider({ flag: false }),
			fakeProvider({ flag: true }),
		);
		expect(tiered.create(SANDBOX_ID).supportsBucketMount).toBeUndefined();
	});

	it('reflects the primary backend once an operation pins it', async () => {
		const tiered = new TieredComputeProvider(
			fakeProvider({ flag: false }),
			fakeProvider({ flag: true }),
		);
		const instance = tiered.create(SANDBOX_ID);
		await instance.exec('true');
		expect(instance.supportsBucketMount).toBe(false);
	});

	it('reflects the mount-capable fallback when the primary is unreachable', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const tiered = new TieredComputeProvider(
			fakeProvider({ flag: false, reachable: false }),
			fakeProvider({ flag: true }),
		);
		const instance = tiered.create(SANDBOX_ID);
		await instance.exec('true');
		expect(instance.supportsBucketMount).toBe(true);
		vi.restoreAllMocks();
	});
});
