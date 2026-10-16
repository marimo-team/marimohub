import { describe, expect, it, vi } from 'vitest';
import { CatalogService, EventService, createServices } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { blockedRecoveryMessage, catalogRecoveryMain, runCatalogRecovery } from './catalogRecovery';

describe('catalog recovery command', () => {
	it('prints help and rejects ambiguous modes without opening storage', async () => {
		const makeBucket = vi.fn(() => new MemoryBucket());
		expect(await runCatalogRecovery(['--help'], makeBucket)).toContain('Dry-run is the default');
		await expect(runCatalogRecovery([], makeBucket)).rejects.toThrow('exactly one');
		await expect(
			runCatalogRecovery(['--rebuild', '--snapshot', 'bad'], makeBucket),
		).rejects.toThrow('exactly one');
		await expect(runCatalogRecovery(['--rebuild', '--apply', 'token'], makeBucket)).rejects.toThrow(
			'writers-stopped',
		);
		expect(makeBucket).not.toHaveBeenCalled();
	});

	it('defaults to dry-run and only applies a reviewed token with explicit operator flags', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		const project = await services.projects.createProject(
			{ name: 'Retained', description: '' },
			ACTOR,
		);
		await bucket.delete('_system/catalog.json');
		const put = vi.spyOn(bucket, 'put');
		const report = await runCatalogRecovery(['--rebuild'], () => bucket);
		expect(report).toMatchObject({ projects: [{ id: project.id }] });
		expect(put).not.toHaveBeenCalled();
		const { token } = await new CatalogService(bucket).planRecovery({ mode: 'rebuild' });
		expect(
			await runCatalogRecovery(
				['--rebuild', '--apply', token, '--writers-stopped', '--actor', ACTOR, '--accept-warnings'],
				() => bucket,
			),
		).toMatchObject({ projects: 1 });
		expect((await services.projects.listProjects())[0].id).toBe(project.id);
		const events = await new EventService(bucket).getEvents(new Date().toISOString().slice(0, 10));
		expect(events).toContainEqual(
			expect.objectContaining({
				event: 'system.recover',
				actor: ACTOR,
				source: { mode: 'rebuild' },
			}),
		);
	});

	it('describes the blocking errors of a dry-run report and nothing for help output', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		const project = await services.projects.createProject(
			{ name: 'Broken', description: '' },
			ACTOR,
		);
		await bucket.put(`projects/${project.id}/project.json`, '{');
		await bucket.delete('_system/catalog.json');
		const report = await runCatalogRecovery(['--rebuild'], () => bucket);
		expect(blockedRecoveryMessage(report)).toContain(`projects/${project.id}/project.json`);
		expect(blockedRecoveryMessage(await runCatalogRecovery(['--help'], () => bucket))).toBe(
			undefined,
		);
	});

	it('exits 2 on a blocked dry-run, 1 on failure, and 0 otherwise', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		const project = await services.projects.createProject(
			{ name: 'Broken', description: '' },
			ACTOR,
		);
		await bucket.delete('_system/catalog.json');
		const io = { log: vi.fn(), error: vi.fn() };
		expect(await catalogRecoveryMain(['--rebuild'], () => bucket, io)).toBe(0);
		expect(io.error).not.toHaveBeenCalled();

		await bucket.put(`projects/${project.id}/project.json`, '{');
		expect(await catalogRecoveryMain(['--rebuild'], () => bucket, io)).toBe(2);
		expect(io.error).toHaveBeenLastCalledWith(
			expect.stringContaining(`projects/${project.id}/project.json`),
		);

		expect(await catalogRecoveryMain(['--bogus'], () => bucket, io)).toBe(1);
		expect(io.log).toHaveBeenCalledTimes(2);
	});

	it('removes its uncommitted snapshot when another writer wins the catalog CAS', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		await services.projects.createProject({ name: 'Retained', description: '' }, ACTOR);
		await bucket.delete('_system/catalog.json');
		const { token } = await new CatalogService(bucket).planRecovery({ mode: 'rebuild' });
		const snapshotKeys = async () =>
			(await bucket.list({ prefix: '_system/snapshots/' })).objects.map((object) => object.key);
		const before = await snapshotKeys();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (key, value, options) => {
			if (key === '_system/catalog.json') await put(key, '{}');
			return put(key, value, options);
		});
		await expect(
			runCatalogRecovery(
				['--rebuild', '--apply', token, '--writers-stopped', '--actor', ACTOR, '--accept-warnings'],
				() => bucket,
			),
		).rejects.toThrow('conflict');
		expect(await snapshotKeys()).toEqual(before);
	});
	it.each([
		['--unknown'],
		['--snapshot', 'not-a-snapshot-id'],
		['--snapshot'],
		['--rebuild', '--apply', '', '--writers-stopped', '--actor', ACTOR],
		['--rebuild', '--apply', 'token', '--writers-stopped'],
		['--rebuild', '--apply', 'token', '--actor', ACTOR],
		['--rebuild', 'unexpected-positional-argument'],
	])('rejects invalid arguments before opening storage: %j', async (...args) => {
		const makeBucket = vi.fn(() => new MemoryBucket());
		await expect(runCatalogRecovery(args, makeBucket)).rejects.toThrow();
		expect(makeBucket).not.toHaveBeenCalled();
	});

	it('does not apply a report with unaccepted warnings or a stale token', async () => {
		const bucket = new MemoryBucket();
		const catalog = new CatalogService(bucket);
		await catalog.initialize(ACTOR);
		const { token } = await catalog.planRecovery({ mode: 'rebuild' });
		const put = vi.spyOn(bucket, 'put');
		await expect(
			runCatalogRecovery(
				['--rebuild', '--apply', token, '--writers-stopped', '--actor', ACTOR],
				() => bucket,
			),
		).rejects.toThrow('warnings');
		await expect(
			runCatalogRecovery(
				[
					'--rebuild',
					'--apply',
					'stale-token',
					'--writers-stopped',
					'--actor',
					ACTOR,
					'--accept-warnings',
				],
				() => bucket,
			),
		).rejects.toThrow('stale');
		expect(put).not.toHaveBeenCalled();
	});

	it('applies a selected snapshot report without reconstructing later projects', async () => {
		const bucket = new MemoryBucket();
		const services = createServices(bucket);
		await services.catalog.initialize(ACTOR);
		const original = await services.projects.createProject(
			{ name: 'Original', description: '' },
			ACTOR,
		);
		const selected = await services.catalog.getCurrentSnapshot();
		await services.projects.createProject({ name: 'Later', description: '' }, ACTOR);
		const source = { mode: 'snapshot', snapshotId: selected.snapshot_id } as const;
		const { token } = await services.catalog.planRecovery(source);
		expect(
			await runCatalogRecovery(['--snapshot', selected.snapshot_id], () => bucket),
		).toMatchObject({ token, projects: [{ id: original.id }] });
		await runCatalogRecovery(
			['--snapshot', selected.snapshot_id, '--apply', token, '--writers-stopped', '--actor', ACTOR],
			() => bucket,
		);
		expect((await services.projects.listProjects()).map((project) => project.id)).toEqual([
			original.id,
		]);
	});
});
