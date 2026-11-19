import type { Bucket } from '@marimo-hub/core/ports/bucket';
import { bucketStorage } from '@marimo-hub/core/ports/metadata';
import type {
	HubStorage,
	IndexedSessionRecords,
	MetadataStore,
} from '@marimo-hub/core/ports/metadata';
import {
	assertBucketMetadataBackend,
	readMetadataBackendMarker,
} from '@marimo-hub/core/storage/backend-marker';
import { createLogicalStorage } from '@marimo-hub/core/storage/logical-bucket';
import { ConfigError } from './errors';
import type { Env } from './env';
import { parseEnumOr, requiredVar } from './env';

export interface MetadataRuntime extends MetadataStore {
	sessions: IndexedSessionRecords;
	ready(): Promise<void>;
	close(): Promise<void>;
}
export interface MetadataPostgresSettings {
	url: string;
	namespace: string;
	poolMax: number;
	connectTimeoutMs: number;
	statementTimeoutMs: number;
	lockTimeoutMs: number;
}
export type MetadataFactory = (
	settings: MetadataPostgresSettings & { epoch: number; artifactStoreId: string },
) => MetadataRuntime;
export interface ResolvedHubStorage extends HubStorage {
	ready(): Promise<void>;
	close(): Promise<void>;
}

export function makeHubStorage(
	raw: Bucket,
	env: Env,
	factory?: MetadataFactory,
): ResolvedHubStorage {
	const backend = parseEnumOr(env, 'MARIMOHUB_METADATA_BACKEND', ['bucket', 'postgres'], 'bucket');
	if (backend === 'bucket') {
		if (
			Object.entries(env).some(
				([key, value]) =>
					value !== undefined &&
					(key.startsWith('MARIMOHUB_METADATA_POSTGRES_') ||
						key === 'MARIMOHUB_METADATA_NAMESPACE'),
			)
		)
			throw new ConfigError(
				'PostgreSQL metadata settings require MARIMOHUB_METADATA_BACKEND=postgres',
			);
		return {
			...bucketStorage(raw),
			ready: () => assertBucketMetadataBackend(raw),
			close: async () => {},
		};
	}
	const namespace = requiredVar(env, 'MARIMOHUB_METADATA_NAMESPACE', {});
	if (
		new TextEncoder().encode(namespace).length > 128 ||
		namespace.includes('\0') ||
		new TextDecoder().decode(new TextEncoder().encode(namespace)) !== namespace
	)
		throw new ConfigError('Metadata namespace must contain 1–128 UTF-8 bytes');
	const number = (variable: string, fallback: number) => {
		const value = env[variable] === undefined ? fallback : Number(env[variable]);
		if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
			throw new ConfigError(`${variable} must be a positive finite integer`, { variable });
		return value;
	};
	const settings: MetadataPostgresSettings = {
		url: requiredVar(env, 'MARIMOHUB_METADATA_POSTGRES_URL', {}),
		namespace,
		poolMax: number('MARIMOHUB_METADATA_POSTGRES_POOL_MAX', 10),
		connectTimeoutMs: number('MARIMOHUB_METADATA_POSTGRES_CONNECT_TIMEOUT_MS', 5000),
		statementTimeoutMs: number('MARIMOHUB_METADATA_POSTGRES_STATEMENT_TIMEOUT_MS', 10000),
		lockTimeoutMs: number('MARIMOHUB_METADATA_POSTGRES_LOCK_TIMEOUT_MS', 2000),
	};
	if (settings.lockTimeoutMs > settings.statementTimeoutMs)
		throw new ConfigError('Metadata lock timeout must not exceed statement timeout');
	if (!factory)
		throw new ConfigError(
			'PostgreSQL metadata requires the Node metadata factory; this host does not support it',
		);
	let target: HubStorage | undefined;
	let runtime: MetadataRuntime | undefined;
	let pending: Promise<void> | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;
	const requireTarget = () => {
		if (!target || closed) throw new Error('Metadata storage is not ready');
		return target;
	};
	const lazy = (which: 'logicalBucket' | 'artifacts'): Bucket => ({
		get: ((key, options) => requireTarget()[which].get(key, options)) as Bucket['get'],
		head: (key) => requireTarget()[which].head(key),
		put: (key, value, options) => requireTarget()[which].put(key, value, options),
		delete: (keys) => requireTarget()[which].delete(keys),
		list: (options) => requireTarget()[which].list(options),
		...(raw.putStream
			? {
					putStream: ((key, chunks, size, options) =>
						requireTarget()[which].putStream!(key, chunks, size, options)) as NonNullable<
						Bucket['putStream']
					>,
				}
			: {}),
		...(raw.multipart
			? {
					multipart: {
						isolatedSessions: raw.multipart.isolatedSessions,
						create: (key, options) => requireTarget()[which].multipart!.create(key, options),
						putPart: (key, uploadId, part, bytes) =>
							requireTarget()[which].multipart!.putPart(key, uploadId, part, bytes),
						complete: (key, uploadId, parts) =>
							requireTarget()[which].multipart!.complete(key, uploadId, parts),
						abort: (key, uploadId) => requireTarget()[which].multipart!.abort(key, uploadId),
					} satisfies NonNullable<Bucket['multipart']>,
				}
			: {}),
	});
	const logicalBucket = lazy('logicalBucket');
	return {
		logicalBucket,
		artifacts: lazy('artifacts'),
		metadata: {
			get: ((key, options) => requireTarget().metadata.get(key, options)) as MetadataStore['get'],
			head: (key) => requireTarget().metadata.head(key),
			put: (key, value, options) => requireTarget().metadata.put(key, value, options),
			delete: (keys) => requireTarget().metadata.delete(keys),
			list: (options) => requireTarget().metadata.list(options),
		},
		sessions: {
			list: (query) => {
				requireTarget();
				return runtime!.sessions.list(query);
			},
		},
		async ready() {
			if (closed) throw new Error('Metadata storage is closed');
			pending ??= (async () => {
				const marker = await readMetadataBackendMarker(raw);
				if (
					marker?.backend !== 'postgres' ||
					marker.state !== 'active' ||
					marker.namespace !== namespace
				)
					throw new Error(
						'Metadata backend marker does not match the configured PostgreSQL deployment',
					);
				runtime = factory({
					...settings,
					epoch: marker.epoch,
					artifactStoreId: marker.artifact_store_id,
				});
				try {
					await runtime.ready();
				} catch (error) {
					await runtime.close();
					runtime = undefined;
					throw error;
				}
				target = createLogicalStorage(raw, runtime, { namespace, epoch: marker.epoch });
			})();
			try {
				await pending;
				if (closed) throw new Error('Metadata storage is closed');
			} catch (error) {
				pending = undefined;
				throw error;
			}
		},
		async close() {
			closed = true;
			closing ??= (async () => {
				await pending?.catch(() => {});
				await runtime?.close();
			})();
			await closing;
		},
	};
}
