import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import type * as remoteWorkspace from '@marimo-hub/core/remote-workspace';
import { applyChanges, blobId, FileTreeBuilder } from './fileTree';
import type { FileTree } from './fileTree';

vi.mock('@marimo-hub/core/remote-workspace', async (importOriginal) => {
	const actual = await importOriginal<typeof remoteWorkspace>();
	return { ...actual, WORKSPACE_LIMITS: { ...actual.WORKSPACE_LIMITS, maxFiles: 3 } };
});

const content = new Uint8Array([1]);
function tree(count: number): FileTree {
	return new Map(
		Array.from({ length: count }, (_, index) => [
			`${index}.py`,
			{ objectId: blobId(content), mode: '100644' },
		]),
	);
}

describe('proposal file count', () => {
	it('counts unchanged files when adding a file', () => {
		const base = tree(3);
		expect(() => applyChanges(base, [{ path: 'new.py', operation: 'add', content }])).toThrow(
			BadRequestError,
		);
		expect(base.size).toBe(3);
		expect(base.has('new.py')).toBe(false);
	});
	it('rejects an oversized resulting tree even when no files are added', () => {
		expect(() => applyChanges(tree(4), [{ path: '0.py', operation: 'modify', content }])).toThrow(
			'Too many proposal files',
		);
	});
	it('allows an addition at the exact limit', () => {
		expect(applyChanges(tree(2), [{ path: 'new.py', operation: 'add', content }]).size).toBe(3);
	});
	it('checks the final count after deletions, regardless of change order', () => {
		const base = tree(3);
		const result = applyChanges(base, [
			{ path: 'new.py', operation: 'add', content },
			{ path: '0.py', operation: 'delete' },
		]);
		expect([...result.keys()]).toEqual(['1.py', '2.py', 'new.py']);
		expect([...base.keys()]).toEqual(['0.py', '1.py', '2.py']);
	});
	it('allows deletions to bring an oversized tree within the limit', () => {
		expect(applyChanges(tree(4), [{ path: '0.py', operation: 'delete' }]).size).toBe(3);
	});
});

describe('FileTreeBuilder', () => {
	const oid = 'a'.repeat(40);
	const blob = (path: string, mode = '100644') => ({ path, type: 'blob', mode, objectId: oid });

	it.each([
		'',
		'/abs',
		'../x',
		'a/../b',
		'.git/config',
		'sub/.GIT/hooks',
		'git~1/config',
		'.git./config',
		'.git\u200c/config',
		'\ufeff.g\u200dit/config',
		'.git:foo/config',
		'.GIT. /config',
		'GIT~1/config',
		'a\0b',
		'a\\b',
	])('rejects unsafe path %j', (path) => {
		expect(() => new FileTreeBuilder('Provider').add(blob(path))).toThrow(
			'Unsafe Provider tree path',
		);
	});

	it('rejects duplicate paths across files and directories', () => {
		const builder = new FileTreeBuilder('Provider');
		builder.add({ path: 'a', type: 'tree', mode: '040000', objectId: oid });
		expect(() => builder.add(blob('a'))).toThrow(
			new UnavailableError('Provider tree has a duplicate path'),
		);
	});

	it.each(['a:b', 'gitx', '.github/workflows'])('accepts safe path %j', (path) => {
		expect(() => new FileTreeBuilder('Provider').add(blob(path))).not.toThrow();
	});

	it('rejects overlapping file and directory paths', () => {
		const builder = new FileTreeBuilder('Provider');
		builder.add(blob('a'));
		builder.add(blob('a/b'));
		expect(() => builder.build()).toThrow('overlapping');
	});

	it('rejects a file that is also the parent of a directory entry', () => {
		const builder = new FileTreeBuilder('Provider');
		builder.add(blob('a'));
		builder.add({ path: 'a/b', type: 'tree', mode: '040000', objectId: oid });
		expect(() => builder.build()).toThrow(BadRequestError);
	});

	it.each([
		{ type: 'blob', mode: '999999' },
		{ type: 'tree', mode: '100644' },
		{ type: 'commit', mode: '100644' },
		{ type: 'blob', mode: '160000' },
	])('rejects mode $mode for $type', (entry) => {
		expect(() =>
			new FileTreeBuilder('Provider').add({ path: 'a', objectId: oid, ...entry }),
		).toThrow('Invalid Provider tree entry');
	});

	it('normalizes object ids, keeps sizes, and omits directories', () => {
		const builder = new FileTreeBuilder('Provider');
		builder.add({ path: 'apps', type: 'tree', mode: '40000', objectId: oid });
		builder.add({
			path: 'apps/main.py',
			type: 'blob',
			mode: '100755',
			objectId: 'B'.repeat(40),
			size: 3,
		});
		builder.add({ path: 'sub', type: 'commit', mode: '160000', objectId: oid });
		expect([...builder.build()]).toEqual([
			['apps/main.py', { objectId: 'b'.repeat(40), mode: '100755', size: 3 }],
			['sub', { objectId: oid, mode: '160000' }],
		]);
	});

	it.each([-1, 1.5, '3'])('rejects invalid size %j', (size) => {
		expect(() => new FileTreeBuilder('Provider').add({ ...blob('a'), size })).toThrow(
			'Invalid Provider file size',
		);
	});
});
