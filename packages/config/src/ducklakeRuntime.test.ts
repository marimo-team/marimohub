import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createIntegrationId, ducklake } from '@marimo-hub/core';
import {
	createNodeDataQueryExecutorFactory,
	DUCKLAKE_SPEC_VERSION,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import type {
	IcebergHttpBrokerResponse,
	IcebergHttpBrokerTransportRequest,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDuckDBHttpSessionFactory } from './duckdbHttpBroker';

const METADATA_URL = 'https://data.example.test/releases/ducklake-0.3.ducklake';
const METADATA_ETAG = '"ducklake-metadata-v1"';
const DATA_ETAG = '"ducklake-data-v1"';
const integration = {
	id: createIntegrationId(),
	name: 'lake',
	kind: 'ducklake',
	version: 1,
};

let metadata = new Uint8Array();
let parquet = new Uint8Array();

beforeAll(async () => {
	[metadata, parquet] = await Promise.all([
		readFile(fileURLToPath(new URL('./fixtures/ducklake-0.3.ducklake', import.meta.url))).then(
			(bytes) => new Uint8Array(bytes),
		),
		readFile(fileURLToPath(new URL('./fixtures/ducklake-orders.parquet', import.meta.url))).then(
			(bytes) => new Uint8Array(bytes),
		),
	]);
});

function queryPlan(prefix = 'ducklake/data/') {
	const config = ducklake.configSchema.parse({
		metadata: {
			type: 'duckdb',
			url: METADATA_URL,
			auth: { method: 'bearer_token', token: 'metadata-secret' },
		},
		storage: {
			scheme: 's3',
			endpoint: 'https://s3.example.test',
			region: 'us-east-1',
			force_virtual_addressing: true,
			credentials: {
				method: 'static',
				access_key_id: 'parent-key',
				secret_access_key: 'parent-secret',
			},
			broker_read_locations: [{ bucket: 'warehouse', prefix }],
		},
		snapshot: { version: 2 },
	});
	const plan = ducklake.query?.plan({ config, integration });
	if (!plan) throw new Error('Expected a DuckLake query plan.');
	return plan;
}

function rangedResponse(
	request: IcebergHttpBrokerTransportRequest,
	bytes: Uint8Array,
	etag: string,
): IcebergHttpBrokerResponse {
	if (request.method === 'HEAD') {
		return {
			status: 200,
			headers: { etag, 'accept-ranges': 'bytes', 'content-length': String(bytes.byteLength) },
			body: new Uint8Array(),
		};
	}
	const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers?.range ?? '');
	if (!match) {
		return {
			status: 200,
			headers: { etag, 'content-length': String(bytes.byteLength) },
			body: bytes,
		};
	}
	const start = Number(match[1]);
	const end = match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
	if (start >= bytes.byteLength) {
		return {
			status: 416,
			headers: { etag, 'content-range': `bytes */${bytes.byteLength}` },
			body: new Uint8Array(),
		};
	}
	const body = bytes.slice(start, end + 1);
	return {
		status: 206,
		headers: {
			etag,
			'content-length': String(body.byteLength),
			'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
		},
		body,
	};
}

describe('packaged DuckLake integration', () => {
	it('queries pinned 0.3 metadata and guarded S3 data through separate routes', async () => {
		const requests: IcebergHttpBrokerTransportRequest[] = [];
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 192,
			httpSessionFactory: createDuckDBHttpSessionFactory({
				transport: async (request) => {
					requests.push(request);
					if (request.url === METADATA_URL) {
						return rangedResponse(request, metadata, METADATA_ETAG);
					}
					if (
						request.url.startsWith('https://warehouse.s3.example.test/ducklake/data/main/orders/')
					) {
						return rangedResponse(request, parquet, DATA_ETAG);
					}
					throw new Error('Unexpected fixture route.');
				},
			}),
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql:
							'SELECT id, customer, total::VARCHAR AS total, ' +
							"(SELECT value FROM __ducklake_metadata_lake.main.ducklake_metadata WHERE key='version') AS specification " +
							'FROM lake.main.orders ORDER BY id',
						connection: { files: [], vars: {}, integration, plan: queryPlan() },
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['id', 'customer', 'total', 'specification'],
				rows: [
					[1, 'Ada', '12.50', DUCKLAKE_SPEC_VERSION],
					[2, 'Lin', '7.25', DUCKLAKE_SPEC_VERSION],
				],
				truncated: false,
			});
		} finally {
			executor.terminate();
		}

		const metadataRequests = requests.filter(({ url }) => url === METADATA_URL);
		const storageRequests = requests.filter(({ url }) => url !== METADATA_URL);
		expect(metadataRequests.length).toBeGreaterThanOrEqual(2);
		expect(storageRequests.length).toBeGreaterThan(0);
		expect(
			metadataRequests.every(({ headers }) => headers?.authorization === 'Bearer metadata-secret'),
		).toBe(true);
		expect(
			storageRequests.every(({ headers }) =>
				headers?.authorization?.startsWith('AWS4-HMAC-SHA256'),
			),
		).toBe(true);
		expect(
			storageRequests.every(({ headers }) => headers?.authorization !== 'Bearer metadata-secret'),
		).toBe(true);
		expect(storageRequests.every(({ headers }) => headers?.['x-amz-date'] !== undefined)).toBe(
			true,
		);
	});

	it('denies a data file outside the configured S3 prefix before transport', async () => {
		const requests: IcebergHttpBrokerTransportRequest[] = [];
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 192,
			httpSessionFactory: createDuckDBHttpSessionFactory({
				transport: async (request) => {
					requests.push(request);
					if (request.url === METADATA_URL) {
						return rangedResponse(request, metadata, METADATA_ETAG);
					}
					throw new Error('Storage transport must not receive an out-of-bounds request.');
				},
			}),
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql: 'SELECT count(*) FROM lake.main.orders',
						connection: {
							files: [],
							vars: {},
							integration,
							plan: queryPlan('ducklake/private/'),
						},
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).rejects.toThrow(/HTTP 404/);
		} finally {
			executor.terminate();
		}

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every(({ url }) => url === METADATA_URL)).toBe(true);
	});
});
