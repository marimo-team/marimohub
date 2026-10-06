import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../errors';
import { createSandboxId } from '../ids';
import { listFilesFailure } from '../ports/sandbox';
import { makeFakeSandbox, makeFsSandbox, RecordingCompute } from './fakes';
import { expectExecResult } from './resultAssertions';

describe('RecordingCompute', () => {
	it('fails a missing or stopped sandbox on first use without creating one', async () => {
		const compute = new RecordingCompute();
		const id = createSandboxId();
		compute.active = [{ id }];
		const create = vi.spyOn(compute, 'create');
		const missing = compute.connectExisting(createSandboxId());
		await expect(missing.exec('true')).rejects.toThrow(NotFoundError);
		const stopped = compute.connectExisting(id);
		compute.active = [];
		await expect(stopped.readFile('/workspace/notebook.py')).rejects.toThrow(NotFoundError);
		await expect(stopped.listFiles('/workspace')).rejects.toThrow(NotFoundError);
		expect(create).not.toHaveBeenCalled();
		expect(compute.destroyed).toEqual([]);
	});

	it('attaches to an active sandbox and retains idempotent teardown for missing IDs', async () => {
		const compute = new RecordingCompute();
		const id = createSandboxId();
		compute.active = [{ id }];
		await expect(compute.connectExisting(id).readFile('/missing')).resolves.toMatchObject({
			success: false,
			error: { code: 'NOT_FOUND' },
		});
		compute.active = [];
		await compute.create(id).destroy();
		await compute.create(id).destroy();
		expect(compute.destroyed).toEqual([id, id]);
	});

	it('reports an idle kernel for the activity probe and rejects other commands', async () => {
		const compute = new RecordingCompute();
		const id = createSandboxId();
		compute.active = [{ id }];
		const sandbox = compute.connectExisting(id);
		expectExecResult(await sandbox.exec('curl http://localhost/api/status/connections'), {
			success: true,
			stdout: '0',
		});
		expectExecResult(await sandbox.exec('unhandled command'), { success: false });
	});
});

describe('makeFsSandbox', () => {
	it('returns NOT_A_DIRECTORY when listFiles receives a file path', async () => {
		const { instance } = makeFsSandbox({ files: { 'notebook.py': 'print(1)' } });

		await expect(instance.listFiles('/workspace/notebook.py')).resolves.toEqual(
			listFilesFailure('NOT_A_DIRECTORY'),
		);
	});

	it('lists relative and absolute directory paths consistently', async () => {
		const { instance } = makeFsSandbox({ files: { 'dir/notebook.py': 'print(1)' } });

		const relative = await instance.listFiles('dir');
		const absolute = await instance.listFiles('/workspace/dir');

		expect(relative).toEqual(absolute);
		expect(relative.files).toHaveLength(1);
	});
});

describe.each([
	['recording', () => makeFakeSandbox({ files: { '/workspace/present': 'data' } }).instance],
	['filesystem', () => makeFsSandbox({ files: { present: 'data' } }).instance],
] as const)('%s bounded reads', (_name, makeInstance) => {
	it.each([100.5, 2 ** 31 - 1])('accepts a supported timeout: %s', async (timeoutMs) => {
		const result = await makeInstance().readFileBounded!('/workspace/present', {
			maxBytes: 4,
			timeoutMs,
		});
		expect(result.success).toBe(true);
	});
	it('rejects invalid limits even for a readable file, before a legacy read', async () => {
		const instance = makeInstance();
		expect(
			(await instance.readFileBounded!('/workspace/present', { maxBytes: 4, timeoutMs: 100 }))
				.success,
		).toBe(true);
		const legacy = vi.spyOn(instance, 'readFile');
		for (const options of [
			{ maxBytes: -1, timeoutMs: 100 },
			{ maxBytes: Number.NaN, timeoutMs: 100 },
			{ maxBytes: 4, timeoutMs: 0 },
			{ maxBytes: 4, timeoutMs: 2 ** 31 },
			{ maxBytes: Number.MAX_SAFE_INTEGER, timeoutMs: 100 },
		]) {
			expect(await instance.readFileBounded!('/workspace/present', options)).toMatchObject({
				success: false,
				error: { code: 'READ_FAILED' },
			});
		}
		expect(legacy).not.toHaveBeenCalled();
	});
});
