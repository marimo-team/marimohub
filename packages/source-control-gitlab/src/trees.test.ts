import { describe, expect, it, vi } from 'vitest';
import type * as remoteWorkspace from '@marimo-hub/core/remote-workspace';
import { UnavailableError } from '@marimo-hub/core/errors';
import { blobId } from '@marimo-hub/source-control-git/file-tree';
import { GitLabClient } from './client';
import { parseGitLabRepository } from './repository';
import { GitLabTrees } from './trees';

vi.mock('@marimo-hub/core/remote-workspace', async (importOriginal) => {
	const actual = await importOriginal<typeof remoteWorkspace>();
	return {
		...actual,
		WORKSPACE_LIMITS: {
			...actual.WORKSPACE_LIMITS,
			maxFiles: 3,
			maxFileBytes: 4,
			maxTotalBytes: 6,
		},
	};
});

const commit = 'a'.repeat(40);
const repo = parseGitLabRepository('https://gitlab.com/team/project');
const encode = (text: string) => new TextEncoder().encode(text);
function file(path: string, content: string, mode = '100644') {
	const bytes = encode(content);
	return { path, mode, type: mode === '160000' ? 'commit' : 'blob', id: blobId(bytes), bytes };
}
function setup(entries: ReturnType<typeof file>[]) {
	const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
		expect(init?.method ?? 'GET').toBe('GET');
		const path = new URL(url).pathname;
		if (path.endsWith(`/commits/${commit}`)) return Response.json({ id: commit });
		if (path.endsWith('/tree'))
			return Response.json(entries.map(({ bytes: _, ...entry }) => entry));
		const entry = entries.find((entry) => path.endsWith(`/blobs/${entry.id}/raw`));
		if (!entry) throw new Error('Unexpected GitLab request');
		return new Response(new Uint8Array(entry.bytes));
	});
	return {
		fetcher,
		trees: new GitLabTrees(new GitLabClient({ token: 'test-token' }, { fetcher }), repo),
	};
}

describe('GitLab tree boundaries', () => {
	it.each([null, [], {}, { id: 'invalid' }, { id: 'b'.repeat(40) }])(
		'rejects an invalid or mismatched commit: %j',
		async (value) => {
			const { trees, fetcher } = setup([]);
			fetcher.mockResolvedValueOnce(Response.json(value));
			const pending = trees.workspace(commit, '');
			await expect(pending).rejects.toBeInstanceOf(UnavailableError);
			await expect(pending).rejects.toThrow(/Invalid|different/);
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);
	it('rejects a malformed tree object ID as a provider failure', async () => {
		const { trees } = setup([{ ...file('a.py', 'a'), id: 'invalid' }]);
		await expect(trees.workspace(commit, '')).rejects.toBeInstanceOf(UnavailableError);
	});
	it('rejects duplicate paths before downloading blobs', async () => {
		const { trees, fetcher } = setup([file('a.py', 'a'), file('a.py', 'b')]);
		await expect(trees.workspace(commit, '')).rejects.toThrow('duplicate');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it.each([false, true])(
		'rejects a file used as a parent directory (reversed: %s)',
		async (reversed) => {
			const entries = [file('apps', 'a'), file('apps/main.py', 'b')];
			const { trees, fetcher } = setup(reversed ? entries.reverse() : entries);
			await expect(trees.workspace(commit, '')).rejects.toThrow('overlapping');
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it('matches subtree boundaries exactly and skips symlinks and submodules', async () => {
		const { trees, fetcher } = setup([
			file('apps/a.py', 'ok'),
			file('apps-other/b.py', 'skip'),
			file('apps/link', 'link', '120000'),
			file('apps/module', '', '160000'),
		]);
		expect(await trees.workspace(commit, 'apps')).toEqual([{ path: 'a.py', bytes: encode('ok') }]);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it('returns an empty workspace for a missing subtree without fetching blobs', async () => {
		const { trees, fetcher } = setup([file('a.py', 'ok')]);
		expect(await trees.workspace(commit, 'missing')).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('accepts empty files and exact size/count boundaries', async () => {
		const { trees } = setup([file('empty', ''), file('a', '1234'), file('b', '56')]);
		expect((await trees.workspace(commit, '')).map((file) => file.bytes.length)).toEqual([0, 4, 2]);
	});
	it('rejects excess file count before downloading any blobs', async () => {
		const { trees, fetcher } = setup(['a', 'b', 'c', 'd'].map((path) => file(path, '')));
		await expect(trees.workspace(commit, '')).rejects.toThrow('too many files');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('rejects a file one byte over its limit', async () => {
		const { trees } = setup([file('a', '12345')]);
		await expect(trees.workspace(commit, '')).rejects.toThrow('size limit');
	});
	it('rejects aggregate overflow even when each file fits', async () => {
		const { trees } = setup([file('a', '1234'), file('b', '567')]);
		await expect(trees.workspace(commit, '')).rejects.toThrow('size limit');
	});
	it('enforces the remaining budget when restoring omitted proposal files', async () => {
		const { trees } = setup([file('restored', '4567')]);
		await expect(
			trees.contents(
				new Map(),
				new Map([
					['changed', { objectId: blobId(encode('123')), mode: '100644' }],
					['restored', { objectId: blobId(encode('4567')), mode: '100644' }],
				]),
				[{ path: 'changed', operation: 'add', content: encode('123') }],
			),
		).rejects.toThrow('size limit');
	});
});
