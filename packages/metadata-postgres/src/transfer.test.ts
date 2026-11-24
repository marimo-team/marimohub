import { PostgresMetadataStore } from './index';
import { randomUUID } from 'node:crypto';
import { createNotebookId, createJobId, createRunId, createProjectId } from '@marimo-hub/core/ids';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { METADATA_BACKEND_KEY } from '@marimo-hub/core/storage/metadata-keys';
import {
	assertBucketMetadataBackend,
	readMetadataBackendMarker,
} from '@marimo-hub/core/storage/backend-marker';
import { withTransferLease } from './transferLease';
import { MetadataTransfer } from './transfer';
import { createMetadataPool } from './pool';
import { migrateSchema } from './migrations';

const url = process.env.MARIMOHUB_TEST_POSTGRES_URL;
if (process.env.MARIMOHUB_REQUIRE_POSTGRES_TESTS === '1' && !url)
	throw new Error('PostgreSQL URL required');

describe.skipIf(!url)('offline metadata transfer', () => {
	let pool: Pool;
	const namespaces: string[] = [];
	beforeAll(async () => {
		pool = createMetadataPool({ url: url! });
		await migrateSchema(pool);
	});
	afterAll(async () => {
		for (const table of ['transfer_items', 'transfers', 'records', 'deployments'])
			await pool.query(`DELETE FROM hub_metadata.${table} WHERE namespace=ANY($1::text[])`, [
				namespaces,
			]);
		await pool.end();
	});
	function fixture(bucket = new MemoryBucket()) {
		const namespace = randomUUID();
		namespaces.push(namespace);
		const id = randomUUID();
		const transfer = new MetadataTransfer(pool, bucket, {
			namespace,
			id,
			writersStopped: true,
			pageSize: 100,
		});
		return { bucket, namespace, id, transfer };
	}
	const key = '_system/host-retry-cleanup.json';

	it('rejects the unused failed state without changing transfer progress', async () => {
		const { transfer, namespace, id } = fixture();
		await transfer.begin({ fresh: true });
		await expect(
			pool.query("UPDATE hub_metadata.transfers SET state='failed' WHERE namespace=$1 AND id=$2", [
				namespace,
				id,
			]),
		).rejects.toMatchObject({ code: '23514' });
		const { rows } = await pool.query(
			'SELECT state FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2',
			[namespace, id],
		);
		expect(rows[0].state).toBe('copying');
	});

	it('copies exact bytes and metadata, rescans updates/deletes, and activates idempotently', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, ' {"after":"old", "future":true} ', {
			customMetadata: { x: 'y' },
			httpMetadata: { contentType: 'application/json' },
		});
		await bucket.put('_system/source-control-account-cleanup.json', '{}');
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state === 'copying') lease = await transfer.step(lease);
		await bucket.put(key, ' {"after":"new", "future":true} ', { customMetadata: { x: 'z' } });
		await bucket.delete('_system/source-control-account-cleanup.json');
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		const rows = (
			await pool.query(
				'SELECT key,body,custom_metadata FROM hub_metadata.records WHERE namespace=$1',
				[namespace],
			)
		).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0].body.toString()).toBe(' {"after":"new", "future":true} ');
		expect(rows[0].custom_metadata).toEqual({ x: 'z' });
		await transfer.activate();
		await transfer.activate();
		expect(await readMetadataBackendMarker(bucket)).toMatchObject({
			backend: 'postgres',
			state: 'active',
			epoch: 2,
			namespace,
		});
	});
	it('keeps an expired audit lease fenced against a competing claimant', async () => {
		const { bucket, namespace, id, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		const lease = await transfer.claim();
		await pool.query(
			"UPDATE hub_metadata.transfers SET lease_until=clock_timestamp()+interval '200 milliseconds' WHERE namespace=$1 AND id=$2",
			[namespace, id],
		);
		const client = await pool.connect();
		let takeover: Promise<unknown> | undefined;
		try {
			await client.query('BEGIN');
			await client.query(
				'SELECT 1 FROM hub_metadata.transfers WHERE namespace=$1 AND id=$2 FOR UPDATE',
				[namespace, id],
			);
			await withTransferLease(client, { namespace, id }, lease, async () => {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const settled = vi.fn();
				takeover = transfer.claim().then(settled, (error: unknown) => {
					settled();
					return error;
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(settled).not.toHaveBeenCalled();
			});
			await client.query('COMMIT');
			expect(await takeover).toBeInstanceOf(Error);
			expect((await transfer.status())!.lease_id).toBe(lease.lease_id);
			await expect(transfer.step(lease)).resolves.toMatchObject({ state: 'checking' });
		} finally {
			await client.query('ROLLBACK');
			client.release();
			await takeover;
		}
	});
	it('retains unchanged SQL records during the checking inventory', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state === 'copying') lease = await transfer.step(lease);
		const before = (
			await pool.query('SELECT etag FROM hub_metadata.records WHERE namespace=$1 AND key=$2', [
				namespace,
				key,
			])
		).rows[0].etag;
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		expect(
			(
				await pool.query('SELECT etag FROM hub_metadata.records WHERE namespace=$1 AND key=$2', [
					namespace,
					key,
				])
			).rows[0].etag,
		).toBe(before);
	});
	it('rejects a stale importer after lease takeover without committing its page', async () => {
		const { bucket, namespace, id, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		const old = await transfer.claim();
		await expect(transfer.claim()).rejects.toThrow('leased');
		await pool.query(
			"UPDATE hub_metadata.transfers SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1",
			[namespace],
		);
		const replica = new MetadataTransfer(pool, bucket, {
			namespace,
			id,
			writersStopped: true,
			pageSize: 100,
		});
		const next = await replica.claim();
		await expect(transfer.step(old)).rejects.toThrow('lease');
		expect(
			(await pool.query('SELECT * FROM hub_metadata.records WHERE namespace=$1', [namespace])).rows,
		).toHaveLength(0);
		await replica.step(next);
	});
	it.each([
		['unknown', 'unknown.json', '{}'],
		['invalid', key, '{broken'],
	])('blocks %s records without advancing the checkpoint', async (_, path, value) => {
		const { bucket, namespace, transfer } = fixture();
		await transfer.begin();
		await bucket.put(path, value);
		const lease = await transfer.claim();
		await expect(transfer.step(lease)).rejects.toThrow();
		expect(
			(
				await pool.query('SELECT cursor FROM hub_metadata.transfers WHERE namespace=$1', [
					namespace,
				])
			).rows[0].cursor,
		).toBeNull();
	});
	it('refuses fresh initialization over any existing object', async () => {
		const { bucket, transfer } = fixture();
		await bucket.put(key, '{}');
		await expect(transfer.begin({ fresh: true })).rejects.toThrow('empty');
		expect(await readMetadataBackendMarker(bucket)).toBeNull();
	});
	it('initializes an empty deployment through the same activation protocol', async () => {
		const { bucket, transfer } = fixture();
		await transfer.begin({ fresh: true });
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		await transfer.activate();
		expect(await readMetadataBackendMarker(bucket)).toMatchObject({
			backend: 'postgres',
			epoch: 2,
		});
	});
	it.each(['bucket_to_sql', 'sql_to_bucket'] as const)(
		'reconciles %s activation after SQL commits but marker publication fails',
		async (direction) => {
			const { bucket, namespace, transfer } = fixture();
			await transfer.begin({ fresh: true });
			let lease = await transfer.claim();
			while (lease.state !== 'ready') lease = await transfer.step(lease);
			let pending = transfer;
			if (direction === 'sql_to_bucket') {
				await transfer.activate();
				pending = new MetadataTransfer(pool, bucket, {
					namespace,
					id: randomUUID(),
					direction,
					writersStopped: true,
				});
				await pending.begin();
				lease = await pending.claim();
				while (lease.state !== 'ready') lease = await pending.step(lease);
			}
			const fault = vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('lost marker write'));
			await expect(pending.activate()).rejects.toThrow('lost marker');
			expect(
				(
					await pool.query('SELECT state FROM hub_metadata.deployments WHERE namespace=$1', [
						namespace,
					])
				).rows[0].state,
			).toBe(direction === 'bucket_to_sql' ? 'active' : 'retired');
			expect(await readMetadataBackendMarker(bucket)).toMatchObject({
				state: 'frozen',
				backend: direction === 'bucket_to_sql' ? 'bucket' : 'postgres',
			});
			fault.mockRestore();
			await pending.activate();
			expect((await pending.status())!.state).toBe('activated');
			expect(await readMetadataBackendMarker(bucket)).toMatchObject({
				state: 'active',
				backend: direction === 'bucket_to_sql' ? 'postgres' : 'bucket',
			});
		},
	);

	it('reads the authoritative checkpoint instead of a forged caller cursor', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state !== 'ready')
			lease = await transfer.step({ ...lease, cursor: { after: 'zzzz' } });
		expect(
			(await pool.query('SELECT key FROM hub_metadata.records WHERE namespace=$1', [namespace]))
				.rows,
		).toEqual([{ key }]);
	});
	it.each(['bucket_to_sql', 'sql_to_bucket'] as const)(
		'does not overwrite a changed marker after the %s activation transaction',
		async (direction) => {
			const { bucket, namespace, transfer } = fixture();
			await transfer.begin({ fresh: true });
			let lease = await transfer.claim();
			while (lease.state !== 'ready') lease = await transfer.step(lease);
			let pending = transfer;
			if (direction === 'sql_to_bucket') {
				await transfer.activate();
				pending = new MetadataTransfer(pool, bucket, {
					namespace,
					id: randomUUID(),
					direction,
					writersStopped: true,
				});
				await pending.begin();
				lease = await pending.claim();
				while (lease.state !== 'ready') lease = await pending.step(lease);
			}
			const marker = (await readMetadataBackendMarker(bucket))!;
			const get = bucket.get.bind(bucket);
			let reads = 0;
			const fault = vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
				if (key === METADATA_BACKEND_KEY && ++reads === 2)
					await bucket.put(key, JSON.stringify({ ...marker, epoch: marker.epoch + 10 }));
				return get(key, options);
			});
			try {
				await expect(pending.activate()).rejects.toThrow('marker changed');
				expect((await readMetadataBackendMarker(bucket))!.epoch).toBe(marker.epoch + 10);
				expect((await pending.status())!.state).toBe('ready');
			} finally {
				fault.mockRestore();
			}
		},
	);
	it('does not freeze the marker for a reverse transfer while activation is incomplete', async () => {
		const { bucket, namespace, transfer } = fixture();
		await transfer.begin({ fresh: true });
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		const fault = vi
			.spyOn(pool, 'query')
			.mockImplementationOnce(() => Promise.reject(new Error('lost activation receipt')));
		try {
			await expect(transfer.activate()).rejects.toThrow('lost activation receipt');
		} finally {
			fault.mockRestore();
		}
		const marker = await readMetadataBackendMarker(bucket);
		const reverse = new MetadataTransfer(pool, bucket, {
			namespace,
			id: randomUUID(),
			direction: 'sql_to_bucket',
			writersStopped: true,
		});
		await expect(reverse.begin()).rejects.toThrow('pending transfer');
		expect(await readMetadataBackendMarker(bucket)).toEqual(marker);
		await transfer.activate();
		await reverse.begin();
		expect(await readMetadataBackendMarker(bucket)).toMatchObject({
			backend: 'postgres',
			state: 'frozen',
		});
	});
	it('audits the source before freezing the marker', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, 'not json');
		await expect(transfer.begin()).rejects.toThrow('Invalid metadata record');
		expect(await readMetadataBackendMarker(bucket)).toBeNull();
		expect(
			(await pool.query('SELECT 1 FROM hub_metadata.deployments WHERE namespace=$1', [namespace]))
				.rowCount,
		).toBe(0);
	});
	it('aborts a forward transfer blocked after the freeze and lets bucket hosts start', async () => {
		const { bucket, namespace, id, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		const lease = await transfer.claim();
		await bucket.put('_system/source-control-account-cleanup.json', 'not json');
		await expect(transfer.step(lease)).rejects.toThrow('Invalid metadata record');
		await expect(assertBucketMetadataBackend(bucket)).rejects.toThrow('frozen');
		await expect(transfer.abort()).rejects.toThrow('leased');
		await pool.query(
			"UPDATE hub_metadata.transfers SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
			[namespace, id],
		);
		await transfer.abort();
		await transfer.abort();
		await assertBucketMetadataBackend(bucket);
		expect(await readMetadataBackendMarker(bucket)).toMatchObject({
			backend: 'bucket',
			state: 'active',
			epoch: 1,
			transfer_id: null,
		});
		for (const table of ['transfers', 'records', 'deployments'])
			expect(
				(await pool.query(`SELECT 1 FROM hub_metadata.${table} WHERE namespace=$1`, [namespace]))
					.rowCount,
			).toBe(0);
		await bucket.delete('_system/source-control-account-cleanup.json');
		await transfer.begin();
		expect((await transfer.status())!.state).toBe('copying');
	});
	it('aborts a reverse transfer and reopens the PostgreSQL deployment', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		await transfer.activate();
		const marker = (await readMetadataBackendMarker(bucket))!;
		const store = new PostgresMetadataStore({
			url: url!,
			namespace,
			epoch: 2,
			artifactStoreId: marker.artifact_store_id,
		});
		try {
			await store.ready();
			const reverse = new MetadataTransfer(pool, bucket, {
				namespace,
				id: randomUUID(),
				direction: 'sql_to_bucket',
				writersStopped: true,
			});
			await reverse.begin();
			await expect(store.put(key, '{}')).rejects.toMatchObject({ kind: 'unavailable' });
			await reverse.abort();
			expect(await readMetadataBackendMarker(bucket)).toEqual({ ...marker, transfer_id: null });
			await store.put(key, '{"after":"abort"}');
			expect(await reverse.status()).toBeNull();
		} finally {
			await store.close();
		}
	});
	it('rejects a replayed checkpoint and resumes from committed progress', async () => {
		const { bucket, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		const old = await transfer.claim();
		await transfer.step(old);
		await expect(transfer.step(old)).rejects.toThrow('lease');
		const current = (await transfer.status())!;
		expect((await transfer.step(current)).state).toBe('ready');
	});
	it('exports new SQL writes and deletions while retaining artifact bytes', async () => {
		const { bucket, namespace, transfer } = fixture();
		const locator = {
			notebook_id: createNotebookId(),
			job_id: createJobId(),
			run_id: createRunId(),
		};
		const locatorKey = `projects/${createProjectId()}/run-index/00000000000000000000000000.json`;
		await bucket.put(locatorKey, JSON.stringify(locator));
		await bucket.put(key, '{"after":"old"}');
		await bucket.put('_system/source-control-account-cleanup.json', '{}');
		const artifact = 'projects/p/notebooks/n/workspace/keep.json';
		await bucket.put(artifact, 'artifact');
		const artifactEtag = (await bucket.head(artifact))!.etag;
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		await transfer.activate();
		const marker = (await readMetadataBackendMarker(bucket))!;
		const store = new PostgresMetadataStore({
			url: url!,
			namespace,
			epoch: 2,
			artifactStoreId: marker.artifact_store_id,
		});
		try {
			await store.ready();
			expect(await (await store.get(locatorKey))!.json()).toEqual(locator);
			await bucket.delete(locatorKey);
			await store.put(key, '{"after":"new"}', { customMetadata: { source: 'sql' } });
			await store.delete('_system/source-control-account-cleanup.json');
			await store.put('_system/working-branches/cleanup.json', '{"cursor":"new"}');
			const get = bucket.get.bind(bucket);
			vi.spyOn(bucket, 'get').mockImplementation(async (key, options) => {
				const result = await get(key, options);
				return result && !('notModified' in result)
					? {
							...result,
							httpMetadata: result.httpMetadata ?? { contentType: undefined },
							customMetadata: result.customMetadata ?? {},
						}
					: result;
			});
			const reverse = new MetadataTransfer(pool, bucket, {
				namespace,
				id: randomUUID(),
				direction: 'sql_to_bucket',
				writersStopped: true,
				pageSize: 1,
			});
			await reverse.begin();
			await expect(store.put(key, '{}')).rejects.toMatchObject({ kind: 'unavailable' });
			lease = await reverse.claim();
			while (lease.state !== 'ready') lease = await reverse.step(lease);
			await reverse.activate();
			await reverse.activate();
			expect(await (await bucket.get(key))!.text()).toBe('{"after":"new"}');
			expect((await bucket.get(key))!.customMetadata).toEqual({ source: 'sql' });
			expect(await bucket.get('_system/source-control-account-cleanup.json')).toBeNull();
			expect(await bucket.get('_system/working-branches/cleanup.json')).not.toBeNull();
			expect((await bucket.head(artifact))!.etag).toBe(artifactEtag);
			expect(await (await bucket.get(locatorKey))!.json()).toEqual(locator);
			expect(await readMetadataBackendMarker(bucket)).toMatchObject({
				backend: 'bucket',
				epoch: 3,
				state: 'active',
			});
			await expect(store.get(key)).rejects.toMatchObject({ kind: 'unavailable' });
		} finally {
			await store.close();
		}
	});
	it('replays a reverse page after a lost bucket write reply', async () => {
		const { bucket, namespace, transfer } = fixture();
		await bucket.put(key, '{}');
		await transfer.begin();
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		await transfer.activate();
		const reverse = new MetadataTransfer(pool, bucket, {
			namespace,
			id: randomUUID(),
			direction: 'sql_to_bucket',
			writersStopped: true,
		});
		await reverse.begin();
		lease = await reverse.claim();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
			await put(...args);
			throw new Error('lost reply');
		});
		await expect(reverse.step(lease)).rejects.toThrow('lost reply');
		expect((await reverse.status())!.revision).toBe(lease.revision);
		while (lease.state !== 'ready') lease = await reverse.step(lease);
		await reverse.activate();
		expect(await (await bucket.get(key))!.text()).toBe('{}');
	});
});
