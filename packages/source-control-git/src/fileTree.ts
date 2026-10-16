import { createHash } from 'node:crypto';
import { BadRequestError, ConflictError, UnavailableError } from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { MAX_GIT_EXPANDED_FILES } from '@marimo-hub/core/ports/source-control';
import type { SourceControlChange } from '@marimo-hub/core/ports/source-control';
import { normalizeProviderCommit } from './validation';
export interface TreeEntry {
	objectId: string;
	mode: string;
	size?: number;
}
export type FileTree = Map<string, TreeEntry>;

export function blobId(content: Uint8Array): string {
	return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}
export function assertBlobContents(bytes: Uint8Array, objectId: string, provider: string): void {
	if (blobId(bytes) !== objectId)
		throw new UnavailableError(`${provider} returned different blob contents`);
}

// HFS+ ignores these code points when comparing names, so `.git\u200c` opens `.git` (Git's
// is_hfs_dotgit strips the same set).
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;

// Mirrors Git's own checkout guards so a regression in isomorphic-git cannot let a provider tree
// plant files inside the repository metadata: HFS+ ignorable code points, and on NTFS an
// alternate data stream suffix (`.git:x`), trailing dots/spaces, and the `git~1` short name.
export function isSafeGitEntryName(name: string): boolean {
	if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0'))
		return false;
	const stream = name.indexOf(':');
	const normalized = (stream === -1 ? name : name.slice(0, stream))
		.replace(HFS_IGNORABLE, '')
		.toLowerCase()
		.replace(/[. ]+$/, '');
	return normalized !== '.git' && !/^\.?git~[1-9]$/.test(normalized);
}

export function isSafeGitTreePath(path: string): boolean {
	return !!path && isSafeWorkspaceRootPath(path) && path.split('/').every(isSafeGitEntryName);
}

const FILE_MODES: Record<string, string> = {
	'100644': 'blob',
	'100755': 'blob',
	'120000': 'blob',
	'160000': 'commit',
};
const TREE_MODES = new Set(['040000', '40000']);
const MAX_TREE_ENTRIES = 2 * MAX_GIT_EXPANDED_FILES + 1;

export class FileTreeBuilder {
	private readonly files: FileTree = new Map();
	private readonly paths = new Set<string>();
	constructor(private readonly provider: string) {}

	add(entry: { path: string; type: unknown; mode: unknown; objectId: unknown; size?: unknown }) {
		const { path, type, size } = entry;
		const mode = String(entry.mode);
		if (!isSafeGitTreePath(path)) throw new BadRequestError(`Unsafe ${this.provider} tree path`);
		if (this.paths.has(path))
			// Git trees cannot hold two entries with one name, so this is a provider fault.
			throw new UnavailableError(`${this.provider} tree has a duplicate path`);
		this.paths.add(path);
		if (this.paths.size > MAX_TREE_ENTRIES)
			throw new BadRequestError(`${this.provider} tree has too many entries`);
		const isTree = type === 'tree' && TREE_MODES.has(mode);
		if (!isTree && FILE_MODES[mode] !== type)
			throw new UnavailableError(`Invalid ${this.provider} tree entry`);
		const objectId = normalizeProviderCommit(entry.objectId);
		if (isTree) return;
		if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0))
			throw new UnavailableError(`Invalid ${this.provider} file size`);
		this.files.set(path, { objectId, mode, ...(size === undefined ? {} : { size }) });
	}

	build(): FileTree {
		for (const path of this.paths) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) {
				if (this.files.has(parts.slice(0, i).join('/')))
					throw new BadRequestError(
						`${this.provider} tree has overlapping file and directory paths`,
					);
			}
		}
		return this.files;
	}
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
