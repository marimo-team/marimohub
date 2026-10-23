import { createHash } from 'node:crypto';
import {
	AbortMultipartUploadCommand,
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	ListMultipartUploadsCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { expect, it } from 'vitest';
import { createNotebookId, createProjectId, UserId } from '@marimo-hub/core/ids';
import { makeWorkspaceService } from '@marimo-hub/core/testing/workspace-fixtures';
import { S3Storage } from './index';

const endpoint = process.env.MARIMOHUB_TEST_S3_ENDPOINT;
it.skipIf(!endpoint || !process.env.MARIMOHUB_TEST_LARGE_UPLOAD_BYTES)(
	'resumes and publishes a large workspace upload through S3 multipart',
	async () => {
		const size = Number(process.env.MARIMOHUB_TEST_LARGE_UPLOAD_BYTES);
		const config = {
			bucket: `workspace-upload-${Date.now()}`,
			endpoint,
			region: 'us-east-1',
			forcePathStyle: true,
			credentials: {
				accessKeyId: process.env.MARIMOHUB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
				secretAccessKey: process.env.MARIMOHUB_TEST_S3_SECRET_KEY ?? 'minioadmin',
			},
		};
		const client = new S3Client(config);
		await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
		try {
			const bucket = new S3Storage(config);
			const limits = { maxFileBytes: 2 * 1024 ** 3, maxTotalBytes: size, maxFiles: 1000 };
			let service = makeWorkspaceService(bucket, undefined, limits).service;
			const pid = createProjectId();
			const nid = createNotebookId();
			const actor = UserId.parse('upload-test');
			const upload = await service.startUpload(pid, nid, { path: 'large.bin', size }, actor);
			expect(size).toBeGreaterThan(upload.part_size);
			const expected = createHash('sha256');
			for (let offset = 0, part = 1; offset < size; offset += upload.part_size, part++) {
				const bytes = new Uint8Array(Math.min(upload.part_size, size - offset)).fill(part % 256);
				expected.update(bytes);
				await service.putUploadPart(pid, nid, upload.id, part, bytes, actor);
				if (part === 2) {
					service = makeWorkspaceService(new S3Storage(config), undefined, limits).service;
					expect((await service.getUpload(pid, nid, upload.id, actor)).parts_done).toEqual([1, 2]);
					await service.write(pid, nid, 'large.bin', new Uint8Array([7]), actor);
				}
			}
			expect((await service.read(pid, nid, 'large.bin')).bytes).toEqual(new Uint8Array([7]));
			expect(
				(
					await bucket.list({
						prefix: `projects/${pid}/notebooks/${nid}/uploads/${upload.id}/parts/`,
					})
				).objects,
			).toEqual([]);
			const item = await service.completeUpload(pid, nid, upload.id, actor);
			expect(item.size).toBe(size);
			const object = await client.send(
				new GetObjectCommand({
					Bucket: config.bucket,
					Key: `projects/${pid}/notebooks/${nid}/workspace/large.bin`,
				}),
			);
			const actual = createHash('sha256');
			for await (const chunk of object.Body as AsyncIterable<Uint8Array>) actual.update(chunk);
			expect(actual.digest('hex')).toBe(expected.digest('hex'));
			const second = await service.startUpload(pid, nid, { path: 'exceeds.bin', size: 1 }, actor);
			await service.putUploadPart(pid, nid, second.id, 1, new Uint8Array([1]), actor);
			await expect(service.completeUpload(pid, nid, second.id, actor)).rejects.toThrow(
				`exceeds ${size} bytes`,
			);
			await service.cancelUpload(pid, nid, second.id, actor);
		} finally {
			let keyMarker: string | undefined;
			let uploadIdMarker: string | undefined;
			do {
				const page = await client.send(
					new ListMultipartUploadsCommand({
						Bucket: config.bucket,
						KeyMarker: keyMarker,
						UploadIdMarker: uploadIdMarker,
					}),
				);
				for (const upload of page.Uploads ?? []) {
					await client.send(
						new AbortMultipartUploadCommand({
							Bucket: config.bucket,
							Key: upload.Key,
							UploadId: upload.UploadId,
						}),
					);
				}
				keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
				uploadIdMarker = page.NextUploadIdMarker;
			} while (keyMarker);
			let token: string | undefined;
			do {
				const page = await client.send(
					new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: token }),
				);
				if (page.Contents?.length)
					await client.send(
						new DeleteObjectsCommand({
							Bucket: config.bucket,
							Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
						}),
					);
				token = page.NextContinuationToken;
			} while (token);
			await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
			client.destroy();
		}
	},
	600_000,
);
