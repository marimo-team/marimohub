import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	storageBackend: vi.fn(),
	makeStorage: vi.fn(),
	recover: vi.fn(),
}));
vi.mock('@marimo-hub/config', () => ({
	storageBackend: mocks.storageBackend,
	makeStorage: mocks.makeStorage,
}));
vi.mock('@marimo-hub/core', () => ({ NotebookMoveService: { recover: mocks.recover } }));

const originalArgv = process.argv;
beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	process.argv = ['node', 'notebook-move-recovery', '--writers-stopped'];
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
});

describe('notebook move recovery command', () => {
	it.each(['memory', 'r2', 'library'])(
		'rejects the %s backend before opening storage',
		async (backend) => {
			mocks.storageBackend.mockReturnValue(backend);
			await expect(import('./notebook-move-recovery')).rejects.toThrow(
				'supports s3, gcs, azure, and fs',
			);
			expect(mocks.makeStorage).not.toHaveBeenCalled();
			expect(mocks.recover).not.toHaveBeenCalled();
			expect(console.log).not.toHaveBeenCalled();
		},
	);

	it('requires writers to be stopped before opening storage', async () => {
		process.argv = ['node', 'notebook-move-recovery'];
		await expect(import('./notebook-move-recovery')).rejects.toThrow('--writers-stopped');
		expect(mocks.makeStorage).not.toHaveBeenCalled();
	});

	it.each(['s3', 'gcs', 'azure', 'fs'])('recovers the deployment %s bucket', async (backend) => {
		const bucket = {};
		const pending = [{ idempotency_key: 'retry-me' }];
		mocks.storageBackend.mockReturnValue(backend);
		mocks.makeStorage.mockReturnValue(bucket);
		mocks.recover.mockResolvedValue(pending);
		await import('./notebook-move-recovery');
		expect(mocks.makeStorage).toHaveBeenCalledWith(process.env);
		expect(mocks.recover).toHaveBeenCalledWith(bucket, { writersStopped: true });
		expect(console.log).toHaveBeenCalledWith(JSON.stringify(pending, null, 2));
	});
});
