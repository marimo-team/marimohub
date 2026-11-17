import { expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { fakeComputeFrom, makeFakeSandbox } from '../../testing';
import { SandboxProvisioner } from './SandboxProvisioner';

it.each([false, true])(
	'reports boot and provisioning stages without relying on the observer (throws: %s)',
	async (throws) => {
		const { instance } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance);
		const create = compute.create.bind(compute);
		vi.spyOn(compute, 'create').mockImplementation((id, options) => {
			options?.onProgress?.({ phase: 'allocating', detail: 'Waiting in queue' });
			return create(id, options);
		});
		const onProgress = vi.fn(() => {
			if (throws) throw new Error('observer failed');
		});
		const provisioner = new SandboxProvisioner(compute);
		const options = {
			sandboxId: createSandboxId(),
			projectId: createProjectId(),
			notebookId: createNotebookId(),
			hostname: 'localhost',
			bucket: { name: 'test', endpoint: 'https://bucket.test' },
			onProgress,
		};
		const bootedSandbox = provisioner.boot(options);
		expect(onProgress).toHaveBeenCalledWith({ phase: 'allocating', detail: 'Waiting in queue' });
		await provisioner.provision({ ...options, bootedSandbox });
		expect(onProgress).toHaveBeenCalledWith({ phase: 'workspace' });
		expect(onProgress).toHaveBeenLastCalledWith({ phase: 'starting' });
	},
);
