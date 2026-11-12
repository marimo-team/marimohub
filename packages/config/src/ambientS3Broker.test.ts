import { describe, expect, it, vi } from 'vitest';
import type { DuckDBHttpAccess } from '@marimo-hub/core';
import type { IcebergHttpBrokerTransport } from '@marimo-hub/duckdb-wasm-runtime/node';
import { createDuckDBHttpSessionFactory } from './duckdbHttpBroker';

const NOW = Date.parse('2026-08-13T12:00:00Z');
const URL = 'https://s3.us-east-1.amazonaws.com/warehouse/tables/file.parquet';
const ACCESS = {
	kind: 'iceberg-rest',
	catalog: { url: 'https://catalog.example.test/iceberg', authorization: 'Bearer catalog-secret' },
	storage: {
		kind: 's3',
		endpoint: 'https://s3.us-east-1.amazonaws.com',
		region: 'us-east-1',
		urlStyle: 'path',
		credentials: { method: 'ambient' },
		locations: [{ bucket: 'warehouse', prefix: 'tables' }],
	},
} as const satisfies DuckDBHttpAccess;
const KEYS = {
	accessKeyId: 'AMBIENT',
	secretAccessKey: 'private-secret',
	sessionToken: 'private-token',
};
const RESPONSE = { status: 200, headers: {}, body: new Uint8Array() };

