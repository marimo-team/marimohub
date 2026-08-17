import {
	createIntegrationId,
	createProjectId,
	createSessionId,
	icebergRest,
	UserId,
} from '@marimo-hub/core';
import type { IcebergHttpBrokerTransportRequest } from '@marimo-hub/duckdb-wasm-runtime/node';
import {
	createNodeDataQueryExecutorFactory,
	createNodeDuckDBWasmRuntimeFactory,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { describe, expect, it } from 'vitest';
import { createDuckDBHttpSessionFactory, createGuardedBinaryTransport } from './duckdbHttpBroker';

const catalogUrl = process.env.MARIMOHUB_TEST_ICEBERG_BROKER_URI;
const s3Endpoint = process.env.MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT;
const liveCatalogUrl = catalogUrl ?? 'http://127.0.0.1:18181';
const liveS3Endpoint = s3Endpoint ?? 'http://127.0.0.1:19000';
const describeLive = catalogUrl && s3Endpoint ? describe : describe.skip;

const integration = {
	id: createIntegrationId(),
	name: 'live_catalog',
	kind: 'iceberg_rest',
	version: 1,
};

const config = icebergRest.configSchema.parse({
	uri: liveCatalogUrl,
	auth: { method: 'none' },
	access_delegation: 'none',
	storage: {
		scheme: 's3',
		endpoint: liveS3Endpoint,
		region: 'us-east-1',
		credentials: {
			method: 'static',
			access_key_id: process.env.MARIMOHUB_TEST_ICEBERG_BROKER_S3_ACCESS_KEY ?? 'minioadmin',
			secret_access_key: process.env.MARIMOHUB_TEST_ICEBERG_BROKER_S3_SECRET_KEY ?? 'minioadmin',
		},
		broker_read_locations: [
			{ bucket: 'warehouse', prefix: 'demo/events' },
			{ bucket: 'warehouse', prefix: 'broker-fixture' },
		],
	},
});

describeLive('guarded DuckDB HTTP broker live', () => {
	it('runs production preview and query plans through the guarded broker', async () => {
		const requests: Pick<IcebergHttpBrokerTransportRequest, 'url' | 'method'>[] = [];
		const guardedTransport = createGuardedBinaryTransport({ allowPrivate: true });
		const transport = async (request: IcebergHttpBrokerTransportRequest) => {
			requests.push({ url: request.url, method: request.method });
			return guardedTransport(request);
		};
		const httpSessionFactory = createDuckDBHttpSessionFactory({ transport });
		const programs = icebergRest.preview?.programs({
			config,
			integration,
			projectId: createProjectId(),
			principal: { userId: UserId.parse('user-live'), email: 'live@example.com' },
			sessionId: createSessionId(),
			namespace: ['demo'],
			table: 'events',
			limit: 20,
		});
		if (!programs?.duckdbWasm) throw new Error('Expected a DuckDB-Wasm preview plan.');

		const runtime = await createNodeDuckDBWasmRuntimeFactory('worker', httpSessionFactory)();
		try {
			await runtime.initialize({ memoryLimitMb: 128 });
			const preview = await runtime.execute(programs.duckdbWasm);
			expect(preview.columns).toEqual(['id', 'ts', 'name', 'value']);
			expect(preview.rows).toHaveLength(3);
			expect(preview.rows.map((row) => row[0])).toEqual(['1', '2', '3']);
		} finally {
			await runtime.close();
		}

		const plan = icebergRest.query?.plan({ config, integration });
		if (!plan) throw new Error('Expected a DuckDB-Wasm query plan.');
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory,
		}).create(new AbortController().signal);
		try {
			await expect(
				executor.execute(
					{
						sql:
							'SELECT (SELECT count(*) FROM live_catalog.demo.events) AS catalog_count, ' +
							"(SELECT count(*) FROM read_parquet('s3://warehouse/broker-fixture/sample.parquet')) AS object_count",
						connection: { files: [], vars: {}, integration, plan },
						accessMode: 'read-only',
						limits: { maxRows: 20, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['catalog_count', 'object_count'],
				rows: [['3', '1']],
				truncated: false,
			});
		} finally {
			executor.terminate();
		}

		const catalogOrigin = new URL(liveCatalogUrl).origin;
		const storageOrigin = new URL(liveS3Endpoint).origin;
		expect(requests.some((request) => new URL(request.url).origin === catalogOrigin)).toBe(true);
		const storagePaths = requests
			.map((request) => new URL(request.url))
			.filter((url) => url.origin === storageOrigin)
			.map((url) => url.pathname);
		expect(storagePaths).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^\/warehouse\/demo\/events\/metadata\/.*\.metadata\.json$/),
				expect.stringMatching(/^\/warehouse\/demo\/events\/metadata\/.*\.avro$/),
				expect.stringMatching(/^\/warehouse\/demo\/events\/data\/.*\.parquet$/),
			]),
		);
		expect(
			new Set(
				storagePaths.filter((path) => /^\/warehouse\/demo\/events\/metadata\/.*\.avro$/.test(path)),
			).size,
		).toBeGreaterThanOrEqual(2);
		for (const request of requests) {
			const url = new URL(request.url);
			if (url.origin === catalogOrigin) continue;
			expect(url.origin).toBe(storageOrigin);
			expect(
				url.pathname.startsWith('/warehouse/demo/events') ||
					url.pathname.startsWith('/warehouse/broker-fixture'),
			).toBe(true);
		}
	}, 45_000);
});
