import { Readable } from 'node:stream';
import { V4MAPPED } from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { ObjectBrowseError } from '@marimo-hub/core';
import { createGuardedLookup, endpointsMatch, enforcedTimeouts } from './client';
import { decodeCursor, encodeCursor } from './cursors';
import { mapS3Error } from './errors';
import { detectRasterImage, rasterContentType } from './formats';
import { readBoundedBody, toWebStream } from './streams';
import { assertBucket, assertObjectIdentity } from './validation';

describe('cursor encoding', () => {
	it('round trips opaque values and treats an absent cursor as empty', () => {
		const cursor = encodeCursor({ token: 'opaque/+ value' });
		expect(decodeCursor(cursor, ['token'])).toEqual({ token: 'opaque/+ value' });
		expect(decodeCursor(undefined, ['token'])).toEqual({});
	});

	it.each([
		['malformed base64', '%%%'],
		['trailing base64 garbage', `${encodeCursor({ token: 'valid' })}%`],
		['non-canonical padding', `${encodeCursor({ token: 'valid' })}=`],
		['invalid base64 length', 'A'],
		['empty value', ''],
		['malformed JSON', Buffer.from('{').toString('base64url')],
		['wrong version', Buffer.from(JSON.stringify({ v: 2 })).toString('base64url')],
		['null payload', Buffer.from('null').toString('base64url')],
		['array payload', Buffer.from(JSON.stringify([1])).toString('base64url')],
		['non-string marker', Buffer.from(JSON.stringify({ v: 1, token: 42 })).toString('base64url')],
		[
			'unknown marker',
			Buffer.from(JSON.stringify({ v: 1, token: 'ok', extra: 'no' })).toString('base64url'),
		],
		['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]).toString('base64url')],
	])('rejects %s', (_label, cursor) => {
		expect(() => decodeCursor(cursor, ['token'])).toThrow(
			expect.objectContaining({ code: 'invalid_cursor' }),
		);
	});
});

describe('provider error mapping', () => {
	it('preserves an existing safe domain error', () => {
		const error = new ObjectBrowseError('not_found', 'safe');
		expect(mapS3Error(error)).toBe(error);
	});

	it.each([
		['AbortError', undefined, 'aborted'],
		['AccessDenied', 500, 'access_denied'],
		['Other', 403, 'access_denied'],
		['NoSuchKey', 500, 'not_found'],
		['NotFound', 500, 'not_found'],
		['Other', 404, 'not_found'],
		['PreconditionFailed', 500, 'precondition_failed'],
		['Other', 412, 'precondition_failed'],
		['InvalidRange', 500, 'range_not_satisfiable'],
		['Other', 416, 'range_not_satisfiable'],
		['NotImplemented', 500, 'unsupported'],
		['UnsupportedOperation', 500, 'unsupported'],
		['InternalError', 500, 'unavailable'],
	] as const)('maps %s/%s to %s without leaking the provider message', (name, status, code) => {
		const error = Object.assign(new Error('secret provider detail'), {
			name,
			$metadata: { httpStatusCode: status, requestId: 'request-id' },
		});
		const mapped = mapS3Error(error);
		expect(mapped).toMatchObject({
			code,
			request_id: code === 'aborted' ? undefined : 'request-id',
		});
		expect(mapped.message).not.toContain('secret provider detail');
	});
});

describe('format and identity validation', () => {
	it.each([
		['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
		['jpeg', [0xff, 0xd8, 0xff]],
		['gif', [...new TextEncoder().encode('GIF87a')]],
		['gif', [...new TextEncoder().encode('GIF89a')]],
		['webp', [...new TextEncoder().encode('RIFFxxxxWEBP')]],
	] as const)('detects %s magic bytes', (format, bytes) => {
		expect(detectRasterImage(new Uint8Array(bytes))).toBe(format);
	});

	it('rejects truncated and extension-only image signatures', () => {
		expect(detectRasterImage(new Uint8Array([0x89, 0x50]))).toBeUndefined();
		expect(detectRasterImage(new TextEncoder().encode('picture.png'))).toBeUndefined();
		expect(rasterContentType('jpeg')).toBe('image/jpeg');
		expect(rasterContentType('png')).toBe('image/png');
	});

	it('enforces bucket scope and the UTF-8 key byte limit', () => {
		const scoped = { configured_bucket: 'lake' } as Parameters<typeof assertBucket>[0];
		expect(() => assertBucket(scoped, '')).toThrow(expect.objectContaining({ code: 'not_found' }));
		expect(() => assertBucket(scoped, 'other')).toThrow(
			expect.objectContaining({ code: 'access_denied' }),
		);
		expect(() => assertObjectIdentity(scoped, { bucket: 'lake', key: '' })).toThrow(
			expect.objectContaining({ code: 'not_found' }),
		);
		expect(() =>
			assertObjectIdentity(scoped, { bucket: 'lake', key: 'é'.repeat(512) }),
		).not.toThrow();
		expect(() =>
			assertObjectIdentity(scoped, { bucket: 'lake', key: `${'é'.repeat(512)}a` }),
		).toThrow(expect.objectContaining({ code: 'not_found' }));
	});
});

describe('guarded DNS lookup', () => {
	it('configures enforcing connection and socket timeouts', () => {
		expect(enforcedTimeouts({})).toEqual({
			connectionTimeout: 10_000,
			requestTimeout: 30_000,
			throwOnRequestTimeout: true,
		});
		expect(enforcedTimeouts({ connectionTimeoutMs: 5, requestTimeoutMs: 10 })).toEqual({
			connectionTimeout: 5,
			requestTimeout: 10,
			throwOnRequestTimeout: true,
		});
	});

	it('pins the resolver output for single and all-address lookups', async () => {
		const resolver = vi.fn().mockResolvedValue([
			{ address: '192.0.2.1', family: 4 },
			{ address: '2001:db8::1', family: 6 },
		]);
		const lookup = createGuardedLookup(resolver);
		const single = await lookupResult(lookup, 'objects.example.com', {});
		const all = await lookupResult(lookup, 'objects.example.com', { all: true });
		expect(single).toEqual({ address: '192.0.2.1', family: 4 });
		expect(all).toEqual({
			addresses: [
				{ address: '192.0.2.1', family: 4 },
				{ address: '2001:db8::1', family: 6 },
			],
		});
		expect(resolver).toHaveBeenCalledTimes(2);
	});

	it('honors requested address families and IPv4-mapped IPv6 hints', async () => {
		const lookup = createGuardedLookup(async () => [
			{ address: '2001:db8::1', family: 6 },
			{ address: '192.0.2.1', family: 4 },
		]);
		await expect(lookupResult(lookup, 'objects.example.com', { family: 4 })).resolves.toEqual({
			address: '192.0.2.1',
			family: 4,
		});
		await expect(
			lookupResult(lookup, 'objects.example.com', { all: true, family: 6 }),
		).resolves.toEqual({ addresses: [{ address: '2001:db8::1', family: 6 }] });

		const ipv4Only = createGuardedLookup(async () => [{ address: '192.0.2.2', family: 4 }]);
		await expect(lookupResult(ipv4Only, 'objects.example.com', { family: 6 })).rejects.toThrow(
			/did not resolve/,
		);
		await expect(
			lookupResult(ipv4Only, 'objects.example.com', { family: 6, hints: V4MAPPED }),
		).resolves.toEqual({ address: '::ffff:192.0.2.2', family: 6 });
	});

	it('fails closed for empty or rejected resolver output', async () => {
		await expect(
			lookupResult(
				createGuardedLookup(async () => []),
				'empty.example.com',
				{},
			),
		).rejects.toThrow(/did not resolve/);
		await expect(
			lookupResult(
				createGuardedLookup(async () => {
					throw new Error('private address detail');
				}),
				'blocked.example.com',
				{},
			),
		).rejects.toThrow('The object-store hostname is not permitted.');
	});

	it('compares normalized origins and rejects malformed or partial endpoints', () => {
		expect(endpointsMatch(undefined, undefined)).toBe(true);
		expect(endpointsMatch(undefined, 'https://s3.example.com')).toBe(false);
		expect(endpointsMatch('https://s3.example.com/a', 'https://s3.example.com/b')).toBe(true);
		expect(endpointsMatch('https://s3.example.com', 'http://s3.example.com')).toBe(false);
		expect(endpointsMatch('not a url', 'not a url')).toBe(false);
	});
});

describe('body stream conversion', () => {
	it('accepts web, transformed, Node, and async-iterable bodies', async () => {
		const web = byteStream([1, 2]);
		expect(toWebStream(web)).toBe(web);
		await expect(
			readBoundedBody({ transformToWebStream: () => byteStream([3]) }, 1),
		).resolves.toEqual(new Uint8Array([3]));
		await expect(readBoundedBody(Readable.from([Buffer.from([4, 5])]), 2)).resolves.toEqual(
			new Uint8Array([4, 5]),
		);
		await expect(readBoundedBody(iterableBody([6, 7]), 2)).resolves.toEqual(new Uint8Array([6, 7]));
	});

	it('rejects invalid and oversized bodies and cancels the upstream iterator', async () => {
		expect(() => toWebStream({})).toThrow(expect.objectContaining({ code: 'unavailable' }));
		let returned = false;
		const iterable = {
			async *[Symbol.asyncIterator]() {
				try {
					yield new Uint8Array([1, 2]);
					yield new Uint8Array([3]);
				} finally {
					returned = true;
				}
			},
		};
		await expect(readBoundedBody(iterable, 2)).rejects.toMatchObject({ code: 'unsupported' });
		expect(returned).toBe(true);
	});

	it('propagates reader failures', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error('read failed'));
			},
		});
		await expect(readBoundedBody(stream, 10)).rejects.toThrow('read failed');
	});
});

function byteStream(values: number[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(values));
			controller.close();
		},
	});
}

function iterableBody(values: number[]): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) yield new Uint8Array([value]);
		},
	};
}

function lookupResult(
	lookup: ReturnType<typeof createGuardedLookup>,
	hostname: string,
	options: { all?: boolean; family?: number; hints?: number },
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		lookup(hostname, options, (error, address, family) => {
			if (error) reject(error);
			else if (options.all) resolve({ addresses: address });
			else resolve({ address, family });
		});
	});
}
