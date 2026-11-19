import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { BucketObject } from '@marimo-hub/core/ports/bucket';
import { METADATA_MANIFEST_VERSION } from '@marimo-hub/core/storage/metadata-keys';

export type TransferDirection = 'bucket_to_sql' | 'sql_to_bucket';
export type TransferState = 'copying' | 'checking' | 'ready' | 'activated' | 'failed';
export interface TransferIdentity {
	namespace: string;
	id: string;
}
export interface TransferCursor {
	after: string;
	phase?: 'deleting';
}
export interface TransferLease {
	state: TransferState;
	lease_id: string;
	revision: string;
	cursor: TransferCursor | null;
	scan_generation: string;
	source_epoch: string;
	target_epoch: string;
	manifest_version: number;
	direction: TransferDirection;
}
export interface TransferProgress {
	state: TransferState;
	cursor: TransferCursor | null;
	generation: number;
}
export interface TransferItem {
	source: Pick<BucketObject, 'key' | 'etag' | 'uploaded'>;
	bytes: Uint8Array;
	targetEtag: string;
	generation: string | number;
}

export async function insertTransfer(
	client: PoolClient,
	identity: TransferIdentity,
	direction: TransferDirection,
	sourceEpoch: number,
	targetEpoch: number,
): Promise<void> {
	await client.query(
		`INSERT INTO hub_metadata.transfers(namespace,id,direction,state,source_epoch,target_epoch,manifest_version)
		VALUES ($1,$2,$3,'copying',$4,$5,$6)`,
		[
			identity.namespace,
			identity.id,
			direction,
			sourceEpoch,
			targetEpoch,
			METADATA_MANIFEST_VERSION,
		],
	);
}

export async function recordTransferItem(
	client: PoolClient,
	identity: TransferIdentity,
	direction: TransferDirection,
	item: TransferItem,
): Promise<void> {
	// Only the bucket source can change between inventory passes; SQL is frozen during export.
	const sourceUpdates =
		direction === 'bucket_to_sql'
			? 'source_etag=EXCLUDED.source_etag,source_uploaded_at=EXCLUDED.source_uploaded_at,sha256=EXCLUDED.sha256,size_bytes=EXCLUDED.size_bytes,'
			: '';
	await client.query(
		`INSERT INTO hub_metadata.transfer_items(namespace,transfer_id,key,source_etag,source_uploaded_at,sha256,size_bytes,target_etag,seen_generation)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT(namespace,transfer_id,key) DO UPDATE SET ${sourceUpdates}target_etag=EXCLUDED.target_etag,seen_generation=EXCLUDED.seen_generation,checked_at=clock_timestamp()`,
		[
			identity.namespace,
			identity.id,
			item.source.key,
			item.source.etag,
			item.source.uploaded,
			createHash('sha256').update(item.bytes).digest('hex'),
			item.bytes.byteLength,
			item.targetEtag,
			item.generation,
		],
	);
}

export async function checkpointTransfer(
	client: PoolClient,
	identity: TransferIdentity,
	lease: TransferLease,
	progress: TransferProgress,
): Promise<TransferLease> {
	const next = await client.query<TransferLease>(
		`UPDATE hub_metadata.transfers SET state=$5,cursor=$6,scan_generation=$7,revision=revision+1,lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
		WHERE namespace=$1 AND id=$2 AND lease_id=$3 AND revision=$4 AND lease_until>clock_timestamp() RETURNING *`,
		[
			identity.namespace,
			identity.id,
			lease.lease_id,
			lease.revision,
			progress.state,
			progress.cursor,
			progress.generation,
		],
	);
	if (!next.rows[0])
		throw new Error(
			lease.direction === 'sql_to_bucket'
				? 'Reverse transfer lease expired; keep all writers stopped'
				: 'Transfer lease expired before checkpoint',
		);
	return next.rows[0];
}
