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
import { objectBrowseContract } from '@marimo-hub/core/testing/object-browse-contract';
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
	allow_server_ambient: false,
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
			const client = setupClient();
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
			await client.send(
				new PutBucketVersioningCommand({
					Bucket: bucket,
					VersioningConfiguration: { Status: 'Enabled' },
				}),
			);
			const directObject = `${prefix}contract.csv`;
			const nestedObject = `${prefix}nested/contract.txt`;
			const versionedObject = `${prefix}versioned.txt`;
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: directObject,
					Body: 'name,value\nfirst,1\nsecond,2\n',
					ContentType: 'text/csv',
				}),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: nestedObject, Body: 'nested contract' }),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: versionedObject, Body: 'version one' }),
			);
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: versionedObject, Body: 'version two' }),
			);
			client.destroy();
			return { bucket, prefix, directObject, nestedObject, versionedObject };
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
