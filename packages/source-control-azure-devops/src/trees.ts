import { createHash } from 'node:crypto';
import { BadRequestError, ConflictError, UnavailableError } from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import type {
	SourceControlChange,
	SourceWorkspaceFile,
	SourceReadOptions,
} from '@marimo-hub/core/ports/source-control';
import { boundedBytes, record, stringField } from './client';
import type { AzureClient } from './client';
import type { AzureRepository } from './repository';
import { normalizeCommit } from './validation';

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

export class AzureTrees {
	constructor(
		private readonly client: AzureClient,
		private readonly repo: AzureRepository,
	) {}
	async commit(sha: string, options: SourceReadOptions = {}): Promise<Record<string, unknown>> {
		const normalizedSha = normalizeCommit(sha);
		const result = record(
			await this.client.json(this.repo, `/commits/${normalizedSha}`, {}, options),
		);
		if (normalizeCommit(stringField(result, 'commitId')) !== normalizedSha)
			throw new UnavailableError('Azure DevOps returned a different commit');
		return result;
	}
	async files(sha: string, options: SourceReadOptions = {}): Promise<FileTree> {
		const commit = await this.commit(sha, options);
		const treeId = normalizeCommit(stringField(commit, 'treeId'));
		const response = record(
			await this.client.json(this.repo, `/trees/${treeId}`, { recursive: 'true' }, options),
		);
		if (response.truncated === true || !Array.isArray(response.treeEntries))
			throw new BadRequestError('Azure DevOps tree is incomplete');
		const tree: FileTree = new Map();
		const paths = new Set<string>();
		for (const item of response.treeEntries) {
			const entry = record(item);
			const path = stringField(entry, 'relativePath');
			if (!isSafeWorkspaceRootPath(path))
				throw new BadRequestError('Unsafe Azure DevOps tree path');
			const type = stringField(entry, 'gitObjectType');
			const mode = String(entry.mode);
			const validMode =
				(type === 'tree' && ['040000', '40000'].includes(mode)) ||
				(type === 'blob' && ['100644', '100755', '120000'].includes(mode)) ||
				(type === 'commit' && mode === '160000');
			if (!validMode || paths.has(path))
				throw new UnavailableError('Invalid Azure DevOps tree entry');
			paths.add(path);
			const objectId = normalizeCommit(stringField(entry, 'objectId'));
			if (type === 'tree') continue;
			const size = entry.size;
			if (
				size !== undefined &&
				(typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
			)
				throw new UnavailableError('Invalid Azure DevOps file size');
			tree.set(path, { objectId, mode, size: typeof size === 'number' ? size : undefined });
		}
		return tree;
	}
	async blob(
		entry: TreeEntry,
		limit: number,
		options: SourceReadOptions = {},
	): Promise<Uint8Array> {
		if (entry.size !== undefined && entry.size > limit)
			throw new BadRequestError('Azure DevOps file exceeds the workspace limit');
		const response = await this.client.request(
			this.repo,
			`/blobs/${entry.objectId}`,
			{ $format: 'octetstream' },
			{ ...options, headers: { accept: 'application/octet-stream' } },
		);
		const bytes = await boundedBytes(response, limit, options.signal);
		if (blobId(bytes) !== entry.objectId)
			throw new UnavailableError('Azure DevOps returned different blob contents');
		return bytes;
	}
	async workspace(
		commit: string,
		rootPath: string,
		options: SourceReadOptions = {},
	): Promise<SourceWorkspaceFile[]> {
		if (!isSafeWorkspaceRootPath(rootPath))
			throw new BadRequestError('Invalid workspace root path');
		const tree = await this.files(commit, options);
		const prefix = rootPath ? `${rootPath}/` : '';
		const selected = [...tree].filter(
			([path, entry]) => path.startsWith(prefix) && ['100644', '100755'].includes(entry.mode),
		);
		if (selected.length > WORKSPACE_LIMITS.maxFiles)
			throw new BadRequestError('Azure DevOps workspace has too many files');
		const files: SourceWorkspaceFile[] = [];
		let size = 0;
		for (const [path, entry] of selected) {
			const bytes = await this.blob(
				entry,
				Math.min(WORKSPACE_LIMITS.maxFileBytes, WORKSPACE_LIMITS.maxTotalBytes - size),
				options,
			);
			size += bytes.byteLength;
			files.push({ path: path.slice(prefix.length), bytes });
		}
		return files;
	}
	desired(base: FileTree, changes: readonly SourceControlChange[]): FileTree {
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
		for (const path of desired.keys()) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) {
				if (desired.has(parts.slice(0, i).join('/')))
					throw new ConflictError('Proposal has overlapping file and directory paths');
			}
		}
		return desired;
	}
	async delta(
		current: FileTree,
		desired: FileTree,
		changes: readonly SourceControlChange[],
	): Promise<unknown[]> {
		const contents = new Map(
			changes
				.filter((change) => change.operation !== 'delete')
				.map((change) => [change.path, change.content]),
		);
		const result: unknown[] = [];
		let totalBytes = 0;
		for (const path of new Set([...current.keys(), ...desired.keys()])) {
			const before = current.get(path);
			const after = desired.get(path);
			if (before?.objectId === after?.objectId && before?.mode === after?.mode) continue;
			if (!after) {
				result.push({ changeType: 'delete', item: { path: `/${path}` } });
				continue;
			}
			// The REST push API cannot express executable-bit or special-file mode changes.
			if ((before && before.mode !== after.mode) || (!before && after.mode !== '100644'))
				throw new ConflictError('This update changes a Git file mode; create a new pull request');
			const bytes =
				contents.get(path) ??
				(await this.blob(
					after,
					Math.min(WORKSPACE_LIMITS.maxFileBytes, WORKSPACE_LIMITS.maxTotalBytes - totalBytes),
				));
			totalBytes += bytes.byteLength;
			if (totalBytes > WORKSPACE_LIMITS.maxTotalBytes)
				throw new BadRequestError('Proposal update exceeds workspace limits');
			result.push({
				changeType: before ? 'edit' : 'add',
				item: { path: `/${path}` },
				newContent: {
					content: Buffer.from(bytes).toString('base64'),
					contentType: 'base64encoded',
				},
			});
		}
		return result;
	}
}
