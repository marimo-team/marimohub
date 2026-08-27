import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { AzureStorage } from '@marimo-hub/storage-azure';
import { S3Storage } from '@marimo-hub/storage-s3';
import { GcsStorage } from '@marimo-hub/storage-gcs';
import { FsStorage } from '@marimo-hub/storage-fs';
import {
	DEFAULT_STORAGE_BACKEND,
	makeStorage,
	makeSandboxBucketConfig,
	storageBackend,
} from './storage';
import { ConfigError } from './errors';
import { CONFIG_SPEC } from './spec';

describe('makeStorage backend selection', () => {
	it('defaults to s3 and requires the bucket name', () => {
		expect(() => makeStorage({})).toThrow(/MARIMOHUB_STORAGE_S3_BUCKET/);
	});

	it('derives the runtime default from the config registry', () => {
		const configuredDefault = CONFIG_SPEC.find(
			(group) => group.selector === 'MARIMOHUB_STORAGE_BACKEND',
		)?.selectorDefault;

		expect(DEFAULT_STORAGE_BACKEND).toBe(configuredDefault);
		expect(storageBackend({})).toBe(configuredDefault);
	});

	it('builds an S3Storage when the bucket is set', () => {
		expect(makeStorage({ MARIMOHUB_STORAGE_S3_BUCKET: 'b' })).toBeInstanceOf(S3Storage);
	});

	it('folds and trims the s3 backend selector', () => {
		expect(
			makeStorage({ MARIMOHUB_STORAGE_BACKEND: ' S3 ', MARIMOHUB_STORAGE_S3_BUCKET: 'b' }),
		).toBeInstanceOf(S3Storage);
	});

	it('treats an empty backend as the s3 default', () => {
		expect(
			makeStorage({ MARIMOHUB_STORAGE_BACKEND: '', MARIMOHUB_STORAGE_S3_BUCKET: 'b' }),
		).toBeInstanceOf(S3Storage);
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

	it('builds an AzureStorage with an account URL', () => {
		expect(
			makeStorage({
				MARIMOHUB_STORAGE_BACKEND: 'azure',
				MARIMOHUB_STORAGE_AZURE_CONTAINER: 'hub',
				MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL: 'https://account.blob.core.windows.net',
			}),
		).toBeInstanceOf(AzureStorage);
	});

	it('rejects both Azure authentication modes together', () => {
		expect(() =>
			makeStorage({
				MARIMOHUB_STORAGE_BACKEND: 'azure',
				MARIMOHUB_STORAGE_AZURE_CONTAINER: 'hub',
				MARIMOHUB_STORAGE_AZURE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
				MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL: 'not a URL',
			}),
		).toThrow(/mutually exclusive/);
	});

	it('requires the Azure container and an account URL when no connection string is set', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'azure' })).toThrow(
			/MARIMOHUB_STORAGE_AZURE_CONTAINER/,
		);
		expect(() =>
			makeStorage({
				MARIMOHUB_STORAGE_BACKEND: 'azure',
				MARIMOHUB_STORAGE_AZURE_CONTAINER: 'hub',
			}),
		).toThrow(/MARIMOHUB_STORAGE_AZURE_ACCOUNT_URL/);
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

	it('rejects an unknown backend and lists the accepted values', () => {
		expect(() => makeStorage({ MARIMOHUB_STORAGE_BACKEND: 'sqlite' })).toThrow(
			/Invalid MARIMOHUB_STORAGE_BACKEND: sqlite \(expected s3, gcs, azure, fs, memory, library, r2\)/,
		);
	});

	// A partially-configured static credential (key id without the matching secret)
	// is an operator mistake: it should fail closed like the secrets-aws all-or-
	// nothing check, not silently drop the credential and fall back to the ambient
	// AWS provider chain (a different, possibly unintended identity).
	it('rejects partial S3 static credentials (key id without secret)', () => {
		expect(() =>
			makeStorage({
				MARIMOHUB_STORAGE_S3_BUCKET: 'b',
				MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID: 'akid',
			}),
		).toThrow();
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
