import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { ObjectBrowseContext, ObjectIdentity, S3ObjectStoreSource } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
export { withOperationDeadline } from '@marimo-hub/object-browser-commons';
import type { S3ClientFactory, S3ClientLike } from './client';
import { mapS3Error } from './errors';
import { readBoundedBody } from './streams';

interface GetOutput {
	Body?: unknown;
}

export async function sendS3<T>(
	client: S3ClientLike,
	command: unknown,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return (await client.send(command, { abortSignal: signal })) as T;
	} catch (error) {
		throw mapS3Error(error);
	}
}

export async function withS3Client<T>(
	clientFactory: S3ClientFactory,
	source: S3ObjectStoreSource,
	context: ObjectBrowseContext,
	run: (client: S3ClientLike) => Promise<T>,
): Promise<T> {
	let client: S3ClientLike;
	try {
		client = clientFactory(source, context);
	} catch (error) {
		throw mapS3Error(error);
	}
	try {
		return await run(client);
	} finally {
		client.destroy();
	}
}

export function releaseClientOnce(client: S3ClientLike): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		client.destroy();
	};
}

export async function readObjectRange(
	client: S3ClientLike,
	request: ObjectIdentity,
	start: number,
	end: number,
	options: { etag?: string; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
		throw new ObjectBrowseError('range_not_satisfiable', 'The requested byte range is invalid.');
	}
	const output = await sendS3<GetOutput>(
		client,
		new GetObjectCommand({
			Bucket: request.bucket,
			Key: request.key,
			VersionId: request.version_id,
			IfMatch: request.version_id ? undefined : options.etag,
			Range: `bytes=${start}-${end - 1}`,
		}),
		options.signal,
	);
	if (!output.Body) throw new ObjectBrowseError('unavailable', 'The object body was empty.');
	try {
		return await readBoundedBody(output.Body, end - start);
	} catch (error) {
		throw mapS3Error(error);
	}
}
