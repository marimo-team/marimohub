import { createNotebookId, createProjectId, createVersionId } from '../../ids';
import { paths } from '../../paths';
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
		bucket.get = async () => {
			throw new Error('boom');
		};
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

describe('launch input cache', () => {
	const immutableKey = paths
		.project(createProjectId())
		.notebook(createNotebookId())
		.version(createVersionId()).code;
	it('shares a pending immutable read and body parse across concurrent starts', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(immutableKey, INLINE_NOTEBOOK);
		const object = (await bucket.get(immutableKey))!;
		const body = Promise.withResolvers<string>();
		const text = vi.fn(() => body.promise);
		const get = vi.spyOn(bucket, 'get').mockResolvedValue({ ...object, text });
		const options = { bucket, entryNotebookKey: immutableKey };
		const starts = Array.from({ length: 3 }, () => resolveLaunchStrategyForSession(options));
		await Promise.resolve();
		expect(get).toHaveBeenCalledOnce();
		expect(text).toHaveBeenCalledOnce();
		body.resolve(INLINE_NOTEBOOK);
		for (const result of await Promise.all(starts)) {
			expect(result).toEqual({ strategy: 'uv-script-pins', detectionFailed: false });
		}
		await resolveLaunchStrategyForSession(options);
		expect(get).toHaveBeenCalledOnce();
	});

	it.each(['missing', 'read failure', 'decode failure'])(
		'shares a pending %s but retries the next start',
		async (failure) => {
			const bucket = new MemoryBucket();
			await bucket.put(immutableKey, INLINE_NOTEBOOK);
			const object = (await bucket.get(immutableKey))!;
			const read = Promise.withResolvers<typeof object | null>();
			const get = vi.spyOn(bucket, 'get').mockImplementationOnce(() => read.promise);
			const options = { bucket, entryNotebookKey: immutableKey };
			const starts = Array.from({ length: 3 }, () => resolveLaunchStrategyForSession(options));
			expect(get).toHaveBeenCalledOnce();
			if (failure === 'read failure') read.reject(new Error('unavailable'));
			else if (failure === 'missing') read.resolve(null);
			else {
				read.resolve({
					...object,
					text: async () => {
						throw new Error('bad encoding');
					},
				});
			}
			for (const result of await Promise.all(starts)) {
				expect(result).toEqual({ strategy: 'uv-sync-edit', detectionFailed: true });
			}
			expect(await resolveLaunchStrategyForSession(options)).toEqual({
				strategy: 'uv-script-pins',
				detectionFailed: false,
			});
			await resolveLaunchStrategyForSession(options);
			expect(get).toHaveBeenCalledTimes(2);
		},
	);

	it.each(['success', 'failure'])(
		'an evicted pending %s does not replace or remove a newer entry',
		async (outcome) => {
			const bucket = new MemoryBucket();
			await bucket.put(immutableKey, INLINE_NOTEBOOK);
			const object = (await bucket.get(immutableKey))!;
			const oldRead = Promise.withResolvers<typeof object | null>();
			const get = vi
				.spyOn(bucket, 'get')
				.mockResolvedValue(object)
				.mockImplementationOnce(() => oldRead.promise);
			const options = { bucket, entryNotebookKey: immutableKey };
			const oldStart = resolveLaunchStrategyForSession(options);
			await Promise.all(
				Array.from({ length: 10_000 }, (_, index) =>
					resolveLaunchStrategyForSession({ bucket, entryNotebookKey: `${immutableKey}-${index}` }),
				),
			);
			expect((await resolveLaunchStrategyForSession(options)).strategy).toBe('uv-script-pins');
			if (outcome === 'success') oldRead.resolve({ ...object, text: async () => 'import marimo' });
			else oldRead.reject(new Error('unavailable'));
			await oldStart;
			expect(await resolveLaunchStrategyForSession(options)).toEqual({
				strategy: 'uv-script-pins',
				detectionFailed: false,
			});
			expect(get).toHaveBeenCalledTimes(10_002);
		},
	);

	it.each([INLINE_NOTEBOOK, 'import marimo'])(
		'caches immutable metadata for %s per bucket',
		async (source) => {
			const bucket = new MemoryBucket();
			await bucket.put(immutableKey, source);
			const get = vi.spyOn(bucket, 'get');
			const options = { bucket, entryNotebookKey: immutableKey };
			expect(await resolveLaunchStrategyForSession(options)).toEqual(
				await resolveLaunchStrategyForSession(options),
			);
			expect(get).toHaveBeenCalledOnce();
			expect(
				(await resolveLaunchStrategyForSession({ ...options, bucket: new MemoryBucket() }))
					.detectionFailed,
			).toBe(true);
		},
	);
	it('reads mutable workspaces on every start, including a directory named versions', async () => {
		const bucket = new MemoryBucket();
		const key = 'projects/p/notebooks/n/workspace/versions/v/notebook.py';
		await bucket.put(key, INLINE_NOTEBOOK);
		const options = { bucket, entryNotebookKey: key };
		expect((await resolveLaunchStrategyForSession(options)).strategy).toBe('uv-script-pins');
		await bucket.put(key, 'import marimo');
		expect((await resolveLaunchStrategyForSession(options)).strategy).toBe('uv-sync-edit');
	});
	it('retries an immutable object after its body fails to decode', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(immutableKey, INLINE_NOTEBOOK);
		const object = await bucket.get(immutableKey);
		const get = vi.spyOn(bucket, 'get').mockResolvedValueOnce({
			...object!,
			text: async () => {
				throw new Error('decode failure');
			},
		});
		const options = { bucket, entryNotebookKey: immutableKey };
		expect((await resolveLaunchStrategyForSession(options)).detectionFailed).toBe(true);
		expect((await resolveLaunchStrategyForSession(options)).strategy).toBe('uv-script-pins');
		await resolveLaunchStrategyForSession(options);
		expect(get).toHaveBeenCalledTimes(2);
	});

	it('retries failed immutable reads', async () => {
		const bucket = new MemoryBucket();
		const options = { bucket, entryNotebookKey: immutableKey };
		expect((await resolveLaunchStrategyForSession(options)).detectionFailed).toBe(true);
		await bucket.put(immutableKey, INLINE_NOTEBOOK);
		const get = vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('unavailable'));
		expect((await resolveLaunchStrategyForSession(options)).detectionFailed).toBe(true);
		expect((await resolveLaunchStrategyForSession(options)).strategy).toBe('uv-script-pins');
		expect(get).toHaveBeenCalledTimes(2);
	});
});
