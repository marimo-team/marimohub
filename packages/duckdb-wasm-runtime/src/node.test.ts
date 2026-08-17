import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	DataQueryExecution,
	DuckDBPreviewProgram,
	DuckDBWasmRuntime,
	IntegrationId,
	Metrics,
} from '@marimo-hub/core';
import {
	createNodeDataQueryExecutorFactory,
	createNodeDuckDBWasmRuntimeFactory,
	DUCKDB_WORKER_RESOURCE_LIMITS,
	nodeDuckDBWasmCapabilities,
} from './node';
import type { DuckDBHttpSessionFactory } from './node';
import { createHttpBridgeBuffers } from './httpBridge';

const open: DuckDBWasmRuntime[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map((runtime) => runtime.close()));
});

async function initialized(mode: 'worker' | 'inline'): Promise<DuckDBWasmRuntime> {
	const runtime = await createNodeDuckDBWasmRuntimeFactory(mode)();
	open.push(runtime);
	await runtime.initialize({ memoryLimitMb: 64 });
	return runtime;
}

function dataQuery(
	sql: string,
	limits: Partial<DataQueryExecution['limits']> = {},
): DataQueryExecution {
	return {
		sql,
		connection: {
			files: [],
			vars: {},
			integration: {
				id: 'intg-query' as IntegrationId,
				name: 'query',
				kind: 'custom_env',
				version: 1,
			},
		},
		accessMode: 'read-only',
		limits: { maxRows: 100, maxBytes: 4096, deadlineMs: 10_000, ...limits },
	};
}

