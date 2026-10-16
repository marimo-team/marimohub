import { createHash } from 'node:crypto';
import { BadRequestError, ConflictError } from '@marimo-hub/core/errors';
import { WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import type { SourceControlChange } from '@marimo-hub/core/ports/source-control';
export interface TreeEntry {
	objectId: string;
	mode: string;
	size?: number;
}
export type FileTree = Map<string, TreeEntry>;

export function blobId(content: Uint8Array): string {
	return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}
export function sameTree(a: FileTree, b: FileTree): boolean {
	return (
		a.size === b.size &&
		[...a].every(
			([path, entry]) =>
				entry.objectId === b.get(path)?.objectId && entry.mode === b.get(path)?.mode,
		)
	);
}

export function applyChanges(base: FileTree, changes: readonly SourceControlChange[]): FileTree {
	const desired = new Map(base);
	let bytes = 0;
	if (changes.length > WORKSPACE_LIMITS.maxFiles)
		throw new BadRequestError('Too many proposal files');
	for (const change of changes) {
		const previous = base.get(change.path);
		if (previous && !['100644', '100755'].includes(previous.mode))
			throw new ConflictError('Proposals cannot modify Git symlinks or submodules');
		if ((change.operation === 'add') === !!previous)
			throw new ConflictError(`Proposal does not match the base tree at ${change.path}`);
		if (change.operation === 'delete') desired.delete(change.path);
		else {
			bytes += change.content.byteLength;
			if (
				change.content.byteLength > WORKSPACE_LIMITS.maxFileBytes ||
				bytes > WORKSPACE_LIMITS.maxTotalBytes
			)
				throw new BadRequestError('Proposal exceeds workspace limits');
			desired.set(change.path, {
				objectId: blobId(change.content),
				mode: previous?.mode ?? '100644',
			});
		}
	}
	if (desired.size > WORKSPACE_LIMITS.maxFiles)
		throw new BadRequestError('Too many proposal files');
	for (const path of desired.keys()) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			if (desired.has(parts.slice(0, i).join('/')))
				throw new ConflictError('Proposal has overlapping file and directory paths');
		}
	}
	return desired;
}
