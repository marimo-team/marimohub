import { PreconditionFailedError } from '@marimo-hub/core/errors';
import type { Pool } from 'pg';
import type { MetadataTransaction, MetadataStore } from '@marimo-hub/core/ports/metadata';
import { compareBucketKeys } from '@marimo-hub/core/ports/bucket';
import { classifyMetadataKey } from '@marimo-hub/core/storage/metadata-keys';
import { guardedTransaction } from './transactions';
import type { DeploymentIdentity } from './transactions';
import {
	getRecord,
	headRecord,
	putRecord,
	deleteRecords,
	listRecords,
	validateKey,
} from './records';
import { listSessions } from './sessions';
import { MetadataStorageError } from './errors';

export async function runScopedTransaction<T>(
	pool: Pool,
	identity: DeploymentIdentity,
	scopes: readonly string[],
	work: (transaction: MetadataTransaction) => Promise<T>,
): Promise<T> {
	if (scopes.length === 0 || scopes.length > 100)
		throw new RangeError('Expected 1–100 transaction scopes');
	const sorted = [...new Set(scopes)].sort(compareBucketKeys);
	sorted.forEach(validateKey);
	for (let attempt = 0; ; attempt++) {
		try {
			return await guardedTransaction(pool, identity, async (client) => {
				for (const scope of sorted) {
					await client.query(
						'INSERT INTO hub_metadata.scopes(namespace,scope) VALUES ($1,$2) ON CONFLICT DO NOTHING',
						[identity.namespace, scope],
					);
					await client.query(
						'SELECT scope FROM hub_metadata.scopes WHERE namespace=$1 AND scope=$2 FOR UPDATE',
						[identity.namespace, scope],
					);
				}
				let active = true;
				const pending = new Set<Promise<unknown>>();
				let failure: Error | undefined;
				const invoke = <R>(run: () => Promise<R>, keys: readonly string[] = []): Promise<R> => {
					if (!active) return Promise.reject(new Error('Metadata transaction has ended'));
					const operation = (async () => {
						for (const key of keys)
							if (classifyMetadataKey(key) !== 'metadata')
								throw new Error('Transactions accept metadata keys only');
						return run();
					})();
					pending.add(operation);
					void operation.then(
						() => pending.delete(operation),
						(error: unknown) => {
							pending.delete(operation);
							if (!(error instanceof PreconditionFailedError))
								failure ??= error instanceof Error ? error : new Error('Metadata operation failed');
						},
					);
					return operation;
				};
				const records: MetadataStore = {
					get: ((key, options) =>
						invoke(
							() => getRecord(client, identity.namespace, key, options, true),
							[key],
						)) as MetadataStore['get'],
					head: (key) => invoke(() => headRecord(client, identity.namespace, key), [key]),
					put: (key, value, options) =>
						invoke(() => putRecord(client, identity.namespace, key, value, options), [key]),
					delete: (keys) =>
						invoke(
							() => deleteRecords(client, identity.namespace, keys),
							typeof keys === 'string' ? [keys] : keys,
						),
					list: (options) =>
						invoke(() => listRecords(client, identity.namespace, identity.epoch, options)),
				};
				try {
					const result = await work({
						records,
						sessions: {
							list: (query) =>
								invoke(() => listSessions(client, identity.namespace, identity.epoch, query)),
						},
					});
					if (pending.size > 0)
						throw new Error('Transaction callback must await all record operations');
					if (failure) throw failure;
					return result;
				} finally {
					active = false;
					await Promise.allSettled(pending);
				}
			});
		} catch (error) {
			if (
				!(error instanceof MetadataStorageError) ||
				error.kind !== 'serialization' ||
				attempt >= 2
			)
				throw error;
			await new Promise((resolve) => {
				setTimeout(resolve, 10 + Math.floor(Math.random() * 30) * (attempt + 1));
			});
		}
	}
}