describe('DuckDB-Wasm worker lifecycle', () => {
	it('caps the worker V8 heap and stack', () => {
		expect(DUCKDB_WORKER_RESOURCE_LIMITS).toEqual({
			maxOldGenerationSizeMb: 256,
			maxYoungGenerationSizeMb: 32,
			stackSizeMb: 4,
		});
		expect(Object.isFrozen(DUCKDB_WORKER_RESOURCE_LIMITS)).toBe(true);
	});

	it('blocks inline execution before a preview runtime is created', async () => {
		await expect(createNodeDuckDBWasmRuntimeFactory('inline')()).rejects.toThrow(
			/cannot be preempted/,
		);
	});

	it('reports why guarded Iceberg HTTP is unavailable', () => {
		const capabilities = nodeDuckDBWasmCapabilities();
		expect(capabilities).toEqual({
			features: [],
			unavailable: {
				'iceberg-http': expect.stringMatching(/configured parent broker session/i),
			},
		});
		expect(Object.isFrozen(capabilities)).toBe(true);
		expect(Object.isFrozen(capabilities.features)).toBe(true);
		expect(Object.isFrozen(capabilities.unavailable)).toBe(true);
	});

	it('loads pinned HTTP extensions and creates only a dummy S3 secret in the worker', async () => {
		const close = vi.fn();
		const fetch = vi.fn();
		let expiresAtMs: number | undefined;
		const createSession: DuckDBHttpSessionFactory = vi.fn((_access, options) => {
			expiresAtMs = options.expiresAtMs;
			return { fetch, close };
		});
		const runtime = await createNodeDuckDBWasmRuntimeFactory('worker', createSession, 125_000)();
		open.push(runtime);
		expect(runtime.features).toEqual([]);
		await runtime.initialize({ memoryLimitMb: 128 });

		expect(runtime.features).toEqual(['iceberg-http']);
		const beforeExecute = Date.now();
		await expect(
			runtime.execute({
				setup: [
					{ text: 'LOAD iceberg' },
					{ text: 'LOAD httpfs' },
					{
						text:
							"CREATE TEMPORARY SECRET broker_test (TYPE S3, KEY_ID 'dummy', " +
							"SECRET 'dummy', REGION ?, ENDPOINT ?, URL_STYLE 'path', USE_SSL ?)",
						params: ['us-east-1', 'objects.example.test', true],
					},
				],
				query: { text: 'SELECT 1 AS value' },
				cleanup: [{ text: 'DROP SECRET broker_test' }],
				requires: ['iceberg-http'],
				httpAccess: {
					kind: 'iceberg-rest',
					catalog: { url: 'https://catalog.example.test' },
					storage: {
						kind: 's3',
						endpoint: 'https://objects.example.test',
						region: 'us-east-1',
						credentials: { method: 'anonymous' },
						locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				},
			}),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
		expect(createSession).toHaveBeenCalledWith(expect.anything(), {
			expiresAtMs: expect.any(Number),
		});
		expect(expiresAtMs).toBeGreaterThanOrEqual(beforeExecute + 124_000);
		expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 125_000);
		expect(fetch).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	}, 30_000);

	it('preserves request order while initialization is pending', async () => {
		const runtime = await createNodeDuckDBWasmRuntimeFactory('worker')();
		open.push(runtime);

		const initializing = runtime.initialize({ memoryLimitMb: 64 });
		const executing = runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } });

		await expect(Promise.all([initializing, executing])).resolves.toEqual([
			undefined,
			{ columns: ['value'], rows: [[1]] },
		]);
	}, 15_000);

	it('blocks host filesystem enumeration when brokered HTTP is enabled', async () => {
		const runtime = await createNodeDuckDBWasmRuntimeFactory('worker', () => ({
			fetch: vi.fn(),
			close: vi.fn(),
		}))();
		open.push(runtime);
		await runtime.initialize({ memoryLimitMb: 64 });

		await expect(
			runtime.execute({ setup: [], query: { text: "SELECT * FROM glob('/*')" } }),
		).rejects.toThrow();
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	}, 15_000);

	it('removes requests rejected synchronously by postMessage', async () => {
		const runtime = await initialized('worker');
		const internals = runtime as unknown as { pending: Map<number, unknown> };
		const invalidProgram = {
			setup: [],
			query: { text: 'SELECT 1', params: [() => {}] },
		} as unknown as DuckDBPreviewProgram;

		await expect(runtime.execute(invalidProgram)).rejects.toThrow(/clone/i);
		expect(internals.pending.size).toBe(0);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 2 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[2]] });
	});

	it('becomes closed when its worker fails', async () => {
		const runtime = await initialized('worker');
		const internals = runtime as unknown as {
			worker: {
				emit(event: 'error', error: Error): boolean;
				terminate(): Promise<number>;
			};
			pending: Map<number, unknown>;
		};
		const pending = runtime.ping();
		const terminate = vi.spyOn(internals.worker, 'terminate');

		internals.worker.emit('error', new Error('worker failed'));

		await expect(pending).rejects.toThrow('worker failed');
		await expect(runtime.ping()).rejects.toThrow('closed');
		expect(internals.pending.size).toBe(0);
		expect(terminate).toHaveBeenCalledOnce();
		const termination = terminate.mock.results[0]?.value;
		if (termination) await termination;
	});

	it('terminates cleanly when the worker sends a non-object response', async () => {
		const runtime = await initialized('worker');
		const internals = runtime as unknown as {
			worker: { emit(event: 'message', message: unknown): boolean };
		};

		expect(() => internals.worker.emit('message', null)).not.toThrow();
		await expect(runtime.ping()).rejects.toThrow('closed');
	});

	it('terminates the worker when an HTTP bridge message has malformed buffers', async () => {
		const metrics = {
			increment: vi.fn(),
			gauge: vi.fn(),
			histogram: vi.fn(),
		} satisfies Metrics;
		const runtime = await createNodeDuckDBWasmRuntimeFactory(
			'worker',
			undefined,
			60_000,
			metrics,
		)();
		open.push(runtime);
		await runtime.initialize({ memoryLimitMb: 64 });
		const internals = runtime as unknown as {
			activeHttpSession?: {
				fetch: ReturnType<typeof vi.fn>;
				close: ReturnType<typeof vi.fn>;
			};
			worker: {
				emit(event: 'message', message: unknown): boolean;
				terminate(): Promise<number>;
			};
		};
		const terminate = vi.spyOn(internals.worker, 'terminate');
		const closeSession = vi.fn();
		internals.activeHttpSession = { fetch: vi.fn(), close: closeSession };

		internals.worker.emit('message', {
			type: 'http-request',
			request: { url: 'https://catalog.example.test/v1/config', method: 'GET' },
			control: new SharedArrayBuffer(1),
			response: new SharedArrayBuffer(1),
		});

		await expect(runtime.ping()).rejects.toThrow('closed');
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.bridge_failure', 1, {
			reason: 'invalid_message',
		});
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_wasm.worker_termination', 1, {
			reason: 'failure',
		});
		expect(closeSession).toHaveBeenCalledOnce();
		expect(terminate).toHaveBeenCalledOnce();
		const termination = terminate.mock.results[0]?.value;
		if (termination) await termination;
	});

	it('rejects a bridge request from a different execution and closes the session', async () => {
		const runtime = await initialized('worker');
		const closeSession = vi.fn();
		const fetch = vi.fn();
		const internals = runtime as unknown as {
			activeHttpSession?: { fetch: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
			activeHttpNonce?: string;
			worker: { emit(event: 'message', message: unknown): boolean };
		};
		internals.activeHttpSession = { fetch, close: closeSession };
		internals.activeHttpNonce = 'current-execution-nonce';
		const { control, response } = createHttpBridgeBuffers();

		internals.worker.emit('message', {
			type: 'http-request',
			executionNonce: 'previous-execution-nonce',
			request: { url: 'https://catalog.example.test/v1/config', method: 'GET' },
			control,
			response,
		});

		await expect(runtime.ping()).rejects.toThrow('closed');
		expect(closeSession).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});

	it('hard-terminates an executing query when closed', async () => {
		const runtime = await initialized('worker');
		const executing = runtime.execute({
			setup: [],
			query: { text: 'SELECT sum(value) FROM range(1000000000) values(value)' },
		});

		await runtime.close();
		await expect(executing).rejects.toThrow('closed');
	}, 15_000);
});

