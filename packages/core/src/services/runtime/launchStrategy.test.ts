import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { resolveLaunchStrategyForSession } from './launchStrategy';

const INLINE_NOTEBOOK = ['# /// script', '# dependencies = ["cowsay==6.1"]', '# ///', ''].join(
	'\n',
);
const ENTRY_KEY = 'workspace/notebook.py';

async function seededBucket(entryCode: string): Promise<MemoryBucket> {
	const bucket = new MemoryBucket();
	await bucket.put(ENTRY_KEY, entryCode);
	return bucket;
}

describe('resolveLaunchStrategyForSession', () => {
	it('detects inline metadata in the selected source', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket: await seededBucket(INLINE_NOTEBOOK),
		});
		expect(resolved).toEqual({ strategy: 'uv-script-pins', detectionFailed: false });
	});

	it.each([
		'# /// script\n# dependencies = []\n# ///',
		'# /// script\n# dependencies = [invalid TOML\n# ///',
		'# /// script',
	])('delegates metadata validation to uv: %s', async (code) => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket: await seededBucket(code),
		});
		expect(resolved).toEqual({ strategy: 'uv-script-pins', detectionFailed: false });
	});

	it('uses the default when the entry file has no inline metadata', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket: await seededBucket('import marimo\n'),
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: false });
	});

	it('falls back leniently when the entry file is missing', async () => {
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket: new MemoryBucket(),
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});

	it('falls back leniently when the bucket read throws', async () => {
		const bucket = new MemoryBucket();
		bucket.get = () => Promise.reject(new Error('boom'));
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket,
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});

	it('falls back leniently when the entry file fails to decode', async () => {
		const bucket = await seededBucket(INLINE_NOTEBOOK);
		const object = await bucket.get(ENTRY_KEY);
		vi.spyOn(bucket, 'get').mockResolvedValue({
			...object!,
			text: () => Promise.reject(new Error('bad encoding')),
		});
		const resolved = await resolveLaunchStrategyForSession({
			entryNotebookKey: ENTRY_KEY,
			bucket,
		});
		expect(resolved).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
	});
});
