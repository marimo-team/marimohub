import { describe, it, expect } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../ids';
import { paths } from '../paths';
import { EXPOSED_URL, fakeComputeFrom, makeFakeSandbox, MemoryBucket } from '../testing';
import { SandboxProvisioner, type BucketConfig } from './SandboxProvisioner';

const MOUNT_PATH = '/workspace/notebooks';

const bucketConfig: BucketConfig = {
	name: 'test-bucket',
	endpoint: 'https://r2.example',
};

describe('SandboxProvisioner', () => {
	const projectId = createProjectId();
	const notebookId = createNotebookId();
	const sandboxId = createSandboxId();

	describe('provision', () => {
		it('happy path with mount: usedFallback false, returns exposed url, starts marimo on port 2718', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
			});

			expect(result.usedFallback).toBe(false);
			expect(result.url).toBe(EXPOSED_URL);
			expect(result.sandbox).toBe(instance);

			// Reachability check ran.
			expect(calls.exec).toContain('true');
			// Bucket was mounted (no fallback file copy).
			expect(calls.mountBucket).toHaveLength(1);
			expect(calls.writeFile).toHaveLength(0);

			// marimo was started on port 2718.
			expect(calls.startProcess).toHaveLength(1);
			expect(calls.startProcess[0].cmd).toContain('marimo edit');
			expect(calls.startProcess[0].cmd).toContain('2718');
			expect(calls.waitForPort).toEqual([2718]);
			expect(calls.exposePort[0].port).toBe(2718);
			expect(calls.exposePort[0].options.token).toBe(sandboxId);
		});

		it('fallback path: mountBucket throws -> usedFallback true, loadNotebookFiles writes files', async () => {
			const { instance, calls } = makeFakeSandbox({ failMount: true });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			// Seed the bucket handle so the fallback copy has files to load.
			const bucketHandle = new MemoryBucket();
			const nb = paths.project(projectId).notebook(notebookId);
			await bucketHandle.put(nb.code, 'import marimo as mo');
			await bucketHandle.put(nb.deps, '[project]\nname = "nb"');

			const result = await provisioner.provision({
				sandboxId,
				projectId,
				notebookId,
				hostname: 'localhost',
				bucket: bucketConfig,
				bucketHandle,
			});

			expect(result.usedFallback).toBe(true);
			expect(result.url).toBe(EXPOSED_URL);

			// Fallback wrote both notebook files into the mount path.
			const written = calls.writeFile.map((w) => w.path);
			expect(written).toContain(`${MOUNT_PATH}/notebook.py`);
			expect(written).toContain(`${MOUNT_PATH}/pyproject.toml`);
			// marimo still started after the fallback copy.
			expect(calls.startProcess).toHaveLength(1);
		});

		it('unreachable sandbox: exec("true") throws -> provision rejects with "not available"', async () => {
			const { instance, calls } = makeFakeSandbox({ failExec: 'true' });
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));

			await expect(
				provisioner.provision({
					sandboxId,
					projectId,
					notebookId,
					hostname: 'localhost',
					bucket: bucketConfig,
				}),
			).rejects.toThrow(/not available/i);

			// Never got past the reachability check.
			expect(calls.mountBucket).toHaveLength(0);
			expect(calls.startProcess).toHaveLength(0);
		});
	});

	describe('teardown', () => {
		it('usedFallback true: saves notebook files back then destroys', async () => {
			const nb = paths.project(projectId).notebook(notebookId);
			const { instance, calls } = makeFakeSandbox({
				files: {
					[`${MOUNT_PATH}/notebook.py`]: 'import marimo as mo  # edited',
					[`${MOUNT_PATH}/pyproject.toml`]: '[project]\nname = "edited"',
				},
			});
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucket = new MemoryBucket();

			await provisioner.teardown(instance, bucket, projectId, notebookId, true);

			// Read both files out of the sandbox.
			expect(calls.readFile).toContain(`${MOUNT_PATH}/notebook.py`);
			expect(calls.readFile).toContain(`${MOUNT_PATH}/pyproject.toml`);
			// Wrote them back to the bucket.
			expect(await (await bucket.get(nb.code))?.text()).toBe('import marimo as mo  # edited');
			expect(await (await bucket.get(nb.deps))?.text()).toBe('[project]\nname = "edited"');
			// Destroyed after saving.
			expect(calls.destroy).toBe(1);
		});

		it('usedFallback false: only destroys (no save)', async () => {
			const { instance, calls } = makeFakeSandbox();
			const provisioner = new SandboxProvisioner(fakeComputeFrom(instance));
			const bucket = new MemoryBucket();

			await provisioner.teardown(instance, bucket, projectId, notebookId, false);

			expect(calls.readFile).toHaveLength(0);
			expect(calls.destroy).toBe(1);
		});
	});
});
