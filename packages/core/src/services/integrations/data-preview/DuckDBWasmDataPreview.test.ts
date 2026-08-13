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
		['maxPoolSize', { ...options, maxPoolSize: 0 }],
		['idleTimeoutMs', { ...options, idleTimeoutMs: -1 }],
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

	it('poisons a failed slot and replaces it without retrying the failed query', async () => {
		const failed = runtime({
			execute: vi.fn(async () => {
				throw new Error('secret');
			}),
		});
		const healthy = runtime({
			execute: vi.fn(async () => ({ columns: ['id'], rows: [[2]] })),
		});
		const factory = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(healthy);
		const preview = new DuckDBWasmDataPreview(factory, options);
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'could not preview',
		);
		expect(failed.execute).toHaveBeenCalledOnce();
		expect(failed.close).toHaveBeenCalledOnce();
		expect(preview.available()).toBe(true);
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[2]],
		});
		expect(factory).toHaveBeenCalledTimes(2);
		expect(failed.execute).toHaveBeenCalledOnce();
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
		expect(preview.available()).toBe(true);
	});

	it('terminates a runtime when execution exceeds its deadline', async () => {
		let signal: AbortSignal | undefined;
		const instance = runtime({
			execute: (_program, runtimeSignal) => {
				signal = runtimeSignal;
				return new Promise(() => {});
			},
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			executionTimeoutMs: 5,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			'timed out',
		);
		expect(instance.close).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(true);
		expect(preview.available()).toBe(true);
	});

	it('rejects work beyond the bounded pool without retaining the program', async () => {
		let rejectFirst: ((error: Error) => void) | undefined;
		const instance = runtime({
			execute: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((_resolve, reject) => {
							rejectFirst = reject;
						}),
				)
				.mockResolvedValueOnce({ columns: ['id'], rows: [[2]] }),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, options);
		await preview.check();

		const first = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		const second = preview.preview({ setup: [], query: { text: 'SELECT 2' } });
		await vi.waitFor(() => expect(instance.execute).toHaveBeenCalledOnce());
		rejectFirst?.(new Error('first failed'));

		await expect(first).rejects.toThrow('could not preview');
		await expect(second).rejects.toThrow('pool is currently full');
		expect(instance.execute).toHaveBeenCalledOnce();
		expect(instance.close).toHaveBeenCalledOnce();
	});

	it('grows lazily to the pool bound and runs one request per slot', async () => {
		const finishes: ((value: { columns: string[]; rows: number[][] }) => void)[] = [];
		const first = runtime({
			execute: vi.fn(
				() =>
					new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
						finishes.push(resolve);
					}),
			),
		});
		const second = runtime({
			execute: vi.fn(
				() =>
					new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
						finishes.push(resolve);
					}),
			),
		});
		const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const preview = new DuckDBWasmDataPreview(factory, { ...options, maxPoolSize: 2 });
		await preview.check();

		const one = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		const two = preview.preview({ setup: [], query: { text: 'SELECT 2' } });
		await vi.waitFor(() => expect(finishes).toHaveLength(2));
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 3' } })).rejects.toThrow(
			'pool is currently full',
		);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(first.execute).toHaveBeenCalledOnce();
		expect(second.execute).toHaveBeenCalledOnce();

		finishes[0]?.({ columns: ['id'], rows: [[1]] });
		finishes[1]?.({ columns: ['id'], rows: [[2]] });
		await Promise.all([one, two]);
	});

	it('rejects a lazily-created slot with different capabilities without disturbing healthy work', async () => {
		let finishFirst: ((value: { columns: string[]; rows: number[][] }) => void) | undefined;
		const first = runtime({
			execute: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
							finishFirst = resolve;
						}),
				)
				.mockResolvedValue({ columns: ['id'], rows: [[3]] }),
		});
		const mismatched = runtime({ features: ['iceberg-http'] });
		const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(mismatched);
		const preview = new DuckDBWasmDataPreview(factory, { ...options, maxPoolSize: 2 });
		await preview.check();

		const one = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).rejects.toThrow(
			'could not start',
		);
		expect(mismatched.execute).not.toHaveBeenCalled();
		expect(mismatched.close).toHaveBeenCalledOnce();

		finishFirst?.({ columns: ['id'], rows: [[1]] });
		await expect(one).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 3' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[3]],
		});
	});

	it('redacts a lazy slot initialization failure and keeps an existing slot usable', async () => {
		let finishFirst: ((value: { columns: string[]; rows: number[][] }) => void) | undefined;
		const first = runtime({
			execute: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
							finishFirst = resolve;
						}),
				)
				.mockResolvedValue({ columns: ['id'], rows: [[3]] }),
		});
		const factory = vi
			.fn<() => Promise<DuckDBWasmRuntime>>()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error('factory secret'));
		const preview = new DuckDBWasmDataPreview(factory, { ...options, maxPoolSize: 2 });
		await preview.check();

		const one = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).rejects.toMatchObject(
			{
				message: 'DuckDB-Wasm could not start a preview runtime.',
			},
		);

		finishFirst?.({ columns: ['id'], rows: [[1]] });
		await one;
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 3' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[3]],
		});
	});

	it('recycles an idle slot and lazily creates a replacement', async () => {
		vi.useFakeTimers();
		try {
			const first = runtime();
			const second = runtime();
			const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
			const preview = new DuckDBWasmDataPreview(factory, { ...options, idleTimeoutMs: 10 });
			await preview.check();

			await vi.advanceTimersByTimeAsync(10);
			expect(first.close).toHaveBeenCalledOnce();
			expect(preview.available()).toBe(true);
			await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
				columns: ['id'],
				rows: [[1]],
			});
			expect(factory).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('resets the idle deadline when a slot is reused', async () => {
		vi.useFakeTimers();
		try {
			const instance = runtime();
			const preview = new DuckDBWasmDataPreview(async () => instance, {
				...options,
				idleTimeoutMs: 10,
			});
			await preview.check();

			await vi.advanceTimersByTimeAsync(5);
			await preview.preview({ setup: [], query: { text: 'SELECT 1' } });
			await vi.advanceTimersByTimeAsync(5);
			expect(instance.close).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5);
			expect(instance.close).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not clamp idle timeouts above the platform timer limit', async () => {
		vi.useFakeTimers();
		try {
			const instance = runtime();
			const preview = new DuckDBWasmDataPreview(async () => instance, {
				...options,
				idleTimeoutMs: 2_147_483_747,
			});
			await preview.check();

			await vi.advanceTimersByTimeAsync(2_147_483_647);
			expect(instance.close).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(99);
			expect(instance.close).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(instance.close).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it('returns a completed preview and replaces its slot when the health check fails', async () => {
		const increment = vi.fn();
		const failed = runtime({
			ping: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unhealthy')),
		});
		const healthy = runtime();
		const factory = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(healthy);
		const preview = new DuckDBWasmDataPreview(factory, {
			...options,
			metrics: { increment, gauge: vi.fn() },
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		expect(failed.close).toHaveBeenCalledOnce();
		expect(increment).toHaveBeenCalledWith('data_preview.duckdb.execution', 1, {
			executor: 'duckdb_wasm',
			runtime: 'worker',
			outcome: 'success',
		});
		expect(increment).toHaveBeenCalledWith('data_preview.duckdb.recycle', 1, {
			runtime: 'worker',
			reason: 'health_check',
		});
		await vi.waitFor(() => expect(failed.close).toHaveResolved());
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
	});

	it('returns a completed preview after bounding a hanging health check', async () => {
		const instance = runtime({
			ping: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockImplementationOnce(() => new Promise(() => {})),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			executionTimeoutMs: 5,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		expect(instance.close).toHaveBeenCalledOnce();
	});

	it('returns a completed preview before recycling finishes and tracks cleanup on close', async () => {
		let finishClose: (() => void) | undefined;
		const instance = runtime({
			ping: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unhealthy')),
			close: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishClose = resolve;
					}),
			),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			startupTimeoutMs: 10_000,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		await vi.waitFor(() => expect(instance.close).toHaveBeenCalledOnce());
		let closed = false;
		const closing = preview.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);

		finishClose?.();
		await closing;
		expect(closed).toBe(true);
	});

	it('counts repeated health-check recycling against pool capacity and shutdown', async () => {
		const finishClose: (() => void)[] = [];
		const unhealthy = (id: number): DuckDBWasmRuntime =>
			runtime({
				execute: vi.fn(async () => ({ columns: ['id'], rows: [[id]] })),
				ping: vi
					.fn()
					.mockResolvedValueOnce(undefined)
					.mockRejectedValueOnce(new Error('unhealthy')),
				close: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishClose.push(resolve);
						}),
				),
			});
		const first = unhealthy(1);
		const second = unhealthy(2);
		const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const preview = new DuckDBWasmDataPreview(factory, {
			...options,
			maxPoolSize: 2,
			startupTimeoutMs: 10_000,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[2]],
		});
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 3' } })).rejects.toThrow(
			'pool is currently full',
		);
		expect(factory).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(finishClose).toHaveLength(2));

		let closed = false;
		const closing = preview.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		for (const finish of finishClose) finish();
		await closing;
		expect(closed).toBe(true);
	});

	it('keeps a timed-out close charged against pool capacity until it settles', async () => {
		let finishClose: (() => void) | undefined;
		const first = runtime({
			ping: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('unhealthy')),
			close: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishClose = resolve;
					}),
			),
		});
		const second = runtime();
		const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const preview = new DuckDBWasmDataPreview(factory, {
			...options,
			startupTimeoutMs: 5,
		});
		await preview.check();

		await expect(preview.preview({ setup: [], query: { text: 'SELECT 1' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).rejects.toThrow(
			'pool is currently full',
		);
		expect(factory).toHaveBeenCalledOnce();

		finishClose?.();
		await vi.waitFor(() => expect(first.close).toHaveResolved());
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 2' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[1]],
		});
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it('does not double-count failed initialization while its runtime closes', async () => {
		let finishFirst: ((value: { columns: string[]; rows: number[][] }) => void) | undefined;
		let finishFailedClose: (() => void) | undefined;
		const first = runtime({
			execute: vi.fn(
				() =>
					new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
						finishFirst = resolve;
					}),
			),
		});
		const failed = runtime({
			ping: vi.fn(async () => {
				throw new Error('unhealthy');
			}),
			close: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishFailedClose = resolve;
					}),
			),
		});
		const third = runtime({
			execute: vi.fn(async () => ({ columns: ['id'], rows: [[3]] })),
		});
		const factory = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(failed)
			.mockResolvedValueOnce(third);
		const preview = new DuckDBWasmDataPreview(factory, {
			...options,
			maxPoolSize: 3,
			startupTimeoutMs: 10_000,
			executionTimeoutMs: 10_000,
		});
		await preview.check();

		const active = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
		const failedInitialization = preview.preview({ setup: [], query: { text: 'SELECT 2' } });
		await vi.waitFor(() => expect(failed.close).toHaveBeenCalledOnce());
		await expect(preview.preview({ setup: [], query: { text: 'SELECT 3' } })).resolves.toEqual({
			columns: ['id'],
			rows: [[3]],
		});
		expect(factory).toHaveBeenCalledTimes(3);

		finishFirst?.({ columns: ['id'], rows: [[1]] });
		finishFailedClose?.();
		await expect(active).resolves.toEqual({ columns: ['id'], rows: [[1]] });
		await expect(failedInitialization).rejects.toThrow('could not start a preview runtime');
	});

	it('emits low-cardinality pool, execution, and recycle metrics', async () => {
		const increment = vi.fn();
		const gauge = vi.fn();
		const instance = runtime({
			execute: vi.fn(async () => {
				throw new Error('contains sensitive details');
			}),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			metrics: { increment, gauge },
		});
		await preview.check();
		await expect(
			preview.preview({ setup: [], query: { text: 'SELECT secret FROM private_table' } }),
		).rejects.toThrow('could not preview');

		expect(increment).toHaveBeenCalledWith('data_preview.duckdb.initialize', 1, {
			runtime: 'worker',
			outcome: 'success',
		});
		expect(increment).toHaveBeenCalledWith('data_preview.duckdb.recycle', 1, {
			runtime: 'worker',
			reason: 'execution_error',
		});
		const serialized = JSON.stringify([...increment.mock.calls, ...gauge.mock.calls]);
		expect(serialized).not.toContain('secret');
		expect(serialized).not.toContain('private_table');
	});

	it('aborts active work and closes its runtime during shutdown', async () => {
		let finish: ((value: { columns: string[]; rows: number[][] }) => void) | undefined;
		let signal: AbortSignal | undefined;
		const instance = runtime({
			execute: vi.fn(
				(_program, runtimeSignal) =>
					new Promise<{ columns: string[]; rows: number[][] }>((resolve) => {
						signal = runtimeSignal;
						finish = resolve;
					}),
			),
		});
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			executionTimeoutMs: 10_000,
		});
		await preview.check();

		const executing = preview.preview({ setup: [], query: { text: 'SELECT 1' } });
		await vi.waitFor(() => expect(instance.execute).toHaveBeenCalledOnce());
		const closing = preview.close();
		expect(signal?.aborted).toBe(true);
		await vi.waitFor(() => expect(instance.close).toHaveBeenCalledOnce());

		finish?.({ columns: ['id'], rows: [[1]] });
		await expect(executing).rejects.toThrow('could not preview');
		await expect(closing).resolves.toBeUndefined();
		expect(instance.close).toHaveBeenCalledOnce();
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

	it('includes runtime factory creation in the initialization deadline', async () => {
		const preview = new DuckDBWasmDataPreview(() => new Promise(() => {}), {
			...options,
			startupTimeoutMs: 5,
		});

		await expect(preview.check()).rejects.toThrow('initialization timed out');
		expect(preview.available()).toBe(false);
	});

	it('disposes a runtime created after the initialization deadline', async () => {
		let resolveFactory: ((value: DuckDBWasmRuntime) => void) | undefined;
		const instance = runtime();
		const preview = new DuckDBWasmDataPreview(
			() =>
				new Promise((resolve) => {
					resolveFactory = resolve;
				}),
			{ ...options, startupTimeoutMs: 5 },
		);

		await expect(preview.check()).rejects.toThrow('initialization timed out');
		resolveFactory?.(instance);
		await vi.waitFor(() => expect(instance.close).toHaveBeenCalledOnce());
		expect(instance.initialize).not.toHaveBeenCalled();
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
		await vi.waitFor(() => expect(initialized).toBeTypeOf('function'));
		const closing = preview.close();
		initialized?.();
		await expect(checking).rejects.toThrow('initialization was abandoned');
		await expect(closing).resolves.toBeUndefined();
		expect(instance.close).toHaveBeenCalled();
		expect(preview.available()).toBe(false);
	});

	it('bounds shutdown when a runtime factory never resolves', async () => {
		const preview = new DuckDBWasmDataPreview(() => new Promise(() => {}), {
			...options,
			startupTimeoutMs: 5,
		});
		const checking = preview.check();

		await expect(preview.close()).resolves.toBeUndefined();
		await expect(checking).rejects.toThrow('initialization timed out');
	});

	it('bounds shutdown when runtime cleanup never resolves', async () => {
		const instance = runtime({ close: vi.fn(() => new Promise<void>(() => {})) });
		const preview = new DuckDBWasmDataPreview(async () => instance, {
			...options,
			startupTimeoutMs: 5,
		});
		await preview.check();

		await expect(preview.close()).resolves.toBeUndefined();
		expect(instance.close).toHaveBeenCalledOnce();
		expect(preview.status()).toEqual({ available: false });
	});

	it('disposes a runtime factory result that arrives after shutdown', async () => {
		let resolveFactory: ((runtime: DuckDBWasmRuntime) => void) | undefined;
		const instance = runtime();
		const preview = new DuckDBWasmDataPreview(
			() =>
				new Promise((resolve) => {
					resolveFactory = resolve;
				}),
			{ ...options, startupTimeoutMs: 5 },
		);
		const checking = preview.check();
		await preview.close();

		resolveFactory?.(instance);
		await expect(checking).rejects.toThrow('initialization timed out');
		await vi.waitFor(() => expect(instance.close).toHaveBeenCalledOnce());
		expect(instance.initialize).not.toHaveBeenCalled();
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
