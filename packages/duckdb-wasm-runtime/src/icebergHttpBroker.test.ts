import { describe, expect, it, vi } from 'vitest';
import type { Metrics } from '@marimo-hub/core';
import { IcebergHttpBroker, IcebergHttpBrokerError } from './icebergHttpBroker';
import type {
	IcebergHttpBrokerCapability,
	IcebergHttpBrokerTransportRequest,
} from './icebergHttpBroker';

const NOW = Date.parse('2026-08-13T12:00:00Z');

function capability(
	overrides: Partial<IcebergHttpBrokerCapability> = {},
): IcebergHttpBrokerCapability {
	return {
		expiresAtMs: NOW + 60_000,
		routes: [
			{
				kind: 'catalog',
				url: 'https://catalog.example.test/iceberg',
				match: 'prefix',
				methods: ['GET'],
				headers: { Authorization: 'Bearer catalog-secret' },
			},
			{
				kind: 'storage',
				url: 'https://objects.example.test/warehouse',
				match: 'prefix',
				methods: ['GET', 'HEAD'],
				headers: { Authorization: 'Bearer storage-secret' },
			},
		],
		limits: {
			maxRequests: 8,
			maxRedirects: 2,
			maxResponseBytes: 4096,
		},
		...overrides,
	};
}

function setup(
	responses?: { status: number; headers?: Record<string, string>; body?: string }[],
	metrics?: Metrics,
) {
	const calls: IcebergHttpBrokerTransportRequest[] = [];
	const queue = [...(responses ?? [{ status: 200, body: 'ok' }])];
	const transport = vi.fn(async (request: IcebergHttpBrokerTransportRequest) => {
		calls.push(request);
		const response = queue.shift() ?? { status: 200, body: 'ok' };
		return {
			status: response.status,
			headers: response.headers ?? {},
			body: new TextEncoder().encode(response.body ?? ''),
		};
	});
	const broker = new IcebergHttpBroker(
		transport,
		() => NOW,
		() => 'capability-id',
		metrics,
	);
	return { broker, calls, transport };
}

async function expectCode(promise: Promise<unknown>, code: IcebergHttpBrokerError['code']) {
	await expect(promise).rejects.toMatchObject({ code });
}

