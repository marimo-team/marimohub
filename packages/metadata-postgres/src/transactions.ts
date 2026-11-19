import type { Pool, PoolClient } from 'pg';
import { MetadataStorageError, storageError } from './errors';

export interface DeploymentIdentity {
	namespace: string;
	epoch: number;
	artifactStoreId: string;
}

export async function guardedTransaction<T>(
	pool: Pool,
	identity: DeploymentIdentity,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	let client: PoolClient;
	try {
		client = await pool.connect();
	} catch (error) {
		throw storageError(error);
	}
	let destroy = false;
	let committing = false;
	try {
		await client.query('BEGIN');
		await client.query('SELECT hub_metadata.guard_deployment($1, $2, $3)', [
			identity.namespace,
			identity.epoch,
			identity.artifactStoreId,
		]);
		const result = await work(client);
		committing = true;
		await client.query('COMMIT');
		return result;
	} catch (error) {
		const failure = storageError(error);
		const knownAbort = failure instanceof MetadataStorageError && failure.kind === 'serialization';
		if (committing && !knownAbort) {
			// A lost COMMIT reply cannot safely be retried as an aborted operation.
			destroy = true;
			throw new MetadataStorageError('commit-unknown');
		}
		try {
			await client.query('ROLLBACK');
		} catch {
			destroy = true;
		}
		throw failure;
	} finally {
		client.release(destroy);
	}
}
