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
	it('is available immediately without allocating a sandbox', async () => {
		const { instance, calls } = makeFakeSandbox();
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
		expect(preview.available()).toBe(true);
		expect(create).not.toHaveBeenCalled();
		expect(calls.exec).toEqual([]);
		expect(calls.destroy).toBe(0);
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

		await expect(preview.preview(program)).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
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
		expect(calls.destroy).toBe(1);
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
			const preview = new SandboxDataPreview(
				{ ...fakeComputeFrom(instance), create },
				{ ...options, executionTimeoutMs: options.startupTimeoutMs * 2 },
			);

			const result = preview.preview({ ...program, credentialVars: credentials });
			await vi.advanceTimersByTimeAsync(options.startupTimeoutMs + 1);
			expect(create).not.toHaveBeenCalled();

			resolveCredentials?.({ AWS_ACCESS_KEY_ID: 'slow-temporary' });
			await expect(result).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds credential resolution and lets close finish', async () => {
		vi.useFakeTimers();
		try {
			const { instance } = makeFakeSandbox();
			const create = vi.fn(() => instance);
			const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);

			const result = preview.preview({
				...program,
				credentialVars: () => new Promise<Record<string, string>>(() => {}),
			});
			const rejected = expect(result).rejects.toThrow(
				'The preview credentials did not resolve in time.',
			);
			const closing = preview.close();

			await vi.advanceTimersByTimeAsync(options.executionTimeoutMs);
			await rejected;
			await closing;
			expect(create).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not create a sandbox when credential resolution fails', async () => {
		const { instance, calls } = makeFakeSandbox();
		const create = vi.fn(() => instance);
		const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);

		await expect(
			preview.preview({
				...program,
				credentialVars: async () => {
					throw new Error('WIF exchange failed');
				},
			}),
		).rejects.toThrow('WIF exchange failed');
		expect(create).not.toHaveBeenCalled();
		expect(calls.destroy).toBe(0);
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

		await expect(preview.preview(program)).rejects.toThrow('could not read this table');
		expect(calls.destroy).toBe(1);
	});

	it('rejects a program result that exceeds its row bound', async () => {
		const { instance } = makeFakeSandbox();
		instance.exec = async (command) =>
			command.includes('marimohub-data-preview.py')
				? { success: true, stdout: '{"columns":["id"],"rows":[[1],[2]]}', stderr: '' }
				: { success: true, stdout: '', stderr: '' };
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);

		await expect(preview.preview({ ...program, maxRows: 1 })).rejects.toThrow('invalid result');
	});

	it('is unavailable after close', async () => {
		const { instance } = makeFakeSandbox();
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
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
		expect(calls.destroy).toBe(1);
		expect(preview.available()).toBe(false);
	});

	it('does not enable previews after close', async () => {
		const { instance, calls } = makeFakeSandbox();
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		await preview.close();
		await expect(preview.preview(program)).rejects.toThrow('unavailable');
		expect(preview.available()).toBe(false);
		expect(calls.exec).toEqual([]);
		expect(calls.destroy).toBe(0);
	});
});

it('cleans up a failed first preview startup and permits a later preview to succeed', async () => {
	const { instance, calls } = makeFakeSandbox();
	instance.ready = vi
		.fn()
		.mockRejectedValueOnce(new Error('image unavailable'))
		.mockResolvedValue(undefined);
	instance.exec = async () => ({
		success: true,
		stdout: '{"columns":["id"],"rows":[[1]]}',
		stderr: '',
	});
	const create = vi.fn(() => instance);
	const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
	expect(create).not.toHaveBeenCalled();
	await expect(preview.preview(program)).rejects.toThrow('image unavailable');
	expect(calls.destroy).toBe(1);
	expect(calls.writeFile).toEqual([]);
	await expect(preview.preview(program)).resolves.toEqual({ columns: ['id'], rows: [[1]] });
	expect(create).toHaveBeenCalledTimes(2);
	expect(calls.destroy).toBe(2);
	await preview.close();
});

it('bounds first-preview readiness, drains cleanup on close, and ignores late readiness', async () => {
	vi.useFakeTimers();
	try {
		const { instance, calls } = makeFakeSandbox();
		const ready = Promise.withResolvers<void>();
		const destroy = Promise.withResolvers<void>();
		instance.ready = vi.fn(() => ready.promise);
		instance.destroy = vi.fn(() => destroy.promise);
		const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
		const result = preview.preview(program);
		const rejected = expect(result).rejects.toThrow('did not start in time');
		await vi.advanceTimersByTimeAsync(0);
		let closed = false;
		const closing = preview.close().then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(options.startupTimeoutMs);
		expect(instance.destroy).toHaveBeenCalledOnce();
		expect(closed).toBe(false);
		destroy.resolve();
		await rejected;
		await closing;
		ready.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.writeFile).toEqual([]);
		expect(calls.exec).toEqual([]);
		expect(preview.available()).toBe(false);
	} finally {
		vi.useRealTimers();
	}
});

it('does not allocate a replacement or hang close when first-preview creation fails', async () => {
	const { instance } = makeFakeSandbox();
	const create = vi.fn(() => {
		throw new Error('compute unavailable');
	});
	const preview = new SandboxDataPreview({ ...fakeComputeFrom(instance), create }, options);
	await expect(preview.preview(program)).rejects.toThrow('compute unavailable');
	expect(create).toHaveBeenCalledOnce();
	await preview.close();
	expect(preview.available()).toBe(false);
});

it.each([
	"ModuleNotFoundError: No module named 'pyarrow'",
	"ImportError: cannot import name 'Table' from 'pyiceberg.table'",
])('reports %s on the first preview without exposing the traceback', async (detail) => {
	const { instance, calls } = makeFakeSandbox();
	instance.ready = async () => {};
	instance.exec = async () => ({
		success: false,
		stdout: '',
		stderr: `Traceback with credentials: secret-token\n${detail} (/private/secret-path)`,
		error: { code: 'COMMAND_FAILED' },
	});
	const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
	await expect(preview.preview(program)).rejects.toThrow(
		`The preview image has incompatible Python dependencies (${detail}). Check MARIMOHUB_DATA_PREVIEW_IMAGE.`,
	);
	expect(calls.destroy).toBe(1);
});

it('does not expose arbitrary stderr or overlong import lines', async () => {
	const { instance } = makeFakeSandbox();
	instance.ready = async () => {};
	instance.exec = async () => ({
		success: false,
		stdout: '',
		stderr: `ImportError: No module named '${'secret'.repeat(1000)}'`,
		error: { code: 'COMMAND_FAILED' },
	});
	const preview = new SandboxDataPreview(fakeComputeFrom(instance), options);
	await expect(preview.preview(program)).rejects.toThrow(
		'The preview sandbox could not read this table.',
	);
});
