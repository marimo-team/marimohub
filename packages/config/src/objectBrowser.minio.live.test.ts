import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { createFromEnv } from './index';

const endpoint = process.env.MARIMOHUB_TEST_S3_ENDPOINT;
const accessKeyId = process.env.MARIMOHUB_TEST_S3_ACCESS_KEY ?? 'minioadmin';
const secretAccessKey = process.env.MARIMOHUB_TEST_S3_SECRET_KEY ?? 'minioadmin';
const bucket = `marimohub-vertical-${process.pid}-${Date.now()}`;
const key = 'smoke/reports.csv';
const body = 'name,value\nfirst,1\nsecond,2\n';

if (endpoint) {
	describe('MinIO object browser vertical smoke', () => {
		const client = new S3Client({
			endpoint,
			region: 'us-east-1',
			forcePathStyle: true,
			credentials: { accessKeyId, secretAccessKey },
		});
		let bucketCreated = false;

		beforeAll(async () => {
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
			bucketCreated = true;
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: 'text/csv',
				}),
			);
		}, 30_000);

		afterAll(async () => {
			const cleanupErrors: unknown[] = [];
			try {
				if (!bucketCreated) {
					return;
				}

				try {
					await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
				} catch (error) {
					cleanupErrors.push(error);
				}

				try {
					await client.send(new DeleteBucketCommand({ Bucket: bucket }));
				} catch (error) {
					cleanupErrors.push(error);
				}

				if (cleanupErrors.length > 0) {
					throw new AggregateError(cleanupErrors, `Failed to remove MinIO smoke bucket ${bucket}`);
				}
			} finally {
				client.destroy();
			}
		}, 30_000);

		it('wires config through API routes to the production S3 browser', async () => {
			const app = createApi(
				createFromEnv({
					MARIMOHUB_STORAGE_BACKEND: 'memory',
					MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
					MARIMOHUB_COMPUTE_BACKEND: 'none',
					MARIMOHUB_AUTH_BACKEND: 'dev',
					MARIMOHUB_AUTH_DEV_USER_ID: 'minio-smoke',
					MARIMOHUB_AUTH_DEV_EMAIL: 'minio-smoke@example.com',
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_DATA_BROWSER: 'full',
					MARIMOHUB_INTEGRATIONS_PROBE: 'private',
					MARIMOHUB_SECRETS_KEK: '/ECMzY/eM7nlHPPNu+OM2wv0lWiFuHUScSJxNmh64N8=',
				}),
			);
			const request = (method: string, path: string, requestBody?: unknown) =>
				app.request(`/api/v1${path}`, {
					method,
					...(requestBody === undefined
						? {}
						: {
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify(requestBody),
							}),
				});

			const project = await expectOk<{ id: string }>(
				await request('POST', '/projects', { name: 'MinIO smoke', description: '' }),
				201,
			);
			const integration = await expectOk<{ id: string }>(
				await request('POST', `/projects/${project.id}/integrations`, {
					kind: 's3',
					name: 'minio-smoke',
					config: {
						bucket,
						region: 'us-east-1',
						endpoint_url: endpoint,
						path_style: true,
						ambient_env: false,
						auth: {
							method: 'static',
							access_key_id: accessKeyId,
							secret_access_key: secretAccessKey,
						},
					},
				}),
				201,
			);
			const base = `/projects/${project.id}/integrations/${integration.id}/browse`;

			expect(await expectOk(await request('GET', base))).toMatchObject({
				surfaces: { objects: { available: true, preview: true, download: true } },
			});
			const listed = await expectOk<{ items: { kind: string; key: string }[] }>(
				await request(
					'GET',
					`${base}/objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent('smoke/')}`,
				),
			);
			expect(listed.items).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: 'object', key })]),
			);
			expect(
				await expectOk(await request('POST', `${base}/objects/preview`, { bucket, key, limit: 1 })),
			).toMatchObject({ kind: 'tabular', format: 'csv', truncated: true });

			const content = await app.request(
				`/api/v1${base}/objects/content?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`,
				{ headers: { Range: 'bytes=0-3' } },
			);
			expect(content.status).toBe(206);
			expect(content.headers.get('content-range')).toBe(`bytes 0-3/${Buffer.byteLength(body)}`);
			expect(await content.text()).toBe('name');
		}, 30_000);
	});
} else {
	describe.skip('MinIO object browser vertical smoke', () => {
		it('requires MARIMOHUB_TEST_S3_ENDPOINT', () => {});
	});
}

async function expectOk<T>(response: Response, status = 200): Promise<T> {
	expect(response.status).toBe(status);
	const envelope = (await response.json()) as { success: boolean; data: T };
	expect(envelope.success).toBe(true);
	return envelope.data;
}
