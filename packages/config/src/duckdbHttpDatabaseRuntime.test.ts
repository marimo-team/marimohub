import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createIntegrationId, duckdbHttp } from '@marimo-hub/core';
import { createNodeDataQueryExecutorFactory } from '@marimo-hub/duckdb-wasm-runtime/node';
import type {
	IcebergHttpBrokerRequest,
	IcebergHttpBrokerTransportRequest,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDuckDBHttpSessionFactory } from './duckdbHttpBroker';

const REMOTE_URL = 'https://data.example.test/snapshots/fixture.duckdb';
const ETAG = '"fixture-v1"';
const PARENT_AUTHORIZATION = 'Bearer parent-secret';
const WORKER_AUTHORIZATION = 'Bearer worker-secret';
const integration = {
	id: createIntegrationId(),
	name: 'remote_fixture',
	kind: 'duckdb_http',
	version: 1,
};

let fixture = new Uint8Array();

beforeAll(async () => {
	fixture = new Uint8Array(
		await readFile(fileURLToPath(new URL('./fixtures/duckdb-http.duckdb', import.meta.url))),
	);
});

afterAll(() => {
	fixture = new Uint8Array();
});

function queryPlan() {
	const config = duckdbHttp.configSchema.parse({
		url: REMOTE_URL,
		auth: { method: 'bearer_token', token: 'parent-secret' },
	});
	const plan = duckdbHttp.query?.plan({ config, integration });
	if (!plan) throw new Error('Expected a remote DuckDB query plan.');
	return plan;
}

function fixtureResponse(request: IcebergHttpBrokerTransportRequest, etag = ETAG) {
	const headers = { etag, 'accept-ranges': 'bytes' };
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers?.range ?? '');
	if (!range) {
		return {
			status: 200,
			headers: { ...headers, 'content-length': String(fixture.byteLength) },
			body: request.method === 'HEAD' ? new Uint8Array() : fixture,
		};
	}
	const start = Number(range[1]);
	const end = range[2]
		? Math.min(Number(range[2]), fixture.byteLength - 1)
		: fixture.byteLength - 1;
	if (start >= fixture.byteLength || end < start) {
		return {
			status: 416,
			headers: { ...headers, 'content-range': `bytes */${fixture.byteLength}` },
			body: new Uint8Array(),
		};
	}
	if (request.method === 'HEAD') {
		return {
			status: 206,
			headers: {
				...headers,
				'content-length': String(end - start + 1),
				'content-range': `bytes ${start}-${end}/${fixture.byteLength}`,
			},
			body: new Uint8Array(),
		};
	}
	const body = fixture.slice(start, end + 1);
	return {
		status: 206,
		headers: {
			...headers,
			'content-length': String(body.byteLength),
			'content-range': `bytes ${start}-${end}/${fixture.byteLength}`,
		},
		body,
	};
}

describe('packaged remote DuckDB database', () => {
	it('models HEAD ranges with matching response bounds', () => {
		const cases = [
			{
				range: 'bytes=65536-',
				status: 206,
				contentRange: `bytes 65536-${fixture.byteLength - 1}/${fixture.byteLength}`,
				contentLength: fixture.byteLength - 65_536,
			},
			{
				range: 'bytes=0-1024',
				status: 206,
				contentRange: `bytes 0-1024/${fixture.byteLength}`,
				contentLength: 1025,
			},
			{
				range: `bytes=${fixture.byteLength}-`,
				status: 416,
				contentRange: `bytes */${fixture.byteLength}`,
				contentLength: undefined,
			},
		];

		for (const { range, status, contentRange, contentLength } of cases) {
			const response = fixtureResponse({
				url: REMOTE_URL,
				method: 'HEAD',
				headers: { range },
				maxResponseBytes: 1,
				deadlineMs: Date.now() + 1_000,
			});

			expect(response).toMatchObject({
				status,
				headers: { 'content-range': contentRange },
				body: new Uint8Array(),
			});
			expect(
				'content-length' in response.headers ? response.headers['content-length'] : undefined,
			).toBe(contentLength === undefined ? undefined : String(contentLength));
		}
	});

	it('attaches and queries the exact object through the production bridge', async () => {
		const requests: IcebergHttpBrokerTransportRequest[] = [];
		const workerRequests: IcebergHttpBrokerRequest[] = [];
		const transport = async (request: IcebergHttpBrokerTransportRequest) => {
			requests.push(request);
			return fixtureResponse(request);
		};
		const parentSessionFactory = createDuckDBHttpSessionFactory({ transport });
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory: (access, options) => {
				const session = parentSessionFactory(access, options);
				return {
					fetch(request, signal) {
						const workerRequest = {
							...request,
							headers: { ...request.headers, authorization: WORKER_AUTHORIZATION },
						};
						workerRequests.push(workerRequest);
						return session.fetch(workerRequest, signal);
					},
					close: () => session.close(),
				};
			},
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql:
							'SELECT (SELECT count(*) FROM remote_fixture.sales.orders) AS orders, ' +
							'(SELECT sum(length(payload))::BIGINT FROM remote_fixture.ops.events) AS payload_bytes',
						connection: { files: [], vars: {}, integration, plan: queryPlan() },
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['orders', 'payload_bytes'],
				rows: [['2', '3200000']],
				truncated: false,
			});
		} finally {
			executor.terminate();
		}

		expect(requests.length).toBeGreaterThan(1);
		for (const request of requests) {
			expect(request.url).toBe(REMOTE_URL);
			expect(request.headers?.authorization).toBe(PARENT_AUTHORIZATION);
		}
		expect(workerRequests.length).toBeGreaterThan(1);
		expect(
			workerRequests.every((request) => request.headers?.authorization === WORKER_AUTHORIZATION),
		).toBe(true);
		expect(requests.slice(1).every((request) => request.headers?.['if-match'] === ETAG)).toBe(true);
		expect(requests.map((request) => request.headers?.authorization)).not.toContain(
			WORKER_AUTHORIZATION,
		);
	});

	it('fails if the object changes after the first range response', async () => {
		let rangeResponses = 0;
		let changed = false;
		const transport = async (request: IcebergHttpBrokerTransportRequest) => {
			if (changed && request.headers?.['if-match'] === ETAG) {
				return { status: 412, headers: {}, body: new Uint8Array() };
			}
			const response = fixtureResponse(request);
			if (request.method === 'GET' && request.headers?.range) {
				rangeResponses += 1;
				changed = true;
			}
			return response;
		};
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory: createDuckDBHttpSessionFactory({ transport }),
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql: 'SELECT sum(length(payload))::BIGINT FROM remote_fixture.ops.events',
						connection: { files: [], vars: {}, integration, plan: queryPlan() },
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).rejects.toThrow('The remote DuckDB database changed during the query');
		} finally {
			executor.terminate();
		}
		expect(rangeResponses).toBe(1);
	});
});
