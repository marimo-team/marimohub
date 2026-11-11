import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { CatalogService, ProjectService, SYSTEM_ACTOR } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';

vi.mock('@marimo-hub/config', () => ({ loadAdapterLibraries: vi.fn(), makeStorage: vi.fn() }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it('repairs the configured storage without a generation setting', async () => {
	const bucket = new MemoryBucket();
	const catalog = new CatalogService(bucket);
	await catalog.initialize(SYSTEM_ACTOR);
	await new ProjectService(bucket, catalog).createProject(
		{ name: 'Existing', description: '' },
		SYSTEM_ACTOR,
	);
	vi.mocked(makeStorage).mockReturnValue(bucket);
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await import('./project-access-rebuild');
	expect(loadAdapterLibraries).toHaveBeenCalledWith(process.env);
	expect((await catalog.getCurrentSnapshot()).projects[0].access?.version).toBe(1);
	expect(log).toHaveBeenCalledWith(
		'Project access summaries rebuilt; pending mutations remain untrusted.',
	);
});

it('propagates storage failures without reporting success', async () => {
	vi.mocked(loadAdapterLibraries).mockRejectedValueOnce(new Error('storage unavailable'));
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await expect(import('./project-access-rebuild')).rejects.toThrow('storage unavailable');
	expect(log).not.toHaveBeenCalled();
});
