import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Bucket, BucketObjectBody } from '@marimo-hub/core/ports/bucket';
import { MetadataBackendMarkerSchema } from '@marimo-hub/core/storage/backend-marker';
import type { MetadataBackendMarker } from '@marimo-hub/core/storage/backend-marker';
import {
	METADATA_BACKEND_KEY,
	METADATA_MANIFEST_VERSION,
	classifyMetadataKey,
} from '@marimo-hub/core/storage/metadata-keys';
import {
	auditMetadataReferences,
	validateMetadataRecord,
} from '@marimo-hub/core/storage/metadata-validation';
import { createLogicalStorage } from '@marimo-hub/core/storage/logical-bucket';
import { body, COLUMNS, getRecord, headRecord, listRecords, matchesRecord, UUID } from './records';
import type { RecordRow } from './records';
import { isValidMetadataIdentifier } from './validation';
import { checkSchema } from './migrations';
import { checkpointTransfer, insertTransfer, recordTransferItem } from './transferState';
import type { TransferDirection, TransferIdentity, TransferLease } from './transferState';

export type { TransferLease } from './transferState';

export interface TransferOptions extends TransferIdentity {
	writersStopped: boolean;
	pageSize?: number;
	direction?: TransferDirection;
}

interface ActivationTarget {
	marker: MetadataBackendMarker;
	sourceEtag: string;
}

