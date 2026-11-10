import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { CatalogService, ProjectService, SYSTEM_ACTOR } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';

vi.mock('@marimo-hub/config', () => ({ loadAdapterLibraries: vi.fn(), makeStorage: vi.fn() }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv('MARIMOHUB_PROJECT_ACCESS_GENERATION', ' deployment-v2 ');
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it('refreshes the configured storage using the trimmed generation', async () => {
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
	expect((await catalog.getCurrentSnapshot()).projects[0].access?.generation).toBe('deployment-v2');
	expect(log).toHaveBeenCalledWith(
		'Project access summaries rebuilt; pending mutations remain untrusted.',
	);
});

it.each([undefined, '   '])('rejects generation %s before loading storage', async (generation) => {
	vi.stubEnv('MARIMOHUB_PROJECT_ACCESS_GENERATION', generation);
	await expect(import('./project-access-rebuild')).rejects.toThrow(
		'MARIMOHUB_PROJECT_ACCESS_GENERATION is required',
	);
	expect(loadAdapterLibraries).not.toHaveBeenCalled();
	expect(makeStorage).not.toHaveBeenCalled();
});

it('propagates storage failures without reporting success', async () => {
	vi.mocked(loadAdapterLibraries).mockRejectedValueOnce(new Error('storage unavailable'));
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await expect(import('./project-access-rebuild')).rejects.toThrow('storage unavailable');
	expect(log).not.toHaveBeenCalled();
});
