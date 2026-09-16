import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSandbox } from '../../testing/fakes';
import { bootstrapKernel } from './kernelBootstrap';
import { kernelBootstrapCommand } from './kernelBootstrap/command';

afterEach(() => vi.useRealTimers());

describe('bootstrapKernel', () => {
	it.each(['ready', 'initializing', 'awaiting_client', 'unavailable'] as const)(
		'returns the bounded %s result',
		async (status) => {
			const { instance } = makeFakeSandbox();
			const exec = vi.spyOn(instance, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({ status, token: 'private' }),
				stderr: 'private',
			});
			expect(await bootstrapKernel(instance, { timeoutMs: 5_000 })).toEqual({ status });
			expect(exec).toHaveBeenCalledWith(expect.any(String), { timeout: 6_000 });
		},
	);
	it('does no work without remaining time', async () => {
		const { instance, calls } = makeFakeSandbox();
		expect(await bootstrapKernel(instance, { timeoutMs: 0 })).toEqual({ status: 'initializing' });
		expect(calls.exec).toEqual([]);
	});
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
	it('only embeds the token file path and never installs runtime dependencies', () => {
		const command = kernelBootstrapCommand(1000, true);
		expect(command).toContain('/tmp/.marimohub-kernel-token');
		expect(command).not.toContain('uv run');
		expect(command).not.toContain('pip install');
	});
});