describe('ambient S3 broker boundaries', () => {
	it.each([
		'https://hub.s3.us-east-1.amazonaws.com',
		'https://hub.s3.amazonaws.com',
		'https://hub.s3.dualstack.us-east-1.amazonaws.com',
		'https://hub.s3-us-east-1.amazonaws.com',
		'https://hub.s3-accelerate.amazonaws.com',
		'https://access-123456789012.s3-accesspoint.us-east-1.amazonaws.com',
		'https://s3.us-east-1.amazonaws.com.attacker.example',
		'https://custom-storage.example',
		'https://s3.us-east-1.amazonaws.com:8443',
	])('rejects an untrusted or bucket-qualified ambient endpoint: %s', (endpoint) => {
		const credentials = vi.fn(async () => KEYS);
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => RESPONSE);
		const factory = createDuckDBHttpSessionFactory({
			transport,
			now: () => NOW,
			ambientS3: { credentials, blockedBucket: 'hub' },
		});
		for (const urlStyle of ['path', 'vhost'] as const) {
			expect(() =>
				factory(
					{
						...ACCESS,
						storage: {
							...ACCESS.storage,
							endpoint,
							urlStyle,
							locations: [{ bucket: 'projects', prefix: 'other-project' }],
						},
					},
					{ expiresAtMs: NOW + 60_000 },
				),
			).toThrow('AWS S3 service endpoint');
		}
		expect(credentials).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		'hub-access-s3alias',
		'hub-access--ol-s3',
		'hub--use1-az1--x-s3',
		'hub--table-s3',
		'hub.mrap',
	])('rejects bucket aliases and alternate bucket types: %s', (bucket) => {
		const credentials = vi.fn(async () => KEYS);
		const factory = createDuckDBHttpSessionFactory({
			now: () => NOW,
			ambientS3: { credentials, blockedBucket: 'hub' },
		});
		for (const urlStyle of ['path', 'vhost'] as const) {
			expect(() =>
				factory(
					{
						...ACCESS,
						storage: { ...ACCESS.storage, urlStyle, locations: [{ bucket, prefix: 'projects' }] },
					},
					{ expiresAtMs: NOW + 60_000 },
				),
			).toThrow('bucket names');
		}
		expect(credentials).not.toHaveBeenCalled();
	});

	it.each([
		'https://s3.amazonaws.com',
		'https://s3.us-east-1.amazonaws.com',
		'https://s3.dualstack.eu-west-1.amazonaws.com',
		'https://s3-fips.us-gov-west-1.amazonaws.com',
		'https://s3-fips.dualstack.us-east-1.amazonaws.com',
		'https://s3.cn-north-1.amazonaws.com.cn',
	])('signs reads for the configured bucket on a service endpoint: %s', async (endpoint) => {
		for (const urlStyle of ['path', 'vhost'] as const) {
			const credentials = vi.fn(async () => KEYS);
			const transport = vi.fn<IcebergHttpBrokerTransport>(async () => RESPONSE);
			const session = createDuckDBHttpSessionFactory({
				transport,
				now: () => NOW,
				ambientS3: { credentials, blockedBucket: 'hub' },
			})(
				{ ...ACCESS, storage: { ...ACCESS.storage, endpoint, urlStyle } },
				{ expiresAtMs: NOW + 60_000 },
			);
			const url =
				urlStyle === 'path'
					? `${endpoint}/warehouse/tables/file.parquet`
					: `${endpoint.replace('https://', 'https://warehouse.')}/tables/file.parquet`;
			await expect(session.fetch({ url, method: 'GET' })).resolves.toMatchObject({ status: 200 });
			expect(transport.mock.calls[0][0].headers?.authorization).toContain('Credential=AMBIENT/');
			session.close();
		}
	});

	it.each([
		'https://attacker.example.test/warehouse/tables/file.parquet',
		'https://s3.us-east-1.amazonaws.com/warehouse/tables-other/file.parquet',
		'https://s3.us-east-1.amazonaws.com/other-bucket/tables/file.parquet',
		'http://s3.us-east-1.amazonaws.com/warehouse/tables/file.parquet',
	])('rejects a redirect outside the authorized storage scope: %s', async (location) => {
		const credentials = vi.fn(async () => KEYS);
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			...RESPONSE,
			status: 302,
			headers: { location },
		}));
		const session = createDuckDBHttpSessionFactory({
			transport,
			now: () => NOW,
			ambientS3: { credentials },
		})(ACCESS, { expiresAtMs: NOW + 60_000 });
		await expect(session.fetch({ url: URL, method: 'GET' })).rejects.toMatchObject({
			code: 'target_denied',
		});
		expect(credentials).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledOnce();
		session.close();
	});

	it('replaces forged worker credentials and keeps ambient credentials out of catalog requests', async () => {
		const credentials = vi.fn(async () => KEYS);
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => RESPONSE);
		const session = createDuckDBHttpSessionFactory({
			transport,
			now: () => NOW,
			ambientS3: { credentials },
		})(ACCESS, { expiresAtMs: NOW + 60_000 });
		await session.fetch({
			url: URL,
			method: 'HEAD',
			headers: {
				authorization: 'forged',
				'x-amz-security-token': 'forged',
				'x-amz-date': 'forged',
				'x-amz-content-sha256': 'forged',
			},
		});
		expect(transport.mock.calls[0][0].headers).toMatchObject({
			authorization: expect.stringContaining('Credential=AMBIENT/'),
			'x-amz-security-token': KEYS.sessionToken,
		});
		expect(JSON.stringify(transport.mock.calls[0][0].headers)).not.toContain('forged');
		await session.fetch({ url: 'https://catalog.example.test/iceberg/v1/config', method: 'GET' });
		expect(transport.mock.calls[1][0].headers).toEqual({ authorization: 'Bearer catalog-secret' });
		expect(credentials).toHaveBeenCalledOnce();
		session.close();
	});

	it('recovers from a credential-provider failure without exposing its error', async () => {
		const credentials = vi
			.fn()
			.mockRejectedValueOnce(new Error(`provider failed: ${KEYS.secretAccessKey}`))
			.mockResolvedValueOnce(KEYS);
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => RESPONSE);
		const session = createDuckDBHttpSessionFactory({
			transport,
			now: () => NOW,
			ambientS3: { credentials },
		})(ACCESS, { expiresAtMs: NOW + 60_000 });
		await expect(session.fetch({ url: URL, method: 'GET' })).rejects.toMatchObject({
			message:
				'S3 credentials are unavailable or expired. Check the server AWS credential configuration.',
		});
		expect(transport).not.toHaveBeenCalled();
		await expect(session.fetch({ url: URL, method: 'GET' })).resolves.toMatchObject({
			status: 200,
		});
		expect(transport).toHaveBeenCalledOnce();
		session.close();
	});

	it.each(['abort', 'deadline'] as const)(
		'does not send late credentials after %s',
		async (stop) => {
			let clock = NOW;
			let resolve!: (value: typeof KEYS) => void;
			const credentials = vi.fn(
				() =>
					new Promise<typeof KEYS>((done) => {
						resolve = done;
					}),
			);
			const transport = vi.fn<IcebergHttpBrokerTransport>(async () => RESPONSE);
			const controller = new AbortController();
			const session = createDuckDBHttpSessionFactory({
				transport,
				now: () => clock,
				ambientS3: { credentials },
			})(ACCESS, { expiresAtMs: NOW + 60_000 });
			const result = session.fetch({ url: URL, method: 'GET' }, controller.signal);
			const rejected = expect(result).rejects.toThrow();
			await vi.waitFor(() => expect(credentials).toHaveBeenCalledOnce());
			if (stop === 'abort') controller.abort();
			else clock = NOW + 60_000;
			resolve(KEYS);
			await rejected;
			expect(transport).not.toHaveBeenCalled();
			session.close();
		},
	);

	it('rejects insecure ambient storage before credential lookup', () => {
		const credentials = vi.fn(async () => KEYS);
		const factory = createDuckDBHttpSessionFactory({ now: () => NOW, ambientS3: { credentials } });
		expect(() =>
			factory(
				{
					...ACCESS,
					storage: { ...ACCESS.storage, endpoint: 'http://s3.us-east-1.amazonaws.com' },
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow(/HTTPS/);
		expect(credentials).not.toHaveBeenCalled();
	});

	it('does not let the insecure-transport override bypass ambient endpoint restrictions', () => {
		const credentials = vi.fn(async () => KEYS);
		const factory = createDuckDBHttpSessionFactory({ now: () => NOW, ambientS3: { credentials } });
		expect(() =>
			factory(
				{
					...ACCESS,
					allowInsecureTransport: true,
					storage: { ...ACCESS.storage, endpoint: 'http://s3.us-east-1.amazonaws.com' },
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow('HTTPS AWS S3 service endpoint');
		expect(credentials).not.toHaveBeenCalled();
	});

	it('blocks control-plane storage even when it follows an allowed location', () => {
		const credentials = vi.fn(async () => KEYS);
		const factory = createDuckDBHttpSessionFactory({
			now: () => NOW,
			ambientS3: { credentials, blockedBucket: 'hub' },
		});
		expect(() =>
			factory(
				{
					...ACCESS,
					storage: {
						...ACCESS.storage,
						urlStyle: 'vhost',
						locations: [...ACCESS.storage.locations, { bucket: 'hub', prefix: 'private/' }],
					},
				},
				{ expiresAtMs: NOW + 60_000 },
			),
		).toThrow('Control-plane storage');
		expect(credentials).not.toHaveBeenCalled();
	});
});
