import { describe, expect, it, vi } from 'vitest';
import { UserId } from '../../../ids';
import { DataPreviewService } from './DataPreviewService';
import type { DuckDBWasmRuntime } from './programs';
import { DuckDBWasmDataPreview } from './DuckDBWasmDataPreview';

const user = UserId.parse('preview-user');
const otherUser = UserId.parse('other-preview-user');

function duckdbRuntime(): DuckDBWasmRuntime {
	return {
		mode: 'worker',
		features: [],
		initialize: async () => {},
		execute: vi.fn(async () => ({ columns: ['runtime'], rows: [['duckdb']] })),
		ping: async () => {},
		close: async () => {},
	};
}

describe('DataPreviewService', () => {
	it('reports availability only for a configured, healthy executor with a matching program', () => {
		const service = new DataPreviewService({
			duckdbWasm: {
				available: () => true,
				supports: () => true,
				supportsFeatures: (features) => features.length === 0,
				status: () => ({ available: true, runtime: 'inline', features: [] }),
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		expect(service.available({ duckdbWasm: [] })).toBe(true);
		expect(service.available({ duckdbWasm: ['iceberg-http'] })).toBe(false);
		expect(service.available({ python: true })).toBe(false);
		expect(service.available({})).toBe(false);
		expect(service.status()).toEqual([{ available: true, runtime: 'inline', features: [] }]);
	});

	it('prefers DuckDB and does not replay a started failure in the sandbox', async () => {
		const runtime = duckdbRuntime();
		const duckdb = new DuckDBWasmDataPreview(async () => runtime, {
			memoryLimitMb: 64,
			startupTimeoutMs: 100,
			executionTimeoutMs: 100,
		});
		await duckdb.check();
		const sandboxPreview = vi.fn(async () => ({ columns: [], rows: [] }));
		const service = new DataPreviewService({
			duckdbWasm: duckdb,
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: sandboxPreview,
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});
		await expect(
			service.preview(user, {
				duckdbWasm: { setup: [], query: { text: 'SELECT 1' } },
				python: {} as never,
			}),
		).resolves.toEqual({ columns: ['runtime'], rows: [['duckdb']] });
		expect(sandboxPreview).not.toHaveBeenCalled();

		(runtime.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('failed'));
		await expect(
			service.preview(user, {
				duckdbWasm: { setup: [], query: { text: 'SELECT 1' } },
				python: {} as never,
			}),
		).rejects.toThrow('could not preview');
		expect(sandboxPreview).not.toHaveBeenCalled();
	});

	it('uses Python before acceptance when DuckDB lacks a required feature', async () => {
		const duckdb = new DuckDBWasmDataPreview(async () => duckdbRuntime(), {
			memoryLimitMb: 64,
			startupTimeoutMs: 100,
			executionTimeoutMs: 100,
		});
		await duckdb.check();
		const sandboxPreview = vi.fn(async () => ({ columns: ['runtime'], rows: [['sandbox']] }));
		const service = new DataPreviewService({
			duckdbWasm: duckdb,
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: sandboxPreview,
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(
			service.preview(user, {
				duckdbWasm: {
					setup: [],
					query: { text: 'SELECT 1' },
					requires: ['iceberg-http'],
				},
				python: {} as never,
			}),
		).resolves.toEqual({ columns: ['runtime'], rows: [['sandbox']] });
		expect(sandboxPreview).toHaveBeenCalledOnce();
	});

	it('records executor selection without request-specific metric tags', async () => {
		const increment = vi.fn();
		const service = new DataPreviewService({
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
			metrics: { increment, gauge: vi.fn() },
		});

		await service.preview(user, { python: {} as never });
		expect(increment).toHaveBeenCalledWith('data_preview.selected', 1, {
			executor: 'sandbox',
		});
	});

	it('rejects overload and lets accepted work drain before close', async () => {
		let finish: (() => void) | undefined;
		const sandboxClose = vi.fn(async () => {});
		const service = new DataPreviewService({
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: () =>
					new Promise((resolve) => {
						finish = () => resolve({ columns: [], rows: [] });
					}),
				close: sandboxClose,
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});
		const accepted = service.preview(user, { python: {} as never });
		await expect(service.preview(user, { python: {} as never })).rejects.toThrow('already running');
		const closing = service.close();
		expect(sandboxClose).not.toHaveBeenCalled();
		finish?.();
		await accepted;
		await closing;
		expect(sandboxClose).toHaveBeenCalledOnce();
		await expect(service.preview(user, { python: {} as never })).rejects.toThrow('closed');
	});

	it('starts DuckDB cancellation before waiting for accepted work to drain', async () => {
		let rejectPreview: ((error: Error) => void) | undefined;
		const duckdbClose = vi.fn(() => {
			rejectPreview?.(new Error('runtime closed'));
			return Promise.resolve();
		});
		const service = new DataPreviewService({
			duckdbWasm: {
				available: () => true,
				supports: () => true,
				supportsFeatures: () => true,
				status: () => ({ available: true }),
				check: async () => {},
				preview: () =>
					new Promise((_resolve, reject) => {
						rejectPreview = reject;
					}),
				close: duckdbClose,
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		const accepted = service.preview(user, {
			duckdbWasm: { setup: [], query: { text: 'SELECT 1' } },
		});
		await vi.waitFor(() => expect(rejectPreview).toBeTypeOf('function'));
		const firstClose = service.close();
		expect(service.close()).toBe(firstClose);
		await expect(accepted).rejects.toThrow('runtime closed');
		await expect(firstClose).resolves.toBeUndefined();
		expect(duckdbClose).toHaveBeenCalledOnce();
	});

	it('enforces the global limit across different users', async () => {
		let finish: (() => void) | undefined;
		const service = new DataPreviewService({
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: () =>
					new Promise((resolve) => {
						finish = () => resolve({ columns: [], rows: [] });
					}),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		const accepted = service.preview(user, { python: {} as never });
		await expect(service.preview(otherUser, { python: {} as never })).rejects.toThrow(
			'deployment data-preview limit',
		);
		finish?.();
		await accepted;
	});

	it('releases admission after an executor rejects', async () => {
		const sandboxPreview = vi
			.fn()
			.mockRejectedValueOnce(new Error('sandbox failed'))
			.mockResolvedValueOnce({ columns: ['ok'], rows: [[true]] });
		const service = new DataPreviewService({
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: sandboxPreview,
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(service.preview(user, { python: {} as never })).rejects.toThrow('sandbox failed');
		await expect(service.preview(user, { python: {} as never })).resolves.toEqual({
			columns: ['ok'],
			rows: [[true]],
		});
	});

	it('rejects when no available executor can run the supplied programs', async () => {
		const service = new DataPreviewService({
			sandbox: {
				available: () => false,
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(service.preview(user, {})).rejects.toThrow('does not support row preview');
		await expect(service.preview(user, { python: {} as never })).rejects.toThrow(
			'does not support row preview',
		);
	});

	it('is ready when either configured executor passes preflight', async () => {
		const service = new DataPreviewService({
			duckdbWasm: {
				available: () => false,
				supports: () => false,
				supportsFeatures: () => false,
				status: () => ({ available: false }),
				check: async () => {
					throw new Error('worker unavailable');
				},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(service.check()).resolves.toBeUndefined();
	});

	it('rejects preflight when every configured executor fails', async () => {
		const service = new DataPreviewService({
			duckdbWasm: {
				available: () => false,
				supports: () => false,
				supportsFeatures: () => false,
				status: () => ({ available: false }),
				check: async () => {
					throw new Error('duckdb failed');
				},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			sandbox: {
				available: () => false,
				check: async () => {
					throw new Error('sandbox failed');
				},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(service.check()).rejects.toThrow('No data-preview runtime is available');
	});

	it('treats preflight with no configured executors as a no-op', async () => {
		const service = new DataPreviewService({ maxConcurrent: 1, maxConcurrentPerUser: 1 });
		await expect(service.check()).resolves.toBeUndefined();
		expect(service.status()).toEqual([]);
	});

	it('closes every executor once without exposing disposal failures', async () => {
		const duckdbClose = vi.fn(async () => {
			throw new Error('duckdb close failed');
		});
		const sandboxClose = vi.fn(async () => {
			throw new Error('sandbox close failed');
		});
		const service = new DataPreviewService({
			duckdbWasm: {
				available: () => true,
				supports: () => true,
				supportsFeatures: () => true,
				status: () => ({ available: true }),
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: duckdbClose,
			},
			sandbox: {
				available: () => true,
				check: async () => {},
				preview: async () => ({ columns: [], rows: [] }),
				close: sandboxClose,
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
		});

		await expect(service.close()).resolves.toBeUndefined();
		await expect(service.close()).resolves.toBeUndefined();
		expect(duckdbClose).toHaveBeenCalledOnce();
		expect(sandboxClose).toHaveBeenCalledOnce();
	});
});
