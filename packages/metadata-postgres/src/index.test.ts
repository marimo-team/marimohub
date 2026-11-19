import { bucketStorage } from '@marimo-hub/core/ports/metadata';
import { ConflictError } from '@marimo-hub/core/errors';
import type { MetadataTransaction } from '@marimo-hub/core/ports/metadata';
import {
	metadataCompositionContract,
	atomicMetadataContract,
	benchmarkMetadataCohort,
} from '@marimo-hub/core/testing/metadata-contract';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createLogicalStorage } from '@marimo-hub/core/storage/logical-bucket';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { ProjectId, UserId } from '@marimo-hub/core/ids';
import { PostgresMetadataStore, createMetadataPool } from './index';
import { migrateSchema } from './migrations';
import { migrationSources } from './schema';

it('rejects namespaces that cannot round-trip through UTF-8', () => {
	expect(
		() =>
			new PostgresMetadataStore({
				url: 'postgres://unused',
				namespace: '\ud800',
				epoch: 1,
				artifactStoreId: randomUUID(),
			}),
	).toThrow(RangeError);
});

const url = process.env.MARIMOHUB_TEST_POSTGRES_URL;
if (process.env.MARIMOHUB_REQUIRE_POSTGRES_TESTS === '1' && !url)
	throw new Error('MARIMOHUB_TEST_POSTGRES_URL is required');

it('embeds the authoritative SQL files without drift', async () => {
	const files = await Promise.all(
		['001-initial.sql', '002-deployment-guard.sql'].map((name) =>
			readFile(new URL(`../sql/${name}`, import.meta.url), 'utf8'),
		),
	);
	expect(migrationSources).toEqual(files);
});

