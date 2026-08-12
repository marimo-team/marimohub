import { describe, expect, it, vi } from 'vitest';
import type { IntegrationId, UserId } from '../../ids';
import { fakeComputeFrom, makeFakeSandbox } from '../../testing/fakes';
import { SandboxDataPreview } from './SandboxDataPreview';

const request = {
	bundle: {
		files: [{ path: '/tmp/marimohub-integrations/config.yaml', content: 'catalog: test' }],
		vars: { PYICEBERG_HOME: '/tmp/marimohub-integrations' },
		attachments: [
			{
				id: 'intg-aaaaaaaaaaaaaaaa' as IntegrationId,
				name: 'lake',
				kind: 'iceberg_rest',
				version: 1,
			},
		],
	},
	integration_name: 'lake',
	user_id: 'user-alice' as UserId,
	credential_vars: { AWS_ACCESS_KEY_ID: 'temporary' },
	namespace: ['sales'],
	table: 'orders',
	limit: 20,
};

const options = {
	image: 'preview:tested',
	maxConcurrent: 2,
	maxConcurrentPerUser: 1,
	startupTimeoutMs: 100,
	executionTimeoutMs: 100,
};

describe('SandboxDataPreview', () => {
	it('advertises only after its dedicated image passes preflight', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) => {
			calls.exec.push(command);
			return { success: true, stdout: '', stderr: '' };
		};
		const compute = fakeComputeFrom(instance);
		const preview = new SandboxDataPreview(compute, options);
		expect(preview.available()).toBe(false);

		await preview.check();

		expect(preview.available()).toBe(true);
		expect(calls.exec.at(-1)).toContain('import pyarrow, pyiceberg');
		expect(calls.destroy).toBe(1);
	});

	it('stays unavailable and destroys the sandbox when preflight fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) =>
			command === 'true'
				? { success: true, stdout: '', stderr: '' }
				: {
						success: false,
						stdout: '',
						stderr: 'missing module',
						error: { code: 'COMMAND_FAILED' },
					};
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);

		await expect(preview.check()).rejects.toThrow('does not provide PyIceberg and PyArrow');

		expect(preview.available()).toBe(false);
		expect(calls.destroy).toBe(1);
	});

	it('uses the dedicated image, injects WIF vars, and destroys after the scan', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) => {
			calls.exec.push(command);
			return command.includes('marimohub-data-preview.py')
				? {
						success: true,
						stdout: JSON.stringify({ columns: ['id'], rows: [[1]] }),
						stderr: '',
					}
				: { success: true, stdout: '', stderr: '' };
		};
		const create = vi.fn(() => instance);
		const compute = { ...fakeComputeFrom(instance), create };
		const preview = new SandboxDataPreview(compute, options);
		await preview.check();

		await expect(preview.preview(request)).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		expect(create).toHaveBeenLastCalledWith(expect.any(String), {
			reuse: false,
			image: 'preview:tested',
		});
		expect(calls.writeFile.map(({ path }) => path)).toEqual(
			expect.arrayContaining([
				'/tmp/marimohub-integrations/config.yaml',
				'/tmp/marimohub-data-preview.py',
				'/tmp/marimohub-data-preview-request.json',
			]),
		);
		expect(calls.setEnvVars.at(-1)).toEqual({
			PYICEBERG_HOME: '/tmp/marimohub-integrations',
			AWS_ACCESS_KEY_ID: 'temporary',
		});
		expect(calls.destroy).toBe(2);
	});

	it('rejects concurrent work for one user before creating another sandbox', async () => {
		const { instance } = makeFakeSandbox();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scans = 0;
		instance.exec = async (command) => {
			if (command.includes('marimohub-data-preview.py')) {
				scans++;
				await held;
				return { success: true, stdout: '{"columns":[],"rows":[]}', stderr: '' };
			}
			return { success: true, stdout: '', stderr: '' };
		};
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
		await preview.check();
		const first = preview.preview(request);
		await vi.waitFor(() => expect(scans).toBe(1));

		await expect(preview.preview(request)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
		expect(create).toHaveBeenCalledTimes(2);
		release();
		await first;
	});

	it('rejects work from another user when the deployment limit is full', async () => {
		const { instance } = makeFakeSandbox();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let scans = 0;
		instance.exec = async (command) => {
			if (command.includes('marimohub-data-preview.py')) {
				scans++;
				await held;
				return { success: true, stdout: '{"columns":[],"rows":[]}', stderr: '' };
			}
			return { success: true, stdout: '', stderr: '' };
		};
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview(
			{ ...fakeComputeFrom(instance), create },
			{ ...options, maxConcurrent: 1 },
		);
		await preview.check();
		const first = preview.preview(request);
		await vi.waitFor(() => expect(scans).toBe(1));

		await expect(
			preview.preview({ ...request, user_id: 'user-bob' as UserId }),
		).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
		expect(create).toHaveBeenCalledTimes(2);
		release();
		await first;
	});

	it('times out startup and destroys the sandbox', async () => {
		vi.useFakeTimers();
		try {
			const { instance, calls } = makeFakeSandbox();
			let preflightComplete = false;
			instance.exec = async (command) => {
				if (command.includes('import pyarrow')) {
					preflightComplete = true;
					return { success: true, stdout: '', stderr: '' };
				}
				if (preflightComplete && command === 'true') return new Promise(() => {});
				return { success: true, stdout: '', stderr: '' };
			};
			const preview = new SandboxDataPreview(fakeComputeFrom(instance), {
				...options,
				startupTimeoutMs: 10,
			});
			await preview.check();
			const timedOut = preview.preview(request);
			const rejection = expect(timedOut).rejects.toThrow('start in time');
			await vi.advanceTimersByTimeAsync(10);
			await rejection;
			expect(calls.destroy).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('times out execution, destroys the sandbox, and releases admission', async () => {
		vi.useFakeTimers();
		try {
			const { instance, calls } = makeFakeSandbox();
			instance.exec = async (command) => {
				if (command.includes('marimohub-data-preview.py')) return new Promise(() => {});
				return { success: true, stdout: '', stderr: '' };
			};
			const preview = new SandboxDataPreview(fakeComputeFrom(instance), {
				...options,
				executionTimeoutMs: 10,
			});
			await preview.check();
			const timedOut = preview.preview(request);
			const rejection = expect(timedOut).rejects.toThrow('finish in time');
			await vi.advanceTimersByTimeAsync(10);
			await rejection;
			expect(calls.destroy).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