describe('DuckDB-Wasm data-query executor', () => {
	it('keeps rendered credentials in the parent for non-brokered plans', async () => {
		const runtime = await initialized('worker');
		const internals = runtime as unknown as {
			worker: { postMessage(message: unknown): void };
			executeQuery(request: DataQueryExecution, signal: AbortSignal): Promise<unknown>;
		};
		const postMessage = vi.spyOn(internals.worker, 'postMessage');
		const request = dataQuery('select true as parent_only');
		request.connection = {
			...request.connection,
			files: [{ path: 'secret.txt', content: 'file-secret' }],
			vars: { QUERY_SECRET: 'environment-secret' },
			plan: { setup: [] },
		};

		await expect(
			internals.executeQuery(request, new AbortController().signal),
		).resolves.toMatchObject({ rows: [[true]] });
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'execute-query',
				request: expect.objectContaining({
					connection: expect.objectContaining({ files: [], vars: {}, plan: { setup: [] } }),
				}),
			}),
		);
	});

	it('keeps rendered credentials in the parent for brokered plans', async () => {
		const close = vi.fn();
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 64,
			httpSessionFactory: () => ({ fetch: vi.fn(), close }),
		}).create(new AbortController().signal);
		const request = dataQuery('select true as parent_only');
		request.connection = {
			...request.connection,
			files: [{ path: 'broker-secret.txt', content: 'file-secret' }],
			vars: { BROKER_SECRET: 'environment-secret' },
			plan: {
				setup: [],
				httpAccess: {
					kind: 'iceberg-rest',
					catalog: { url: 'https://catalog.example.test' },
					storage: {
						kind: 's3',
						endpoint: 'https://objects.example.test',
						region: 'us-east-1',
						credentials: { method: 'anonymous' },
						locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				},
			},
		};
		try {
			await expect(executor.execute(request, new AbortController().signal)).resolves.toEqual({
				columns: ['parent_only'],
				rows: [[true]],
				truncated: false,
			});
			expect(close).toHaveBeenCalledOnce();
		} finally {
			executor.terminate();
		}
	}, 15_000);

	it('uses a fresh worker and enforces the row cap while streaming', async () => {
		const executor = await createNodeDataQueryExecutorFactory({ memoryLimitMb: 64 }).create(
			new AbortController().signal,
		);
		try {
			await expect(
				executor.execute(
					dataQuery('select value from range(5) values(value)', { maxRows: 2 }),
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['value'],
				rows: [['0'], ['1']],
				truncated: true,
			});
		} finally {
			executor.terminate();
		}
	}, 15_000);

	it('rejects multiple statements and ambient external access', async () => {
		const executor = await createNodeDataQueryExecutorFactory({ memoryLimitMb: 64 }).create(
			new AbortController().signal,
		);
		try {
			await expect(
				executor.execute(dataQuery('select 1; select 2'), new AbortController().signal),
			).rejects.toThrow(/exactly one statement/i);
			await expect(
				executor.execute(
					dataQuery("select * from read_csv_auto('https://example.com/data.csv')"),
					new AbortController().signal,
				),
			).rejects.toThrow(/external access|disabled/i);
		} finally {
			executor.terminate();
		}
	}, 15_000);
});

