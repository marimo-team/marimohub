import { describe, expect, it, vi } from 'vitest';
import type { IntegrationId, SessionId } from '../../../ids';
import { fakeComputeFrom, makeFakeSandbox } from '../../../testing/fakes';
import type { PythonPreviewProgram } from './programs';
import { SandboxDataPreview } from './SandboxDataPreview';

const program: PythonPreviewProgram = {
	script: 'print("{\\"columns\\":[\\"id\\"],\\"rows\\":[[1]]}")',
	maxRows: 20,
	input: { namespace: ['sales'], table: 'orders', limit: 20 },
	render: {
		files: [{ path: 'config.json', content: '{}' }],
		env: { PYICEBERG_HOME: '/tmp/marimohub-integrations' },
	},
	integration: {
		id: 'intg-aaaaaaaaaaaaaaaa' as IntegrationId,
		name: 'lake',
		kind: 'iceberg_rest',
		version: 1,
	},
	sessionId: 'sess-aaaaaaaaaaaaaaaa' as SessionId,
	credentialVars: { AWS_ACCESS_KEY_ID: 'temporary' },
};

const options = {
	image: 'preview:tested',
	startupTimeoutMs: 100,
	executionTimeoutMs: 100,
};

describe('SandboxDataPreview', () => {
	it('preflights the dedicated image', async () => {
		const { instance, calls } = makeFakeSandbox();
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		expect(preview.available()).toBe(false);

		await preview.check();

		expect(preview.available()).toBe(true);
		expect(calls.exec.at(-1)).toContain('pyarrow, pyiceberg');
		expect(calls.destroy).toBe(1);
	});

	it('applies a Python program and destroys the sandbox', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) => {
			calls.exec.push(command);
			return command.includes('marimohub-data-preview.py')
				? { success: true, stdout: '{"columns":["id"],"rows":[[1]]}', stderr: '' }
				: { success: true, stdout: '', stderr: '' };
		};
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
		await preview.check();

		await expect(preview.preview(program)).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		expect(create).toHaveBeenLastCalledWith(expect.any(String), {
			reuse: false,
			image: 'preview:tested',
		});
		expect(calls.writeFile.map(({ path }) => path)).toEqual(
			expect.arrayContaining([
				'/tmp/marimohub-integrations/config.json',
				'/tmp/marimohub-data-preview.py',
				'/tmp/marimohub-data-preview-request.json',
			]),
		);
		expect(calls.setEnvVars.at(-1)).toMatchObject({ AWS_ACCESS_KEY_ID: 'temporary' });
		expect(calls.destroy).toBe(2);
	});

	it('destroys the sandbox after execution failure', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) => {
			calls.exec.push(command);
			return command.includes('marimohub-data-preview.py')
				? {
						success: false,
						stdout: '',
						stderr: 'secret detail',
						error: { code: 'COMMAND_FAILED' },
					}
				: { success: true, stdout: '', stderr: '' };
		};
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.check();

		await expect(preview.preview(program)).rejects.toThrow('could not read this table');
		expect(calls.destroy).toBe(2);
	});

	it('rejects a program result that exceeds its row bound', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async (command) =>
			command.includes('marimohub-data-preview.py')
				? { success: true, stdout: '{"columns":["id"],"rows":[[1],[2]]}', stderr: '' }
				: { success: true, stdout: '', stderr: '' };
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.check();

		await expect(preview.preview({ ...program, maxRows: 1 })).rejects.toThrow('invalid result');
	});

	it('is unavailable after close', async () => {
		const { instance } = makeFakeSandbox();
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.check();
		await preview.close();

		expect(preview.available()).toBe(false);
		await expect(preview.preview(program)).rejects.toThrow('unavailable');
	});
});
