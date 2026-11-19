import { PostgresMetadataStore } from './index';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { readMetadataBackendMarker } from '@marimo-hub/core/storage/backend-marker';
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
		await bucket.put(path, value);
		await transfer.begin();
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
	it('reconciles activation after SQL commits but marker publication fails', async () => {
		const { bucket, namespace, transfer } = fixture();
		await transfer.begin({ fresh: true });
		let lease = await transfer.claim();
		while (lease.state !== 'ready') lease = await transfer.step(lease);
		const put = bucket.put.bind(bucket);
		const fault = vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('lost marker write'));
		await expect(transfer.activate()).rejects.toThrow('lost marker');
		expect(
			(
				await pool.query('SELECT state FROM hub_metadata.deployments WHERE namespace=$1', [
					namespace,
				])
			).rows[0].state,
		).toBe('active');
		expect(await readMetadataBackendMarker(bucket)).toMatchObject({
			state: 'frozen',
			backend: 'bucket',
		});
		fault.mockImplementation(put);
		await transfer.activate();
		expect((await transfer.status())!.state).toBe('activated');
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
			await store.put(key, '{"after":"new"}', { customMetadata: { source: 'sql' } });
			await store.delete('_system/source-control-account-cleanup.json');
			await store.put('_system/working-branches/cleanup.json', '{"cursor":"new"}');
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
