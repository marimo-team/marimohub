import { describe, expect, it, vi } from 'vitest';
import type { IntegrationId, SessionId } from '../../../ids';
import type { ExecResult } from '../../../ports/sandbox';
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

	it('resolves credentials only when the Python program executes', async () => {
		const { instance, calls } = makeFakeSandbox();
		instance.exec = async (command) => {
			calls.exec.push(command);
			return command.includes('marimohub-data-preview.py')
				? { success: true, stdout: '{"columns":["id"],"rows":[[1]]}', stderr: '' }
				: { success: true, stdout: '', stderr: '' };
		};
		const credentials = vi.fn(async () => ({ AWS_ACCESS_KEY_ID: 'lazy-temporary' }));
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.check();
		expect(credentials).not.toHaveBeenCalled();

		await preview.preview({ ...program, credentialVars: credentials });

		expect(credentials).toHaveBeenCalledOnce();
		expect(calls.setEnvVars.at(-1)).toMatchObject({ AWS_ACCESS_KEY_ID: 'lazy-temporary' });
	});

	it('does not charge credential resolution against the sandbox startup deadline', async () => {
		vi.useFakeTimers();
		try {
			const { instance } = makeFakeSandbox();
			instance.exec = async (command) =>
				command.includes('marimohub-data-preview.py')
					? { success: true, stdout: '{"columns":["id"],"rows":[[1]]}', stderr: '' }
					: { success: true, stdout: '', stderr: '' };
			let resolveCredentials: ((vars: Record<string, string>) => void) | undefined;
			const credentials = vi.fn(
				() =>
					new Promise<Record<string, string>>((resolve) => {
						resolveCredentials = resolve;
					}),
			);
			const create = vi.fn(() => instance);
			const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
			await preview.check();

			const result = preview.preview({ ...program, credentialVars: credentials });
			await vi.advanceTimersByTimeAsync(options.startupTimeoutMs + 1);
			expect(create).toHaveBeenCalledOnce();

			resolveCredentials?.({ AWS_ACCESS_KEY_ID: 'slow-temporary' });
			await expect(result).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not create a sandbox when credential resolution fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
		await preview.check();

		await expect(
			preview.preview({
				...program,
				credentialVars: async () => {
					throw new Error('WIF exchange failed');
				},
			}),
		).rejects.toThrow('WIF exchange failed');
		expect(create).toHaveBeenCalledOnce();
		expect(calls.destroy).toBe(1);
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

	it('waits for an in-flight preview and its sandbox cleanup before closing', async () => {
		const { instance, calls } = makeFakeSandbox();
		let finishExecution: ((result: ExecResult) => void) | undefined;
		instance.exec = vi.fn(async (command): Promise<ExecResult> => {
			calls.exec.push(command);
			if (!command.includes('marimohub-data-preview.py')) {
				return { success: true, stdout: '', stderr: '' };
			}
			return new Promise<ExecResult>((resolve) => {
				finishExecution = resolve;
			});
		});
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.check();
		const result = preview.preview(program);
		await vi.waitFor(() => expect(finishExecution).toBeTypeOf('function'));

		let closed = false;
		const closing = preview.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);

		finishExecution?.({
			success: true,
			stdout: '{"columns":["id"],"rows":[[1]]}',
			stderr: '',
		});
		await expect(result).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		await closing;
		expect(calls.destroy).toBe(2);
		expect(preview.available()).toBe(false);
	});

	it('waits for an in-flight readiness check without becoming available after close', async () => {
		const { instance, calls } = makeFakeSandbox();
		let finishCheck:
			| ((result: { success: true; stdout: string; stderr: string }) => void)
			| undefined;
		const checkResult = new Promise<{ success: true; stdout: string; stderr: string }>(
			(resolve) => {
				finishCheck = resolve;
			},
		);
		instance.exec = vi.fn((command) => {
			calls.exec.push(command);
			return checkResult;
		});
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		const checking = preview.check();

		let closed = false;
		const closing = preview.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);

		finishCheck?.({ success: true, stdout: '', stderr: '' });
		await Promise.all([checking, closing]);
		expect(calls.destroy).toBe(1);
		expect(preview.available()).toBe(false);
		await expect(preview.check()).rejects.toThrow('closed');
	});
});
