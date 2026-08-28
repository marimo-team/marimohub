import { describe, expect, it, vi } from 'vitest';
import type { DataQueryExecution, IntegrationId } from '@marimo-hub/core';
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

	it('loads every pinned HTTP prerequisite before locking configuration', async () => {
		const connection = {
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			query: vi.fn(),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi.fn(() => connection),
			reset: vi.fn(),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await engine.initialize(64, true);

		const statements = connection.query.mock.calls.map(([sql]) => sql);
		expect(statements).toContain('LOAD httpfs');
		expect(statements).toContain('LOAD parquet');
		expect(statements).toContain('LOAD avro');
		expect(statements).toContain('LOAD iceberg');
		expect(statements.indexOf('LOAD iceberg')).toBeLessThan(
			statements.indexOf('SET lock_configuration=true'),
		);
	});

	it('does not initialize when a pinned HTTP prerequisite cannot load', async () => {
		const connection = {
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			query: vi.fn((sql: string) => {
				if (sql === 'LOAD iceberg') throw new Error('extension checksum mismatch');
			}),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi.fn(() => connection),
			reset: vi.fn(),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await expect(engine.initialize(64, true)).rejects.toThrow('extension checksum mismatch');
		expect(database.reset).toHaveBeenCalledOnce();
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

	it('preserves a preview query error when connection close also fails', async () => {
		const initializationConnection = {
			query: vi.fn(),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			close: vi.fn(),
		};
		const queryConnection = {
			query: vi.fn((sql: string) => {
				if (sql === 'SELECT broken') throw new Error('query failed');
			}),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			close: vi.fn(() => {
				throw new Error('close failed');
			}),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi
				.fn()
				.mockReturnValueOnce(initializationConnection)
				.mockReturnValueOnce(queryConnection),
			reset: vi.fn(),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		await engine.initialize(64);

		expect(() => engine.execute({ setup: [], query: { text: 'SELECT broken' } })).toThrow(
			'query failed',
		);
		expect(queryConnection.close).toHaveBeenCalledOnce();
	});

	it('materializes query files and environment only for the request lifetime', async () => {
		const existingName = 'MARIMOHUB_ENGINE_TEST_EXISTING';
		const newName = 'MARIMOHUB_ENGINE_TEST_NEW';
		const previousExisting = process.env[existingName];
		const previousNew = process.env[newName];
		process.env[existingName] = 'before';
		delete process.env[newName];
		const registerFileText = vi.fn();
		const dropFile = vi.fn((path: string) => {
			if (path.endsWith('second.json')) throw new Error('drop failed');
		});
		const queryConnection = {
			query: vi.fn((sql: string) => {
				if (sql === 'SELECT materialized') {
					expect(registerFileText).toHaveBeenCalledWith('/tmp/query-config.json', '{"ok":true}');
					expect(process.env[existingName]).toBe('during');
					expect(process.env[newName]).toBe('temporary');
					throw new Error('stop after inspection');
				}
			}),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			send: vi.fn(),
			close: vi.fn(),
		};
		const initializationConnection = {
			query: vi.fn(),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi
				.fn()
				.mockReturnValueOnce(initializationConnection)
				.mockReturnValueOnce(queryConnection),
			registerFileText,
			dropFile,
			reset: vi.fn(),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);
		const request: DataQueryExecution = {
			sql: 'SELECT 1',
			connection: {
				files: [
					{ path: '/tmp/query-config.json', content: '{"ok":true}' },
					{ path: '/tmp/second.json', content: '{}' },
				],
				vars: { [existingName]: 'during', [newName]: 'temporary' },
				integration: {
					id: 'intg-engine-test' as IntegrationId,
					name: 'engine-test',
					kind: 'test',
					version: 1,
				},
				plan: { setup: [{ text: 'SELECT materialized' }] },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 4096, deadlineMs: 1000 },
		};

		try {
			await engine.initialize(64);
			await expect(engine.executeQuery(request)).rejects.toThrow('stop after inspection');
			expect(dropFile).toHaveBeenCalledWith('/tmp/query-config.json');
			expect(dropFile).toHaveBeenCalledWith('/tmp/second.json');
			expect(process.env[existingName]).toBe('before');
			expect(process.env[newName]).toBeUndefined();
		} finally {
			if (previousExisting === undefined) delete process.env[existingName];
			else process.env[existingName] = previousExisting;
			if (previousNew === undefined) delete process.env[newName];
			else process.env[newName] = previousNew;
		}
	});

	it('removes materialized query state after successful execution', async () => {
		const envName = 'MARIMOHUB_ENGINE_TEST_SUCCESS';
		const previous = process.env[envName];
		delete process.env[envName];
		const registerFileText = vi.fn();
		const dropFile = vi.fn();
		const result = {
			schema: { fields: [{ name: 'value', type: { typeId: 0 } }] },
			open: vi.fn(),
			cancel: vi.fn(),
			*[Symbol.iterator]() {
				yield [{ toJSON: () => ({ value: 1 }) }];
			},
		};
		const queryConnection = {
			query: vi.fn(),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			send: vi.fn(async () => {
				expect(process.env[envName]).toBe('during');
				return result;
			}),
			close: vi.fn(),
		};
		const initializationConnection = {
			query: vi.fn(),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			close: vi.fn(),
		};
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi
				.fn()
				.mockReturnValueOnce(initializationConnection)
				.mockReturnValueOnce(queryConnection),
			registerFileText,
			dropFile,
			reset: vi.fn(),
		};
		const engine = new BlockingDuckDBEngine(async () => database as never);

		try {
			await engine.initialize(64);
			await expect(
				engine.executeQuery({
					sql: 'SELECT 1 AS value',
					connection: {
						files: [{ path: '/tmp/success.json', content: '{}' }],
						vars: { [envName]: 'during' },
						integration: {
							id: 'intg-engine-success' as IntegrationId,
							name: 'engine-success',
							kind: 'test',
							version: 1,
						},
					},
					accessMode: 'read-only',
					limits: { maxRows: 10, maxBytes: 4096, deadlineMs: 1000 },
				}),
			).resolves.toEqual({ columns: ['value'], rows: [[1]], truncated: false });
			expect(registerFileText).toHaveBeenCalledWith('/tmp/success.json', '{}');
			expect(dropFile).toHaveBeenCalledWith('/tmp/success.json');
			expect(process.env[envName]).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env[envName];
			else process.env[envName] = previous;
		}
	});

	it('serializes query environment materialization at the engine boundary', async () => {
		const envName = 'MARIMOHUB_ENGINE_TEST_SERIAL';
		const previous = process.env[envName];
		delete process.env[envName];
		const result = {
			schema: { fields: [{ name: 'value', type: { typeId: 0 } }] },
			open: vi.fn(),
			cancel: vi.fn(),
			*[Symbol.iterator]() {
				yield [{ toJSON: () => ({ value: 1 }) }];
			},
		};
		let finishFirst: ((value: typeof result) => void) | undefined;
		const firstSend = vi.fn(
			() =>
				new Promise<typeof result>((resolve) => {
					finishFirst = resolve;
				}),
		);
		const secondSend = vi.fn(async () => {
			expect(process.env[envName]).toBe('second');
			return result;
		});
		const connection = (send: typeof firstSend | typeof secondSend) => ({
			query: vi.fn(),
			prepare: vi.fn(() => ({ query: vi.fn(), close: vi.fn() })),
			send,
			close: vi.fn(),
		});
		const database = {
			instantiate: vi.fn(),
			open: vi.fn(),
			connect: vi
				.fn()
				.mockReturnValueOnce(connection(vi.fn() as never))
				.mockReturnValueOnce(connection(firstSend))
				.mockReturnValueOnce(connection(secondSend)),
			registerFileText: vi.fn(),
			dropFile: vi.fn(),
			reset: vi.fn(),
		};
		const request = (value: string): DataQueryExecution => ({
			sql: 'SELECT 1 AS value',
			connection: {
				files: [],
				vars: { [envName]: value },
				integration: {
					id: `intg-${value}` as IntegrationId,
					name: value,
					kind: 'test',
					version: 1,
				},
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 4096, deadlineMs: 1000 },
		});
		const engine = new BlockingDuckDBEngine(async () => database as never);

		try {
			await engine.initialize(64);
			const first = engine.executeQuery(request('first'));
			await vi.waitFor(() => expect(firstSend).toHaveBeenCalledOnce());
			expect(process.env[envName]).toBe('first');
			const second = engine.executeQuery(request('second'));
			await Promise.resolve();
			expect(secondSend).not.toHaveBeenCalled();
			expect(process.env[envName]).toBe('first');
			finishFirst?.(result);
			await expect(first).resolves.toEqual({ columns: ['value'], rows: [[1]], truncated: false });
			await expect(second).resolves.toEqual({ columns: ['value'], rows: [[1]], truncated: false });
			expect(secondSend).toHaveBeenCalledOnce();
			expect(process.env[envName]).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env[envName];
			else process.env[envName] = previous;
		}
	});
});
