import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectBrowseContext, ObjectStoreSource } from '@marimo-hub/core';
import type { S3ClientLike } from './client';
import {
	readObjectRange,
	releaseClientOnce,
	sendS3,
	withOperationDeadline,
	withS3Client,
} from './s3Request';

const source = {} as ObjectStoreSource;
const context = {} as ObjectBrowseContext;

describe('S3 request utilities', () => {
	it('passes the abort signal and maps rejected provider requests', async () => {
		const signal = new AbortController().signal;
		const client = mockClient();
		client.send.mockResolvedValue({ value: true });
		await expect(sendS3(client, { command: true }, signal)).resolves.toEqual({ value: true });
		expect(client.send).toHaveBeenCalledWith({ command: true }, { abortSignal: signal });

		client.send.mockRejectedValueOnce(Object.assign(new Error('raw'), { name: 'NoSuchKey' }));
		await expect(sendS3(client, {})).rejects.toMatchObject({ code: 'not_found' });
	});

	it('destroys scoped clients after success and failure', async () => {
		const success = mockClient();
		await expect(
			withS3Client(
				() => success,
				source,
				context,
				async () => 'done',
			),
		).resolves.toBe('done');
		expect(success.destroy).toHaveBeenCalledOnce();

		const failure = mockClient();
		await expect(
			withS3Client(
				() => failure,
				source,
				context,
				async () => {
					throw new Error('failed');
				},
			),
		).rejects.toMatchObject({
			code: 'unavailable',
			message: 'The object-store request failed.',
		});
		expect(failure.destroy).toHaveBeenCalledOnce();
	});

	it('maps client construction failures without attempting cleanup', async () => {
		await expect(
			withS3Client(
				() => {
					throw Object.assign(new Error('private credential detail'), { name: 'AccessDenied' });
				},
				source,
				context,
				async () => 'unreachable',
			),
		).rejects.toMatchObject({ code: 'access_denied' });
	});

	it('releases a client at most once', () => {
		const client = mockClient();
		const release = releaseClientOnce(client);
		release();
		release();
		expect(client.destroy).toHaveBeenCalledOnce();
	});

	it('propagates caller cancellation through an operation deadline', async () => {
		const parent = new AbortController();
		const operation = withOperationDeadline(
			{ ...context, signal: parent.signal },
			1_000,
			(scoped) =>
				new Promise<boolean>((resolve) => {
					scoped.signal?.addEventListener('abort', () => resolve(scoped.signal!.aborted), {
						once: true,
					});
				}),
		);
		parent.abort();
		await expect(operation).resolves.toBe(true);
	});

	it.each([
		[-1, 1],
		[1, 1],
		[2, 1],
		[0.5, 1],
		[0, Number.MAX_SAFE_INTEGER + 1],
	])('rejects an invalid half-open range %s:%s before sending', async (start, end) => {
		const client = mockClient();
		await expect(
			readObjectRange(client, { bucket: 'lake', key: 'a' }, start, end),
		).rejects.toMatchObject({ code: 'range_not_satisfiable' });
		expect(client.send).not.toHaveBeenCalled();
	});

	it('sends a bounded inclusive S3 range with ETag protection for current objects', async () => {
		const client = mockClient();
		client.send.mockResolvedValue({ Body: byteStream([1, 2, 3]) });
		await expect(
			readObjectRange(client, { bucket: 'lake', key: 'a' }, 4, 7, { etag: 'etag' }),
		).resolves.toEqual(new Uint8Array([1, 2, 3]));
		const command = client.send.mock.calls[0]?.[0];
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect((command as GetObjectCommand).input).toMatchObject({
			Bucket: 'lake',
			Key: 'a',
			Range: 'bytes=4-6',
			IfMatch: 'etag',
		});
	});

	it('uses version pinning instead of If-Match and rejects missing or oversized bodies', async () => {
		const missing = mockClient();
		missing.send.mockResolvedValue({});
		await expect(
			readObjectRange(missing, { bucket: 'lake', key: 'a', version_id: 'v1' }, 0, 1, {
				etag: 'ignored',
			}),
		).rejects.toMatchObject({ code: 'unavailable' });
		const command = missing.send.mock.calls[0]?.[0] as GetObjectCommand;
		expect(command.input).toMatchObject({ VersionId: 'v1' });
		expect(command.input.IfMatch).toBeUndefined();

		const oversized = mockClient();
		oversized.send.mockResolvedValue({ Body: byteStream([1, 2]) });
		await expect(
			readObjectRange(oversized, { bucket: 'lake', key: 'a' }, 0, 1),
		).rejects.toMatchObject({ code: 'unsupported' });
	});

	it.each([
		['AbortError', 'aborted'],
		['AccessDenied', 'access_denied'],
		['InternalError', 'unavailable'],
	] as const)('maps %s failures raised while reading a response body', async (name, code) => {
		const client = mockClient();
		client.send.mockResolvedValue({ Body: failingBody(name) });
		await expect(readObjectRange(client, { bucket: 'lake', key: 'a' }, 0, 1)).rejects.toMatchObject(
			{ code },
		);
	});
});

function mockClient() {
	return {
		send: vi.fn(),
		destroy: vi.fn(),
	} satisfies S3ClientLike;
}

function byteStream(values: number[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(values));
			controller.close();
		},
	});
}

function failingBody(name: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.error(Object.assign(new Error('raw provider detail'), { name }));
		},
	});
}
