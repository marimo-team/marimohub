import type { DuckDBHttpAccess } from '@marimo-hub/core';
import type {
	IcebergHttpBrokerTransport,
	IcebergHttpBrokerTransportRequest,
} from '@marimo-hub/duckdb-wasm-runtime/node';
import { describe, expect, it, vi } from 'vitest';
import { createDuckDBHttpSessionFactory } from './duckdbHttpBroker';

const NOW = Date.parse('2026-08-27T12:00:00Z');
const URL = 'https://data.example.test/snapshots/analytics.duckdb';
const ACCESS = {
	kind: 'http-database',
	url: URL,
	authorization: 'Bearer parent-secret',
} as const satisfies DuckDBHttpAccess;

function open(transport: IcebergHttpBrokerTransport, access: DuckDBHttpAccess = ACCESS) {
	return createDuckDBHttpSessionFactory({ transport, now: () => NOW })(access, {
		expiresAtMs: NOW + 60_000,
	});
}

function partialResponse(
	overrides: {
		status?: number;
		headers?: Record<string, string>;
		body?: Uint8Array;
	} = {},
) {
	const body = overrides.body ?? new Uint8Array([1, 2, 3, 4]);
	return {
		status: overrides.status ?? 206,
		headers: {
			etag: '"snapshot-v1"',
			'content-length': String(body.byteLength),
			'content-range': 'bytes 0-3/1024',
			...overrides.headers,
		},
		body,
	};
}

describe('remote DuckDB database broker', () => {
	it('authorizes only the normalized exact URL', async () => {
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => partialResponse());
		const session = open(transport);

		await expect(
			session.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).resolves.toMatchObject({ status: 206 });
		for (const denied of [
			'https://data.example.test/snapshots/sibling.duckdb',
			'https://data.example.test/snapshots/',
		]) {
			await expect(session.fetch({ url: denied, method: 'GET' })).rejects.toMatchObject({
				code: 'target_denied',
			});
		}
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('captures a strong ETag, injects If-Match, and replaces worker authorization', async () => {
		const calls: IcebergHttpBrokerTransportRequest[] = [];
		const transport = vi.fn<IcebergHttpBrokerTransport>(async (request) => {
			calls.push(request);
			if (request.method === 'HEAD') {
				return {
					status: 200,
					headers: { etag: '"snapshot-v1"', 'content-length': '1024' },
					body: new Uint8Array(),
				};
			}
			return partialResponse();
		});
		const session = open(transport);

		await session.fetch({
			url: URL,
			method: 'HEAD',
			headers: { authorization: 'Bearer worker-secret', range: 'bytes=0-' },
		});
		await session.fetch({
			url: URL,
			method: 'GET',
			headers: {
				authorization: 'Bearer worker-secret',
				'if-match': '"worker-etag"',
				range: 'bytes=0-3',
			},
		});

		expect(calls[0].headers).toMatchObject({ authorization: 'Bearer parent-secret' });
		expect(calls[0].headers).not.toHaveProperty('if-match');
		expect(calls[1].headers).toMatchObject({
			authorization: 'Bearer parent-secret',
			'if-match': '"snapshot-v1"',
		});
		expect(JSON.stringify(calls)).not.toContain('worker-secret');
	});

	it.each([
		{ label: 'missing', etag: undefined },
		{ label: 'weak', etag: 'W/"snapshot-v1"' },
	])('rejects a $label strong ETag', async ({ etag }) => {
		const session = open(async () =>
			partialResponse({
				headers: { etag: etag ?? '' },
			}),
		);
		await expect(
			session.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'strong_etag_required' });
	});

	it('fails when the response ETag changes or If-Match returns 412', async () => {
		let call = 0;
		const changed = open(async () => {
			call += 1;
			return partialResponse({ headers: { etag: `"snapshot-v${call}"` } });
		});
		await changed.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } });
		await expect(
			changed.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'object_changed' });

		call = 0;
		const precondition = open(async () => {
			call += 1;
			return call === 1 ? partialResponse() : { status: 412, headers: {}, body: new Uint8Array() };
		});
		await precondition.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } });
		await expect(
			precondition.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'object_changed' });
	});

	it.each([
		['missing Content-Range', { headers: { 'content-range': '' } }],
		['wrong body length', { headers: { 'content-range': 'bytes 0-7/1024' } }],
		['conflicting Content-Length', { headers: { 'content-length': '3' } }],
		['multipart ranges', { headers: { 'content-type': 'multipart/byteranges; boundary=unsafe' } }],
		['wrong range start', { headers: { 'content-range': 'bytes 1-4/1024' } }],
	])('rejects %s', async (_label, overrides) => {
		const session = open(async () => partialResponse(overrides));
		await expect(
			session.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'range_invalid' });
	});

	it('rejects partial responses without a matching request range', async () => {
		const withoutRange = open(async () => partialResponse());
		await expect(withoutRange.fetch({ url: URL, method: 'GET' })).rejects.toMatchObject({
			code: 'range_invalid',
		});

		const head = open(async () =>
			partialResponse({ headers: { 'content-range': 'bytes 1-4/1024' } }),
		);
		await expect(
			head.fetch({ url: URL, method: 'HEAD', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'range_invalid' });
	});

	it('allows only small complete-body fallbacks for a range request', async () => {
		const smallBody = new Uint8Array(1024);
		const small = open(async () => ({
			status: 200,
			headers: { etag: '"snapshot-v1"', 'content-length': String(smallBody.byteLength) },
			body: smallBody,
		}));
		await expect(
			small.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).resolves.toMatchObject({ status: 200 });

		const largeBody = new Uint8Array(1024 * 1024 + 1);
		const large = open(async () => ({
			status: 200,
			headers: { etag: '"snapshot-v1"', 'content-length': String(largeBody.byteLength) },
			body: largeBody,
		}));
		await expect(
			large.fetch({ url: URL, method: 'GET', headers: { range: 'bytes=0-3' } }),
		).rejects.toMatchObject({ code: 'range_invalid' });
	});

	it('denies redirects before authorizing another target', async () => {
		const transport = vi.fn<IcebergHttpBrokerTransport>(async () => ({
			status: 302,
			headers: { location: 'https://cdn.example.test/analytics.duckdb' },
			body: new Uint8Array(),
		}));
		const session = open(transport);

		await expect(session.fetch({ url: URL, method: 'HEAD' })).rejects.toMatchObject({
			code: 'redirect_denied',
		});
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('rejects non-HTTPS and non-normalized database capabilities', () => {
		for (const url of [
			'http://data.example.test/analytics.duckdb',
			'https://DATA.example.test:443/analytics.duckdb',
			'https://data.example.test/analytics.duckdb?version=1',
		]) {
			expect(() => open(vi.fn(), { ...ACCESS, url })).toThrow(/normalized exact HTTPS/);
		}
	});
});