describe('DuckDB-Wasm worker runtime', () => {
	const mode = 'worker' as const;
	it('rejects remote-required programs before executing their setup', async () => {
		const runtime = await initialized(mode);
		expect(runtime.features).not.toContain('iceberg-http');
		await expect(
			runtime.execute({
				setup: [{ text: 'CREATE TABLE must_not_exist(value INTEGER)' }],
				query: { text: 'SELECT 1' },
				requires: ['iceberg-http'],
			}),
		).rejects.toThrow(/does not support required feature iceberg-http.*policy-enforcing broker/i);
		await expect(
			runtime.execute({
				setup: [],
				query: {
					text: `SELECT count(*) AS count
						FROM information_schema.tables
						WHERE table_name = 'must_not_exist'`,
				},
			}),
		).resolves.toEqual({ columns: ['count'], rows: [['0']] });
	});

	it('rejects work before initialization and after close', async () => {
		const runtime = await createNodeDuckDBWasmRuntimeFactory(mode)();
		open.push(runtime);
		await expect(runtime.execute({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			/not initialized/i,
		);
		await runtime.initialize({ memoryLimitMb: 64 });
		await runtime.close();
		await expect(runtime.execute({ setup: [], query: { text: 'SELECT 1' } })).rejects.toThrow(
			/closed|not initialized/i,
		);
		await expect(runtime.close()).resolves.toBeUndefined();
	});

	it('allows repeated initialization without replacing the database', async () => {
		const runtime = await initialized(mode);
		await runtime.initialize({ memoryLimitMb: 128 });
		await expect(runtime.ping()).resolves.toBeUndefined();
		await expect(
			runtime.execute({ setup: [], query: { text: "SET memory_limit='128MB'" } }),
		).rejects.toThrow(/locked/i);
	});

	it('resets after failed initialization and can initialize cleanly later', async () => {
		const runtime = await createNodeDuckDBWasmRuntimeFactory(mode)();
		open.push(runtime);

		await expect(runtime.initialize({ memoryLimitMb: Number.NaN })).rejects.toThrow();
		await expect(runtime.ping()).rejects.toThrow(/not initialized/i);
		await expect(runtime.initialize({ memoryLimitMb: 64 })).resolves.toBeUndefined();
		await expect(runtime.ping()).resolves.toBeUndefined();
	}, 15_000);

	it('executes SQL and normalizes Arrow values', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: "SELECT 42::BIGINT AS bigint, 'ok' AS text, '2024-01-01'::DATE AS date" },
			}),
		).resolves.toEqual({
			columns: ['bigint', 'text', 'date'],
			rows: [['42', 'ok', expect.any(String)]],
		});
	});

	it('normalizes nested, binary, null, and non-finite values to JSON-safe output', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: {
					text: `SELECT
						NULL::VARCHAR AS null_value,
						'NaN'::DOUBLE AS nan_value,
						'Infinity'::DOUBLE AS infinity_value,
						from_hex('616263') AS bytes,
						[1, 2, NULL] AS list_value,
						{'name': 'duck', 'count': 2} AS struct_value`,
				},
			}),
		).resolves.toEqual({
			columns: ['null_value', 'nan_value', 'infinity_value', 'bytes', 'list_value', 'struct_value'],
			rows: [[null, null, null, 'YWJj', [1, 2, null], { name: 'duck', count: 2 }]],
		});
	});

	it('binds statement parameters instead of interpolating values', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [
					{ text: 'CREATE TABLE values_table(value VARCHAR)' },
					{ text: 'INSERT INTO values_table VALUES (?)', params: ["x'); SELECT 99; --"] },
				],
				query: { text: 'SELECT value FROM values_table LIMIT ?', params: [1] },
				cleanup: [{ text: 'DROP TABLE values_table' }],
			}),
		).resolves.toEqual({
			columns: ['value'],
			rows: [["x'); SELECT 99; --"]],
		});
	});

	it('binds every supported parameter type including null', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: {
					text: `SELECT
						?::VARCHAR AS text,
						?::DOUBLE AS number,
						?::BOOLEAN AS bool,
						?::VARCHAR AS nullable`,
					params: ["x'); DROP TABLE anything; --", 1.25, false, null],
				},
			}),
		).resolves.toEqual({
			columns: ['text', 'number', 'bool', 'nullable'],
			rows: [["x'); DROP TABLE anything; --", 1.25, false, null]],
		});
	});

	it.each([
		['too few', []],
		['too many', [1, 2]],
	] as const)('rejects %s bound parameters and remains usable', async (_name, params) => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT ? AS value', params } }),
		).rejects.toThrow();
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	});

	it('locks configuration, disables external access, and forces a read-only transaction', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({ setup: [], query: { text: "SET memory_limit='128MB'" } }),
		).rejects.toThrow(/locked/i);
		await expect(
			runtime.execute({ setup: [], query: { text: 'CREATE TABLE denied(i INTEGER)' } }),
		).rejects.toThrow(/read-only mode/i);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: "SELECT * FROM read_csv_auto('https://example.com/a.csv')" },
			}),
		).rejects.toThrow(/external access|disabled/i);
	});

	it('closes the failed connection before later work', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: 'SELECT missing_column' },
			}),
		).rejects.toThrow(/missing_column/i);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({
			columns: ['value'],
			rows: [[1]],
		});
	});

	it('runs cleanup when setup fails partway through', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [
					{ text: 'CREATE TABLE cleanup_after_setup_failure(value INTEGER)' },
					{ text: 'INSERT INTO cleanup_after_setup_failure VALUES (?)', params: [] },
				],
				query: { text: 'SELECT * FROM cleanup_after_setup_failure' },
				cleanup: [{ text: 'DROP TABLE cleanup_after_setup_failure' }],
			}),
		).rejects.toThrow();
		await expect(
			runtime.execute({
				setup: [],
				query: {
					text: `SELECT count(*) AS count
						FROM information_schema.tables
						WHERE table_name = 'cleanup_after_setup_failure'`,
				},
			}),
		).resolves.toEqual({ columns: ['count'], rows: [['0']] });
	});

	it('runs cleanup after the preview query fails', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [{ text: 'CREATE TABLE cleanup_after_query_failure(value INTEGER)' }],
				query: { text: 'SELECT missing_column FROM cleanup_after_query_failure' },
				cleanup: [{ text: 'DROP TABLE cleanup_after_query_failure' }],
			}),
		).rejects.toThrow(/missing_column/i);
		await expect(
			runtime.execute({
				setup: [],
				query: {
					text: `SELECT count(*) AS count
						FROM information_schema.tables
						WHERE table_name = 'cleanup_after_query_failure'`,
				},
			}),
		).resolves.toEqual({ columns: ['count'], rows: [['0']] });
	});

	it('runs cleanup statements in reverse dependency order', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [
					{ text: 'CREATE TABLE cleanup_parent(id INTEGER PRIMARY KEY)' },
					{
						text: 'CREATE TABLE cleanup_child(parent_id INTEGER REFERENCES cleanup_parent(id))',
					},
				],
				query: { text: 'SELECT 1 AS value' },
				cleanup: [{ text: 'DROP TABLE cleanup_parent' }, { text: 'DROP TABLE cleanup_child' }],
			}),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	});

	it('returns the primary query error when cleanup also fails', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: 'SELECT primary_missing' },
				cleanup: [{ text: 'SELECT cleanup_missing' }],
			}),
		).rejects.toThrow(/primary_missing/i);
	});

	it('returns a cleanup error after a successful query and remains usable', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: 'SELECT 1 AS value' },
				cleanup: [{ text: 'SELECT cleanup_missing' }],
			}),
		).rejects.toThrow(/cleanup_missing/i);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 2 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[2]] });
	});

	it('rejects oversized results without making later work fail', async () => {
		const runtime = await initialized(mode);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: `SELECT repeat('x', ${2 * 1024 * 1024 + 1}) AS huge` },
			}),
		).rejects.toThrow(/response limit/i);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	});
});
