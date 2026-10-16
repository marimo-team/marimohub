import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from './index';

const config = {
	bucket: 'test-bucket',
	region: 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
	requestTimeoutMs: 500,
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('S3 request deadlines', () => {
	it.each(['get', 'head', 'put', 'delete', 'batchDelete', 'list'] as const)(
		'aborts a stalled %s request and allows a later request',
		async (operation) => {
			vi.useFakeTimers();
			const send = vi
				.spyOn(S3Client.prototype, 'send')
				.mockImplementation(() => new Promise(() => {}));
			const bucket = new S3Storage(config);
			const operations = {
				get: () => bucket.get('key'),
				head: () => bucket.head('key'),
				put: () => bucket.put('key', 'value'),
				delete: () => bucket.delete('key'),
				batchDelete: () => bucket.delete(['key']),
				list: () => bucket.list(),
			};
			const rejected = expect(operations[operation]()).rejects.toMatchObject({
				name: 'TimeoutError',
			});
			await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
			await rejected;
			const options = send.mock.calls[0][1] as { abortSignal: AbortSignal };
			expect(options.abortSignal.aborted).toBe(true);
			send.mockImplementation(async () => ({}));
			await expect(bucket.head('key')).resolves.toMatchObject({ key: 'key' });
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('keeps the deadline active while consuming the body', async () => {
		vi.useFakeTimers();
		vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
			Body: { transformToByteArray: () => new Promise(() => {}) },
		}));
		const rejected = expect(new S3Storage(config).get('key')).rejects.toMatchObject({
			name: 'TimeoutError',
		});
		await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
		await rejected;
	});

	it('destroys a body returned after the request deadline', async () => {
		vi.useFakeTimers();
		const response = Promise.withResolvers<object>();
		vi.spyOn(S3Client.prototype, 'send').mockImplementation(() => response.promise);
		const rejected = expect(new S3Storage(config).get('key')).rejects.toMatchObject({
			name: 'TimeoutError',
		});
		await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
		await rejected;
		const stream = new PassThrough();
		const consumed = new Promise<Uint8Array>((_resolve, reject) => stream.once('error', reject));
		const settled = expect(consumed).rejects.toMatchObject({ name: 'TimeoutError' });
		response.resolve({
			Body: Object.assign(stream, { transformToByteArray: () => consumed }),
		});
		await settled;
		expect(stream.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['transport', 'body'] as const)(
		'preserves %s failures and clears the deadline',
		async (phase) => {
			vi.useFakeTimers();
			const failure = new Error('connection reset');
			const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
				if (phase === 'transport') throw failure;
				return {
					Body: {
						transformToByteArray: async () => {
							throw failure;
						},
					},
				};
			});
			await expect(new S3Storage(config).get('key')).rejects.toBe(failure);
			const options = send.mock.calls[0][1] as { abortSignal: AbortSignal };
			await vi.advanceTimersByTimeAsync(config.requestTimeoutMs * 2);
			expect(options.abortSignal.aborted).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(['resolve', 'reject'] as const)(
		'ignores a late %s after timeout without affecting the next request',
		async (outcome) => {
			vi.useFakeTimers();
			const old = Promise.withResolvers<object>();
			const next = Promise.withResolvers<object>();
			const send = vi
				.spyOn(S3Client.prototype, 'send')
				.mockImplementationOnce(() => old.promise)
				.mockImplementationOnce(() => next.promise);
			const bucket = new S3Storage(config);
			const first = expect(bucket.head('old')).rejects.toMatchObject({ name: 'TimeoutError' });
			await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
			await first;
			const pending = bucket.head('next');
			await vi.advanceTimersByTimeAsync(0);
			if (outcome === 'resolve') old.resolve({});
			else old.reject(new Error('late rejection'));
			await vi.advanceTimersByTimeAsync(0);
			const options = send.mock.calls[1][1] as { abortSignal: AbortSignal };
			expect(options.abortSignal.aborted).toBe(false);
			next.resolve({});
			await expect(pending).resolves.toMatchObject({ key: 'next' });
			await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
			expect(options.abortSignal.aborted).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it('gives each delete batch a separate budget and stops after a timed-out batch', async () => {
		vi.useFakeTimers();
		const send = vi
			.spyOn(S3Client.prototype, 'send')
			.mockImplementation(() => new Promise(() => {}))
			.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({}), 400)))
			.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({}), 400)));
		const keys = Array.from({ length: 3001 }, (_, index) => `key-${index}`);
		const rejected = expect(new S3Storage(config).delete(keys)).rejects.toMatchObject({
			name: 'TimeoutError',
		});
		await vi.advanceTimersByTimeAsync(800);
		expect(send).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
		await rejected;
		expect(send).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])('closes the transport when stalled after headers=%s', async (headers) => {
		const disconnected = Promise.withResolvers<void>();
		const server = createServer((request, response) => {
			request.socket.once('close', () => disconnected.resolve());
			if (headers) {
				response.writeHead(200, { 'Content-Length': '100' });
				response.write('x');
			}
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing server address');
		try {
			const bucket = new S3Storage({ ...config, endpoint: `http://127.0.0.1:${address.port}` });
			await expect(bucket.get('key')).rejects.toMatchObject({ name: 'TimeoutError' });
			await disconnected.promise;
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('settles checksum body consumers when repeated reads time out', async () => {
		const consumers: Promise<Uint8Array>[] = [];
		const send = S3Client.prototype.send;
		vi.spyOn(S3Client.prototype, 'send').mockImplementation(async function (
			this: S3Client,
			...args
		) {
			const output = (await Reflect.apply(send, this, args)) as GetObjectCommandOutput;
			if (output.Body) {
				const transform = output.Body.transformToByteArray.bind(output.Body);
				output.Body.transformToByteArray = () => {
					const pending = transform();
					consumers.push(pending);
					return pending;
				};
			}
			return output;
		});
		const server = createServer((_request, response) => {
			response.writeHead(200, {
				'Content-Length': '100',
				'x-amz-checksum-crc32': 'AAAAAA==',
			});
			response.write('x');
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing server address');
		try {
			const bucket = new S3Storage({ ...config, endpoint: `http://127.0.0.1:${address.port}` });
			for (let attempt = 0; attempt < 3; attempt++) {
				await expect(bucket.get('key')).rejects.toMatchObject({ name: 'TimeoutError' });
				await expect(consumers[attempt]).rejects.toMatchObject({ name: 'TimeoutError' });
			}
			expect(consumers).toHaveLength(3);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it.each([0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648])(
		'rejects invalid timeout %s',
		(requestTimeoutMs) => {
			expect(() => new S3Storage({ ...config, requestTimeoutMs })).toThrow(RangeError);
		},
	);
});
