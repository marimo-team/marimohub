import { auditMetadataReferences } from '@marimo-hub/core/storage/metadata-validation';
import { readMetadataBackendMarker } from '@marimo-hub/core/storage/backend-marker';
import { createLogicalStorage } from '@marimo-hub/core/storage/logical-bucket';
import { PostgresMetadataStore } from './index';
import type { Bucket } from '@marimo-hub/core/ports/bucket';
import { MetadataTransfer } from './transfer';
import type { TransferOptions } from './transfer';
import { checkSchema, migrateSchema } from './migrations';
import { createMetadataPool } from './pool';
import { storageError } from './errors';

export async function migrateMetadataSchema(url: string): Promise<void> {
	const pool = createMetadataPool({ url, statementTimeoutMs: 60000, lockTimeoutMs: 10000 });
	try {
		await migrateSchema(pool);
	} finally {
		await pool.end();
	}
}

export async function inspectMetadataDeployment(url: string, namespace: string) {
	const pool = createMetadataPool({ url });
	try {
		const client = await pool.connect();
		try {
			await checkSchema(client);
			const deployment = await client.query<{
				backend_epoch: string;
				state: string;
				artifact_store_id: string;
			}>(
				'SELECT backend_epoch,state,artifact_store_id FROM hub_metadata.deployments WHERE namespace=$1',
				[namespace],
			);
			const counts = await client.query<{ records: string; bytes: string }>(
				'SELECT count(*) AS records, coalesce(sum(size_bytes),0) AS bytes FROM hub_metadata.records WHERE namespace=$1',
				[namespace],
			);
			const transfers = await client.query(
				'SELECT id,direction,state,source_epoch,target_epoch,scan_generation,lease_until FROM hub_metadata.transfers WHERE namespace=$1 ORDER BY created_at DESC LIMIT 10',
				[namespace],
			);
			return {
				deployment: deployment.rows[0] ?? null,
				...counts.rows[0],
				transfers: transfers.rows,
			};
		} finally {
			client.release();
		}
	} catch (error) {
		throw storageError(error);
	} finally {
		await pool.end();
	}
}

export async function runMetadataTransfer(
	url: string,
	bucket: Bucket,
	options: TransferOptions & { fresh?: boolean; activate?: boolean; abort?: boolean },
) {
	const pool = createMetadataPool({ url, statementTimeoutMs: 60000, lockTimeoutMs: 10000 });
	try {
		const transfer = new MetadataTransfer(pool, bucket, options);
		if (options.abort) {
			await transfer.abort();
			return { id: options.id, state: 'aborted' };
		}
		if (options.activate) {
			await transfer.activate();
		} else {
			if (!(await transfer.status())) await transfer.begin({ fresh: options.fresh });
			const status = await transfer.status();
			if (status && ['copying', 'checking'].includes(status.state)) {
				let lease = await transfer.claim();
				while (lease.state !== 'ready') lease = await transfer.step(lease);
			}
		}
		const status = await transfer.status();
		return {
			id: options.id,
			state: status?.state,
			targetEpoch: status?.target_epoch,
			generation: status?.scan_generation,
		};
	} finally {
		await pool.end();
	}
}

export async function auditMetadataDeployment(
	url: string | undefined,
	bucket: Bucket,
): Promise<void> {
	const marker = await readMetadataBackendMarker(bucket);
	if (!marker || marker.backend === 'bucket') {
		await auditMetadataReferences(bucket);
		return;
	}
	if (!url || !marker.namespace || marker.state !== 'active')
		throw new Error('Audit requires a matching active PostgreSQL deployment');
	const store = new PostgresMetadataStore({
		url,
		namespace: marker.namespace,
		epoch: marker.epoch,
		artifactStoreId: marker.artifact_store_id,
	});
	try {
		await store.ready();
		await auditMetadataReferences(
			createLogicalStorage(bucket, store, { namespace: marker.namespace, epoch: marker.epoch })
				.logicalBucket,
		);
	} finally {
		await store.close();
	}
}