describe('IcebergHttpBroker', () => {
	it('rejects incomplete capabilities at the runtime boundary', () => {
		const { broker } = setup();
		expect(() =>
			broker.open({
				...capability(),
				limits: { maxRequests: 1 },
			} as unknown as IcebergHttpBrokerCapability),
		).toThrow(IcebergHttpBrokerError);
	});

	it('rejects non-string forwarded header names as an invalid capability', () => {
		const { broker } = setup();
		let error: unknown;

		try {
			broker.open(
				capability({
					forwardRequestHeaders: ['range', 42] as unknown as string[],
				}),
			);
		} catch (cause) {
			error = cause;
		}

		expect(error).toBeInstanceOf(IcebergHttpBrokerError);
		expect(error).toMatchObject({ code: 'invalid_capability' });
	});

	it.each(['authorization', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'])(
		'does not allow %s to be forwarded across every route',
		(header) => {
			const { broker } = setup();

			expect(() => broker.open(capability({ forwardRequestHeaders: ['range', header] }))).toThrow(
				IcebergHttpBrokerError,
			);
		},
	);

	it.each([
		['a non-array forwarded list', { forwardRequestHeaders: 'authorization' }],
		['a non-string forwarded name', { forwardRequestHeaders: [42] }],
		['an empty forwarded name', { forwardRequestHeaders: [''] }],
		['a never-forwarded name', { forwardRequestHeaders: ['cookie'] }],
		['a non-array discarded list', { discardRequestHeaders: 'authorization' }],
		['a non-string discarded name', { discardRequestHeaders: [42] }],
		['an empty discarded name', { discardRequestHeaders: [''] }],
		['a never-forwarded discarded name', { discardRequestHeaders: ['host'] }],
	])('rejects a route with %s', (_case, routeOptions) => {
		const { broker } = setup();

		expect(() =>
			broker.open(
				capability({
					routes: [
						{
							kind: 'storage',
							url: 'https://objects.example.test/warehouse',
							match: 'prefix',
							methods: ['GET'],
							...routeOptions,
						},
					] as IcebergHttpBrokerCapability['routes'],
				}),
			),
		).toThrow(IcebergHttpBrokerError);
	});

	it('keeps credentials in the parent and forwards only approved worker headers', async () => {
		const { broker, calls } = setup([
			{
				status: 206,
				headers: {
					'Content-Range': 'bytes 0-1/20',
					'Set-Cookie': 'session=do-not-return',
				},
				body: 'ab',
			},
		]);
		const id = broker.open(capability());
		const response = await broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/table/data.parquet',
			method: 'GET',
			headers: { Range: 'bytes=0-1' },
		});

		expect(calls[0]).toMatchObject({
			url: 'https://objects.example.test/warehouse/table/data.parquet',
			method: 'GET',
			headers: {
				range: 'bytes=0-1',
				authorization: 'Bearer storage-secret',
			},
			maxResponseBytes: 4096,
		});
		expect(response.headers).toEqual({ 'content-range': 'bytes 0-1/20' });
	});

	it('discards worker placeholders before applying parent-owned credentials', async () => {
		const { broker, calls } = setup();
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'catalog',
						url: 'https://catalog.example.test/iceberg',
						match: 'prefix',
						methods: ['GET'],
						headers: { Authorization: 'Bearer catalog-secret' },
						discardRequestHeaders: ['authorization'],
					},
				],
			}),
		);

		await broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET',
			headers: { authorization: 'Bearer marimohub-parent-broker' },
		});

		expect(calls[0].headers).toEqual({ authorization: 'Bearer catalog-secret' });
	});

	it('rejects overlapping forwarded and discarded route headers', () => {
		const { broker } = setup();
		expect(() =>
			broker.open(
				capability({
					routes: [
						{
							kind: 'storage',
							url: 'https://objects.example.test/warehouse',
							match: 'prefix',
							methods: ['GET'],
							forwardRequestHeaders: ['Authorization'],
							discardRequestHeaders: ['authorization'],
						},
					],
				}),
			),
		).toThrow(IcebergHttpBrokerError);
	});

	it('forwards vended signing headers only on the storage route that grants them', async () => {
		const { broker, calls } = setup();
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'catalog',
						url: 'https://catalog.example.test/iceberg',
						match: 'prefix',
						methods: ['GET'],
						headers: { Authorization: 'Bearer catalog-secret' },
					},
					{
						kind: 'storage',
						url: 'https://objects.example.test/warehouse',
						match: 'prefix',
						methods: ['GET'],
						forwardRequestHeaders: [
							'authorization',
							'x-amz-content-sha256',
							'x-amz-date',
							'x-amz-security-token',
						],
					},
				],
			}),
		);

		await broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/table/data.parquet',
			method: 'GET',
			headers: {
				authorization: 'AWS4-HMAC-SHA256 Credential=vended',
				'x-amz-content-sha256': 'payload-hash',
				'x-amz-date': '20260814T120000Z',
				'x-amz-security-token': 'session-token',
			},
		});

		expect(calls[0].headers).toEqual({
			authorization: 'AWS4-HMAC-SHA256 Credential=vended',
			'x-amz-content-sha256': 'payload-hash',
			'x-amz-date': '20260814T120000Z',
			'x-amz-security-token': 'session-token',
		});
		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
				headers: { authorization: 'AWS4-HMAC-SHA256 Credential=vended' },
			}),
			'header_denied',
		);
	});

	it('allows catalog HEAD and computes parent-owned headers after authorization', async () => {
		const { broker, calls } = setup();
		const prepareHeaders = vi.fn(async (request) => ({
			authorization: `Signed ${request.method}:${new URL(request.url).pathname}`,
			'x-amz-date': '20260813T120000Z',
		}));
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'catalog',
						url: 'https://catalog.example.test/iceberg',
						match: 'prefix',
						methods: ['GET', 'HEAD'],
						prepareHeaders,
					},
				],
			}),
		);

		await broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'HEAD',
		});

		expect(prepareHeaders).toHaveBeenCalledOnce();
		expect(calls[0].headers).toEqual({
			authorization: 'Signed HEAD:/iceberg/v1/config',
			'x-amz-date': '20260813T120000Z',
		});
	});

	it('rejects targets outside the granted origins and path prefixes', async () => {
		const { broker, transport } = setup();
		const id = broker.open(capability());

		await expectCode(
			broker.fetch(id, { url: 'http://169.254.169.254/latest/meta-data', method: 'GET' }),
			'target_denied',
		);
		await expectCode(
			broker.fetch(id, { url: 'https://catalog.example.test/admin', method: 'GET' }),
			'target_denied',
		);
		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg-other',
				method: 'GET',
			}),
			'target_denied',
		);
		expect(transport).not.toHaveBeenCalled();
	});

	it('rejects worker-supplied credentials and unapproved methods', async () => {
		const { broker, transport } = setup();
		const id = broker.open(capability());

		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
				headers: { Authorization: 'Bearer forged' },
			}),
			'header_denied',
		);
		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
				headers: { 'X-Iceberg-Access-Delegation': 'vended-credentials' },
			}),
			'header_denied',
		);
		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/namespaces',
				method: 'HEAD',
			}),
			'method_denied',
		);
		expect(transport).not.toHaveBeenCalled();
	});

	it('does not retain an abort controller when request normalization fails', async () => {
		const { broker } = setup();
		const abort = vi.spyOn(AbortController.prototype, 'abort');
		const id = broker.open(capability());

		try {
			await expectCode(
				broker.fetch(id, {
					url: 'https://catalog.example.test/iceberg/v1/config',
					method: 'GET',
					headers: { Range: 'bytes=0-1\r\nx-forged: value' },
				}),
				'invalid_request',
			);
			broker.close(id);

			expect(abort).not.toHaveBeenCalled();
		} finally {
			abort.mockRestore();
		}
	});

	it('does not consume request budget when parent header preparation fails', async () => {
		const { broker, transport } = setup();
		const prepareHeaders = vi
			.fn<NonNullable<IcebergHttpBrokerCapability['routes'][number]['prepareHeaders']>>()
			.mockRejectedValueOnce(new Error('temporary signing failure'))
			.mockResolvedValueOnce({ Authorization: 'signed' });
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'storage',
						url: 'https://objects.example.test/warehouse',
						match: 'prefix',
						methods: ['GET'],
						prepareHeaders,
					},
				],
				limits: { ...capability().limits, maxRequests: 1 },
			}),
		);
		const request = {
			url: 'https://objects.example.test/warehouse/data.parquet',
			method: 'GET' as const,
		};

		await expect(broker.fetch(id, request)).rejects.toThrow('temporary signing failure');
		await expect(broker.fetch(id, request)).resolves.toMatchObject({ status: 200 });

		expect(prepareHeaders).toHaveBeenCalledTimes(2);
		expect(transport).toHaveBeenCalledOnce();
	});

	it('uses an exact route before an equal-path prefix route', async () => {
		const { broker, calls } = setup();
		const url = 'https://objects.example.test/warehouse/table.parquet';
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'storage',
						url,
						match: 'prefix',
						methods: ['GET', 'HEAD'],
						headers: { Authorization: 'Bearer prefix-secret' },
					},
					{
						kind: 'storage',
						url,
						match: 'exact',
						methods: ['GET'],
						headers: { Authorization: 'Bearer exact-secret' },
					},
				],
			}),
		);

		await broker.fetch(id, { url, method: 'GET' });
		expect(calls[0].headers).toMatchObject({ authorization: 'Bearer exact-secret' });

		await expectCode(broker.fetch(id, { url, method: 'HEAD' }), 'method_denied');
		expect(calls).toHaveLength(1);
	});

	it('reauthorizes redirects and switches to credentials for the destination route', async () => {
		const { broker, calls } = setup([
			{
				status: 307,
				headers: {
					Location: 'https://objects.example.test/warehouse/table/metadata.json',
				},
			},
			{ status: 200, headers: { ETag: 'snapshot-1' }, body: '{}' },
		]);
		const id = broker.open(capability());
		const response = await broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/table',
			method: 'GET',
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].headers).toMatchObject({ authorization: 'Bearer catalog-secret' });
		expect(calls[1]).toMatchObject({
			url: 'https://objects.example.test/warehouse/table/metadata.json',
			headers: { authorization: 'Bearer storage-secret' },
		});
		expect(response).toMatchObject({ status: 200, headers: { etag: 'snapshot-1' } });
	});

	it('does not carry discarded or parent-owned headers into redirects', async () => {
		const { broker, calls } = setup([
			{
				status: 307,
				headers: {
					Location: 'https://objects.example.test/warehouse/table/metadata.json',
				},
			},
			{ status: 200, body: '{}' },
		]);
		const id = broker.open(
			capability({
				routes: [
					{
						kind: 'catalog',
						url: 'https://catalog.example.test/iceberg',
						match: 'prefix',
						methods: ['GET'],
						headers: { Authorization: 'Bearer catalog-secret' },
						discardRequestHeaders: ['authorization'],
					},
					{
						kind: 'storage',
						url: 'https://objects.example.test/warehouse',
						match: 'prefix',
						methods: ['GET'],
						forwardRequestHeaders: ['authorization'],
					},
				],
			}),
		);

		await broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/table',
			method: 'GET',
			headers: {
				authorization: 'Bearer worker-placeholder',
				range: 'bytes=0-99',
			},
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].headers).toEqual({
			range: 'bytes=0-99',
			authorization: 'Bearer catalog-secret',
		});
		expect(calls[1].headers).toEqual({ range: 'bytes=0-99' });
	});

	it('emits low-cardinality policy, redirect, budget, byte, and latency metrics', async () => {
		const metrics = {
			increment: vi.fn(),
			gauge: vi.fn(),
			histogram: vi.fn(),
		} satisfies Metrics;
		const { broker } = setup(
			[
				{
					status: 307,
					headers: { Location: 'https://objects.example.test/warehouse/data.parquet' },
				},
				{ status: 200, body: 'data' },
			],
			metrics,
		);
		const id = broker.open(capability({ limits: { ...capability().limits, maxRequests: 2 } }));

		await broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/table',
			method: 'GET',
		});
		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'request_budget_exceeded',
		);

		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.request', 1, {
			outcome: 'authorized',
			route: 'catalog',
			method: 'GET',
		});
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.request', 1, {
			outcome: 'authorized',
			route: 'storage',
			method: 'GET',
		});
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.request', 1, {
			outcome: 'denied',
			reason: 'request_budget_exceeded',
			method: 'GET',
		});
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.redirect', 1, {
			outcome: 'followed',
		});
		expect(metrics.increment).toHaveBeenCalledWith('duckdb_http_broker.budget_exhausted', 1, {
			budget: 'request',
		});
		expect(metrics.histogram).toHaveBeenCalledWith('duckdb_http_broker.response_bytes', 4, {
			route: 'storage',
			method: 'GET',
			status_class: '2xx',
		});
		expect(metrics.histogram).toHaveBeenCalledWith('duckdb_http_broker.transport_latency_ms', 0, {
			route: 'catalog',
			method: 'GET',
			status_class: '3xx',
		});
		expect(metrics.histogram).toHaveBeenCalledWith('duckdb_http_broker.request_latency_ms', 0, {
			method: 'GET',
		});
	});

	it('does not follow a redirect to an ungranted destination', async () => {
		const { broker, calls } = setup([
			{
				status: 302,
				headers: { Location: 'http://127.0.0.1:3000/internal' },
			},
		]);
		const id = broker.open(capability());

		await expectCode(
			broker.fetch(id, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'target_denied',
		);
		expect(calls).toHaveLength(1);
	});

	it('enforces request, response, redirect, expiry, and close boundaries', async () => {
		const requestLimited = setup();
		const requestId = requestLimited.broker.open(
			capability({ limits: { ...capability().limits, maxRequests: 1 } }),
		);
		await requestLimited.broker.fetch(requestId, {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET',
		});
		await expectCode(
			requestLimited.broker.fetch(requestId, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'request_budget_exceeded',
		);

		const responseLimited = setup([{ status: 200, body: 'too large' }]);
		const responseId = responseLimited.broker.open(
			capability({ limits: { ...capability().limits, maxResponseBytes: 2 } }),
		);
		await expectCode(
			responseLimited.broker.fetch(responseId, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'response_budget_exceeded',
		);

		const redirectLimited = setup([{ status: 302, headers: { Location: '/iceberg/v1/config' } }]);
		const redirectId = redirectLimited.broker.open(
			capability({ limits: { ...capability().limits, maxRedirects: 0 } }),
		);
		await expectCode(
			redirectLimited.broker.fetch(redirectId, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'redirect_budget_exceeded',
		);

		let clock = NOW;
		const expiring = new IcebergHttpBroker(
			async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
			() => clock,
			() => 'expiring',
		);
		const expiringId = expiring.open(capability({ expiresAtMs: NOW + 1 }));
		clock += 1;
		await expectCode(
			expiring.fetch(expiringId, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'capability_expired',
		);

		const closed = setup();
		const closedId = closed.broker.open(capability());
		closed.broker.close(closedId);
		await expectCode(
			closed.broker.fetch(closedId, {
				url: 'https://catalog.example.test/iceberg/v1/config',
				method: 'GET',
			}),
			'capability_unknown',
		);
	});

	it('discards an in-flight response when its capability is revoked', async () => {
		let resolveTransport!: (response: {
			status: number;
			headers: Record<string, string>;
			body: Uint8Array;
		}) => void;
		const broker = new IcebergHttpBroker(
			() =>
				new Promise((resolve) => {
					resolveTransport = resolve;
				}),
			() => NOW,
			() => 'revoked',
		);
		const id = broker.open(capability());
		const pending = broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET',
		});
		await vi.waitFor(() => expect(resolveTransport).toBeTypeOf('function'));
		broker.close(id);
		resolveTransport({ status: 200, headers: {}, body: new Uint8Array() });

		await expectCode(pending, 'capability_unknown');
	});

	it('aborts in-flight transport when its capability is revoked', async () => {
		let transportSignal: AbortSignal | undefined;
		const broker = new IcebergHttpBroker(
			(request) =>
				new Promise((_resolve, reject) => {
					transportSignal = request.signal;
					request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
						once: true,
					});
				}),
			() => NOW,
			() => 'abortable',
		);
		const id = broker.open(capability());
		const pending = broker.fetch(id, {
			url: 'https://catalog.example.test/iceberg/v1/config',
			method: 'GET',
		});
		await vi.waitFor(() => expect(transportSignal).toBeDefined());

		broker.close(id);

		expect(transportSignal?.aborted).toBe(true);
		await expect(pending).rejects.toBeDefined();
	});

	it('allows bounded parallel reads while reserving the shared byte budget', async () => {
		const releases: (() => void)[] = [];
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const limits: number[] = [];
		const broker = new IcebergHttpBroker(
			async (request) => {
				calls += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				limits.push(request.maxResponseBytes);
				await new Promise<void>((resolve) => releases.push(resolve));
				active -= 1;
				return { status: 200, headers: {}, body: new Uint8Array(2) };
			},
			() => NOW,
			() => 'parallel',
		);
		const id = broker.open(
			capability({
				limits: {
					...capability().limits,
					maxConcurrentRequests: 2,
					maxResponseBytes: 4,
					maxSingleResponseBytes: 2,
				},
			}),
		);
		const first = broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/one.parquet',
			method: 'GET',
		});
		const second = broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/two.parquet',
			method: 'GET',
		});
		const third = broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/three.parquet',
			method: 'GET',
		});

		await vi.waitFor(() => expect(calls).toBe(2));
		expect(maxActive).toBe(2);
		releases.splice(0).forEach((release) => release());
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		await expectCode(third, 'response_budget_exceeded');
		expect(calls).toBe(2);
		expect(limits).toEqual([2, 2]);
	});
});
