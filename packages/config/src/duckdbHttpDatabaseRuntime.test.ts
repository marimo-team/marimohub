import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createIntegrationId, duckdbHttp } from '@marimo-hub/core';
import { createNodeDataQueryExecutorFactory } from '@marimo-hub/duckdb-wasm-runtime/node';
import type { IcebergHttpBrokerTransportRequest } from '@marimo-hub/duckdb-wasm-runtime/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDuckDBHttpSessionFactory } from './duckdbHttpBroker';

const REMOTE_URL = 'https://data.example.test/snapshots/fixture.duckdb';
const ETAG = '"fixture-v1"';
const PARENT_AUTHORIZATION = 'Bearer parent-secret';
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
	if (request.method === 'HEAD') {
		return range
			? {
					status: 206,
					headers: {
						...headers,
						'content-length': String(fixture.byteLength),
						'content-range': `bytes 0-${fixture.byteLength - 1}/${fixture.byteLength}`,
					},
					body: new Uint8Array(),
				}
			: {
					status: 200,
					headers: { ...headers, 'content-length': String(fixture.byteLength) },
					body: new Uint8Array(),
				};
	}
	if (!range) {
		return {
			status: 200,
			headers: { ...headers, 'content-length': String(fixture.byteLength) },
			body: fixture,
		};
	}
	const start = Number(range[1]);
	const end = range[2]
		? Math.min(Number(range[2]), fixture.byteLength - 1)
		: fixture.byteLength - 1;
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
	it('attaches and queries the exact object through the production bridge', async () => {
		const requests: IcebergHttpBrokerTransportRequest[] = [];
		const transport = async (request: IcebergHttpBrokerTransportRequest) => {
			requests.push(request);
			return fixtureResponse(request);
		};
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory: createDuckDBHttpSessionFactory({ transport }),
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
		expect(requests.slice(1).every((request) => request.headers?.['if-match'] === ETAG)).toBe(true);
		expect(JSON.stringify(requests)).not.toContain('marimohub-parent-broker');
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
