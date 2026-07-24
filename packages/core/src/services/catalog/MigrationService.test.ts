import { describe, it, expect, beforeEach } from 'vitest';
import { createNotebookId, createProjectId } from '../../ids';
import { MemoryBucket, makeNotebookMeta } from '../../testing';
import type { BucketListOptions } from '../../ports/bucket';
import { paths } from '../../paths';
import { EventService } from './EventService';
import { MigrationService, exampleMigrateV1toV2 } from './MigrationService';
import type { MigrateFn } from './MigrationService';

/** Forces a tiny list page so the cursor loop is exercised without 1000+ objects. */
class SmallPageBucket extends MemoryBucket {
	constructor(private readonly pageSize: number) {
		super();
	}
	override list(options?: BucketListOptions) {
		return super.list({ ...options, limit: options?.limit ?? this.pageSize });
	}
}

describe('MigrationService (prototype, unwired)', () => {
	let bucket: MemoryBucket;
	let migrations: MigrationService;

	// Seed three meta.json objects under distinct notebook keys.
	async function seedMeta(count: number): Promise<string[]> {
		const keys: string[] = [];
		const projectId = createProjectId();
		for (let i = 0; i < count; i++) {
			const notebookId = createNotebookId();
			const key = paths.project(projectId).notebook(notebookId).meta;
			const meta = makeNotebookMeta({ id: notebookId, project_id: projectId });
			await bucket.put(key, JSON.stringify(meta));
			keys.push(key);
		}
		return keys;
	}

	beforeEach(() => {
		bucket = new MemoryBucket();
		migrations = new MigrationService(bucket);
	});

	it('migrates every v1 object exactly once', async () => {
		const keys = await seedMeta(3);

		const result = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		expect(result.scanned).toBe(3);
		expect(result.migrated).toBe(3);
		expect(result.skipped).toBe(0);

		for (const key of keys) {
			const obj = await bucket.get(key);
			const data = await obj!.json<any>();
			expect(data.schema_version).toBe(2);
			expect(data.migrated_marker).toBe(true);
		}
	});

	it('is idempotent — a second run migrates nothing', async () => {
		await seedMeta(3);

		const first = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);
		expect(first.migrated).toBe(3);

		// Second run: every object is now at v2, so the schema_version guard skips
		// all of them — each object is migrated at most once across both runs.
		const second = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);
		expect(second.scanned).toBe(3);
		expect(second.migrated).toBe(0);
		expect(second.skipped).toBe(3);
	});

	it('only migrates objects still at fromVersion (mixed-version corpus)', async () => {
		// Two v1 objects plus one already-migrated v2 object.
		const keys = await seedMeta(2);
		const projectId = createProjectId();
		const notebookId = createNotebookId();
		const v2Key = paths.project(projectId).notebook(notebookId).meta;
		await bucket.put(
			v2Key,
			JSON.stringify({
				...makeNotebookMeta({ id: notebookId, project_id: projectId }),
				schema_version: 2,
				migrated_marker: true,
			}),
		);

		const result = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		expect(result.scanned).toBe(3);
		expect(result.migrated).toBe(2); // only the two v1 objects
		expect(result.skipped).toBe(1); // the pre-existing v2 object

		for (const key of [...keys, v2Key]) {
			const data = await (await bucket.get(key))!.json<any>();
			expect(data.schema_version).toBe(2);
		}
	});

	it('emits a migration.run event on completion', async () => {
		await seedMeta(2);
		await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		const date = new Date().toISOString().slice(0, 10);
		const events = await new EventService(bucket).getEvents(date);
		const run = events.find((e) => e.event === 'migration.run');
		expect(run).toBeDefined();
		expect((run as any).from_version).toBe(1);
		expect((run as any).to_version).toBe(2);
		expect((run as any).migrated).toBe(2);
	});

	it('leaves already-migrated objects intact when migrateFn throws mid-run', async () => {
		await seedMeta(3);
		let n = 0;
		const migrateThrows: MigrateFn = (data) => {
			if (n++ === 1) throw new Error('mid-run boom');
			return { ...data, migrated_marker: true };
		};

		await expect(migrations.runMigration(1, 2, 'meta', migrateThrows)).rejects.toThrow(
			'mid-run boom',
		);

		// The object migrated before the throw stays at v2 (not rolled back).
		const metas = await Promise.all(
			(await bucket.list({ prefix: 'projects/' })).objects.map(async (o) =>
				(await bucket.get(o.key))!.json<any>(),
			),
		);
		expect(metas.filter((m) => m.schema_version === 2)).toHaveLength(1);
	});

	it('does not abort the whole run on one malformed object', async () => {
		const validKeys = await seedMeta(2);
		// A corrupt meta.json (invalid JSON) under the scanned prefix/suffix.
		const projectId = createProjectId();
		const notebookId = createNotebookId();
		const badKey = paths.project(projectId).notebook(notebookId).meta;
		await bucket.put(badKey, 'not-json{');

		const result = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		// The two valid objects should migrate despite the corrupt sibling.
		expect(result.migrated).toBe(2);
		for (const key of validKeys) {
			expect((await (await bucket.get(key))!.json<any>()).schema_version).toBe(2);
		}
	});

	it('skips a JSON-valid but non-object record (e.g. null) without aborting', async () => {
		const validKeys = await seedMeta(2);
		// Valid JSON, but `null` — reading `.schema_version` off it would throw.
		const badKey = paths.project(createProjectId()).notebook(createNotebookId()).meta;
		await bucket.put(badKey, 'null');

		const result = await migrations.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		expect(result.migrated).toBe(2);
		expect(result.skipped).toBe(1);
		for (const key of validKeys) {
			expect((await (await bucket.get(key))!.json<any>()).schema_version).toBe(2);
		}
	});

	it('resumes across multiple cursor pages', async () => {
		const small = new SmallPageBucket(2);
		const svc = new MigrationService(small);
		const projectId = createProjectId();
		const keys: string[] = [];
		for (let i = 0; i < 5; i++) {
			const notebookId = createNotebookId();
			const key = paths.project(projectId).notebook(notebookId).meta;
			await small.put(
				key,
				JSON.stringify(makeNotebookMeta({ id: notebookId, project_id: projectId })),
			);
			keys.push(key);
		}

		const result = await svc.runMigration(1, 2, 'meta', exampleMigrateV1toV2);

		expect(result.scanned).toBe(5);
		expect(result.migrated).toBe(5);
		for (const key of keys) {
			expect((await (await small.get(key))!.json<any>()).schema_version).toBe(2);
		}
	});

	it('exampleMigrateV1toV2 is pure and leaves schema_version to the runner', () => {
		const input = { schema_version: 1, foo: 'bar' };
		const output = exampleMigrateV1toV2(input);
		expect(output.migrated_marker).toBe(true);
		expect(output.foo).toBe('bar');
		// The migrate fn must not stamp schema_version itself — the runner does.
		expect(output.schema_version).toBe(1);
		// Input is not mutated.
		expect(input).not.toHaveProperty('migrated_marker');
	});
});
