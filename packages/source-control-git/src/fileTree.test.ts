import { describe, expect, it, vi } from 'vitest';
import { BadRequestError } from '@marimo-hub/core/errors';
import type * as remoteWorkspace from '@marimo-hub/core/remote-workspace';
import { applyChanges, blobId } from './fileTree';
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
