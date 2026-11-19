import type { Pool, PoolClient } from 'pg';
import type {
	BucketGetOptions,
	BucketGetResult,
	BucketListOptions,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports/bucket';
import type {
	MetadataTransactions,
	IndexedSessionRecords,
	MetadataStore,
} from '@marimo-hub/core/ports/metadata';
import { MetadataStorageError, storageError } from './errors';
import { checkSchema } from './migrations';
import { createMetadataPool } from './pool';
import type { PostgresConnectionOptions } from './pool';
import { deleteRecords, getRecord, headRecord, listRecords, putRecord, UUID } from './records';
import { isValidMetadataIdentifier } from './validation';
import { listSessions } from './sessions';
import { runScopedTransaction } from './scopedTransactions';
import { guardedTransaction } from './transactions';
import type { DeploymentIdentity } from './transactions';

export type PostgresMetadataOptions = PostgresConnectionOptions & DeploymentIdentity;
export { MetadataStorageError } from './errors';
export { createMetadataPool } from './pool';

export class PostgresMetadataStore implements MetadataStore {
	private readonly pool: Pool;
	private readonly identity: DeploymentIdentity;
	private initialized = false;
	private closed = false;
	private closing?: Promise<void>;
	private initialization?: Promise<void>;
	readonly sessions: IndexedSessionRecords;
	readonly transactions: MetadataTransactions;

	constructor(options: PostgresMetadataOptions) {
		if (
			!isValidMetadataIdentifier(options.namespace, 128) ||
			!Number.isSafeInteger(options.epoch) ||
			options.epoch < 1 ||
			!UUID.test(options.artifactStoreId)
		)
			throw new RangeError('Invalid metadata deployment identity');
		this.identity = {
			namespace: options.namespace,
			epoch: options.epoch,
			artifactStoreId: options.artifactStoreId,
		};
		this.pool = createMetadataPool(options);
		this.transactions = {
			run: (scopes, work) => {
				if (!this.initialized || this.closed)
					return Promise.reject(new MetadataStorageError('unavailable'));
				return runScopedTransaction(this.pool, this.identity, scopes, work);
			},
		};
		this.sessions = {
			list: (query) =>
				this.run((client) =>
					listSessions(client, this.identity.namespace, this.identity.epoch, query),
				),
		};
	}

	async ready(): Promise<void> {
		if (this.closed) throw new MetadataStorageError('unavailable');
		if (!this.initialization) {
			this.initialization = guardedTransaction(this.pool, this.identity, checkSchema)
				.then(() => {
					if (this.closed) throw new MetadataStorageError('unavailable');
					this.initialized = true;
				})
				.catch((error: unknown) => {
					this.initialization = undefined;
					throw storageError(error);
				});
		}
		await this.initialization;
		if (this.closed) throw new MetadataStorageError('unavailable');
	}
	async close(): Promise<void> {
		this.closed = true;
		this.initialized = false;
		this.closing ??= this.pool.end();
		await this.closing;
	}
	private run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		if (!this.initialized || this.closed)
			return Promise.reject(new MetadataStorageError('unavailable'));
		return guardedTransaction(this.pool, this.identity, work);
	}
	get(key: string): Promise<BucketObjectBody | null>;
	get(key: string, options?: BucketGetOptions): Promise<BucketGetResult>;
	get(key: string, options?: BucketGetOptions): Promise<BucketGetResult> {
		return this.run((client) => getRecord(client, this.identity.namespace, key, options));
	}
	head(key: string) {
		return this.run((client) => headRecord(client, this.identity.namespace, key));
	}
	put(key: string, value: string | Uint8Array, options?: BucketPutOptions) {
		return this.run((client) => putRecord(client, this.identity.namespace, key, value, options));
	}
	delete(keys: string | string[]) {
		return this.run((client) => deleteRecords(client, this.identity.namespace, keys));
	}
	list(options?: BucketListOptions) {
		return this.run((client) =>
			listRecords(client, this.identity.namespace, this.identity.epoch, options),
		);
	}
}
