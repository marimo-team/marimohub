import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSandbox } from '../../testing/fakes';
import { bootstrapKernel } from './kernelBootstrap';
import { kernelBootstrapCommand } from './kernelBootstrap/command';

afterEach(() => vi.useRealTimers());

describe('bootstrapKernel', () => {
	it('maps the exact bridge launcher into the sandbox process namespace', async () => {
		const { instance } = makeFakeSandbox();
		instance.resolveProcessPath = (path) => `/local sandbox${path}`;
		const exec = vi
			.spyOn(instance, 'exec')
			.mockResolvedValue({ success: true, stdout: '{"status":"ready"}', stderr: '' });
		await bootstrapKernel(instance, {
			timeoutMs: 1_000,
			bridge: { sandboxId: 'sb-test', launcher: 'custom bridge.py' },
		});
		expect(exec).toHaveBeenCalledWith(
			kernelBootstrapCommand(
				900,
				false,
				2718,
				'/local sandbox/tmp/marimohub-bridge/sb-test/custom bridge.py',
			),
			{ timeout: 2_000 },
		);
	});
	it('retains allowlisted diagnostics and discards arbitrary sandbox output', async () => {
		const { instance } = makeFakeSandbox();
		const diagnostics = {
			stage: 'configure',
			reason: 'incompatible_runtime',
			runtime_kind: 'bridge',
			authenticated: false,
			http_status: 404,
			processes_scanned: 6,
			port_matches: 1,
		};
		vi.spyOn(instance, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({
				status: 'awaiting_client',
				diagnostics: { ...diagnostics, token: 'private', stderr: 'private' },
			}),
			stderr: 'private',
		});
		expect(await bootstrapKernel(instance, { timeoutMs: 1_000 })).toEqual({
			status: 'awaiting_client',
			diagnostics,
		});
	});
	it('ignores malformed diagnostics without changing readiness', async () => {
		const { instance } = makeFakeSandbox();
		for (const diagnostics of [
			'private',
			null,
			{
				stage: 'private',
				reason: 'private',
				runtime_kind: 'private',
				authenticated: 'private',
				http_status: 999,
				processes_scanned: -1,
				port_matches: 'private',
			},
		]) {
			vi.spyOn(instance, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({ status: 'ready', diagnostics }),
				stderr: 'private',
			});
			const result = await bootstrapKernel(instance, { timeoutMs: 1_000 });
			expect(result.status).toBe('ready');
			expect(JSON.stringify(result)).not.toContain('private');
			expect(
				Object.values(result.diagnostics ?? {}).filter((value) => value !== undefined),
			).toEqual([]);
		}
	});
	it.each([null, true, -1, 1.5, 1_000_001, 'private'])(
		'drops invalid counters (%s) while retaining useful diagnostics',
		async (count) => {
			const { instance } = makeFakeSandbox();
			vi.spyOn(instance, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({
					status: 'awaiting_client',
					diagnostics: {
						stage: 'discovery',
						reason: 'runtime_not_found',
						processes_scanned: count,
						port_matches: count,
						http_status: 'private',
					},
				}),
				stderr: '',
			});
			const result = await bootstrapKernel(instance, { timeoutMs: 1_000 });
			expect(JSON.parse(JSON.stringify(result))).toEqual({
				status: 'awaiting_client',
				diagnostics: { stage: 'discovery', reason: 'runtime_not_found' },
			});
		},
	);
	it('rejects a failed exec even if its stdout claims a ready kernel', async () => {
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockResolvedValue({
			success: false,
			stdout: '{"status":"ready","diagnostics":{"stage":"kernel_status"}}',
			stderr: 'private',
			error: { code: 'COMMAND_FAILED' },
		});
		expect(await bootstrapKernel(instance, { timeoutMs: 1_000 })).toEqual({
			status: 'unavailable',
			diagnostics: { stage: 'exec', reason: 'exec_failed' },
		});
	});
	it.each([
		['http://127.0.0.1:43210', 43210],
		['http://127.0.0.1:80', 80],
		['http://127.0.0.1', 80],
		['https://127.0.0.1:443', 443],
		['http://127.0.0.1:0', 2718],
	] as const)('discovers the sandbox port from %s', async (url, port) => {
		const { instance } = makeFakeSandbox();
		instance.resolveProcessUrl = () => url;
		const exec = vi.spyOn(instance, 'exec').mockResolvedValue({
			success: true,
			stdout: '{"status":"ready"}',
			stderr: '',
		});
		expect(await bootstrapKernel(instance, { timeoutMs: 1_000 })).toEqual({ status: 'ready' });
		expect(exec).toHaveBeenCalledWith(kernelBootstrapCommand(900, false, port), {
			timeout: 2_000,
		});
	});
	it.each(['ready', 'awaiting_client', 'unavailable'] as const)(
		'returns the bounded %s result',
		async (status) => {
			const { instance } = makeFakeSandbox();
			const exec = vi.spyOn(instance, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({ status, token: 'private' }),
				stderr: 'private',
			});
			expect(await bootstrapKernel(instance, { timeoutMs: 5_000 })).toEqual({ status });
			expect(exec).toHaveBeenCalledWith(expect.any(String), { timeout: 3_000 });
		},
	);
	it('polls while the kernel is still initializing, then returns ready', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		const exec = vi
			.spyOn(instance, 'exec')
			.mockResolvedValueOnce({
				success: true,
				stdout: JSON.stringify({ status: 'initializing' }),
				stderr: '',
			})
			.mockResolvedValue({
				success: true,
				stdout: JSON.stringify({ status: 'ready' }),
				stderr: '',
			});
		const pending = bootstrapKernel(instance, { timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(499);
		expect(exec).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toEqual({ status: 'ready' });
		expect(exec).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('retries a stalled probe while the overall deadline still has time', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		const exec = vi
			.spyOn(instance, 'exec')
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValue({ success: true, stdout: '{"status":"ready"}', stderr: '' });
		const pending = bootstrapKernel(instance, { timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(2_500);
		expect(await pending).toEqual({ status: 'ready' });
		expect(exec).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('bounds the final probe by the remaining overall deadline', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		const exec = vi.spyOn(instance, 'exec').mockImplementation(() => new Promise(() => {}));
		const pending = bootstrapKernel(instance, { timeoutMs: 3_000 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await pending).toMatchObject({ status: 'initializing' });
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec).toHaveBeenNthCalledWith(2, kernelBootstrapCommand(450), { timeout: 1_500 });
		expect(vi.getTimerCount()).toBe(0);
	});
	it('gives up with initializing when the budget is spent', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: 'initializing' }),
			stderr: '',
		});
		const pending = bootstrapKernel(instance, { timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await pending).toMatchObject({ status: 'initializing' });
		expect(vi.getTimerCount()).toBe(0);
	});
	it('does not poll in inspect mode', async () => {
		const { instance } = makeFakeSandbox();
		const exec = vi.spyOn(instance, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: 'initializing' }),
			stderr: '',
		});
		expect(await bootstrapKernel(instance, { timeoutMs: 5_000, inspectOnly: true })).toEqual({
			status: 'initializing',
		});
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec).toHaveBeenCalledWith(expect.any(String), { timeout: 6_000 });
	});
	it('does no work without remaining time', async () => {
		const { instance, calls } = makeFakeSandbox();
		expect(await bootstrapKernel(instance, { timeoutMs: 0 })).toEqual({ status: 'initializing' });
		expect(calls.exec).toEqual([]);
	});
	it.each([0, -1])(
		'propagates cancellation without a remaining budget (%ims)',
		async (timeoutMs) => {
			const { instance, calls } = makeFakeSandbox();
			const reason = new Error('authorization expired');
			await expect(
				bootstrapKernel(instance, { timeoutMs, signal: AbortSignal.abort(reason) }),
			).rejects.toBe(reason);
			expect(calls.exec).toEqual([]);
		},
	);
	it('bounds adapters that never settle', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockImplementation(() => new Promise(() => {}));
		const pending = bootstrapKernel(instance, { timeoutMs: 100 });
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toMatchObject({ status: 'initializing' });
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([100, 1_000])(
		'keeps adapter termination beyond a %ims request deadline',
		async (timeoutMs) => {
			vi.useFakeTimers();
			const { instance } = makeFakeSandbox();
			vi.spyOn(instance, 'exec').mockImplementation(async (_command, options) => {
				const timeout = options!.timeout!;
				await new Promise((resolve) => setTimeout(resolve, timeout - Math.min(100, timeout / 10)));
				return {
					success: false,
					stdout: '',
					stderr: 'command timed out',
					error: { code: 'COMMAND_FAILED' },
				};
			});
			const pending = bootstrapKernel(instance, { timeoutMs });
			await vi.advanceTimersByTimeAsync(timeoutMs);
			expect(await pending).toMatchObject({ status: 'initializing' });
			await vi.runAllTimersAsync();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it.each(['invalid json', '{"status":"secret"}'])(
		'sanitizes invalid output: %s',
		async (stdout) => {
			const { instance } = makeFakeSandbox();
			vi.spyOn(instance, 'exec').mockResolvedValue({ success: true, stdout, stderr: 'secret' });
			expect(await bootstrapKernel(instance, { timeoutMs: 100 })).toEqual({
				status: 'unavailable',
				diagnostics: { stage: 'exec', reason: 'invalid_output' },
			});
		},
	);
	it('sanitizes execution errors', async () => {
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockRejectedValue(new Error('secret'));
		expect(await bootstrapKernel(instance, { timeoutMs: 100 })).toEqual({
			status: 'unavailable',
			diagnostics: { stage: 'exec', reason: 'exec_failed' },
		});
	});
	it('stops waiting on cancellation and clears its deadline', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockImplementation(() => new Promise(() => {}));
		const controller = new AbortController();
		const pending = bootstrapKernel(instance, { timeoutMs: 100, signal: controller.signal });
		const rejected = expect(pending).rejects.toThrow('stopped');
		controller.abort(new Error('stopped'));
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
	});
	it('clears the retry pause immediately on cancellation', async () => {
		vi.useFakeTimers();
		const { instance } = makeFakeSandbox();
		const exec = vi.spyOn(instance, 'exec').mockResolvedValue({
			success: true,
			stdout: '{"status":"initializing"}',
			stderr: '',
		});
		const controller = new AbortController();
		const pending = bootstrapKernel(instance, { timeoutMs: 5_000, signal: controller.signal });
		const reason = new Error('stopped');
		const rejected = expect(pending).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		controller.abort(reason);
		await rejected;
		expect(vi.getTimerCount()).toBe(0);
		expect(exec).toHaveBeenCalledTimes(1);
	});
	it('only embeds the token file path and never installs runtime dependencies', () => {
		const command = kernelBootstrapCommand(1000, true);
		expect(command).toContain('/tmp/.marimohub-kernel-token');
		expect(command).not.toContain('uv run');
		expect(command).not.toContain('pip install');
	});
	it.each(['instantiate', 'kernel_status'] as const)(
		'preserves initialization failure diagnostics from %s',
		async (stage) => {
			const { instance } = makeFakeSandbox();
			const diagnostics = { stage, reason: 'initialization_failed' };
			vi.spyOn(instance, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({
					status: 'unavailable',
					diagnostics: { ...diagnostics, error: 'private' },
				}),
				stderr: 'private',
			});
			expect(await bootstrapKernel(instance, { timeoutMs: 1_000 })).toEqual({
				status: 'unavailable',
				diagnostics,
			});
		},
	);
});
