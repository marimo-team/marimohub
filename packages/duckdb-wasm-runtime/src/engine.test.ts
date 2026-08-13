import { describe, expect, it, vi } from 'vitest';
import { BlockingDuckDBEngine } from './engine';

describe('BlockingDuckDBEngine initialization', () => {
	it('resets a database whose WASM instantiation fails', async () => {
		const reset = vi.fn();
		const database = {
			instantiate: vi.fn(async () => {
				throw new Error('partial initialization');
			}),
			reset,
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await expect(engine.initialize(64)).rejects.toThrow('partial initialization');
		expect(reset).toHaveBeenCalledOnce();
		expect(() => engine.ping()).toThrow('not initialized');
	});

	it('preserves the initialization error when cleanup also fails', async () => {
		const database = {
			instantiate: vi.fn(async () => {
				throw new Error('initialization failed');
			}),
			reset: vi.fn(() => {
				throw new Error('cleanup failed');
			}),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await expect(engine.initialize(64)).rejects.toThrow('initialization failed');
		expect(database.reset).toHaveBeenCalledOnce();
	});

	it.each(['open', 'connect'] as const)('resets a database when %s fails', async (stage) => {
		const reset = vi.fn();
		const connection = {
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			query: vi.fn(),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(() => {
				if (stage === 'open') throw new Error('open failed');
			}),
			connect: vi.fn(() => {
				if (stage === 'connect') throw new Error('connect failed');
				return connection;
			}),
			reset,
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await expect(engine.initialize(64)).rejects.toThrow(`${stage} failed`);
		expect(reset).toHaveBeenCalledOnce();
		expect(() => engine.ping()).toThrow('not initialized');
	});

	it('clears its database handle before reset during close', async () => {
		const connection = {
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			query: vi.fn(),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi.fn(() => connection),
			reset: vi.fn(() => {
				throw new Error('reset failed');
			}),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);
		await engine.initialize(64);

		expect(() => engine.close()).toThrow('reset failed');
		expect(() => engine.ping()).toThrow('not initialized');
		expect(() => engine.close()).not.toThrow();
		expect(database.reset).toHaveBeenCalledOnce();
	});
});
