import { describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createVersionId } from '../../ids';
import { paths } from '../../paths';
import { MemoryBucket } from '../../testing';
import { resolveLaunchStrategyForSession } from './launchStrategy';

const INLINE_NOTEBOOK = ['# /// script', '# dependencies = ["cowsay==6.1"]', '# ///', ''].join(
	'\n',
);
const ENTRY = 'apps/dash.py';
// The real paths helper, so a trailing-slash change in workspacePrefix breaks here.
const PREFIX = paths
	.project(createProjectId())
	.notebook(createNotebookId())
	.version(createVersionId()).workspacePrefix;

async function seededBucket(entryCode: string): Promise<MemoryBucket> {
	const bucket = new MemoryBucket();
	await bucket.put(PREFIX + ENTRY, entryCode);
	return bucket;
}

describe('resolveLaunchStrategyForSession', () => {
	it('uses the default without reading the bucket when there is no synced workspace', async () => {
		const bucket = new MemoryBucket();
		const get = vi.spyOn(bucket, 'get');
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: 'notebook.py',
			bucket,
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: false });
		expect(get).not.toHaveBeenCalled();
	});

	it('detects inline metadata in the synced entry file', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: ENTRY,
			workspacePrefix: PREFIX,
			bucket: await seededBucket(INLINE_NOTEBOOK),
		});
		expect(resolved).toEqual({ strategy: 'uv-script-pins', detectionFailed: false });
	});

	it('uses the default when the entry file has no inline metadata', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: ENTRY,
			workspacePrefix: PREFIX,
			bucket: await seededBucket('import marimo\n'),
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: false });
	});

	it('falls back leniently when the entry file is missing', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: ENTRY,
			workspacePrefix: PREFIX,
			bucket: new MemoryBucket(),
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});

	it('falls back leniently when the bucket read throws', async () => {
		const bucket = new MemoryBucket();
		bucket.get = () => Promise.reject(new Error('boom'));
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: ENTRY,
			workspacePrefix: PREFIX,
			bucket,
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});

	it('falls back leniently when the entry file fails to decode', async () => {
		const bucket = await seededBucket(INLINE_NOTEBOOK);
		const object = await bucket.get(PREFIX + ENTRY);
		vi.spyOn(bucket, 'get').mockResolvedValue({
			...object!,
			text: () => Promise.reject(new Error('bad encoding')),
		});
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebook: ENTRY,
			workspacePrefix: PREFIX,
			bucket,
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});
});