describe.skipIf(!url)('PostgreSQL metadata (live)', () => {
	let admin: Pool;
	let runtimeUrl: string;
	const role = `metadata_test_${randomUUID().replaceAll('-', '')}`;
	const stores: PostgresMetadataStore[] = [];
	const namespaces: string[] = [];
	beforeAll(async () => {
		admin = createMetadataPool({ url: url!, statementTimeoutMs: 30000 });
		await migrateSchema(admin);
		await migrateSchema(admin);
		await admin.query(
			await readFile(
				new URL('../../../internal/sql/metadata/schema-checks.sql', import.meta.url),
				'utf8',
			),
		);
		const password = randomUUID();
		await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
		await admin.query(`GRANT USAGE ON SCHEMA hub_metadata TO ${role}`);
		await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON hub_metadata.records TO ${role}`);
		await admin.query(`GRANT SELECT, INSERT, UPDATE ON hub_metadata.scopes TO ${role}`);
		await admin.query(
			`GRANT SELECT ON hub_metadata.deployments, hub_metadata.schema_migrations TO ${role}`,
		);
		await admin.query(
			`GRANT EXECUTE ON FUNCTION hub_metadata.prepare_record(), hub_metadata.session_time(text), hub_metadata.guard_deployment(text,bigint,uuid) TO ${role}`,
		);
		const connection = new URL(url!);
		connection.username = role;
		connection.password = password;
		runtimeUrl = connection.toString();
	});
	afterEach(async () => {
		await Promise.all(stores.splice(0).map((store) => store.close()));
	});
	afterAll(async () => {
		if (!admin) return;
		await admin.query('DELETE FROM hub_metadata.records WHERE namespace=ANY($1::text[])', [
			namespaces,
		]);
		await admin.query('DELETE FROM hub_metadata.scopes WHERE namespace=ANY($1::text[])', [
			namespaces,
		]);
		await admin.query('DELETE FROM hub_metadata.deployments WHERE namespace=ANY($1::text[])', [
			namespaces,
		]);
		await admin.query(`DROP OWNED BY ${role}`);
		await admin.query(`DROP ROLE ${role}`);
		await admin.end();
	});

	async function fixture(
		options: {
			ready?: boolean;
			namespace?: string;
			poolMax?: number;
			lockTimeoutMs?: number;
			connectTimeoutMs?: number;
		} = {},
	) {
		const namespace = options.namespace ?? randomUUID();
		const artifactStoreId = randomUUID();
		namespaces.push(namespace);
		await admin.query(
			"INSERT INTO hub_metadata.deployments(namespace,backend_epoch,state,artifact_store_id) VALUES ($1,1,'active',$2)",
			[namespace, artifactStoreId],
		);
		const store = new PostgresMetadataStore({
			url: runtimeUrl,
			namespace,
			epoch: 1,
			artifactStoreId,
			poolMax: options.poolMax,
			lockTimeoutMs: options.lockTimeoutMs,
			connectTimeoutMs: options.connectTimeoutMs,
		});
		stores.push(store);
		if (options.ready !== false) await store.ready();
		return { store, namespace, artifactStoreId };
	}

	bucketContract('PostgresMetadataStore', async () => (await fixture()).store, { metadata: true });

	metadataCompositionContract('PostgreSQL with bucket artifacts', async () => {
		const { store, namespace } = await fixture();
		return {
			...createLogicalStorage(new MemoryBucket(), store, { namespace, epoch: 1 }),
			sessions: store.sessions,
			transactions: store.transactions,
		};
	});

	atomicMetadataContract(async () => {
		const { store, namespace } = await fixture();
		return {
			...createLogicalStorage(new MemoryBucket(), store, { namespace, epoch: 1 }),
			sessions: store.sessions,
			transactions: store.transactions,
		};
	});

	it('fails closed before readiness, on frozen state, and after closing', async () => {
		const { store, namespace } = await fixture({ ready: false });
		await expect(store.get('missing')).rejects.toMatchObject({ kind: 'unavailable' });
		await store.ready();
		await admin.query("UPDATE hub_metadata.deployments SET state='frozen' WHERE namespace=$1", [
			namespace,
		]);
		await expect(store.get('missing')).rejects.toMatchObject({ kind: 'unavailable' });
		await expect(store.put('new', 'x')).rejects.toMatchObject({ kind: 'unavailable' });
		await store.close();
		await expect(store.ready()).rejects.toMatchObject({ kind: 'unavailable' });
	});

	it('rejects malformed ETags and both conditional flags without exposing driver details', async () => {
		const { store } = await fixture();
		await expect(store.put('x', 'x', { onlyIfEtagMatches: 'bad' })).rejects.toMatchObject({
			code: 'PRECONDITION_FAILED',
		});
		await expect(
			store.put('x', 'x', { onlyIfNotExists: true, onlyIfEtagMatches: randomUUID() }),
		).rejects.toBeInstanceOf(RangeError);
	});

	it('treats SQL metacharacters in namespaces, keys, prefixes, and scopes as data', async () => {
		const payload = "x'; DROP TABLE hub_metadata.records; --";
		const { store } = await fixture({ namespace: `${payload}${randomUUID()}` });
		const other = (await fixture()).store;
		const key = `_system/identities/${payload}.json`;
		await store.put(key, 'private');
		await other.put(key, 'other namespace');
		expect(await (await store.get(key))!.text()).toBe('private');
		expect(
			(await store.list({ prefix: `_system/identities/${payload}` })).objects.map(
				(record) => record.key,
			),
		).toEqual([key]);
		await store.transactions.run([payload], async (tx) => {
			const current = (await tx.records.get(key))!;
			await tx.records.put(key, 'updated', { onlyIfEtagMatches: current.etag });
		});
		await store.delete(key);
		expect(await store.get(key)).toBeNull();
		expect(await (await other.get(key))!.text()).toBe('other namespace');
	});
	it('refreshes identical-write and delete/recreate tokens', async () => {
		const { store } = await fixture();
		const first = await store.put('x', 'same');
		const second = await store.put('x', 'same');
		expect(first.etag).not.toBe(second.etag);
		await store.delete('x');
		await store.put('x', 'same');
		await expect(store.put('x', 'wrong', { onlyIfEtagMatches: second.etag })).rejects.toMatchObject(
			{ code: 'PRECONDITION_FAILED' },
		);
	});

	it('isolates namespaces and binds cursors to epoch, query and namespace', async () => {
		const a = await fixture();
		const b = await fixture();
		for (const key of ['%_/a', '%_/b', 'other']) await a.store.put(key, 'a');
		await b.store.put('%_/a', 'b');
		expect(await (await b.store.get('%_/a'))!.text()).toBe('b');
		const first = await a.store.list({ prefix: '%_/', limit: 1 });
		expect(first.objects.map((item) => item.key)).toEqual(['%_/a']);
		await expect(b.store.list({ prefix: '%_/', cursor: first.cursor })).rejects.toBeInstanceOf(
			RangeError,
		);
		await expect(a.store.list({ prefix: 'other', cursor: first.cursor })).rejects.toBeInstanceOf(
			RangeError,
		);
		await admin.query('UPDATE hub_metadata.deployments SET backend_epoch=2 WHERE namespace=$1', [
			a.namespace,
		]);
		await expect(a.store.list({ prefix: '%_/', cursor: first.cursor })).rejects.toMatchObject({
			kind: 'unavailable',
		});
	});

	it('queries authoritative session candidates without excluding terminal unreclaimed sandboxes', async () => {
		const { store } = await fixture();
		const pid = ProjectId.create();
		const userId = UserId.parse('owner');
		for (let i = 0; i < 3; i++) {
			await store.put(
				`_system/sessions/${pid}/s${i}.json`,
				JSON.stringify({
					session_id: `s${i}`,
					project_id: pid,
					notebook_id: 'n',
					user_id: userId,
					status: i === 0 ? 'running' : 'stopped',
					started_at: '2026-01-01T00:00:00Z',
					last_heartbeat: '2026-01-01T00:00:01.999Z',
					sandbox_id: 'sandbox',
					future: { retained: true },
				}),
			);
		}
		const first = await store.sessions.list({ userId, unreclaimedOnly: true, limit: 2 });
		const last = await store.sessions.list({
			userId,
			unreclaimedOnly: true,
			limit: 2,
			cursor: first.cursor,
		});
		expect(first.records).toHaveLength(2);
		expect(last.records).toHaveLength(1);
		expect(await last.records[0].json()).toMatchObject({
			status: 'stopped',
			future: { retained: true },
		});
		expect(
			(await store.sessions.list({ heartbeatBefore: '2026-01-01T00:00:01.999999Z', limit: 10 }))
				.records,
		).toHaveLength(0);
		expect(
			(await store.sessions.list({ heartbeatBefore: '2026-01-01T00:00:02Z', limit: 10 })).records,
		).toHaveLength(3);
		await expect(store.sessions.list({ limit: 1001 })).rejects.toBeInstanceOf(RangeError);
		await expect(store.put(`_system/sessions/${pid}/bad.json`, '{}')).rejects.toMatchObject({
			kind: 'corrupt',
		});
	});

	it('paginates more than 1000 rows and skips large delimiter groups', async () => {
		const { store, namespace } = await fixture();
		await admin.query(
			"INSERT INTO hub_metadata.records(namespace,key,body) SELECT $1,'many/' || lpad(i::text,4,'0'),'\\x'::bytea FROM generate_series(1,1005) AS i",
			[namespace],
		);
		await store.put('next/value', 'x');
		const first = await store.list({ limit: 1000, prefix: 'many/' });
		expect(first.objects).toHaveLength(1000);
		await store.delete(first.objects[999].key);
		const last = await store.list({ prefix: 'many/', cursor: first.cursor });
		expect(last.objects).toHaveLength(5);
		const grouped = await store.list({ delimiter: '/', limit: 1 });
		expect(grouped.delimitedPrefixes).toEqual(['many/']);
		expect(
			(await store.list({ delimiter: '/', limit: 1, cursor: grouped.cursor })).delimitedPrefixes,
		).toEqual(['next/']);
	});

	it('cannot activate or truncate through the runtime role', async () => {
		const pool = createMetadataPool({ url: runtimeUrl });
		try {
			await expect(
				pool.query("UPDATE hub_metadata.deployments SET state='active'"),
			).rejects.toMatchObject({ code: '42501' });
			await expect(pool.query('TRUNCATE hub_metadata.records')).rejects.toMatchObject({
				code: '42501',
			});
			await expect(pool.query('DELETE FROM hub_metadata.scopes')).rejects.toMatchObject({
				code: '42501',
			});
			await expect(pool.query('DELETE FROM hub_metadata.transfers')).rejects.toMatchObject({
				code: '42501',
			});
		} finally {
			await pool.end();
		}
	});

	it('times out behind a deployment freeze lock and returns a reusable connection', async () => {
		const { store, namespace } = await fixture({ poolMax: 1, lockTimeoutMs: 50 });
		const blocker = await admin.connect();
		try {
			await blocker.query('BEGIN');
			await blocker.query('SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE', [
				namespace,
			]);
			await expect(store.put('x', 'x')).rejects.toMatchObject({
				kind: 'unavailable',
				sqlState: '55P03',
			});
			await blocker.query('ROLLBACK');
			expect(await store.get('x')).toBeNull();
			await store.put('x', 'ok');
		} finally {
			await blocker.query('ROLLBACK');
			blocker.release();
		}
	});
	it.each(['importing', 'frozen', 'retired'])(
		'rejects every operation while the deployment is %s',
		async (state) => {
			const { store, namespace } = await fixture();
			await store.put('retained', 'value');
			await admin.query('UPDATE hub_metadata.deployments SET state=$2 WHERE namespace=$1', [
				namespace,
				state,
			]);
			for (const work of [
				() => store.get('retained'),
				() => store.head('retained'),
				() => store.put('retained', 'wrong'),
				() => store.delete('retained'),
				() => store.list(),
				() => store.sessions.list({ limit: 1 }),
			]) {
				await expect(work()).rejects.toMatchObject({ kind: 'unavailable' });
			}
			await admin.query("UPDATE hub_metadata.deployments SET state='active' WHERE namespace=$1", [
				namespace,
			]);
			expect(await (await store.get('retained'))!.text()).toBe('value');
		},
	);

	it.each(['epoch', 'artifactStoreId', 'namespace'] as const)(
		'rejects readiness with the wrong %s',
		async (field) => {
			const fixtureValue = await fixture();
			const invalid = new PostgresMetadataStore({
				url: runtimeUrl,
				namespace: fixtureValue.namespace,
				artifactStoreId: fixtureValue.artifactStoreId,
				epoch: 1,
				[field]: field === 'epoch' ? 2 : randomUUID(),
			});
			stores.push(invalid);
			await expect(invalid.ready()).rejects.toMatchObject({ kind: 'unavailable' });
			await expect(invalid.get('missing')).rejects.toMatchObject({ kind: 'unavailable' });
		},
	);

	it('can retry readiness after a checksum mismatch without accepting early writes', async () => {
		const { store } = await fixture({ ready: false });
		const previous = (
			await admin.query<{ checksum: string }>(
				'SELECT checksum FROM hub_metadata.schema_migrations WHERE version=2',
			)
		).rows[0].checksum;
		try {
			await admin.query(
				"UPDATE hub_metadata.schema_migrations SET checksum=repeat('0',64) WHERE version=2",
			);
			await expect(store.ready()).rejects.toMatchObject({ kind: 'unavailable' });
			await expect(store.put('x', 'x')).rejects.toMatchObject({ kind: 'unavailable' });
		} finally {
			await admin.query('UPDATE hub_metadata.schema_migrations SET checksum=$1 WHERE version=2', [
				previous,
			]);
		}
		await store.ready();
		await store.put('x', 'ok');
	});

	async function waitForBlockedRuntime(): Promise<number> {
		let pid = 0;
		await vi.waitFor(
			async () => {
				const rows = (
					await admin.query<{ pid: number }>(
						"SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",
						[role],
					)
				).rows;
				expect(rows).toHaveLength(1);
				pid = rows[0].pid;
			},
			{ timeout: 2000 },
		);
		return pid;
	}

	it('bounds pool acquisition and resumes after the occupied connection is released', async () => {
		const { store, namespace } = await fixture({ poolMax: 1, connectTimeoutMs: 50 });
		const blocker = await admin.connect();
		let write: Promise<unknown> | undefined;
		try {
			await blocker.query('BEGIN');
			await blocker.query('SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE', [
				namespace,
			]);
			write = store.put('pending', 'ok');
			void write.catch(() => {});
			await waitForBlockedRuntime();
			await expect(store.get('pending')).rejects.toMatchObject({ kind: 'unavailable' });
			await blocker.query('ROLLBACK');
			await write;
			expect(await (await store.get('pending'))!.text()).toBe('ok');
		} finally {
			await blocker.query('ROLLBACK');
			blocker.release();
			await write?.catch(() => {});
		}
	});

	it.each(['cancel', 'terminate'])(
		'recovers after the database %s interrupts a statement',
		async (action) => {
			const { store, namespace } = await fixture({ poolMax: 1 });
			const blocker = await admin.connect();
			let write: Promise<unknown> | undefined;
			try {
				await blocker.query('BEGIN');
				await blocker.query(
					'SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE',
					[namespace],
				);
				write = store.put('interrupted', 'wrong');
				void write.catch(() => {});
				const pid = await waitForBlockedRuntime();
				await admin.query(
					action === 'cancel' ? 'SELECT pg_cancel_backend($1)' : 'SELECT pg_terminate_backend($1)',
					[pid],
				);
				await expect(write).rejects.toMatchObject({ kind: 'unavailable' });
				await blocker.query('ROLLBACK');
				expect(await store.get('interrupted')).toBeNull();
				await store.put('recovered', 'ok');
			} finally {
				await blocker.query('ROLLBACK');
				blocker.release();
				await write?.catch(() => {});
			}
		},
	);

	it('makes all concurrent close callers wait for in-flight work', async () => {
		const { store, namespace } = await fixture({ poolMax: 1 });
		const blocker = await admin.connect();
		let write: Promise<unknown> | undefined;
		const closes: Promise<void>[] = [];
		try {
			await blocker.query('BEGIN');
			await blocker.query('SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE', [
				namespace,
			]);
			write = store.put('pending', 'ok');
			void write.catch(() => {});
			await waitForBlockedRuntime();
			const finished = [false, false];
			closes.push(
				...finished.map((_, index) =>
					store.close().then(() => {
						finished[index] = true;
					}),
				),
			);
			await admin.query('SELECT 1');
			expect(finished).toEqual([false, false]);
			await expect(store.get('pending')).rejects.toMatchObject({ kind: 'unavailable' });
		} finally {
			await blocker.query('ROLLBACK');
			blocker.release();
			await write?.catch(() => {});
			await Promise.all(closes);
		}
	});

	it('rejects invalid batch keys before deleting any valid record', async () => {
		const { store } = await fixture();
		await store.put('kept', 'ok');
		await expect(store.delete(['kept', '\u0000'])).rejects.toBeInstanceOf(RangeError);
		expect(await (await store.get('kept'))!.text()).toBe('ok');
	});

	it('handles escaped LIKE characters and Unicode delimiter upper bounds', async () => {
		const { store } = await fixture();
		const prefix = 'a%_\\';
		for (const key of [
			`${prefix}x`,
			'abcdx',
			'a\ud7ff/1',
			'a\ue000/1',
			'z\u{10ffff}/1',
			'z\u{10ffff}/2',
			'zz',
		])
			await store.put(key, key);
		expect((await store.list({ prefix })).objects.map((object) => object.key)).toEqual([
			`${prefix}x`,
		]);
		const first = await store.list({
			prefix: 'a',
			delimiter: '\ud7ff',
			limit: 1,
			startAfter: 'abcdx',
		});
		const all = await store.list({ prefix: 'z', delimiter: '\u{10ffff}', limit: 1 });
		expect(all.objects.map((object) => object.key)).toEqual(['zz']);
		expect(
			(await store.list({ prefix: 'z', delimiter: '\u{10ffff}', cursor: all.cursor }))
				.delimitedPrefixes,
		).toEqual(['z\u{10ffff}']);
		expect(first.delimitedPrefixes).toEqual(['a\ud7ff']);
		expect(first.truncated).toBe(true);
		const next = await store.list({
			prefix: 'a',
			delimiter: '\ud7ff',
			limit: 1,
			cursor: first.cursor,
		});
		expect(next.objects.map((object) => object.key)).toEqual(['a\ue000/1']);
		expect(next.truncated).toBe(false);
	});
	it('holds the deployment fence until the record write commits', async () => {
		const { store, namespace } = await fixture();
		await store.put('blocked', 'before');
		const blocker = await admin.connect();
		const freezer = await admin.connect();
		let write: Promise<unknown> | undefined;
		try {
			await blocker.query('BEGIN');
			await blocker.query(
				"SELECT * FROM hub_metadata.records WHERE namespace=$1 AND key='blocked' FOR UPDATE",
				[namespace],
			);
			write = store.put('blocked', 'after');
			void write.catch(() => {});
			await waitForBlockedRuntime();
			await freezer.query("SET lock_timeout='50ms'");
			await expect(
				freezer.query("UPDATE hub_metadata.deployments SET state='frozen' WHERE namespace=$1", [
					namespace,
				]),
			).rejects.toMatchObject({ code: '55P03' });
			await blocker.query('ROLLBACK');
			await write;
			await freezer.query("UPDATE hub_metadata.deployments SET state='frozen' WHERE namespace=$1", [
				namespace,
			]);
			await expect(store.put('blocked', 'late')).rejects.toMatchObject({ kind: 'unavailable' });
			const row = (
				await admin.query<{ body: Buffer }>(
					"SELECT body FROM hub_metadata.records WHERE namespace=$1 AND key='blocked'",
					[namespace],
				)
			).rows[0];
			expect(row.body.toString()).toBe('after');
		} finally {
			await blocker.query('ROLLBACK');
			blocker.release();
			await freezer.query('RESET lock_timeout');
			freezer.release();
			await write?.catch(() => {});
		}
	});

	it('rejects readiness if shutdown starts while its deployment check is blocked', async () => {
		const { store, namespace } = await fixture({ ready: false });
		const blocker = await admin.connect();
		let ready: Promise<void> | undefined;
		let close: Promise<void> | undefined;
		try {
			await blocker.query('BEGIN');
			await blocker.query('SELECT * FROM hub_metadata.deployments WHERE namespace=$1 FOR UPDATE', [
				namespace,
			]);
			ready = store.ready();
			void ready.catch(() => {});
			await waitForBlockedRuntime();
			close = store.close();
			await blocker.query('ROLLBACK');
			await expect(ready).rejects.toMatchObject({ kind: 'unavailable' });
			await close;
			await expect(store.ready()).rejects.toMatchObject({ kind: 'unavailable' });
		} finally {
			await blocker.query('ROLLBACK');
			blocker.release();
			await ready?.catch(() => {});
			await close;
		}
	});

	it('rejects malformed cursors and invalid UTF-8 keys without poisoning the pool', async () => {
		const { store } = await fixture({ poolMax: 1 });
		for (const cursor of ['not-json', Buffer.from('[]').toString('base64url')]) {
			await expect(store.list({ cursor })).rejects.toBeInstanceOf(RangeError);
			await expect(store.sessions.list({ cursor, limit: 1 })).rejects.toBeInstanceOf(RangeError);
		}
		for (const key of ['', '\u0000', '\ud800', 'é'.repeat(513)]) {
			await expect(store.put(key, 'wrong')).rejects.toBeInstanceOf(RangeError);
			await expect(store.get(key)).rejects.toBeInstanceOf(RangeError);
		}
		const key = 'é'.repeat(512);
		await store.put(key, 'boundary');
		expect(await (await store.get(key))!.text()).toBe('boundary');
	});
	it('rolls back a multi-record transaction and preserves domain failures', async () => {
		const { store } = await fixture();
		await expect(
			store.transactions.run(['["user","one"]'], async (tx) => {
				await tx.records.put('_system/host-retry-cleanup.json', '{}');
				await tx.records.put('_system/source-control-account-cleanup.json', '{}');
				throw new ConflictError('policy changed');
			}),
		).rejects.toThrow('policy changed');
		expect(await store.get('_system/host-retry-cleanup.json')).toBeNull();
		expect(await store.get('_system/source-control-account-cleanup.json')).toBeNull();
	});
	it('serializes overlapping scopes regardless of caller order', async () => {
		const { store } = await fixture();
		const key = '_system/host-retry-cleanup.json';
		await store.put(key, '{"count":0}');
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.transactions.run(index % 2 ? ['b', 'a'] : ['a', 'b'], async (tx) => {
					const object = (await tx.records.get(key))!;
					const { count } = await object.json<{ count: number }>();
					await tx.records.put(key, JSON.stringify({ count: count + 1 }), {
						onlyIfEtagMatches: object.etag,
					});
				}),
			),
		);
		expect(await (await store.get(key))!.json()).toEqual({ count: 8 });
	});
	it('rejects escaped handles and artifact writes', async () => {
		const { store } = await fixture();
		let escaped: MetadataTransaction | undefined;
		await store.transactions.run(['a'], async (tx) => {
			escaped = tx;
		});
		await expect(escaped!.records.get('_system/catalog.json')).rejects.toThrow('ended');
		await expect(
			store.transactions.run(['a'], async (tx) =>
				tx.records.put('projects/p/notebooks/n/workspace/file', 'x'),
			),
		).rejects.toThrow();
		await expect(store.transactions.run([], async () => {})).rejects.toThrow(RangeError);
	});
	it('records matched metadata cohorts without provider or artifact-latency claims', async () => {
		const baseline = await benchmarkMetadataCohort(bucketStorage(new MemoryBucket()));
		const compatible = await fixture();
		const compatibilityStorage = {
			...createLogicalStorage(new MemoryBucket(), compatible.store, {
				namespace: compatible.namespace,
				epoch: 1,
			}),
			sessions: compatible.store.sessions,
		};
		const compatibility = await benchmarkMetadataCohort(compatibilityStorage);
		const consolidated = await fixture();
		const consolidation = await benchmarkMetadataCohort({
			...createLogicalStorage(new MemoryBucket(), consolidated.store, {
				namespace: consolidated.namespace,
				epoch: 1,
			}),
			sessions: consolidated.store.sessions,
			transactions: consolidated.store.transactions,
		});
		console.log(
			JSON.stringify({ metadataPerformance: { baseline, compatibility, consolidation } }),
		);
		expect(consolidation.counters.transactions).toBeGreaterThan(0);
	}, 60000);
});
