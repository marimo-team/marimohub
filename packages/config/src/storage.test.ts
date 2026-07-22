import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { S3Storage } from '@marimo-hub/storage-s3';
import { GcsStorage } from '@marimo-hub/storage-gcs';
import { FsStorage } from '@marimo-hub/storage-fs';
import { makeStorage, makeSandboxBucketConfig } from './storage';
import { ConfigError } from './errors';

describe('makeStorage backend selection', () => {
	it('defaults to s3 and requires the bucket name', () => {
		expect(() => makeStorage({})).toThrow(/MARIMOHUB_STORAGE_S3_BUCKET/);
	});

	it('builds an S3Storage when the bucket is set', () => {
		expect(makeStorage({ MARIMOHUB_STORAGE_S3_BUCKET: 'b' })).toBeInstanceOf(S3Storage);
	});

	it('builds a GcsStorage for the gcs backend', () => {
		expect(
			makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'gcs', MARIMOHUB_STORAGE_GCS_BUCKET: 'b' }),
		).toBeInstanceOf(GcsStorage);
	});

	it('requires the gcs bucket name', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'gcs' })).toThrow(
			/MARIMOHUB_STORAGE_GCS_BUCKET/,
		);
	});

	const tmpRoots: string[] = [];
	afterAll(() => {
		for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
	});
	const tmpRoot = () => {
		const root = mkdtempSync(path.join(os.tmpdir(), 'marimohub-fs-config-'));
		tmpRoots.push(root);
		return root;
	};

	it('builds an FsStorage for the fs backend without an ephemeral gate', () => {
		expect(
			makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'fs', MARIMOHUB_STORAGE_FS_ROOT: tmpRoot() }),
		).toBeInstanceOf(FsStorage);
	});

	it('requires the fs root', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'fs' })).toThrow(
			/MARIMOHUB_STORAGE_FS_ROOT/,
		);
	});

	it('wraps an unusable fs root in a ConfigError', () => {
		const file = path.join(tmpRoot(), 'a-file');
		writeFileSync(file, '');
		expect(() =>
			makeStorage({
				MARIMOHUB_STORAGE_BACKEND: 'fs',
				MARIMOHUB_STORAGE_FS_ROOT: path.join(file, 'nested'),
			}),
		).toThrow(/filesystem storage root/);
	});

	it('refuses the non-durable memory backend unless explicitly allowed', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'memory' })).toThrow(
			/MARIMOHUB_ALLOW_EPHEMERAL_STORAGE/,
		);
	});

	it('allows memory when MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true', () => {
		expect(
			makeStorage({
				MARIMOHUB_STORAGE_BACKEND: 'memory',
				MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			}),
		).toBeInstanceOf(MemoryBucket);
	});

	it('throws for the r2 backend (needs a Workers binding)', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'r2' })).toThrow(ConfigError);
	});

	it('throws on an unknown backend', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'bogus' })).toThrow(
			/Unknown MARIMOHUB_STORAGE_BACKEND/,
		);
	});
});

describe('makeSandboxBucketConfig', () => {
	it('reflects the S3 name and endpoint, defaulting both to empty', () => {
		expect(makeSandboxBucketConfig({})).toEqual({
			name: '',
			endpoint: '',
			credentials: undefined,
		});
	});

	it('includes credentials only when both key id and secret are present', () => {
		const withCreds = makeSandboxBucketConfig({
			MARIMOHUB_STORAGE_S3_BUCKET: 'b',
			MARIMOHUB_STORAGE_S3_ENDPOINT: 'https://s3.example',
			MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID: 'akid',
			MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
		});
		expect(withCreds).toEqual({
			name: 'b',
			endpoint: 'https://s3.example',
			credentials: { accessKeyId: 'akid', secretAccessKey: 'secret' },
		});
	});

	it('omits credentials when only the key id is set', () => {
		expect(
			makeSandboxBucketConfig({ MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID: 'akid' }).credentials,
		).toBeUndefined();
	});
});
