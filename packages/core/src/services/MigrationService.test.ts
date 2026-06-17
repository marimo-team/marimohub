import { describe, it, expect, beforeEach } from 'vitest';
import { createNotebookId, createProjectId } from '../ids';
import { MemoryBucket, makeNotebookMeta } from '../testing';
import { paths } from '../paths';
import { EventService } from './EventService';
import { MigrationService, exampleMigrateV1toV2 } from './MigrationService';

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
