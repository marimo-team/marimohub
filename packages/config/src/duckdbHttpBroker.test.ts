import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createIntegrationId, s3 } from '@marimo-hub/core';
import type { DuckDBHttpAccess } from '@marimo-hub/core';
import {
	createNodeDataQueryExecutorFactory,
	createNodeDuckDBWasmRuntimeFactory,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import type {
	IcebergHttpBrokerTransport,
	IcebergHttpBrokerTransportRequest,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createDuckDBHttpSessionFactory,
	createGuardedBinaryTransport,
	createGuardedOAuthTokenExchange,
	signS3Request,
} from './duckdbHttpBroker';
import type { OAuthTokenExchange, OAuthTokenExchangeRequest } from './duckdbHttpBroker';

const NOW = Date.parse('2026-08-13T12:00:00Z');
const OAUTH_TRANSPORT_ERROR =
	'OAuth2 token endpoint was not reachable. Make sure that DNS, TLS, and the integration egress policy are correct.';
const OAUTH_SESSION_ERROR =
	'OAuth2 token request did not finish before the DuckDB session ended. Retry the query.';
const OAUTH_CANCELLED_ERROR =
	'OAuth2 token request stopped because the DuckDB request ended or reached its deadline. Retry the query.';
const OAUTH_RESPONSE_ERROR =
	'OAuth2 token endpoint returned an invalid response. Make sure that access_token is non-empty. If token_type is present, it must be bearer. The expiry must be between 1 and 86400 seconds.';
const ROUTE_OVERLAP_ERROR =
	'Catalog and S3 routes overlap. Change the catalog path, S3 endpoint, bucket, or guarded read prefix.';
const INVALID_S3_ENDPOINT_ERROR =
	'S3 endpoint is invalid. Use an HTTP or HTTPS origin without credentials, a path, query parameters, or a fragment.';
const INVALID_CATALOG_ENDPOINT_ERROR =
	'Catalog endpoint is invalid. Use an HTTP or HTTPS URL without embedded credentials or query parameters.';
const INVALID_S3_LOCATION_ERROR =
	'S3 read location is invalid. Use a valid bucket and a non-empty prefix without path traversal.';
const INVALID_VHOST_LOCATION_ERROR =
	'Virtual-hosted S3 requires a DNS bucket and endpoint. Use path-style addressing for IP endpoints or non-DNS buckets.';

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

const R2_ACCESS = {
	kind: 'iceberg-rest',
	catalog: {
		url: 'https://catalog.cloudflarestorage.com/account-id/warehouse',
		authorization: 'Bearer catalog-secret',
	},
	storage: {
		kind: 'r2-catalog',
		endpoint: 'https://account-id.r2.cloudflarestorage.com',
		bucket: 'warehouse',
	},
} as const satisfies DuckDBHttpAccess;

const S3_ACCESS = {
	kind: 's3-object-store',
	endpoint: 'https://objects.example.test',
	region: 'us-east-1',
	urlStyle: 'path',
	credentials: {
		method: 'static',
		accessKeyId: 'AKIDEXAMPLE',
		secretAccessKey: 'secret-example',
		sessionToken: 'session-example',
	},
	locations: [{ bucket: 'warehouse', prefix: 'analytics/events' }],
} as const satisfies DuckDBHttpAccess;

const OAUTH_ACCESS = {
	...ACCESS,
	catalog: {
		url: 'https://catalog.example.test/iceberg',
		oauth2: {
			tokenEndpoint: 'https://identity.example.test/oauth/token',
			clientId: 'client-id',
			clientSecret: 'client-secret',
			scope: 'PRINCIPAL_ROLE:ALL table.read',
			refreshMarginSeconds: 20,
		},
	},
} as const satisfies DuckDBHttpAccess;

describe('createDuckDBHttpSessionFactory', () => {
	it('opens bearer, OAuth2, and S3 object-query sessions', () => {
		const factory = createDuckDBHttpSessionFactory({
			transport: vi.fn(),
			now: () => NOW,
		});
		const sessionOptions = { expiresAtMs: NOW + 60_000 };

		const bearer = factory(ACCESS, sessionOptions);
		bearer.close();
		const oauth = factory(OAUTH_ACCESS, sessionOptions);
		const objectQuery = factory(S3_ACCESS, sessionOptions);
		oauth.close();
		objectQuery.close();
	});

	it('lazily exchanges, reuses, and refreshes a parent-owned OAuth token', async () => {
		let clock = NOW;
		let nextToken = 1;
		const increment = vi.fn();
		const exchange = vi.fn<OAuthTokenExchange>(async () => ({
			accessToken: `token-${nextToken++}`,
			expiresInSeconds: 100,
		}));
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array() };
		});
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			metrics: { increment, gauge: vi.fn() },
			now: () => clock,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 300_000 });
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
			headers: { authorization: 'Bearer marimohub-parent-broker' },
		};

		expect(exchange).not.toHaveBeenCalled();
		await session.fetch(request);
		await session.fetch(request);
		expect(exchange).toHaveBeenCalledOnce();
		expect(exchange).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: 'https://identity.example.test/oauth/token',
				clientId: 'client-id',
				clientSecret: 'client-secret',
				scope: 'PRINCIPAL_ROLE:ALL table.read',
			}),
			expect.any(AbortSignal),
		);
		expect(calls.slice(0, 2).map((call) => call.headers?.authorization)).toEqual([
			'Bearer token-1',
			'Bearer token-1',
		]);

		clock += 81_000;
		await session.fetch(request);
		expect(exchange).toHaveBeenCalledTimes(2);
		expect(calls[2].headers?.authorization).toBe('Bearer token-2');
		expect(JSON.stringify(calls)).not.toContain('client-id');
		expect(JSON.stringify(calls)).not.toContain('client-secret');
		expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_refresh', 1, {
			outcome: 'success',
		});
		expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_token', 1, {
			source: 'cache',
		});
	});

	it('single-flights concurrent OAuth refresh and falls back to an unexpired token', async () => {
		let clock = NOW;
		let refreshResolve!: (value: { accessToken: string; expiresInSeconds: number }) => void;
		const exchange = vi
			.fn<OAuthTokenExchange>()
			.mockResolvedValueOnce({ accessToken: 'token-1', expiresInSeconds: 100 })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						refreshResolve = resolve;
					}),
			)
			.mockRejectedValueOnce(new Error('identity unavailable'));
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => clock,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 300_000 });
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
		};

		await session.fetch(request);
		clock += 81_000;
		const first = session.fetch(request);
		const second = session.fetch(request);
		await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(2));
		refreshResolve({ accessToken: 'token-2', expiresInSeconds: 100 });
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(exchange).toHaveBeenCalledTimes(2);

		clock += 81_000;
		await expect(session.fetch(request)).resolves.toMatchObject({ status: 200 });
		expect(exchange).toHaveBeenCalledTimes(3);
		const lastCall = transport.mock.calls.at(-1)?.[0];
		expect(lastCall?.headers?.authorization).toBe('Bearer token-2');

		await expect(session.fetch(request)).resolves.toMatchObject({ status: 200 });
		expect(exchange).toHaveBeenCalledTimes(3);
		expect(transport.mock.calls.at(-1)?.[0].headers?.authorization).toBe('Bearer token-2');
	});

	it('keeps a shared OAuth refresh running when one catalog request is canceled', async () => {
		let resolveExchange!: (value: { accessToken: string; expiresInSeconds: number }) => void;
		let exchangeSignal: AbortSignal | undefined;
		const exchange = vi.fn<OAuthTokenExchange>(
			(_request, signal) =>
				new Promise((resolve, reject) => {
					resolveExchange = resolve;
					exchangeSignal = signal;
					signal?.addEventListener('abort', () => reject(new Error('exchange aborted')), {
						once: true,
					});
				}),
		);
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => NOW,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 60_000 });
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
		};
		const firstController = new AbortController();
		const first = session.fetch(request, firstController.signal);
		await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
		const second = session.fetch(request);
		const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });

		firstController.abort();

		await firstResult;
		expect(exchangeSignal?.aborted).toBe(false);
		resolveExchange({ accessToken: 'shared-token', expiresInSeconds: 100 });
		await expect(second).resolves.toMatchObject({ status: 200 });
		expect(exchange).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledOnce();
		expect(transport.mock.calls[0]?.[0].headers?.authorization).toBe('Bearer shared-token');
	});

	it('retries after an initial OAuth outage without sending an unauthenticated catalog request', async () => {
		let clock = NOW;
		const exchange = vi
			.fn<OAuthTokenExchange>()
			.mockRejectedValueOnce(new Error('identity unavailable'))
			.mockResolvedValueOnce({ accessToken: 'recovered-token', expiresInSeconds: 100 });
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => clock,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 60_000 });
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
		};

		await expect(session.fetch(request)).rejects.toThrow(OAUTH_TRANSPORT_ERROR);
		expect(transport).not.toHaveBeenCalled();
		await expect(session.fetch(request)).rejects.toThrow(OAUTH_TRANSPORT_ERROR);
		expect(exchange).toHaveBeenCalledOnce();
		clock += 1_001;
		await expect(session.fetch(request)).resolves.toMatchObject({ status: 200 });
		expect(exchange).toHaveBeenCalledTimes(2);
		expect(transport).toHaveBeenCalledOnce();
		expect(transport.mock.calls[0]?.[0].headers?.authorization).toBe('Bearer recovered-token');
	});

	it('preserves a credential error during the OAuth refresh backoff', async () => {
		let tokenRequests = 0;
		const tokenServer = createServer((_request, response) => {
			tokenRequests += 1;
			response.writeHead(401, { 'content-type': 'application/json' });
			response.end('{"error":"invalid_client"}');
		});
		await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
		const address = tokenServer.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Expected an OAuth test-server port.');
		}
		const expected =
			'OAuth2 token endpoint returned HTTP 401 for the credentials. Make sure that the client ID, client secret, and scope are correct.';
		const transport = vi.fn<IcebergHttpBrokerTransport>();
		const session = createDuckDBHttpSessionFactory({
			transport,
			allowPrivate: true,
			now: () => NOW,
		})(
			{
				...OAUTH_ACCESS,
				allowInsecureTransport: true,
				catalog: {
					...OAUTH_ACCESS.catalog,
					oauth2: {
						...OAUTH_ACCESS.catalog.oauth2,
						tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
					},
				},
			},
			{ expiresAtMs: NOW + 60_000 },
		);
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
		};

		try {
			await expect(session.fetch(request)).rejects.toThrow(expected);
			await expect(session.fetch(request)).rejects.toThrow(expected);
			expect(tokenRequests).toBe(1);
			expect(transport).not.toHaveBeenCalled();
		} finally {
			session.close();
			await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
		}
	});

	it('bounds OAuth exchange work to the broker session deadline', async () => {
		let exchangeSignal: AbortSignal | undefined;
		const exchange = vi.fn<OAuthTokenExchange>(
			(_request, signal) =>
				new Promise((_resolve, reject) => {
					exchangeSignal = signal;
					signal?.addEventListener('abort', () => reject(new Error('deadline reached')), {
						once: true,
					});
				}),
		);
		const transport = vi.fn<IcebergHttpBrokerTransport>();
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => NOW,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 20 });

		await expect(
			session.fetch({
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
		).rejects.toThrow(OAUTH_SESSION_ERROR);
		expect(exchangeSignal?.aborted).toBe(true);
		expect(transport).not.toHaveBeenCalled();
	});

	it('discards a token returned after the broker session deadline', async () => {
		let clock = NOW;
		const exchange = vi.fn<OAuthTokenExchange>(async () => {
			clock += 1_000;
			return { accessToken: 'late-token', expiresInSeconds: 100 };
		});
		const transport = vi.fn<IcebergHttpBrokerTransport>();
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => clock,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 500 });

		await expect(
			session.fetch({
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
		).rejects.toThrow(OAUTH_SESSION_ERROR);
		expect(exchange).toHaveBeenCalledOnce();
		expect(transport).not.toHaveBeenCalled();
	});

	it('does not fall back to an expired OAuth token after refresh fails', async () => {
		let clock = NOW;
		const exchange = vi
			.fn<OAuthTokenExchange>()
			.mockResolvedValueOnce({ accessToken: 'expired-token', expiresInSeconds: 100 })
			.mockRejectedValueOnce(new Error('identity unavailable'));
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => clock,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 300_000 });
		const request = {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET' as const,
		};

		await session.fetch(request);
		clock += 101_000;
		await expect(session.fetch(request)).rejects.toThrow(OAUTH_TRANSPORT_ERROR);
		expect(transport).toHaveBeenCalledOnce();
	});

	it('aborts an in-flight OAuth exchange when the broker session closes', async () => {
		let exchangeSignal: AbortSignal | undefined;
		const exchange = vi.fn<OAuthTokenExchange>(
			(_request, signal) =>
				new Promise((_resolve, reject) => {
					exchangeSignal = signal;
					signal?.addEventListener('abort', () => reject(new Error('exchange aborted')), {
						once: true,
					});
				}),
		);
		const transport = vi.fn<IcebergHttpBrokerTransport>();
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => NOW,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 60_000 });
		const pending = session.fetch({
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET',
		});
		await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());

		session.close();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(exchangeSignal?.aborted).toBe(true);
		expect(transport).not.toHaveBeenCalled();
	});

	it('does not expose the OAuth token endpoint as a worker route', async () => {
		const exchange = vi.fn<OAuthTokenExchange>(async () => ({
			accessToken: 'catalog-token',
			expiresInSeconds: 100,
		}));
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 200,
			headers: {},
			body: new Uint8Array(),
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			oauthTokenExchange: exchange,
			now: () => NOW,
		})(OAUTH_ACCESS, { expiresAtMs: NOW + 60_000 });

		await expect(
			session.fetch({
				url: OAUTH_ACCESS.catalog.oauth2.tokenEndpoint,
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		expect(exchange).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		'https://client:secret@identity.example.test/oauth/token',
		'https://identity.example.test/oauth/token#fragment',
		'ftp://identity.example.test/oauth/token',
	])('rejects an unsafe OAuth token endpoint before opening the session', (tokenEndpoint) => {
		const create = createDuckDBHttpSessionFactory({
			transport: vi.fn(),
			oauthTokenExchange: vi.fn(),
		});

		expect(() =>
			create(
				{
					...OAUTH_ACCESS,
					catalog: {
						...OAUTH_ACCESS.catalog,
						oauth2: { ...OAUTH_ACCESS.catalog.oauth2, tokenEndpoint },
					},
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(
			'OAuth2 token endpoint is invalid. Use an HTTP or HTTPS URL without embedded credentials or a fragment.',
		);
	});

	it('rejects plaintext OAuth and catalog credentials without an explicit override', () => {
		const create = createDuckDBHttpSessionFactory({
			transport: vi.fn(),
			oauthTokenExchange: vi.fn(),
		});

		expect(() =>
			create(
				{
					...OAUTH_ACCESS,
					catalog: {
						...OAUTH_ACCESS.catalog,
						oauth2: {
							...OAUTH_ACCESS.catalog.oauth2,
							tokenEndpoint: 'http://identity.example.test/oauth/token',
						},
					},
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(
			'OAuth2 token endpoint uses HTTP. Use HTTPS, or enable allow_insecure_transport for local development.',
		);
		expect(() =>
			create(
				{
					...ACCESS,
					catalog: { ...ACCESS.catalog, url: 'http://catalog.example.test/iceberg' },
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(
			'Catalog credentials require HTTPS. Use HTTPS, or enable allow_insecure_transport for local development.',
		);
	});

	it('rejects plaintext static S3 credentials and permits explicit or anonymous HTTP', () => {
		const create = createDuckDBHttpSessionFactory({ transport: vi.fn(), now: () => NOW });
		const insecure = { ...S3_ACCESS, endpoint: 'http://objects.example.test' };

		expect(() => create(insecure, { expiresAtMs: NOW + 60_000 })).toThrow(
			'S3 credentials require HTTPS. Use HTTPS, or enable allow_insecure_transport for local development.',
		);
		const optedIn = create(
			{ ...insecure, allowInsecureTransport: true },
			{ expiresAtMs: NOW + 60_000 },
		);
		const anonymous = create(
			{ ...insecure, credentials: { method: 'anonymous' } },
			{ expiresAtMs: NOW + 60_000 },
		);

		optedIn.close();
		anonymous.close();
	});

	it('injects route-specific credentials and denies sibling paths', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
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
			headers: { authorization: 'Bearer marimohub-parent-broker' },
		});
		await session.fetch({
			url: 'https://objects.example.test/warehouse/tables/data/file.parquet',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=marimohub-parent-broker',
				range: 'bytes=0-127',
				'x-amz-content-sha256': 'dummy-hash',
				'x-amz-date': '20260814T120000Z',
			},
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

	it('signs standalone S3 routes without granting a catalog or sibling prefix', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			return { status: 206, headers: {}, body: new Uint8Array([1]) };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(S3_ACCESS, {
			expiresAtMs: NOW + 60_000,
		});

		await session.fetch({
			url: 'https://objects.example.test/warehouse/analytics/events/2026/file.parquet',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=marimohub-parent-broker',
				range: 'bytes=0-127',
				'x-amz-date': 'forged',
			},
		});

		expect(calls[0].headers).toMatchObject({
			range: 'bytes=0-127',
			authorization: expect.stringContaining('Credential=AKIDEXAMPLE/'),
			'x-amz-date': '20260813T120000Z',
			'x-amz-security-token': 'session-example',
		});
		await expect(
			session.fetch({
				url: 'https://objects.example.test/warehouse/analytics/events-old/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://objects.example.test/warehouse/private/file.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		expect(calls).toHaveLength(1);
	});

	it('removes worker signing headers from anonymous standalone S3 requests', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array() };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(
			{ ...S3_ACCESS, credentials: { method: 'anonymous' } },
			{ expiresAtMs: NOW + 60_000 },
		);

		await session.fetch({
			url: 'https://objects.example.test/warehouse/analytics/events/file.csv',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=marimohub-parent-broker',
				range: 'bytes=0-127',
				'x-amz-content-sha256': 'dummy',
				'x-amz-date': 'dummy',
			},
		});

		expect(calls[0].headers).toEqual({ range: 'bytes=0-127' });
	});

	it.each([
		[
			'https://objects.example.test/warehouse/analytics/events%2Fprivate/file.parquet',
			'invalid_request',
		],
		[
			'https://objects.example.test/warehouse/analytics/events%5Cprivate/file.parquet',
			'invalid_request',
		],
		[
			'https://objects.example.test/warehouse/analytics/events/../private/file.parquet',
			'target_denied',
		],
		[
			'https://objects.example.test/warehouse?list-type=2&prefix=analytics%2Fevents',
			'target_denied',
		],
	] as const)(
		'denies an S3 path or listing request outside the normalized prefix: %s',
		async (url, code) => {
			const transport = vi.fn<IcebergHttpBrokerTransport>();
			const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(S3_ACCESS, {
				expiresAtMs: NOW + 60_000,
			});

			await expect(session.fetch({ url, method: 'GET' })).rejects.toMatchObject({
				code,
			});
			expect(transport).not.toHaveBeenCalled();
		},
	);

	it('runs an S3 integration query through the packaged worker and parent signer', async () => {
		const bytes = new TextEncoder().encode('region,revenue\nnorth,12500.50\nsouth,9800.00\n');
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			const headers = {
				'accept-ranges': 'bytes',
				'content-length': String(bytes.byteLength),
				etag: '"fixture-1"',
			};
			if (request.method === 'HEAD') return { status: 200, headers, body: new Uint8Array() };
			const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers?.range ?? '');
			if (!range) return { status: 200, headers, body: bytes };
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), bytes.byteLength - 1);
			const body = bytes.slice(start, end + 1);
			return {
				status: 206,
				headers: {
					...headers,
					'content-length': String(body.byteLength),
					'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
				},
				body,
			};
		});
		const config = s3.configSchema.parse({
			endpoint_url: 'https://objects.example.test',
			region: 'us-east-1',
			path_style: true,
			auth: {
				method: 'static',
				access_key_id: 'AKIDEXAMPLE',
				secret_access_key: 'secret-example',
			},
			broker_read_locations: [{ bucket: 'warehouse', prefix: 'analytics' }],
		});
		const integration = {
			id: createIntegrationId(),
			name: 'warehouse',
			kind: 's3',
			version: 1,
		} as const;
		const plan = s3.query?.plan({ config, integration });
		if (!plan) throw new Error('Expected an S3 query plan.');
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory: createDuckDBHttpSessionFactory({ transport, now: () => NOW }),
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql: "SELECT region, revenue FROM read_csv_auto('s3://warehouse/analytics/report.csv') ORDER BY region",
						connection: { files: [], vars: {}, integration, plan },
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['region', 'revenue'],
				rows: [
					['north', 12500.5],
					['south', 9800],
				],
				truncated: false,
			});
		} finally {
			executor.terminate();
		}

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(new URL(call.url).pathname).toBe('/warehouse/analytics/report.csv');
			expect(call.headers?.authorization).toContain('Credential=AKIDEXAMPLE/');
		}
		expect(JSON.stringify(calls)).not.toContain('secret-example');
	}, 30_000);

	it('runs an anonymous S3 query through the packaged worker without authorization headers', async () => {
		const bytes = new TextEncoder().encode('value\n42\n');
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			const headers = {
				'accept-ranges': 'bytes',
				'content-length': String(bytes.byteLength),
				etag: '"anonymous-fixture"',
			};
			if (request.method === 'HEAD') return { status: 200, headers, body: new Uint8Array() };
			const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers?.range ?? '');
			if (!range) return { status: 200, headers, body: bytes };
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), bytes.byteLength - 1);
			const body = bytes.slice(start, end + 1);
			return {
				status: 206,
				headers: {
					...headers,
					'content-length': String(body.byteLength),
					'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
				},
				body,
			};
		});
		const config = s3.configSchema.parse({
			endpoint_url: 'https://objects.example.test',
			path_style: true,
			auth: { method: 'anonymous' },
			broker_read_locations: [{ bucket: 'public-data', prefix: 'releases' }],
		});
		const integration = {
			id: createIntegrationId(),
			name: 'public_data',
			kind: 's3',
			version: 1,
		} as const;
		const plan = s3.query?.plan({ config, integration });
		if (!plan) throw new Error('Expected an anonymous S3 query plan.');
		const executor = await createNodeDataQueryExecutorFactory({
			memoryLimitMb: 128,
			httpSessionFactory: createDuckDBHttpSessionFactory({ transport, now: () => NOW }),
		}).create(new AbortController().signal);

		try {
			await expect(
				executor.execute(
					{
						sql: "SELECT value FROM read_csv_auto('s3://public-data/releases/data.csv')",
						connection: { files: [], vars: {}, integration, plan },
						accessMode: 'read-only',
						limits: { maxRows: 10, maxBytes: 1_048_576, deadlineMs: 20_000 },
					},
					new AbortController().signal,
				),
			).resolves.toEqual({
				columns: ['value'],
				rows: [['42']],
				truncated: false,
			});
		} finally {
			executor.terminate();
		}

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(new URL(call.url).pathname).toBe('/public-data/releases/data.csv');
			expect(call.headers).not.toHaveProperty('authorization');
			expect(call.headers).not.toHaveProperty('x-amz-date');
			expect(call.headers).not.toHaveProperty('x-amz-content-sha256');
		}
	}, 30_000);

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

	it('confines catalog-vended R2 signatures to the catalog bucket', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array([1]) };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(R2_ACCESS, {
			expiresAtMs: NOW + 60_000,
		});

		await session.fetch({
			url: 'https://catalog.cloudflarestorage.com/account-id/warehouse/v1/config',
			method: 'GET',
			headers: { authorization: 'Bearer marimohub-parent-broker' },
		});
		await session.fetch({
			url: 'https://account-id.r2.cloudflarestorage.com/warehouse/data/file.parquet',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=vended',
				'x-amz-content-sha256': 'payload-hash',
				'x-amz-date': '20260814T120000Z',
				'x-amz-security-token': 'session-token',
			},
		});
		await session.fetch({
			url: 'https://warehouse.account-id.r2.cloudflarestorage.com/data/file.parquet',
			method: 'HEAD',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=vended-vhost',
				'x-amz-date': '20260814T120001Z',
			},
		});

		expect(calls[0].headers).toEqual({
			authorization: 'Bearer catalog-secret',
			'x-iceberg-access-delegation': 'vended-credentials',
		});
		expect(calls[1].headers).toEqual({
			authorization: 'AWS4-HMAC-SHA256 Credential=vended',
			'x-amz-content-sha256': 'payload-hash',
			'x-amz-date': '20260814T120000Z',
			'x-amz-security-token': 'session-token',
		});
		expect(calls[2]).toMatchObject({
			url: 'https://warehouse.account-id.r2.cloudflarestorage.com/data/file.parquet',
			method: 'HEAD',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=vended-vhost',
				'x-amz-date': '20260814T120001Z',
			},
		});
		await expect(
			session.fetch({
				url: 'https://account-id.r2.cloudflarestorage.com/private/data.parquet',
				method: 'GET',
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://private.account-id.r2.cloudflarestorage.com/data.parquet',
				method: 'GET',
				headers: { authorization: 'AWS4-HMAC-SHA256 Credential=vended' },
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
		await expect(
			session.fetch({
				url: 'https://catalog.cloudflarestorage.com/account-id/warehouse/v1/config',
				method: 'GET',
				headers: { 'x-amz-date': '20260814T120000Z' },
			}),
		).rejects.toMatchObject({ code: 'header_denied' });
		expect(calls).toHaveLength(3);
	});

	it('injects delegation into an actual DuckDB-Wasm catalog request', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			const url = new URL(request.url);
			if (url.pathname.endsWith('/v1/config')) {
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: new TextEncoder().encode(JSON.stringify({ defaults: {}, overrides: {} })),
				};
			}
			return {
				status: 404,
				headers: {} as Record<string, string>,
				body: new Uint8Array(),
			};
		});
		const runtime = await createNodeDuckDBWasmRuntimeFactory(
			'worker',
			createDuckDBHttpSessionFactory({ transport }),
		)();

		try {
			await runtime.initialize({ memoryLimitMb: 128 });
			await expect(
				runtime.execute({
					setup: [
						{ text: 'LOAD iceberg' },
						{ text: 'LOAD httpfs' },
						{
							text:
								`ATTACH 'account-id_warehouse' AS "r2_e2e" (` +
								'TYPE iceberg, ENDPOINT ?, TOKEN ?, ACCESS_DELEGATION_MODE ?, READ_ONLY)',
							params: [R2_ACCESS.catalog.url, 'marimohub-parent-broker', 'vended_credentials'],
						},
					],
					query: { text: 'SELECT 1 AS value' },
					cleanup: [{ text: 'DETACH "r2_e2e"' }],
					requires: ['iceberg-http'],
					httpAccess: R2_ACCESS,
				}),
			).resolves.toEqual({ columns: ['value'], rows: [[1]] });
		} finally {
			await runtime.close();
		}

		const configRequest = calls.find((request) =>
			new URL(request.url).pathname.endsWith('/v1/config'),
		);
		expect(configRequest?.headers).toMatchObject({
			authorization: 'Bearer catalog-secret',
			'x-iceberg-access-delegation': 'vended-credentials',
		});
	}, 30_000);

	it('injects a parent-exchanged OAuth token into an actual DuckDB-Wasm catalog request', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const exchange = vi.fn<OAuthTokenExchange>(async () => ({
			accessToken: 'short-lived-token',
			expiresInSeconds: 300,
		}));
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			const url = new URL(request.url);
			if (url.pathname.endsWith('/v1/config')) {
				return {
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: new TextEncoder().encode(JSON.stringify({ defaults: {}, overrides: {} })),
				};
			}
			return {
				status: 404,
				headers: {} as Record<string, string>,
				body: new Uint8Array(),
			};
		});
		const runtime = await createNodeDuckDBWasmRuntimeFactory(
			'worker',
			createDuckDBHttpSessionFactory({ transport, oauthTokenExchange: exchange }),
		)();

		try {
			await runtime.initialize({ memoryLimitMb: 128 });
			await expect(
				runtime.execute({
					setup: [
						{ text: 'LOAD iceberg' },
						{ text: 'LOAD httpfs' },
						{
							text:
								`ATTACH 'oauth_warehouse' AS "oauth_e2e" (` +
								'TYPE iceberg, ENDPOINT ?, TOKEN ?, ACCESS_DELEGATION_MODE ?, READ_ONLY)',
							params: [OAUTH_ACCESS.catalog.url, 'marimohub-parent-broker', 'none'],
						},
					],
					query: { text: 'SELECT 1 AS value' },
					cleanup: [{ text: 'DETACH "oauth_e2e"' }],
					requires: ['iceberg-http'],
					httpAccess: OAUTH_ACCESS,
				}),
			).resolves.toEqual({ columns: ['value'], rows: [[1]] });
		} finally {
			await runtime.close();
		}

		expect(exchange).toHaveBeenCalledOnce();
		const configRequest = calls.find((request) =>
			new URL(request.url).pathname.endsWith('/v1/config'),
		);
		expect(configRequest?.headers?.authorization).toBe('Bearer short-lived-token');
		expect(JSON.stringify(calls)).not.toContain('client-secret');
	}, 30_000);

	it('keeps non-DNS R2 bucket names on the path-style route', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array([1]) };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(
			{
				...R2_ACCESS,
				storage: { ...R2_ACCESS.storage, bucket: 'warehouse_name' },
			},
			{ expiresAtMs: NOW + 60_000 },
		);

		await session.fetch({
			url: 'https://account-id.r2.cloudflarestorage.com/warehouse_name/data.parquet',
			method: 'GET',
			headers: { authorization: 'AWS4-HMAC-SHA256 Credential=vended' },
		});

		expect(calls).toHaveLength(1);
		await expect(
			session.fetch({
				url: 'https://warehouse_name.account-id.r2.cloudflarestorage.com/data.parquet',
				method: 'GET',
				headers: { authorization: 'AWS4-HMAC-SHA256 Credential=vended' },
			}),
		).rejects.toMatchObject({ code: 'target_denied' });
	});

	it('routes iceberg bucket objects through storage when the catalog uses a separate host', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
			calls.push(request);
			return { status: 200, headers: {}, body: new Uint8Array([1]) };
		});
		const session = createDuckDBHttpSessionFactory({ transport, now: () => NOW })(
			{
				...R2_ACCESS,
				catalog: {
					...R2_ACCESS.catalog,
					url: 'https://catalog.cloudflarestorage.com/account-id/iceberg',
				},
				storage: { ...R2_ACCESS.storage, bucket: 'iceberg' },
			},
			{ expiresAtMs: NOW + 60_000 },
		);

		await session.fetch({
			url: 'https://account-id.r2.cloudflarestorage.com/iceberg/iceberg/data.parquet',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=vended',
				'x-amz-date': '20260814T120000Z',
			},
		});

		expect(calls[0].headers).toEqual({
			authorization: 'AWS4-HMAC-SHA256 Credential=vended',
			'x-amz-date': '20260814T120000Z',
		});
	});

	it('rejects overlapping account-scoped R2 catalog and storage routes', () => {
		const create = createDuckDBHttpSessionFactory({
			transport: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
		});

		expect(() =>
			create(
				{
					...R2_ACCESS,
					catalog: {
						...R2_ACCESS.catalog,
						url: 'https://account-id.r2.cloudflarestorage.com/iceberg/iceberg',
					},
					storage: { ...R2_ACCESS.storage, bucket: 'iceberg' },
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(ROUTE_OVERLAP_ERROR);
	});

	it.each([
		{
			name: 'storage route shadows the catalog',
			catalogUrl: 'https://shared.example.test/bucket',
			endpoint: 'https://shared.example.test',
			urlStyle: 'path' as const,
			bucket: 'bucket',
			prefix: 'v1',
		},
		{
			name: 'catalog route shadows path-style storage',
			catalogUrl: 'https://shared.example.test/bucket/data/catalog',
			endpoint: 'https://shared.example.test',
			urlStyle: 'path' as const,
			bucket: 'bucket',
			prefix: 'data',
		},
		{
			name: 'catalog route shadows virtual-hosted storage',
			catalogUrl: 'https://warehouse.objects.example.test/data/catalog',
			endpoint: 'https://objects.example.test',
			urlStyle: 'vhost' as const,
			bucket: 'warehouse',
			prefix: 'data',
		},
	])('rejects generic credential-route overlap: $name', (fixture) => {
		const create = createDuckDBHttpSessionFactory({ transport: vi.fn() });

		expect(() =>
			create(
				{
					...ACCESS,
					catalog: { ...ACCESS.catalog, url: fixture.catalogUrl },
					storage: {
						...ACCESS.storage,
						endpoint: fixture.endpoint,
						urlStyle: fixture.urlStyle,
						locations: [{ bucket: fixture.bucket, prefix: fixture.prefix }],
					},
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(ROUTE_OVERLAP_ERROR);
	});

	it('allows same-origin catalog and storage routes with disjoint prefixes', () => {
		const create = createDuckDBHttpSessionFactory({ transport: vi.fn(), now: () => NOW });

		const session = create(
			{
				...ACCESS,
				catalog: { ...ACCESS.catalog, url: 'https://shared.example.test/catalog' },
				storage: {
					...ACCESS.storage,
					endpoint: 'https://shared.example.test',
					locations: [{ bucket: 'warehouse', prefix: 'data' }],
				},
			},
			{ expiresAtMs: NOW + 60_000 },
		);

		session.close();
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
		).toThrow(INVALID_S3_ENDPOINT_ERROR);
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
		).toThrow(INVALID_S3_LOCATION_ERROR);
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
		).toThrow(INVALID_VHOST_LOCATION_ERROR);
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
		).toThrow(INVALID_VHOST_LOCATION_ERROR);
		expect(() =>
			create(
				{
					...ACCESS,
					catalog: { ...ACCESS.catalog, url: `${ACCESS.catalog.url}?tenant=analytics` },
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(INVALID_CATALOG_ENDPOINT_ERROR);
		expect(() =>
			create(
				{
					...R2_ACCESS,
					storage: { ...R2_ACCESS.storage, endpoint: `${R2_ACCESS.storage.endpoint}/base` },
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(INVALID_S3_ENDPOINT_ERROR);
		expect(() =>
			create(
				{
					...R2_ACCESS,
					storage: { ...R2_ACCESS.storage, bucket: '../private' },
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(INVALID_S3_LOCATION_ERROR);
		expect(() =>
			create(
				{
					...ACCESS,
					storage: {
						...ACCESS.storage,
						locations: [{ bucket: 'warehouse', prefix: '' }],
					},
				},
				{ expiresAtMs: Date.now() + 60_000 },
			),
		).toThrow(INVALID_S3_LOCATION_ERROR);
	});
});

describe('createGuardedOAuthTokenExchange', () => {
	let server: Server | undefined;
	const localTokenRequest = (
		tokenEndpoint: string,
		overrides: Partial<OAuthTokenExchangeRequest> = {},
	): OAuthTokenExchangeRequest => ({
		tokenEndpoint,
		clientId: 'client',
		clientSecret: 'secret',
		scope: 'catalog',
		allowInsecureTransport: true,
		...overrides,
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	async function serve(response: { status?: number; body: string; delayMs?: number }) {
		let received:
			| { method?: string; authorization?: string; contentType?: string; body: string }
			| undefined;
		server = createServer((request, responseStream) => {
			const chunks: Buffer[] = [];
			request.on('data', (chunk: Buffer) => chunks.push(chunk));
			request.on('end', () => {
				received = {
					method: request.method,
					authorization: request.headers.authorization,
					contentType: request.headers['content-type'],
					body: Buffer.concat(chunks).toString('utf8'),
				};
				const send = () => {
					if (responseStream.destroyed) return;
					responseStream.writeHead(response.status ?? 200, {
						'content-type': 'application/json',
					});
					responseStream.end(response.body);
				};
				if (response.delayMs) setTimeout(send, response.delayMs);
				else send();
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Expected a server port.');
		return {
			url: `http://localhost:${address.port}/oauth/token`,
			received: () => received,
		};
	}

	it('sends the Basic client grant and parses a bounded Bearer token', async () => {
		const fixture = await serve({
			body: JSON.stringify({ access_token: 'access-token', token_type: 'bEaReR', expires_in: 300 }),
		});
		const increment = vi.fn();
		const exchange = createGuardedOAuthTokenExchange({
			allowPrivate: true,
			metrics: { increment, gauge: vi.fn() },
		});

		await expect(
			exchange(
				localTokenRequest(fixture.url, {
					clientId: 'client id',
					clientSecret: 's:ecret',
					scope: 'PRINCIPAL_ROLE:ALL table.read',
				}),
			),
		).resolves.toEqual({ accessToken: 'access-token', expiresInSeconds: 300 });
		expect(fixture.received()).toEqual({
			method: 'POST',
			authorization: `Basic ${Buffer.from('client id:s:ecret').toString('base64')}`,
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=client_credentials&scope=PRINCIPAL_ROLE%3AALL+table.read',
		});
		expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_exchange', 1, {
			outcome: 'success',
		});
	});

	it('uses the fallback expiry only when the response omits expires_in', async () => {
		const fixture = await serve({ body: JSON.stringify({ access_token: 'access-token' }) });
		const exchange = createGuardedOAuthTokenExchange({ allowPrivate: true });

		await expect(
			exchange(localTokenRequest(fixture.url, { scope: '', fallbackExpiresInSeconds: 60 })),
		).resolves.toEqual({ accessToken: 'access-token', expiresInSeconds: 60 });
	});

	it('rejects plaintext token transport before sending client credentials', async () => {
		const fixture = await serve({
			body: JSON.stringify({ access_token: 'access-token', expires_in: 60 }),
		});
		const exchange = createGuardedOAuthTokenExchange({ allowPrivate: true });

		await expect(
			exchange({
				...localTokenRequest(fixture.url),
				allowInsecureTransport: false,
			}),
		).rejects.toThrow(
			'OAuth2 token endpoint uses HTTP. Use HTTPS, or enable allow_insecure_transport for local development.',
		);
		expect(fixture.received()).toBeUndefined();
	});

	it('accepts a positive fractional expiry', async () => {
		const fixture = await serve({
			body: JSON.stringify({ access_token: 'access-token', expires_in: 60.5 }),
		});
		const exchange = createGuardedOAuthTokenExchange({ allowPrivate: true });

		await expect(exchange(localTokenRequest(fixture.url, { scope: '' }))).resolves.toEqual({
			accessToken: 'access-token',
			expiresInSeconds: 60.5,
		});
	});

	it.each([
		['a missing token', { expires_in: 60 }],
		['an empty token', { access_token: '', expires_in: 60 }],
		['a missing expiry', { access_token: 'token' }],
		['an unsupported token type', { access_token: 'token', token_type: 'MAC', expires_in: 60 }],
		['a non-string token type', { access_token: 'token', token_type: null, expires_in: 60 }],
		['a zero expiry', { access_token: 'token', expires_in: 0 }],
		['a negative expiry', { access_token: 'token', expires_in: -1 }],
		['a string expiry', { access_token: 'token', expires_in: '60' }],
		['an excessive expiry', { access_token: 'token', expires_in: 86_401 }],
	] as const)('rejects %s without exposing the response or client secret', async (_case, body) => {
		const fixture = await serve({ body: JSON.stringify(body) });
		const increment = vi.fn();
		const exchange = createGuardedOAuthTokenExchange({
			allowPrivate: true,
			metrics: { increment, gauge: vi.fn() },
		});
		let error: unknown;

		try {
			await exchange(localTokenRequest(fixture.url, { clientSecret: 'do-not-echo' }));
		} catch (cause) {
			error = cause;
		}

		expect(error).toMatchObject({ code: 'credential_failed', message: OAUTH_RESPONSE_ERROR });
		expect(String(error)).not.toContain('do-not-echo');
		expect(String(error)).not.toContain(JSON.stringify(body));
		expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_exchange', 1, {
			outcome: 'failure',
			reason: 'response',
		});
	});

	it.each([
		[
			'bad credentials',
			401,
			'{"error":"invalid_client","secret":"response-secret"}',
			'status',
			'OAuth2 token endpoint returned HTTP 401 for the credentials. Make sure that the client ID, client secret, and scope are correct.',
		],
		[
			'throttling',
			429,
			'{"error":"slow_down","secret":"response-secret"}',
			'status',
			'OAuth2 token endpoint returned HTTP 429. The identity service limited requests. Retry the query later.',
		],
		[
			'an identity-service outage',
			503,
			'{"error":"unavailable","secret":"response-secret"}',
			'status',
			'OAuth2 token endpoint returned HTTP 503. The identity service is unavailable. Retry the query later.',
		],
		['invalid JSON', 200, '{"access_token":', 'response', OAUTH_RESPONSE_ERROR],
	] as const)(
		'rejects %s with a fixed error and metric reason',
		async (_case, status, body, reason, expectedMessage) => {
			const fixture = await serve({ status, body });
			const increment = vi.fn();
			const exchange = createGuardedOAuthTokenExchange({
				allowPrivate: true,
				metrics: { increment, gauge: vi.fn() },
			});
			let error: unknown;

			try {
				await exchange(localTokenRequest(fixture.url, { clientSecret: 'client-secret' }));
			} catch (cause) {
				error = cause;
			}
			expect(error).toMatchObject({ code: 'credential_failed', message: expectedMessage });
			expect(String(error)).not.toContain('client-secret');
			expect(String(error)).not.toContain('response-secret');
			expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_exchange', 1, {
				outcome: 'failure',
				reason,
			});
		},
	);

	it('bounds the token exchange with its own timeout', async () => {
		const fixture = await serve({
			body: JSON.stringify({ access_token: 'late-token', expires_in: 60 }),
			delayMs: 100,
		});
		const increment = vi.fn();
		const exchange = createGuardedOAuthTokenExchange({
			allowPrivate: true,
			timeoutMs: 5,
			metrics: { increment, gauge: vi.fn() },
		});

		await expect(
			exchange(localTokenRequest(fixture.url, { clientSecret: 'client-secret' })),
		).rejects.toMatchObject({ code: 'credential_failed', message: OAUTH_TRANSPORT_ERROR });
		expect(increment).toHaveBeenCalledWith('duckdb_http_broker.oauth_exchange', 1, {
			outcome: 'failure',
			reason: 'transport',
		});
	});

	it('rejects redirects, oversized JSON, cancellation, and private targets', async () => {
		const redirect = await serve({ status: 302, body: '{}' });
		const allowed = createGuardedOAuthTokenExchange({ allowPrivate: true });
		const request = localTokenRequest(redirect.url);
		await expect(allowed(request)).rejects.toThrow(
			'OAuth2 token endpoint returned HTTP 302. Make sure that the endpoint and OAuth2 configuration are correct.',
		);

		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
		const oversized = await serve({
			body: JSON.stringify({ access_token: 'x'.repeat(70 * 1024), expires_in: 60 }),
		});
		await expect(allowed({ ...request, tokenEndpoint: oversized.url })).rejects.toThrow(
			OAUTH_RESPONSE_ERROR,
		);

		const aborted = new AbortController();
		aborted.abort();
		await expect(
			allowed({ ...request, tokenEndpoint: oversized.url }, aborted.signal),
		).rejects.toThrow(OAUTH_CANCELLED_ERROR);
		await expect(
			createGuardedOAuthTokenExchange({ allowPrivate: false })({
				...request,
				tokenEndpoint: oversized.url,
			}),
		).rejects.toThrow(OAUTH_TRANSPORT_ERROR);
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
