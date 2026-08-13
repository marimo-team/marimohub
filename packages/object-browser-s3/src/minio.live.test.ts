import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectsCommand,
	ListObjectVersionsCommand,
	PutBucketVersioningCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { describe, it } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import {
	OBJECT_BROWSE_CONTRACT_SEED,
	objectBrowseContract,
} from '@marimo-hub/core/testing/object-browse-contract';
import { S3ObjectBrowser } from './index';

const endpoint = process.env.MARIMOHUB_TEST_S3_ENDPOINT;
const accessKeyId = process.env.MARIMOHUB_TEST_S3_ACCESS_KEY ?? 'minioadmin';
const secretAccessKey = process.env.MARIMOHUB_TEST_S3_SECRET_KEY ?? 'minioadmin';
const bucket = `marimohub-object-browser-${process.pid}`;
const prefix = `contract-${Date.now()}/`;
const credentials = { accessKeyId, secretAccessKey };
const source = {
	provider: 's3' as const,
	configured_bucket: bucket,
	region: 'us-east-1',
	endpoint,
	path_style: true,
	auth: {
		method: 'static' as const,
		access_key_id: accessKeyId,
		secret_access_key: secretAccessKey,
	},
};
const context = {
	project_id: createProjectId(),
	user_id: UserId.parse('object-contract'),
	user_email: 'object-contract@example.com',
	allow_server_ambient: {},
};

if (endpoint)
	objectBrowseContract('S3-compatible MinIO', () => ({
		browser: new S3ObjectBrowser({
			mode: 'full',
			resolveHost: async (hostname) => {
				if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
					throw new Error('unexpected live-test hostname');
				}
				return [{ address: '127.0.0.1', family: 4 }];
			},
		}),
		source,
		context,
		async setup() {
			const seed = OBJECT_BROWSE_CONTRACT_SEED;
			const client = setupClient();
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
			await client.send(
				new PutBucketVersioningCommand({
					Bucket: bucket,
					VersioningConfiguration: { Status: 'Enabled' },
				}),
			);
			const directObject = `${prefix}${seed.direct.path}`;
			const nestedObject = `${prefix}${seed.nested.path}`;
			const unicodeObject = `${prefix}${seed.unicode.path}`;
			const emptyObject = `${prefix}${seed.empty.path}`;
			const parquetObject = `${prefix}${seed.parquet.path}`;
			const versionedObject = `${prefix}${seed.versioned.path}`;
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: directObject,
					Body: seed.direct.body,
					ContentType: seed.direct.contentType,
				}),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: nestedObject, Body: seed.nested.body }),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: unicodeObject, Body: seed.unicode.body }),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: emptyObject, Body: seed.empty.body }),
			);
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: parquetObject,
					Body: seed.parquet.body,
					ContentType: seed.parquet.contentType,
				}),
			);
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: versionedObject,
					Body: seed.versioned.firstBody,
				}),
			);
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: versionedObject,
					Body: seed.versioned.secondBody,
				}),
			);
			client.destroy();
			return {
				bucket,
				prefix,
				directObject,
				nestedObject,
				unicodeObject,
				emptyObject,
				parquetObject,
				versionedObject,
			};
		},
		async teardown() {
			const client = setupClient();
			const listed = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
			const objects = [
				...(listed.Versions ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
				...(listed.DeleteMarkers ?? []).map((item) => ({
					Key: item.Key,
					VersionId: item.VersionId,
				})),
			].filter((item): item is { Key: string; VersionId: string } =>
				Boolean(item.Key && item.VersionId),
			);
			if (objects.length > 0) {
				await client.send(
					new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
				);
			}
			await client.send(new DeleteBucketCommand({ Bucket: bucket }));
			client.destroy();
		},
	}));
else {
	describe.skip('Object browse contract: S3-compatible MinIO', () => {
		it('requires MARIMOHUB_TEST_S3_ENDPOINT', () => {});
	});
}

function setupClient(): S3Client {
	return new S3Client({
		endpoint,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials,
	});
}
