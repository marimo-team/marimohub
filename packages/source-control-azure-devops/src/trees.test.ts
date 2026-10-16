import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, ConflictError, UnavailableError } from '@marimo-hub/core/errors';
import type * as RemoteWorkspace from '@marimo-hub/core/remote-workspace';
import { AzureClient } from './client';
import { parseAzureRepository } from './repository';
import { applyChanges } from '@marimo-hub/source-control-git/file-tree';
import { AzureTrees } from './trees';
import { FakeAzure, repository } from './testing/fakeAzure';

// Small limits exercise cumulative boundaries without allocating production-sized workspaces.
vi.mock('@marimo-hub/core/remote-workspace', async (importOriginal) => ({
	...(await importOriginal<typeof RemoteWorkspace>()),
	WORKSPACE_LIMITS: { maxFileBytes: 8, maxTotalBytes: 12, maxFiles: 3 },
}));
const bytes = (text: string) => new TextEncoder().encode(text);
function setup() {
	const fake = new FakeAzure();
	const client = new AzureClient(
		{ organization: 'acme', credential: { getToken: async () => ({ token: 'test' }) } },
		{ fetcher: fake.fetcher },
	);
	const trees = new AzureTrees(client, parseAzureRepository(repository));
	const commit = (files: Record<string, string>) =>
		fake.commit(
			new Map(
				Object.entries(files).map(([path, content]) => [
					path,
					{ bytes: bytes(content), mode: '100644' },
				]),
			),
			[],
		);
	return { fake, trees, commit };
}
function withEntries(entries: unknown[]) {
	const context = setup();
	context.fake.fetcher.mockResolvedValueOnce(
		Response.json({ commitId: context.fake.base, treeId: 'a'.repeat(40) }),
	);
	context.fake.fetcher.mockResolvedValueOnce(Response.json({ treeEntries: entries }));
	return context;
}
const entry = {
	relativePath: 'file.py',
	gitObjectType: 'blob',
	mode: '100644',
	objectId: 'a'.repeat(40),
	size: 1,
};

