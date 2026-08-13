import { describe, expect, it, vi } from 'vitest';
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

function setup(responses?: { status: number; headers?: Record<string, string>; body?: string }[]) {
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
				url: 'https://catalog.example.test/iceberg/v1/namespaces',
				method: 'HEAD',
			}),
			'method_denied',
		);
		expect(transport).not.toHaveBeenCalled();
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

	it('serializes requests so concurrent reads share one exact byte budget', async () => {
		let releaseFirst!: () => void;
		let calls = 0;
		const limits: number[] = [];
		const broker = new IcebergHttpBroker(
			async (request) => {
				calls += 1;
				limits.push(request.maxResponseBytes);
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return { status: 200, headers: {}, body: new Uint8Array(2) };
			},
			() => NOW,
			() => 'serialized',
		);
		const id = broker.open(capability({ limits: { ...capability().limits, maxResponseBytes: 4 } }));
		const first = broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/one.parquet',
			method: 'GET',
		});
		const second = broker.fetch(id, {
			url: 'https://objects.example.test/warehouse/two.parquet',
			method: 'GET',
		});

		await vi.waitFor(() => expect(calls).toBe(1));
		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(limits).toEqual([4, 2]);
	});
});
