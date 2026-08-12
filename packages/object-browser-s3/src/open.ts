import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type {
	ObjectBody,
	ObjectBrowseContext,
	ObjectOpenRequest,
	ObjectStoreSource,
} from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import type { S3ObjectBrowserLimits } from './index';
import type { S3ClientFactory } from './client';
import { mapS3Error } from './errors';
import { detectRasterImage, rasterContentType } from './formats';
import { readObjectRange, releaseClientOnce, sendS3 } from './s3Request';
import { toWebStream } from './streams';

interface GetOutput {
	Body?: unknown;
	ContentLength?: number;
	ContentRange?: string;
	ContentType?: string;
	ETag?: string;
	VersionId?: string;
}

export async function openS3Object(
	clientFactory: S3ClientFactory,
	limits: S3ObjectBrowserLimits,
	source: ObjectStoreSource,
	context: ObjectBrowseContext,
	request: ObjectOpenRequest,
): Promise<ObjectBody> {
	const client = clientFactory(source, context);
	const release = releaseClientOnce(client);
	try {
		let verifiedType: string | undefined;
		let ifMatch = request.if_match;
		if (request.inline) {
			const head = await sendS3<{ ContentLength?: number; ETag?: string }>(
				client,
				new HeadObjectCommand({
					Bucket: request.bucket,
					Key: request.key,
					VersionId: request.version_id,
				}),
				context.signal,
			);
			const size = head.ContentLength ?? 0;
			if (size === 0) {
				throw new ObjectBrowseError('unsupported', 'An empty object is not a raster image.');
			}
			if (size > limits.inlineImageMaxBytes) {
				throw new ObjectBrowseError('unsupported', 'The image exceeds the inline preview limit.');
			}
			ifMatch ??= request.version_id ? undefined : head.ETag;
			const probe = await readObjectRange(client, request, 0, Math.min(size, 16), {
				etag: ifMatch,
				signal: context.signal,
			});
			const imageFormat = detectRasterImage(probe);
			if (!imageFormat) {
				throw new ObjectBrowseError('unsupported', 'Only safe raster images can be shown inline.');
			}
			verifiedType = rasterContentType(imageFormat);
		}
		const output = await sendS3<GetOutput>(
			client,
			new GetObjectCommand({
				Bucket: request.bucket,
				Key: request.key,
				VersionId: request.version_id,
				IfMatch: ifMatch,
				Range: request.inline ? undefined : request.range,
			}),
			context.signal,
		);
		if (!output.Body) throw new ObjectBrowseError('unavailable', 'The object body was empty.');
		const upstream = toWebStream(output.Body).getReader();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await upstream.read();
					if (next.done) {
						controller.close();
						release();
					} else {
						controller.enqueue(next.value);
					}
				} catch (error) {
					controller.error(error);
					release();
				}
			},
			async cancel(reason) {
				try {
					await upstream.cancel(reason);
				} finally {
					release();
				}
			},
		});
		const total = totalSize(output.ContentRange, output.ContentLength ?? 0);
		return {
			body,
			status: output.ContentRange ? 206 : 200,
			content_type: verifiedType ?? output.ContentType ?? 'application/octet-stream',
			content_length: output.ContentLength ?? 0,
			total_size: total,
			content_range: output.ContentRange,
			etag: output.ETag,
			version_id: output.VersionId ?? request.version_id,
			close: release,
		};
	} catch (error) {
		release();
		throw mapS3Error(error);
	}
}

function totalSize(contentRange: string | undefined, contentLength: number): number {
	if (!contentRange) return contentLength;
	const match = /\/(\d+)$/.exec(contentRange);
	return match ? Number(match[1]) : contentLength;
}