export class MetadataTransfer {
	private readonly pageSize: number;
	constructor(
		private readonly pool: Pool,
		private readonly bucket: Bucket,
		private readonly options: TransferOptions,
	) {
		this.options = { ...options };
		this.pageSize = options.pageSize ?? 100;
		if (!options.writersStopped)
			throw new Error('Stop and externally fence every writer before transfer');
		if (!UUID.test(options.id) || !isValidMetadataIdentifier(options.namespace, 128))
			throw new Error('Invalid transfer identity');
		if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000)
			throw new Error('Invalid transfer page size');
	}
	private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		let destroy = false;
		try {
			await client.query('BEGIN');
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			try {
				await client.query('ROLLBACK');
			} catch {
				destroy = true;
			}
			throw error;
		} finally {
			client.release(destroy);
		}
	}
	private async marker() {
		const object = await this.bucket.get(METADATA_BACKEND_KEY);
		return object
			? { marker: MetadataBackendMarkerSchema.parse(await object.json()), etag: object.etag }
			: null;
	}
	private async writeMarker(marker: MetadataBackendMarker, etag?: string) {
		await this.bucket.put(
			METADATA_BACKEND_KEY,
			JSON.stringify(marker),
			etag ? { onlyIfEtagMatches: etag } : { onlyIfNotExists: true },
		);
	}
	private async frozenMarker() {
		const current = await this.marker();
		if (
			current?.marker.state !== 'frozen' ||
			current.marker.backend !==
				(this.options.direction === 'sql_to_bucket' ? 'postgres' : 'bucket') ||
			current.marker.transfer_id !== this.options.id
		)
			throw new Error('Transfer source marker is not frozen for this transfer');
		return current;
	}
	async begin({ fresh = false } = {}): Promise<void> {
		if (this.options.direction === 'sql_to_bucket') {
			if (fresh) throw new Error('Reverse transfer cannot initialize a fresh deployment');
			return this.beginReverse();
		}
		await this.transaction(async (client) => {
			await checkSchema(client);
			await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
				this.options.namespace,
			]);
			const existing = (
				await client.query('SELECT * FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2', [
					this.options.namespace,
					this.options.id,
				])
			).rows[0];
			if (existing) {
				if (fresh) throw new Error('Fresh initialization requires an empty deployment');
				await this.frozenMarker();
				return;
			}
			if (
				(
					await client.query('SELECT 1 FROM hub_metadata.deployments WHERE namespace=$1', [
						this.options.namespace,
					])
				).rowCount
			)
				throw new Error('Target namespace already exists');
			let current = await this.marker();
			if (fresh && (current || (await this.bucket.list({ limit: 1 })).objects.length > 0))
				throw new Error('Fresh initialization requires an empty bucket');
			if (!current) {
				await this.writeMarker({
					version: 1,
					artifact_store_id: randomUUID(),
					backend: 'bucket',
					epoch: 1,
					state: 'active',
					namespace: null,
					transfer_id: null,
				});
				current = (await this.marker())!;
			}
			const marker = current.marker;
			if (
				marker.backend !== 'bucket' ||
				(marker.state === 'frozen' && marker.transfer_id !== this.options.id)
			)
				throw new Error('Incompatible source marker');
			if (!Number.isSafeInteger(marker.epoch + 1)) throw new Error('Backend epoch exhausted');
			await this.writeMarker(
				{ ...marker, state: 'frozen', transfer_id: this.options.id },
				current.etag,
			);
			await client.query(
				"INSERT INTO hub_metadata.deployments(namespace,backend_epoch,state,artifact_store_id) VALUES ($1,$2,'importing',$3)",
				[this.options.namespace, marker.epoch + 1, marker.artifact_store_id],
			);
			await insertTransfer(client, this.options, 'bucket_to_sql', marker.epoch, marker.epoch + 1);
		});
	}
	async status(): Promise<TransferLease | null> {
		return (
			(
				await this.pool.query<TransferLease>(
					'SELECT * FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2',
					[this.options.namespace, this.options.id],
				)
			).rows[0] ?? null
		);
	}
	async claim(): Promise<TransferLease> {
		await this.frozenMarker();
		const result = await this.pool.query<TransferLease>(
			`UPDATE hub_metadata.transfers SET lease_id=$3,lease_until=clock_timestamp()+interval '60 seconds',revision=revision+1,updated_at=clock_timestamp()
			WHERE namespace=$1 AND id=$2 AND state IN ('copying','checking') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,
			[this.options.namespace, this.options.id, randomUUID()],
		);
		if (!result.rows[0]) throw new Error('Transfer is leased or is no longer copying');
		return result.rows[0];
	}
	private async lock(client: PoolClient, lease?: TransferLease): Promise<TransferLease> {
		const result = await client.query<TransferLease & { live: boolean }>(
			'SELECT *,lease_until>clock_timestamp() AS live FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2 FOR UPDATE',
			[this.options.namespace, this.options.id],
		);
		const row = result.rows[0];
		if (
			!row ||
			row.manifest_version !== METADATA_MANIFEST_VERSION ||
			row.direction !== (this.options.direction ?? 'bucket_to_sql')
		)
			throw new Error('Unknown transfer or manifest version');
		if (
			lease &&
			(!row.live ||
				row.lease_id !== lease.lease_id ||
				row.revision !== lease.revision ||
				!['copying', 'checking'].includes(row.state))
		)
			throw new Error('Transfer lease lost');
		return row;
	}
	private view(client: PoolClient, epoch: number): Bucket {
		const namespace = this.options.namespace;
		const readOnly = {
			get: ((key: string, options?: Parameters<Bucket['get']>[1]) =>
				getRecord(client, namespace, key, options)) as Bucket['get'],
			head: (key: string) => headRecord(client, namespace, key),
			list: (options?: Parameters<Bucket['list']>[0]) =>
				listRecords(client, namespace, epoch, options),
			put: async () => {
				throw new Error('Read-only transfer audit');
			},
			delete: async () => {
				throw new Error('Read-only transfer audit');
			},
		};
		return createLogicalStorage(this.bucket, readOnly, { namespace, epoch }).logicalBucket;
	}
	async step(claim: TransferLease): Promise<TransferLease> {
		const lease = { ...claim };
		if (this.options.direction === 'sql_to_bucket') return this.stepReverse(lease);
		return this.transaction(async (client) => {
			const row = await this.lock(client, lease);
			const marker = await this.frozenMarker();
			const deployment = (
				await client.query(
					"SELECT 1 FROM hub_metadata.deployments WHERE namespace=$1 AND backend_epoch=$2 AND state='importing' AND artifact_store_id=$3 FOR UPDATE",
					[this.options.namespace, row.target_epoch, marker.marker.artifact_store_id],
				)
			).rows[0];
			if (!deployment) throw new Error('Importing deployment mismatch');
			const page = await this.bucket.list({ startAfter: row.cursor?.after, limit: this.pageSize });
			const records: BucketObjectBody[] = [];
			for (const item of page.objects) {
				if (classifyMetadataKey(item.key) !== 'metadata') continue;
				const object = await this.bucket.get(item.key);
				if (!object || object.etag !== item.etag)
					throw new Error('Source changed while reading transfer page');
				await validateMetadataRecord(object);
				records.push(object);
			}
			for (const record of records) {
				const bytes = Buffer.from(await record.bytes());
				// Replacing within the isolated importing namespace preserves source upload time.
				await client.query('DELETE FROM hub_metadata.records WHERE namespace=$1 AND key=$2', [
					this.options.namespace,
					record.key,
				]);
				const written = (
					await client.query<RecordRow>(
						`INSERT INTO hub_metadata.records(namespace,key,body,uploaded_at,http_metadata,custom_metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS},body`,
						[
							this.options.namespace,
							record.key,
							bytes,
							record.uploaded,
							record.httpMetadata ?? null,
							record.customMetadata ?? null,
						],
					)
				).rows[0];
				if (
					!(await body(written).bytes()).every((byte, index) => byte === bytes[index]) ||
					Number(written.size_bytes) !== bytes.length
				)
					throw new Error('Transfer byte verification failed');
				await recordTransferItem(client, this.options, 'bucket_to_sql', {
					source: record,
					bytes,
					targetEtag: written.etag,
					generation: row.scan_generation,
				});
			}
			let state = row.state;
			let generation = Number(row.scan_generation);
			const cursor = page.truncated ? { after: page.objects.at(-1)!.key } : null;
			if (!page.truncated && state === 'copying') {
				state = 'checking';
				generation++;
			} else if (!page.truncated && state === 'checking') {
				await client.query(
					'DELETE FROM hub_metadata.records r WHERE namespace=$1 AND NOT EXISTS (SELECT 1 FROM hub_metadata.transfer_items i WHERE i.namespace=r.namespace AND i.transfer_id=$2 AND i.key=r.key AND i.seen_generation=$3)',
					[this.options.namespace, this.options.id, generation],
				);
				await auditMetadataReferences(this.view(client, Number(row.target_epoch)));
				state = 'ready';
			}
			return checkpointTransfer(client, this.options, lease, { state, cursor, generation });
		});
	}
	async activate(): Promise<void> {
		if (this.options.direction === 'sql_to_bucket') return this.activateReverse();
		const target = await this.transaction(async (client) => {
			const row = await this.lock(client);
			if (!['ready', 'activated'].includes(row.state)) throw new Error('Transfer is not ready');
			const current = await this.marker();
			if (!current || current.marker.transfer_id !== this.options.id)
				throw new Error('Activation marker mismatch');
			const marker = current.marker;
			const completed =
				marker.backend === 'postgres' &&
				marker.state === 'active' &&
				marker.namespace === this.options.namespace &&
				marker.epoch === Number(row.target_epoch);
			if (
				!completed &&
				!(
					marker.backend === 'bucket' &&
					marker.state === 'frozen' &&
					marker.epoch === Number(row.source_epoch)
				)
			)
				throw new Error('Activation source mismatch');
			const updated = await client.query(
				"UPDATE hub_metadata.deployments SET state='active',updated_at=clock_timestamp() WHERE namespace=$1 AND backend_epoch=$2 AND artifact_store_id=$3 AND state IN ('importing','active') RETURNING namespace",
				[this.options.namespace, row.target_epoch, marker.artifact_store_id],
			);
			if (!updated.rowCount) throw new Error('Activation deployment mismatch');
			return {
				marker: {
					...marker,
					backend: 'postgres' as const,
					namespace: this.options.namespace,
					state: 'active' as const,
					epoch: Number(row.target_epoch),
				},
				sourceEtag: current.etag,
			};
		});
		await this.completeActivation(target, 'Activation marker changed');
	}
	private async completeActivation(
		activation: ActivationTarget,
		markerChangedMessage: string,
	): Promise<void> {
		const target = activation.marker;
		const current = await this.marker();
		if (
			!current ||
			current.marker.transfer_id !== this.options.id ||
			current.marker.artifact_store_id !== target.artifact_store_id
		)
			throw new Error(markerChangedMessage);
		if (JSON.stringify(current.marker) !== JSON.stringify(target)) {
			if (current.etag !== activation.sourceEtag) throw new Error(markerChangedMessage);
			await this.writeMarker(target, activation.sourceEtag);
		}
		await this.pool.query(
			"UPDATE hub_metadata.transfers SET state='activated',lease_id=NULL,lease_until=NULL,revision=revision+1 WHERE namespace=$1 AND id=$2 AND state IN ('ready','activated')",
			[this.options.namespace, this.options.id],
		);
	}
	private async beginReverse(): Promise<void> {
		await this.transaction(async (client) => {
			await checkSchema(client);
			const deployment = (
				await client.query<{ backend_epoch: string; state: string; artifact_store_id: string }>(
					'SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE',
					[this.options.namespace],
				)
			).rows[0];
			const current = await this.marker();
			if (
				!deployment ||
				current?.marker.backend !== 'postgres' ||
				current.marker.namespace !== this.options.namespace ||
				current.marker.artifact_store_id !== deployment.artifact_store_id ||
				current.marker.epoch !== Number(deployment.backend_epoch)
			)
				throw new Error('Reverse transfer source mismatch');
			const existing = await client.query(
				'SELECT direction FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2',
				[this.options.namespace, this.options.id],
			);
			if (existing.rowCount) {
				await this.frozenMarker();
				return;
			}
			const pending = await client.query(
				"SELECT 1 FROM hub_metadata.transfers WHERE namespace=$1 AND state IN ('copying','checking','ready')",
				[this.options.namespace],
			);
			if (pending.rowCount)
				throw new Error('Complete the pending transfer before starting another');

			if (
				!['active', 'frozen'].includes(deployment.state) ||
				(current.marker.state === 'frozen' && current.marker.transfer_id !== this.options.id)
			)
				throw new Error('Reverse source is already frozen for another operation');
			const target = current.marker.epoch + 1;
			if (!Number.isSafeInteger(target)) throw new Error('Backend epoch exhausted');
			await client.query(
				"UPDATE hub_metadata.deployments SET state='frozen',updated_at=clock_timestamp() WHERE namespace=$1",
				[this.options.namespace],
			);
			await this.writeMarker(
				{ ...current.marker, state: 'frozen', transfer_id: this.options.id },
				current.etag,
			);
			await insertTransfer(client, this.options, 'sql_to_bucket', current.marker.epoch, target);
		});
	}
	private async stepReverse(lease: TransferLease): Promise<TransferLease> {
		return this.transaction(async (client) => {
			const row = await this.lock(client, lease);
			const marker = await this.frozenMarker();
			const deployment = await client.query(
				"SELECT 1 FROM hub_metadata.deployments WHERE namespace=$1 AND backend_epoch=$2 AND state='frozen' AND artifact_store_id=$3 FOR UPDATE",
				[this.options.namespace, row.source_epoch, marker.marker.artifact_store_id],
			);
			if (!deployment.rowCount) throw new Error('Reverse deployment mismatch');
			let state = row.state;
			let generation = Number(row.scan_generation);
			let cursor: TransferLease['cursor'] = null;
			if (row.cursor?.phase === 'deleting') {
				const page = await this.bucket.list({ startAfter: row.cursor.after, limit: this.pageSize });
				for (const item of page.objects) {
					if (classifyMetadataKey(item.key) !== 'metadata') continue;
					if (!(await headRecord(client, this.options.namespace, item.key)))
						await this.bucket.delete(item.key);
				}
				if (page.truncated) cursor = { after: page.objects.at(-1)!.key, phase: 'deleting' };
				else {
					await auditMetadataReferences(this.bucket);
					state = 'ready';
				}
			} else {
				const page = (
					await client.query<RecordRow>(
						`SELECT ${COLUMNS},body FROM hub_metadata.records WHERE namespace=$1 AND key>$2 ORDER BY key COLLATE "C" LIMIT $3`,
						[this.options.namespace, row.cursor?.after ?? '', this.pageSize],
					)
				).rows;
				for (const record of page) {
					const source = body(record);
					await validateMetadataRecord(source);
					const existing = await this.bucket.get(record.key);
					const equal = await matchesRecord(record, existing);
					if (row.state === 'copying' || !equal)
						await this.bucket.put(record.key, record.body, {
							httpMetadata: source.httpMetadata,
							customMetadata: source.customMetadata,
							...(existing ? { onlyIfEtagMatches: existing.etag } : { onlyIfNotExists: true }),
						});
					const target = await this.bucket.get(record.key);
					if (!target || !(await matchesRecord(record, target)))
						throw new Error('Reverse transfer verification failed');
					await recordTransferItem(client, this.options, 'sql_to_bucket', {
						source,
						bytes: record.body,
						targetEtag: target.etag,
						generation,
					});
				}
				if (page.length === this.pageSize) cursor = { after: page.at(-1)!.key };
				else if (state === 'copying') {
					state = 'checking';
					generation++;
				} else cursor = { after: '', phase: 'deleting' };
			}
			return checkpointTransfer(client, this.options, lease, { state, cursor, generation });
		});
	}
	private async activateReverse(): Promise<void> {
		const target = await this.transaction(async (client) => {
			const row = await this.lock(client);
			if (!['ready', 'activated'].includes(row.state))
				throw new Error('Reverse transfer is not ready');
			const current = await this.marker();
			if (!current || current.marker.transfer_id !== this.options.id)
				throw new Error('Reverse activation marker mismatch');
			const marker = current.marker;
			const completed =
				marker.backend === 'bucket' &&
				marker.state === 'active' &&
				marker.epoch === Number(row.target_epoch);
			if (
				!completed &&
				!(
					marker.backend === 'postgres' &&
					marker.state === 'frozen' &&
					marker.namespace === this.options.namespace &&
					marker.epoch === Number(row.source_epoch)
				)
			)
				throw new Error('Reverse activation source mismatch');
			const result = await client.query(
				"UPDATE hub_metadata.deployments SET state='retired',backend_epoch=$2,updated_at=clock_timestamp() WHERE namespace=$1 AND artifact_store_id=$3 AND ((state='frozen' AND backend_epoch=$4) OR (state='retired' AND backend_epoch=$2)) RETURNING namespace",
				[this.options.namespace, row.target_epoch, marker.artifact_store_id, row.source_epoch],
			);
			if (!result.rowCount) throw new Error('Reverse activation deployment mismatch');
			return {
				marker: {
					...marker,
					backend: 'bucket' as const,
					namespace: null,
					state: 'active' as const,
					epoch: Number(row.target_epoch),
				},
				sourceEtag: current.etag,
			};
		});
		await this.completeActivation(target, 'Reverse activation marker changed');
	}
}
