import { describe, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
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
import type { DuckDBHttpSessionFactory, IcebergHttpBrokerRequest } from './node';
import { createHttpBridgeBuffers } from './httpBridge';

type OnTestFinished = TestContext['onTestFinished'];

function track(runtime: DuckDBWasmRuntime, onTestFinished: OnTestFinished): DuckDBWasmRuntime {
	onTestFinished(() => runtime.close());
	return runtime;
}

async function initialized(
	mode: 'worker' | 'inline',
	onTestFinished: OnTestFinished,
): Promise<DuckDBWasmRuntime> {
	const runtime = track(await createNodeDuckDBWasmRuntimeFactory(mode)(), onTestFinished);
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

describe.concurrent('DuckDB-Wasm worker lifecycle', { timeout: 15_000 }, () => {
	it('caps the worker V8 heap and stack', ({ expect }) => {
		expect(DUCKDB_WORKER_RESOURCE_LIMITS).toEqual({
			maxOldGenerationSizeMb: 256,
			maxYoungGenerationSizeMb: 32,
			stackSizeMb: 4,
		});
		expect(Object.isFrozen(DUCKDB_WORKER_RESOURCE_LIMITS)).toBe(true);
	});

	it('blocks inline execution before a preview runtime is created', async ({ expect }) => {
		await expect(createNodeDuckDBWasmRuntimeFactory('inline')()).rejects.toThrow(
			/cannot be preempted/,
		);
	});

	it('reports why guarded HTTP is unavailable', ({ expect }) => {
		const capabilities = nodeDuckDBWasmCapabilities();
		expect(capabilities).toEqual({
			features: [],
			unavailable: {
				'guarded-http': expect.stringMatching(/configured parent broker session/i),
				'iceberg-http': expect.stringMatching(/configured parent broker session/i),
			},
		});
		expect(Object.isFrozen(capabilities)).toBe(true);
		expect(Object.isFrozen(capabilities.features)).toBe(true);
		expect(Object.isFrozen(capabilities.unavailable)).toBe(true);
	});

	it('loads pinned HTTP extensions and creates only a dummy S3 secret in the worker', async ({
		expect,
		onTestFinished,
	}) => {
		const close = vi.fn();
		const fetch = vi.fn();
		let expiresAtMs: number | undefined;
		const createSession: DuckDBHttpSessionFactory = vi.fn((_access, options) => {
			expiresAtMs = options.expiresAtMs;
			return { fetch, close };
		});
		const runtime = track(
			await createNodeDuckDBWasmRuntimeFactory('worker', createSession, 125_000)(),
			onTestFinished,
		);
		expect(runtime.features).toEqual([]);
		await runtime.initialize({ memoryLimitMb: 128 });

		expect(runtime.features).toEqual(['guarded-http', 'iceberg-http']);
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
						urlStyle: 'path',
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

	it('builds virtual-hosted S3 requests with the packaged HTTP extension', async ({
		expect,
		onTestFinished,
	}) => {
		const close = vi.fn();
		const fetch = vi.fn(async (_request: IcebergHttpBrokerRequest) => ({
			status: 404,
			headers: {},
			body: new Uint8Array(),
		}));
		const runtime = track(
			await createNodeDuckDBWasmRuntimeFactory('worker', () => ({ fetch, close }))(),
			onTestFinished,
		);
		await runtime.initialize({ memoryLimitMb: 128 });

		await expect(
			runtime.execute({
				setup: [
					{ text: 'LOAD httpfs' },
					{
						text:
							"CREATE TEMPORARY SECRET broker_test (TYPE S3, KEY_ID 'dummy', " +
							"SECRET 'dummy', REGION ?, ENDPOINT ?, URL_STYLE 'vhost', USE_SSL ?)",
						params: ['us-east-1', 'objects.example.test', true],
					},
				],
				query: { text: "SELECT * FROM read_parquet('s3://warehouse/tables/file.parquet')" },
				cleanup: [{ text: 'DROP SECRET broker_test' }],
				requires: ['iceberg-http'],
				httpAccess: {
					kind: 'iceberg-rest',
					catalog: { url: 'https://catalog.example.test' },
					storage: {
						kind: 's3',
						endpoint: 'https://objects.example.test',
						region: 'us-east-1',
						urlStyle: 'vhost',
						credentials: { method: 'anonymous' },
						locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				},
			}),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalled();
		expect(fetch.mock.calls.map(([request]) => request.url)).toEqual(
			expect.arrayContaining(['https://warehouse.objects.example.test/tables/file.parquet']),
		);
		expect(close).toHaveBeenCalledOnce();
	}, 30_000);

	it('preserves request order while initialization is pending', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = track(await createNodeDuckDBWasmRuntimeFactory('worker')(), onTestFinished);

		const initializing = runtime.initialize({ memoryLimitMb: 64 });
		const executing = runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } });

		await expect(Promise.all([initializing, executing])).resolves.toEqual([
			undefined,
			{ columns: ['value'], rows: [[1]] },
		]);
	}, 15_000);

	it('blocks host filesystem enumeration when brokered HTTP is enabled', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = track(
			await createNodeDuckDBWasmRuntimeFactory('worker', () => ({
				fetch: vi.fn(),
				close: vi.fn(),
			}))(),
			onTestFinished,
		);
		await runtime.initialize({ memoryLimitMb: 64 });

		await expect(
			runtime.execute({ setup: [], query: { text: "SELECT * FROM glob('/*')" } }),
		).rejects.toThrow();
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	}, 15_000);

	it('removes requests rejected synchronously by postMessage', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized('worker', onTestFinished);
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
	}, 15_000);

	it('becomes closed when its worker fails', async ({ expect, onTestFinished }) => {
		const runtime = await initialized('worker', onTestFinished);
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

	it('terminates cleanly when the worker sends a non-object response', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized('worker', onTestFinished);
		const internals = runtime as unknown as {
			worker: { emit(event: 'message', message: unknown): boolean };
		};

		expect(() => internals.worker.emit('message', null)).not.toThrow();
		await expect(runtime.ping()).rejects.toThrow('closed');
	});

	it('terminates the worker when an HTTP bridge message has malformed buffers', async ({
		expect,
		onTestFinished,
	}) => {
		const metrics = {
			increment: vi.fn(),
			gauge: vi.fn(),
			histogram: vi.fn(),
		} satisfies Metrics;
		const runtime = track(
			await createNodeDuckDBWasmRuntimeFactory('worker', undefined, 60_000, metrics)(),
			onTestFinished,
		);
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

	it('rejects a bridge request from a different execution and closes the session', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized('worker', onTestFinished);
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

	it('hard-terminates an executing query when closed', async ({ expect, onTestFinished }) => {
		const runtime = await initialized('worker', onTestFinished);
		const executing = runtime.execute({
			setup: [],
			query: { text: 'SELECT sum(value) FROM range(1000000000) values(value)' },
		});

		await runtime.close();
		await expect(executing).rejects.toThrow('closed');
	}, 15_000);
});

describe.concurrent('DuckDB-Wasm data-query executor', () => {
	it('preserves rendered connection material for non-brokered plans', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized('worker', onTestFinished);
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
					connection: expect.objectContaining({
						files: [{ path: 'secret.txt', content: 'file-secret' }],
						vars: { QUERY_SECRET: 'environment-secret' },
						plan: { setup: [] },
					}),
				}),
			}),
		);
	});

	it('keeps rendered credentials in the parent for brokered plans', async ({
		expect,
		onTestFinished,
	}) => {
		const close = vi.fn();
		const createSession = vi.fn<
			NonNullable<Parameters<typeof createNodeDuckDBWasmRuntimeFactory>[1]>
		>(() => ({
			fetch: vi.fn(),
			close,
		}));
		const runtime = track(
			await createNodeDuckDBWasmRuntimeFactory('worker', createSession)(),
			onTestFinished,
		);
		await runtime.initialize({ memoryLimitMb: 64 });
		const internals = runtime as unknown as {
			worker: { postMessage(message: unknown): void };
			executeQuery(request: DataQueryExecution, signal: AbortSignal): Promise<unknown>;
		};
		const postMessage = vi.spyOn(internals.worker, 'postMessage');
		const request = dataQuery('select true as parent_only');
		request.connection = {
			...request.connection,
			files: [{ path: 'broker-secret.txt', content: 'file-secret' }],
			vars: { BROKER_SECRET: 'environment-secret' },
			plan: {
				setup: [],
				httpAccess: {
					kind: 'iceberg-rest',
					catalog: {
						url: 'https://catalog.example.test',
						oauth2: {
							tokenEndpoint: 'https://identity.example.test/oauth/token',
							clientId: 'parent-client-id',
							clientSecret: 'parent-client-secret',
							scope: 'catalog',
							refreshMarginSeconds: 60,
						},
					},
					storage: {
						kind: 's3',
						endpoint: 'https://objects.example.test',
						region: 'us-east-1',
						urlStyle: 'path',
						credentials: { method: 'anonymous' },
						locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				},
			},
		};
		await expect(internals.executeQuery(request, new AbortController().signal)).resolves.toEqual({
			columns: ['parent_only'],
			rows: [[true]],
			truncated: false,
		});
		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'execute-query',
				request: expect.objectContaining({
					connection: expect.objectContaining({ files: [], vars: {}, plan: { setup: [] } }),
				}),
			}),
		);
		const workerMessages = JSON.stringify(postMessage.mock.calls);
		expect(workerMessages).not.toContain('parent-client-id');
		expect(workerMessages).not.toContain('parent-client-secret');
		expect(createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				catalog: expect.objectContaining({
					oauth2: expect.objectContaining({ clientSecret: 'parent-client-secret' }),
				}),
			}),
			expect.anything(),
		);
		expect(close).toHaveBeenCalledOnce();
	}, 15_000);

	it('uses a fresh worker and enforces the row cap while streaming', async ({ expect }) => {
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

	it('rejects multiple statements and ambient external access', async ({ expect }) => {
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

describe.concurrent('DuckDB-Wasm worker runtime', () => {
	const mode = 'worker' as const;
	it('rejects remote-required programs before executing their setup', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
		expect(runtime.features).not.toContain('guarded-http');
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

	it('rejects work before initialization and after close', async ({ expect, onTestFinished }) => {
		const runtime = track(await createNodeDuckDBWasmRuntimeFactory(mode)(), onTestFinished);
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

	it('allows repeated initialization without replacing the database', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
		await runtime.initialize({ memoryLimitMb: 128 });
		await expect(runtime.ping()).resolves.toBeUndefined();
		await expect(
			runtime.execute({ setup: [], query: { text: "SET memory_limit='128MB'" } }),
		).rejects.toThrow(/locked/i);
	});

	it('resets after failed initialization and can initialize cleanly later', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = track(await createNodeDuckDBWasmRuntimeFactory(mode)(), onTestFinished);

		await expect(runtime.initialize({ memoryLimitMb: Number.NaN })).rejects.toThrow();
		await expect(runtime.ping()).rejects.toThrow(/not initialized/i);
		await expect(runtime.initialize({ memoryLimitMb: 64 })).resolves.toBeUndefined();
		await expect(runtime.ping()).resolves.toBeUndefined();
	}, 15_000);

	it('executes SQL and normalizes Arrow values', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('normalizes nested, binary, null, and non-finite values to JSON-safe output', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('binds statement parameters instead of interpolating values', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('binds every supported parameter type including null', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	async function rejectsInvalidParameterCount(
		params: readonly number[],
		expect: TestContext['expect'],
		onTestFinished: OnTestFinished,
	) {
		const runtime = await initialized(mode, onTestFinished);
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT ? AS value', params } }),
		).rejects.toThrow();
		await expect(
			runtime.execute({ setup: [], query: { text: 'SELECT 1 AS value' } }),
		).resolves.toEqual({ columns: ['value'], rows: [[1]] });
	}

	it('rejects too few bound parameters and remains usable', async ({ expect, onTestFinished }) =>
		rejectsInvalidParameterCount([], expect, onTestFinished));

	it('rejects too many bound parameters and remains usable', async ({ expect, onTestFinished }) =>
		rejectsInvalidParameterCount([1, 2], expect, onTestFinished));

	it('locks configuration, disables external access, and forces a read-only transaction', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('closes the failed connection before later work', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('runs cleanup when setup fails partway through', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('runs cleanup after the preview query fails', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('runs cleanup statements in reverse dependency order', async ({ expect, onTestFinished }) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('returns the primary query error when cleanup also fails', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
		await expect(
			runtime.execute({
				setup: [],
				query: { text: 'SELECT primary_missing' },
				cleanup: [{ text: 'SELECT cleanup_missing' }],
			}),
		).rejects.toThrow(/primary_missing/i);
	});

	it('returns a cleanup error after a successful query and remains usable', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
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

	it('rejects oversized results without making later work fail', async ({
		expect,
		onTestFinished,
	}) => {
		const runtime = await initialized(mode, onTestFinished);
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
