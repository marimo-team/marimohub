import { describe, expect, it, vi } from 'vitest';
import { CatalogService, createServices } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { runCatalogRecovery } from './catalogRecovery';

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
	});
});
