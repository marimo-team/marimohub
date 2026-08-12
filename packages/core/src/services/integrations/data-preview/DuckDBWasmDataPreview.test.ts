import { describe, expect, it, vi } from 'vitest';
import type { DuckDBWasmRuntime } from './programs';
import { DuckDBWasmDataPreview } from './DuckDBWasmDataPreview';

function runtime(overrides: Partial<DuckDBWasmRuntime> = {}): DuckDBWasmRuntime {
	return {
		mode: 'worker',
		features: [],
		initialize: vi.fn(async () => {}),
		execute: vi.fn(async () => ({ columns: ['id'], rows: [[1]] })),
		ping: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		...overrides,
	};
}

const options = { memoryLimitMb: 64, startupTimeoutMs: 100, executionTimeoutMs: 100 };

describe('DuckDBWasmDataPreview', () => {
	it.each([
		['memoryLimitMb', { ...options, memoryLimitMb: 0 }],
		['startupTimeoutMs', { ...options, startupTimeoutMs: -1 }],
		['executionTimeoutMs', { ...options, executionTimeoutMs: 1.5 }],
	] as const)('rejects an invalid %s option', (name, invalidOptions) => {
		expect(() => new DuckDBWasmDataPreview(async () => runtime(), invalidOptions)).toThrow(name);
	});

	it('is unavailable and rejects programs before preflight', async () => {
		const instance = runtime();
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		expect(preview.available()).toBe(false);
		expect(preview.supports({ setup: [], query: { text: 'SELECT 1' } })).toBe(false);
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'cannot execute',
		);
		expect(instance.execute).not.toHaveBeenCalled();
	});

	it('shares concurrent initialization and reports runtime features', async () => {
		const instance = runtime({ features: ['iceberg-http'] });
		const factory = vi.fn(async () => instance);
		const preview = new DuckDBWasmDataPreview(factory, options);
		await Promise.all([preview.check(), preview.check()]);

		expect(factory).toHaveBeenCalledOnce();
		expect(instance.initialize).toHaveBeenCalledWith({ memoryLimitMb: 64 });
		expect(preview.status()).toEqual({
			available: true,
			runtime: 'worker',
			features: ['iceberg-http'],
		});
	});

	it('does not accept programs whose required features are absent', async () => {
		const preview = new DuckDBWasmDataPreview(async () => runtime(), options);
		await preview.check();
		expect(preview.supports({ setup: [], query: { text: 'SELECT 1' } })).toBe(true);
		expect(
			preview.supports({ setup: [], query: { text: 'SELECT 1' }, requires: ['iceberg-http'] }),
		).toBe(false);
	});

	it('poisons a failed runtime without retrying the query', async () => {
		const instance = runtime({
			execute: vi.fn(async () => {
				throw new Error('secret');
			}),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'could not preview',
		);
		expect(instance.execute).toHaveBeenCalledOnce();
		expect(instance.close).toHaveBeenCalledOnce();
		expect(preview.available()).toBe(false);
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'cannot execute',
		);
		expect(instance.execute).toHaveBeenCalledOnce();
	});

	it('does not mask an execution failure when runtime disposal also fails', async () => {
		const instance = runtime({
			execute: vi.fn(async () => {
				throw new Error('query secret');
			}),
			close: vi.fn(async () => {
				throw new Error('close secret');
			}),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'could not preview',
		);
		expect(preview.available()).toBe(false);
	});

	it('terminates a runtime when execution exceeds its deadline', async () => {
		const instance = runtime({ execute: () => new Promise(() => {}) });
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			executionTimeoutMs: 5,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'could not preview',
		);
		expect(instance.close).toHaveBeenCalledOnce();
		expect(preview.available()).toBe(false);
	});

	it('disposes a runtime when initialization times out', async () => {
		const instance = runtime({ initialize: () => new Promise(() => {}) });
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			startupTimeoutMs: 5,
		});

		await expect(preview.check()).rejects.toThrow('initialization timed out');
		expect(instance.close).toHaveBeenCalledOnce();
		expect(preview.available()).toBe(false);
	});

	it('disposes a runtime when ping fails and permits a later preflight retry', async () => {
		const failed = runtime({
			ping: vi.fn(async () => {
				throw new Error('ping failed');
			}),
			close: vi.fn(async () => {
				throw new Error('close failed');
			}),
		});
		const healthy = runtime();
		const factory = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(healthy);
		const preview = new DuckDBWasmDataPreview(factory, options);

		await expect(preview.check()).rejects.toThrow('ping failed');
		expect(failed.close).toHaveBeenCalledOnce();
		await expect(preview.check()).resolves.toBeUndefined();
		expect(factory).toHaveBeenCalledTimes(2);
		expect(preview.available()).toBe(true);
	});

	it('permits retry after the runtime factory rejects', async () => {
		const healthy = runtime();
		const factory = vi
			.fn<() => Promise<DuckDBWasmRuntime>>()
			.mockRejectedValueOnce(new Error('worker unavailable'))
			.mockResolvedValueOnce(healthy);
		const preview = new DuckDBWasmDataPreview(factory, options);

		await expect(preview.check()).rejects.toThrow('worker unavailable');
		await expect(preview.check()).resolves.toBeUndefined();
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('disposes a runtime closed during initialization', async () => {
		let initialized: (() => void) | undefined;
		const instance = runtime({
			initialize: () =>
				new Promise((resolve) => {
					initialized = resolve;
				}),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		const checking = preview.check();
		await Promise.resolve();
		await preview.close();
		initialized?.();
		await expect(checking).rejects.toThrow('closed during initialization');
		expect(instance.close).toHaveBeenCalled();
		expect(preview.available()).toBe(false);
	});

	it('closes an initialized runtime once and rejects later preflight', async () => {
		const instance = runtime();
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		await preview.check();

		await Promise.all([preview.close(), preview.close()]);
		expect(instance.close).toHaveBeenCalledOnce();
		expect(preview.status()).toEqual({ available: false });
		await expect(preview.check()).rejects.toThrow('closed');
	});
});
