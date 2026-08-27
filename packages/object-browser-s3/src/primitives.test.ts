import { Readable } from 'node:stream';
import { ALL, V4MAPPED } from 'node:dns';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectBrowseError, UserId, createProjectId } from '@marimo-hub/core';
import {
	assertBucket,
	assertObjectIdentity,
	assertPermittedHost,
	decodeCursor,
	detectRasterImage,
	encodeCursor,
	rasterContentType,
	readBoundedBody,
	toWebStream,
} from '@marimo-hub/object-browser-commons';
import type { ObjectBrowseContext, S3ObjectStoreSource } from '@marimo-hub/core';
import {
	createGuardedLookup,
	createS3ClientFactory,
	endpointsMatch,
	enforcedTimeouts,
	s3ResponseLimit,
} from './client';

function browseContext(): ObjectBrowseContext {
	return {
		project_id: createProjectId(),
		user_id: UserId.parse('user-1'),
		user_email: 'ada@example.com',
		allow_server_ambient: {},
	};
}

function sourceWithEndpoint(endpoint: string): S3ObjectStoreSource {
	return {
		provider: 's3',
		endpoint,
		path_style: true,
		auth: { method: 'static', access_key_id: 'ak', secret_access_key: 'sk' },
	};
}
import { mapS3Error } from './errors';

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
		['TimeoutError', undefined, 'aborted'],
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

	it('keeps an explicit permission status ahead of a conflicting provider name', () => {
		const mapped = mapS3Error(
			Object.assign(new Error('provider detail'), {
				name: 'NoSuchKey',
				$metadata: { httpStatusCode: 403 },
			}),
		);
		expect(mapped).toMatchObject({ code: 'access_denied' });
	});

	it('keeps an explicit permission status ahead of an unsupported provider name', () => {
		const mapped = mapS3Error(
			Object.assign(new Error('provider detail'), {
				name: 'NotImplemented',
				$metadata: { httpStatusCode: 403 },
			}),
		);
		expect(mapped).toMatchObject({ code: 'access_denied' });
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
	let server: Server | undefined;

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	it('sends no authorization header for anonymous sources', async () => {
		let authorization: string | undefined;
		server = createServer((request, response) => {
			authorization = request.headers.authorization;
			response.writeHead(200, { 'content-type': 'application/xml' });
			response.end(
				'<?xml version="1.0" encoding="UTF-8"?>' +
					'<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>',
			);
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('Expected a server port.');
		const factory = createS3ClientFactory({
			resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
		});
		const client = factory(
			{
				provider: 's3',
				endpoint: `http://anonymous.example.test:${address.port}`,
				path_style: true,
				auth: { method: 'anonymous' },
			},
			browseContext(),
		);

		try {
			await client.send(new ListBucketsCommand({}));
			expect(authorization).toBeUndefined();
		} finally {
			client.destroy();
		}
	});

	it('uses separate response caps for list and metadata operations and does not cap HEAD', () => {
		const request = (method: string, query: Record<string, string>) =>
			({ method, query }) as Parameters<typeof s3ResponseLimit>[0];
		expect(s3ResponseLimit(request('GET', { 'list-type': '2' }), 10, 100)).toBe(100);
		expect(s3ResponseLimit(request('GET', { versions: '' }), 10, 100)).toBe(100);
		expect(s3ResponseLimit(request('GET', { 'x-id': 'ListBuckets' }), 10, 100)).toBe(100);
		expect(s3ResponseLimit(request('GET', { tagging: '' }), 10, 100)).toBe(10);
		expect(s3ResponseLimit(request('HEAD', {}), 10, 100)).toBeUndefined();
	});

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

	// The pinned lookup is never consulted for a literal endpoint, so the client
	// has to check it before issuing any command.
	it('refuses commands when the endpoint host fails the address policy', async () => {
		const resolver = vi.fn().mockRejectedValue(new Error('private or reserved address'));
		const factory = createS3ClientFactory({ resolveHost: resolver });
		const client = factory(sourceWithEndpoint('http://169.254.169.254'), browseContext());
		try {
			await expect(client.send({})).rejects.toMatchObject({
				code: 'access_denied',
				message: expect.stringMatching(/endpoint is not permitted/),
			});
			expect(resolver).toHaveBeenCalledWith('169.254.169.254', undefined);
		} finally {
			client.destroy();
		}
	});

	it.each(['AbortError', 'TimeoutError'])(
		'rethrows an endpoint-guard %s as aborted instead of access denied',
		async (name) => {
			const resolver = vi.fn().mockRejectedValue(new DOMException('canceled', name));
			const factory = createS3ClientFactory({ resolveHost: resolver });
			const client = factory(sourceWithEndpoint('http://169.254.169.254'), browseContext());
			try {
				await expect(client.send({})).rejects.toMatchObject({
					code: 'aborted',
					message: 'The request was canceled.',
				});
			} finally {
				client.destroy();
			}
		},
	);

	it('does not consult the address policy for a hostname endpoint', async () => {
		const resolver = vi.fn().mockResolvedValue([{ address: '192.0.2.1', family: 4 }]);
		const factory = createS3ClientFactory({ resolveHost: resolver });
		const client = factory(sourceWithEndpoint('https://objects.example.com'), browseContext());
		client.destroy();
		// Hostnames stay pinned by the lookup hook, so no eager resolution.
		expect(resolver).not.toHaveBeenCalled();
	});

	it('rejects a malformed endpoint', async () => {
		const factory = createS3ClientFactory({ resolveHost: async () => [] });
		const client = factory(sourceWithEndpoint('not a url'), browseContext());
		try {
			await expect(client.send({})).rejects.toMatchObject({ code: 'access_denied' });
		} finally {
			client.destroy();
		}
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
		await expect(
			lookupResult(lookup, 'objects.example.com', {
				all: true,
				family: 6,
				hints: V4MAPPED | ALL,
			}),
		).resolves.toEqual({
			addresses: [
				{ address: '2001:db8::1', family: 6 },
				{ address: '::ffff:192.0.2.1', family: 6 },
			],
		});
	});

	it('passes the operation abort signal to guarded resolution', async () => {
		const signal = new AbortController().signal;
		const resolver = vi.fn().mockResolvedValue([{ address: '192.0.2.1', family: 4 }]);
		const lookup = createGuardedLookup(resolver, signal);
		await lookupResult(lookup, 'objects.example.com', {});
		expect(resolver).toHaveBeenCalledWith('objects.example.com', signal);
	});

	it('preserves cancellation identity while scrubbing resolver failures', async () => {
		const aborted = createGuardedLookup(async () => {
			throw Object.assign(new Error('private abort detail'), { name: 'AbortError' });
		});
		const abortError = await lookupResult(aborted, 'objects.example.com', {}).catch(
			(error: unknown) => error,
		);
		expect(abortError).toMatchObject({
			name: 'AbortError',
			message: 'The object-store hostname resolution was canceled.',
		});
		expect(mapS3Error(abortError)).toMatchObject({ code: 'aborted' });

		const denied = createGuardedLookup(async () => {
			throw Object.assign(new Error('private resolver detail'), { name: 'ResolverFailure' });
		});
		await expect(lookupResult(denied, 'objects.example.com', {})).rejects.toEqual(
			expect.objectContaining({
				name: 'Error',
				message: 'The object-store hostname is not permitted.',
			}),
		);
	});

	it('fails closed for empty or rejected resolver output', async () => {
		await expect(assertPermittedHost('127.0.0.1', async () => [])).rejects.toThrow(
			/did not resolve/,
		);
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
				controller.enqueue(new Uint8Array([1]));
			},
			pull() {
				throw new Error('read failed');
			},
		});
		const reader = stream.getReader();
		const cancel = vi.spyOn(reader, 'cancel');
		vi.spyOn(stream, 'getReader').mockReturnValue(reader);
		await expect(readBoundedBody(stream, 10)).rejects.toThrow('read failed');
		expect(cancel).toHaveBeenCalledOnce();
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
