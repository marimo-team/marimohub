import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSandbox } from '../../testing/fakes';
import { bootstrapKernel } from './kernelBootstrap';
import { kernelBootstrapCommand } from './kernelBootstrap/command';

afterEach(() => vi.useRealTimers());

describe('bootstrapKernel', () => {
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
		expect(await pending).toEqual({ status: 'initializing' });
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
		expect(await pending).toEqual({ status: 'initializing' });
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
		expect(await pending).toEqual({ status: 'initializing' });
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
			expect(await pending).toEqual({ status: 'initializing' });
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
			});
		},
	);
	it('sanitizes execution errors', async () => {
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockRejectedValue(new Error('secret'));
		expect(await bootstrapKernel(instance, { timeoutMs: 100 })).toEqual({ status: 'unavailable' });
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
});
