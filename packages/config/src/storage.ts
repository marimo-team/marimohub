import type { Bucket, BucketConfig } from '@marimo-hub/core';
// Narrow import (not the `/testing` barrel) so the server bundle doesn't pull in
// the barrel's vitest-dependent test helpers.
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { S3Storage } from '@marimo-hub/storage-s3';
import { GcsStorage } from '@marimo-hub/storage-gcs';
import { FsStorage } from '@marimo-hub/storage-fs';
import { parseBool, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

function s3Credentials(env: Env) {
	return env.MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID && env.MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY
		? {
				accessKeyId: env.MARIMOHUB_STORAGE_S3_ACCESS_KEY_ID,
				secretAccessKey: env.MARIMOHUB_STORAGE_S3_SECRET_ACCESS_KEY,
			}
		: undefined;
}

export function makeStorage(env: Env): Bucket {
	const backend = env.MARIMOHUB_STORAGE_BACKEND ?? 's3';
	switch (backend) {
		case 's3':
			return new S3Storage({
				bucket: requiredVar(env, 'MARIMOHUB_STORAGE_S3_BUCKET', {
					remediation:
						'Set it to the name of the bucket that backs the hub (e.g. orgname-marimohub).',
					docs: 'docs/configuration.md#storage',
				}),
				endpoint: env.MARIMOHUB_STORAGE_S3_ENDPOINT,
				region: env.MARIMOHUB_STORAGE_S3_REGION,
				credentials: s3Credentials(env),
				forcePathStyle: parseBool(env, 'MARIMOHUB_STORAGE_S3_FORCE_PATH_STYLE'),
			});
		case 'gcs':
			// Google Cloud Storage via its native JSON API (generation-based CAS).
			// Auth: a service-account key JSON (MARIMOHUB_STORAGE_GCS_SA_KEY) minted
			// into access tokens, or a static MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN.
			return new GcsStorage({
				bucket: requiredVar(env, 'MARIMOHUB_STORAGE_GCS_BUCKET', {
					remediation: 'Set it to the name of the GCS bucket that backs the hub.',
					docs: 'docs/configuration.md#storage',
				}),
				apiEndpoint: env.MARIMOHUB_STORAGE_GCS_API_ENDPOINT,
				serviceAccountKey: env.MARIMOHUB_STORAGE_GCS_SA_KEY,
				accessToken: env.MARIMOHUB_STORAGE_GCS_ACCESS_TOKEN,
			});
		case 'fs': {
			const root = requiredVar(env, 'MARIMOHUB_STORAGE_FS_ROOT', {
				remediation:
					'Set it to a writable host directory that will hold all hub state (e.g. /var/lib/marimohub/storage).',
				docs: 'docs/configuration.md#storage',
			});
			try {
				return new FsStorage({ root });
			} catch (err) {
				throw new ConfigError(
					`Could not initialize the filesystem storage root "${root}": ${err instanceof Error ? err.message : String(err)}`,
					{ variable: 'MARIMOHUB_STORAGE_FS_ROOT', docs: 'docs/configuration.md#storage' },
				);
			}
		}
		case 'memory':
			// The in-memory bucket is NON-DURABLE — all state is lost on restart. It
			// exists for local dev and tests only. Refuse it unless the operator
			// explicitly opts in, so it can never back a real deployment by accident
			// (the supported durable backends are `s3` and, in Workers, `r2`).
			if (!parseBool(env, 'MARIMOHUB_ALLOW_EPHEMERAL_STORAGE')) {
				throw new ConfigError(
					'MARIMOHUB_STORAGE_BACKEND=memory is non-durable (all state is lost on restart) and is for ' +
						'local dev/tests only. Set MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true to use it, or choose a ' +
						'durable backend (s3, gcs, fs).',
					{
						variable: 'MARIMOHUB_ALLOW_EPHEMERAL_STORAGE',
						docs: 'docs/configuration.md#storage',
					},
				);
			}
			return new MemoryBucket();
		case 'r2':
			throw new ConfigError(
				'MARIMOHUB_STORAGE_BACKEND=r2 requires a Cloudflare R2 binding; wire it in examples/cloudflare-worker.',
				{ variable: 'MARIMOHUB_STORAGE_BACKEND' },
			);
		default:
			throw new ConfigError(`Unknown MARIMOHUB_STORAGE_BACKEND: ${backend}`, {
				variable: 'MARIMOHUB_STORAGE_BACKEND',
				remediation: 'Supported backends: s3, gcs, fs, memory (dev), r2 (Workers).',
				docs: 'docs/configuration.md#storage',
			});
	}
}

/** The S3 connection info a sandbox uses to read/write notebook files. */
export function makeSandboxBucketConfig(env: Env): BucketConfig {
	return {
		name: env.MARIMOHUB_STORAGE_S3_BUCKET ?? '',
		endpoint: env.MARIMOHUB_STORAGE_S3_ENDPOINT ?? '',
		credentials: s3Credentials(env),
	};
}
