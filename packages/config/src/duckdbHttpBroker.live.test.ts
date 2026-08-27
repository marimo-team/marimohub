import {
	createIntegrationId,
	createProjectId,
	createSessionId,
	icebergRest,
	s3,
	UserId,
} from '@marimo-hub/core';
import type { IcebergHttpBrokerTransportRequest } from '@marimo-hub/duckdb-wasm-runtime/node';
import {
	createNodeDataQueryExecutorFactory,
	createNodeDuckDBWasmRuntimeFactory,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { describe, expect, it } from 'vitest';
import { createDuckDBHttpSessionFactory, createGuardedBinaryTransport } from './duckdbHttpBroker';

const LIVE_ENVIRONMENT_KEYS = [
	'MARIMOHUB_TEST_ICEBERG_BROKER_URI',
	'MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT',
	'MARIMOHUB_TEST_ICEBERG_BROKER_S3_ACCESS_KEY',
	'MARIMOHUB_TEST_ICEBERG_BROKER_S3_SECRET_KEY',
] as const;

interface LiveBrokerEnvironment {
	catalogUrl: string;
	s3Endpoint: string;
	s3AccessKey: string;
	s3SecretKey: string;
}

function readLiveBrokerEnvironment(
	environment: Record<string, string | undefined>,
): LiveBrokerEnvironment | undefined {
	const configured = LIVE_ENVIRONMENT_KEYS.some((key) => environment[key] !== undefined);
	if (!configured) return undefined;

	const missing = LIVE_ENVIRONMENT_KEYS.filter((key) => !environment[key]?.trim());
	if (missing.length > 0) {
		throw new Error(
			'DuckDB HTTP broker live tests are only partially configured. ' +
				`Set all required live-test environment variables. Missing: ${missing.join(', ')}`,
		);
	}

	return {
		catalogUrl: environment.MARIMOHUB_TEST_ICEBERG_BROKER_URI!,
		s3Endpoint: environment.MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT!,
		s3AccessKey: environment.MARIMOHUB_TEST_ICEBERG_BROKER_S3_ACCESS_KEY!,
		s3SecretKey: environment.MARIMOHUB_TEST_ICEBERG_BROKER_S3_SECRET_KEY!,
	};
}

const liveEnvironment = readLiveBrokerEnvironment(process.env);
const describeLive = liveEnvironment ? describe : describe.skip;

const integration = {
	id: createIntegrationId(),
	name: 'live_catalog',
	kind: 'iceberg_rest',
	version: 1,
};

const s3Integration = {
	id: createIntegrationId(),
	name: 'live_s3',
	kind: 's3',
	version: 1,
};

describe('readLiveBrokerEnvironment', () => {
	it('does not enable live tests when none of the variables are set', () => {
		expect(readLiveBrokerEnvironment({})).toBeUndefined();
	});

	it('reports every missing variable when configuration is incomplete', () => {
		expect(() =>
			readLiveBrokerEnvironment({
				MARIMOHUB_TEST_ICEBERG_BROKER_URI: 'http://127.0.0.1:18181',
				MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT: ' ',
			}),
		).toThrow(
			'DuckDB HTTP broker live tests are only partially configured. ' +
				'Set all required live-test environment variables. Missing: ' +
				'MARIMOHUB_TEST_ICEBERG_BROKER_S3_ENDPOINT, ' +
				'MARIMOHUB_TEST_ICEBERG_BROKER_S3_ACCESS_KEY, ' +
				'MARIMOHUB_TEST_ICEBERG_BROKER_S3_SECRET_KEY',
		);
	});
});

describeLive('guarded DuckDB HTTP broker live', () => {
	it('runs production preview and query plans through the guarded broker', async () => {
		if (!liveEnvironment) throw new Error('Expected live-test configuration.');
		const { catalogUrl: liveCatalogUrl, s3Endpoint: liveS3Endpoint } = liveEnvironment;
		const config = icebergRest.configSchema.parse({
			uri: liveCatalogUrl,
			allow_insecure_transport: true,
			auth: { method: 'none' },
			access_delegation: 'none',
			storage: {
				scheme: 's3',
				endpoint: liveS3Endpoint,
				region: 'us-east-1',
				credentials: {
					method: 'static',
					access_key_id: liveEnvironment.s3AccessKey,
					secret_access_key: liveEnvironment.s3SecretKey,
				},
				broker_read_locations: [
					{ bucket: 'warehouse', prefix: 'demo/events' },
					{ bucket: 'warehouse', prefix: 'broker-fixture' },
				],
			},
		});
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
			expect(new Set(preview.rows.map((row) => row[0]))).toEqual(new Set(['1', '2', '3']));
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

		const s3Config = s3.configSchema.parse({
			endpoint_url: liveS3Endpoint,
			allow_insecure_transport: true,
			region: 'us-east-1',
			path_style: true,
			auth: {
				method: 'static',
				access_key_id: liveEnvironment.s3AccessKey,
				secret_access_key: liveEnvironment.s3SecretKey,
			},
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'broker-fixture' }],
		});
		const s3Plan = s3.query?.plan({ config: s3Config, integration: s3Integration });
		if (!s3Plan) throw new Error('Expected a guarded S3 query plan.');
		const s3Executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory,
		}).create(new AbortController().signal);
		try {
			await expect(
				s3Executor.execute(
					{
						sql: "SELECT count(*) AS object_count FROM read_parquet('s3://warehouse/broker-fixture/sample.parquet')",
						connection: { files: [], vars: {}, integration: s3Integration, plan: s3Plan },
						accessMode: 'read-only',
						limits: { maxRows: 20, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['object_count'],
				rows: [['1']],
				truncated: false,
			});
		} finally {
			s3Executor.terminate();
		}

		const catalogOrigin = new URL(liveCatalogUrl).origin;
		const storageOrigin = new URL(liveS3Endpoint).origin;
		expect(requests.some((request) => new URL(request.url).origin === catalogOrigin)).toBe(true);
		const storagePaths = requests
			.map((request) => new URL(request.url))
			.filter((url) => url.origin === storageOrigin)
			.map((url) => url.pathname);
		// The REST response may embed table metadata, so object reads can begin at the manifests.
		expect(storagePaths).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^\/warehouse\/demo\/events\/metadata\/.*\.avro$/),
				expect.stringMatching(/^\/warehouse\/demo\/events\/data\/.*\.parquet$/),
				'/warehouse/broker-fixture/sample.parquet',
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
