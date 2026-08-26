import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { DuckDBHttpAccess } from '@marimo-hub/core';
import type { IcebergHttpBrokerTransportRequest } from '@marimo-hub/duckdb-wasm-runtime/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createDuckDBHttpSessionFactory,
	createGuardedBinaryTransport,
	signS3Request,
} from './duckdbHttpBroker';

const NOW = Date.parse('2026-08-13T12:00:00Z');

const ACCESS = {
	kind: 'iceberg-rest',
	catalog: {
		url: 'https://catalog.example.test/iceberg',
		authorization: 'Bearer catalog-secret',
	},
	storage: {
		kind: 's3',
		endpoint: 'https://objects.example.test',
		region: 'us-east-1',
		urlStyle: 'path',
		credentials: {
			method: 'static',
			accessKeyId: 'AKIDEXAMPLE',
			secretAccessKey: 'secret-example',
			sessionToken: 'session-example',
		},
		locations: [{ bucket: 'warehouse', prefix: 'tables' }],
	},
} as const satisfies DuckDBHttpAccess;

describe('createDuckDBHttpSessionFactory', () => {
	it('injects route-specific credentials and denies sibling paths', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) };
		});
		const expiresAtMs = NOW + 120_000;
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(ACCESS, {
			expiresAtMs,
		});

		await session.fetch({
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'HEAD',
		});
		await session.fetch({
			url: 'https://objects.example.test/warehouse/tables/data/file.parquet',
			method: 'GET',
			headers: { range: 'bytes=0-127' },
		});

		expect(calls[0].headers).toEqual({ authorization: 'Bearer catalog-secret' });
		expect(calls[0].deadlineMs).toBe(expiresAtMs);
		expect(calls[1].headers).toMatchObject({
			range: 'bytes=0-127',
			'x-amz-content-sha256': expect.stringMatching(/^[a-f0-9]{64}$/),
			'x-amz-date': '20260813T120000Z',
			'x-amz-security-token': 'session-example',
			authorization: expect.stringMatching(
				/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260813\/us-east-1\/s3\/aws4_request, /,
			),
		});
		expect(JSON.stringify(calls)).not.toContain('secret-example');
		expect(JSON.stringify(calls[0])).not.toContain('AKIDEXAMPLE');
		await expect(
			session.fetch({
				url: 'https://objects.example.test/warehouse/private/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });

		session.close();
		await expect(
			session.fetch({
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'capability_unknown' });
	});

	it('authorizes virtual-hosted buckets without broadening their prefix routes', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array([1]) };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(
			{
				...ACCESS,
				storage: {
					...ACCESS.storage,
					urlStyle: 'vhost',
					locations: [...ACCESS.storage.locations, { bucket: '999.999.999.999', prefix: 'tables' }],
				},
			},
			{ expiresAtMs: NOW + 60_000 },
		);

		await session.fetch({
			url: 'https://warehouse.objects.example.test/tables/data/file.parquet',
			method: 'GET',
		});
		await session.fetch({
			url: 'https://999.999.999.999.objects.example.test/tables/data/file.parquet',
			method: 'GET',
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].headers).toMatchObject({
			authorization: expect.stringContaining('Credential=AKIDEXAMPLE/'),
		});
		await expect(
			session.fetch({
				url: 'https://objects.example.test/warehouse/tables/data/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://other.objects.example.test/tables/data/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://warehouse.objects.example.test/private/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
	});

	it('rejects endpoints that DuckDB cannot route through an S3 secret', () => {
		const create = createDuckDBHttpSessionFactory({
			transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
		});
		expect(() =>
			create(
				{
					...ACCESS,
					storage: { ...ACCESS.storage, endpoint: 'https://objects.example.test/base' },
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(/S3 endpoint is invalid/);
		expect(() =>
			create(
				{
					...ACCESS,
					storage: {
						...ACCESS.storage,
						locations: [{ bucket: 'warehouse', prefix: 'allowed/../private' }],
					},
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(/S3 read location is invalid/);
		expect(() =>
			create(
				{
					...ACCESS,
					storage: {
						...ACCESS.storage,
						urlStyle: 'vhost',
						locations: [{ bucket: 'warehouse_name', prefix: 'tables' }],
					},
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(/Virtual-hosted S3 read location is invalid/);
		expect(() =>
			create(
				{
					...ACCESS,
					storage: {
						...ACCESS.storage,
						urlStyle: 'vhost',
						locations: [{ bucket: '192.168.0.1', prefix: 'tables' }],
					},
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(/Virtual-hosted S3 read location is invalid/);
		expect(() =>
			create(
				{
					...ACCESS,
					catalog: { ...ACCESS.catalog, url: `${ACCESS.catalog.url}?tenant=analytics` },
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(/Catalog endpoint is invalid/);
	});
});

describe('signS3Request', () => {
	it('matches the AWS S3 GET Bucket lifecycle signing example', () => {
		const signed = signS3Request(
			{
				url: 'https://examplebucket.s3.amazonaws.com/?lifecycle',
				method: 'GET',
			},
			{
				accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
				secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				region: 'us-east-1',
				now: Date.parse('2013-05-24T00:00:00Z'),
			},
		);

		expect(signed).toEqual({
			authorization:
				'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
			'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			'x-amz-date': '20130524T000000Z',
		});
	});

	it('binds the method, path, query, and session token', () => {
		const options = {
			accessKeyId: 'AKIDEXAMPLE',
			secretAccessKey: 'secret-example',
			sessionToken: 'session-example',
			region: 'us-east-1',
			now: NOW,
		};
		const first = signS3Request(
			{
				url: 'https://objects.example.test/warehouse/a%20b.parquet?versionId=two',
				method: 'GET',
			},
			options,
		);
		const changedMethod = signS3Request(
			{ url: 'https://objects.example.test/warehouse/a%20b.parquet?versionId=two', method: 'HEAD' },
			options,
		);
		const changedPath = signS3Request(
			{ url: 'https://objects.example.test/warehouse/c.parquet?versionId=two', method: 'GET' },
			options,
		);
		const changedQuery = signS3Request(
			{
				url: 'https://objects.example.test/warehouse/a%20b.parquet?versionId=three',
				method: 'GET',
			},
			options,
		);

		expect(first.authorization).toContain(
			'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
		);
		expect(
			new Set([
				first.authorization,
				changedMethod.authorization,
				changedPath.authorization,
				changedQuery.authorization,
			]),
		).toHaveLength(4);
		expect(first['x-amz-date']).toBe('20260813T120000Z');
	});
});

describe('createGuardedBinaryTransport', () => {
	let server: Server | undefined;

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	async function serve(body: Uint8Array): Promise<string> {
		server = createServer((_request, response) => {
			response.writeHead(206, {
				'content-type': 'application/octet-stream',
				'content-length': String(body.byteLength),
			});
			response.end(body);
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		return `http://localhost:${address.port}/object`;
	}

	it('resolves, validates, pins, and preserves binary responses', async () => {
		const url = await serve(new Uint8Array([0, 255, 1, 254]));
		const transport = createGuardedBinaryTransport({ allowPrivate: true });

		await expect(
			transport({
				url,
				method: 'GET',
				headers: {},
				maxResponseBytes: 4,
				deadlineMs: Date.now() + 10_000,
			}),
		).resolves.toMatchObject({ status: 206, body: new Uint8Array([0, 255, 1, 254]) });
	});

	it('blocks private targets by default and stops at the byte limit', async () => {
		const url = await serve(new Uint8Array([1, 2, 3, 4]));
		await expect(
			createGuardedBinaryTransport({ allowPrivate: false })({
				url,
				method: 'GET',
				headers: {},
				maxResponseBytes: 4,
				deadlineMs: Date.now() + 10_000,
			}),
		).rejects.toThrow(/private or reserved/);
		await expect(
			createGuardedBinaryTransport({ allowPrivate: true })({
				url,
				method: 'GET',
				headers: {},
				maxResponseBytes: 3,
				deadlineMs: Date.now() + 10_000,
			}),
		).rejects.toMatchObject({ code: 'response_budget_exceeded' });
	});

	it('does not apply the response body limit to HEAD content-length metadata', async () => {
		const url = await serve(new Uint8Array([1, 2, 3, 4]));

		await expect(
			createGuardedBinaryTransport({ allowPrivate: true })({
				url,
				method: 'HEAD',
				headers: {},
				maxResponseBytes: 3,
				deadlineMs: Date.now() + 10_000,
			}),
		).resolves.toMatchObject({ status: 206, body: new Uint8Array() });
	});

	it('resolves and pins every request instead of reusing an origin socket', async () => {
		const url = new URL(await serve(new Uint8Array([1])));
		url.hostname = 'broker.example.test';
		let connections = 0;
		server?.on('connection', () => {
			connections += 1;
		});
		const resolveHost = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
		const transport = createGuardedBinaryTransport({ allowPrivate: true, resolveHost });
		const request = {
			url: url.toString(),
			method: 'GET' as const,
			headers: {},
			maxResponseBytes: 1,
			deadlineMs: Date.now() + 10_000,
		};

		await transport(request);
		await transport(request);

		expect(resolveHost).toHaveBeenCalledTimes(2);
		expect(connections).toBe(2);
	});

	it('shares one deadline across DNS and the HTTP response', async () => {
		server = createServer((_request, response) => {
			setTimeout(() => response.end('ok'), 60);
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const resolveHost = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return [{ address: '127.0.0.1', family: 4 as const }];
		});
		const transport = createGuardedBinaryTransport({
			allowPrivate: true,
			resolveHost,
			timeoutMs: 100,
		});

		await expect(
			transport({
				url: `http://broker.example.test:${address.port}/object`,
				method: 'GET',
				headers: {},
				maxResponseBytes: 2,
				deadlineMs: Date.now() + 100,
			}),
		).rejects.toThrow(/abort|timed out/i);
		expect(resolveHost).toHaveBeenCalledOnce();
	});
});