describe('Azure tree response validation', () => {
	it.each(['../secret', '/absolute', 'a/../secret', '.git/config', 'a\\b', 'a//b'])(
		'rejects unsafe provider path %s before fetching blobs',
		async (relativePath) => {
			const { fake, trees } = withEntries([{ ...entry, relativePath }]);
			await expect(trees.workspace(fake.base, '')).rejects.toBeInstanceOf(BadRequestError);
			expect(fake.fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it.each([-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid file size %s',
		async (size) => {
			const { fake, trees } = withEntries([{ ...entry, size }]);
			await expect(trees.files(fake.base)).rejects.toBeInstanceOf(UnavailableError);
		},
	);
	it.each([
		{ gitObjectType: 'tag' },
		{ gitObjectType: 'commit', mode: '100644' },
		{ gitObjectType: 'blob', mode: '160000' },
		{ gitObjectType: 'tree', mode: '100644' },
		{ mode: '100600' },
	])('rejects inconsistent object metadata %j', async (override) => {
		const { fake, trees } = withEntries([{ ...entry, ...override }]);
		await expect(trees.files(fake.base)).rejects.toBeInstanceOf(UnavailableError);
	});
	it.each([
		[entry, entry],
		[{ ...entry, gitObjectType: 'tree', mode: '040000' }, entry],
	])('rejects duplicate paths even across object types', async (...entries) => {
		const { fake, trees } = withEntries(entries);
		await expect(trees.files(fake.base)).rejects.toThrow(
			new UnavailableError('Azure DevOps tree has a duplicate path'),
		);
	});
	it('rejects a file used as a parent directory', async () => {
		const { fake, trees } = withEntries([
			{ ...entry, relativePath: 'apps' },
			{ ...entry, relativePath: 'apps/main.py' },
		]);
		await expect(trees.files(fake.base)).rejects.toThrow(
			new BadRequestError('Azure DevOps tree has overlapping file and directory paths'),
		);
	});
	it('rejects a file used as the parent of a directory entry', async () => {
		const { fake, trees } = withEntries([
			{ ...entry, relativePath: 'apps' },
			{ ...entry, relativePath: 'apps/lib', gitObjectType: 'tree', mode: '040000' },
		]);
		await expect(trees.files(fake.base)).rejects.toThrow(
			new BadRequestError('Azure DevOps tree has overlapping file and directory paths'),
		);
	});
	it('rejects a response for a different commit', async () => {
		const { fake, trees } = setup();
		fake.fetcher.mockResolvedValueOnce(
			Response.json({ commitId: 'f'.repeat(40), treeId: 'a'.repeat(40) }),
		);
		await expect(trees.workspace(fake.base, '')).rejects.toThrow('different commit');
		expect(fake.fetcher).toHaveBeenCalledOnce();
	});
	it('skips directories, symlinks, and submodules without requesting their blobs', async () => {
		const { fake, trees } = withEntries([
			{ ...entry, relativePath: 'dir', gitObjectType: 'tree', mode: '040000' },
			{ ...entry, relativePath: 'link', mode: '120000' },
			{ ...entry, relativePath: 'submodule', gitObjectType: 'commit', mode: '160000' },
		]);
		await expect(trees.workspace(fake.base, '')).resolves.toEqual([]);
		expect(fake.fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('Azure workspace limits', () => {
	it('accepts the exact per-file, total-byte, and file-count limits', async () => {
		const { trees, commit } = setup();
		const files = await trees.workspace(commit({ a: '12345678', b: '1234', empty: '' }), '');
		expect(files.map(({ path, bytes }) => [path, bytes.byteLength])).toEqual([
			['a', 8],
			['b', 4],
			['empty', 0],
		]);
	});
	it('rejects excessive file counts before downloading any blobs', async () => {
		const { fake, trees, commit } = setup();
		await expect(trees.workspace(commit({ a: '', b: '', c: '', d: '' }), '')).rejects.toThrow(
			'too many files',
		);
		expect(fake.fetcher).toHaveBeenCalledTimes(2);
	});
	it.each<Record<string, string>>([{ a: '123456789' }, { a: '12345678', b: '12345' }])(
		'rejects oversized files or cumulative content: %j',
		async (files) => {
			const { trees, commit } = setup();
			await expect(trees.workspace(commit(files), '')).rejects.toBeInstanceOf(BadRequestError);
		},
	);
	it('counts streamed bytes when the tree understates sizes', async () => {
		const { fake, trees, commit } = setup();
		const sha = commit({ a: '12345678', b: '12345' });
		const original = fake.fetcher.getMockImplementation()!;
		fake.fetcher.mockImplementation(async (url, init) => {
			const response = await original(url, init);
			if (!url.includes('/trees/')) return response;
			const payload = (await response.json()) as { treeEntries: Record<string, unknown>[] };
			return Response.json({
				treeEntries: payload.treeEntries.map((item) => ({ ...item, size: 0 })),
			});
		});
		await expect(trees.workspace(sha, '')).rejects.toBeInstanceOf(BadRequestError);
	});
	it('does not include adjacent prefix paths or count out-of-scope files', async () => {
		const { trees, commit } = setup();
		const sha = commit({
			'app/main.py': 'ok',
			'apps/large.py': 'oversized content',
			a: '',
			b: '',
			c: '',
		});
		await expect(trees.workspace(sha, 'app')).resolves.toEqual([
			{ path: 'main.py', bytes: bytes('ok') },
		]);
		await expect(trees.workspace(sha, 'missing')).resolves.toEqual([]);
	});
});

describe('Azure proposal tree limits', () => {
	it.each([
		[{ path: 'a', operation: 'add' as const, content: bytes('123456789') }],
		[
			{ path: 'a', operation: 'add' as const, content: bytes('12345678') },
			{ path: 'b', operation: 'add' as const, content: bytes('12345') },
		],
		['a', 'b', 'c', 'd'].map((path) => ({ path, operation: 'add' as const, content: bytes('') })),
	])('rejects proposals exceeding workspace limits', (...changes) => {
		expect(() => applyChanges(new Map(), changes)).toThrow(BadRequestError);
	});
	it('bounds restored content as well as supplied content during updates', async () => {
		const { trees, commit } = setup();
		const desired = await trees.files(commit({ a: '12345678', b: '12345' }));
		await expect(
			trees.delta(new Map(), desired, [
				{ path: 'a', operation: 'add', content: bytes('12345678') },
			]),
		).rejects.toBeInstanceOf(BadRequestError);
	});
	it('refuses to restore an executable file as a regular file', async () => {
		const { trees } = setup();
		await expect(
			trees.delta(
				new Map(),
				new Map([['run.sh', { objectId: 'a'.repeat(40), mode: '100755' }]]),
				[],
			),
		).rejects.toBeInstanceOf(ConflictError);
	});
});
