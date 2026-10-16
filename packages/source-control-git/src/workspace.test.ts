import { describe, expect, it } from 'vitest';
import { BadRequestError } from '@marimo-hub/core/errors';
import { WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { blobId } from './fileTree';
import type { FileTree } from './fileTree';
import { readTreeWorkspace } from './workspace';

const bytes = new TextEncoder().encode('print(1)');

function read(
	tree: FileTree,
	blob: (entry: unknown, limit: number) => Promise<Uint8Array> = async () => bytes,
	rootPath = '',
) {
	return readTreeWorkspace({ provider: 'Provider', rootPath, tree: async () => tree, blob });
}

describe('readTreeWorkspace', () => {
	it('returns regular files under the root path', async () => {
		const tree: FileTree = new Map([
			['apps/main.py', { objectId: blobId(bytes), mode: '100755' }],
			['apps/link', { objectId: blobId(bytes), mode: '120000' }],
			['other.py', { objectId: blobId(bytes), mode: '100644' }],
		]);
		expect(await read(tree, undefined, 'apps')).toEqual([{ path: 'main.py', bytes }]);
	});

	it.each(['.git/config', 'apps/../x', 'git~1/hooks/pre-commit'])(
		'rechecks provider path %s',
		async (path) => {
			const tree: FileTree = new Map([[path, { objectId: blobId(bytes), mode: '100644' }]]);
			await expect(read(tree)).rejects.toThrow('Unsafe Provider tree path');
		},
	);

	it('rejects a blob callback that returns more bytes than the limit', async () => {
		const tree: FileTree = new Map([['main.py', { objectId: blobId(bytes), mode: '100644' }]]);
		let requested = 0;
		const oversized = async (_entry: unknown, limit: number) => {
			requested = limit;
			return new Uint8Array(limit + 1);
		};
		await expect(read(tree, oversized)).rejects.toThrow(
			new BadRequestError('Provider workspace exceeds the size limit'),
		);
		expect(requested).toBe(WORKSPACE_LIMITS.maxFileBytes);
	});

	it('verifies blob contents against the tree object id', async () => {
		const tree: FileTree = new Map([['main.py', { objectId: 'a'.repeat(40), mode: '100644' }]]);
		await expect(read(tree)).rejects.toThrow('Provider returned different blob contents');
	});
});
