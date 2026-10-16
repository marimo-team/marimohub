import { readTreeWorkspace } from '@marimo-hub/source-control-git/workspace';
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
import { normalizeCommit, normalizeProviderCommit } from './validation';

export { blobId, sameTree } from '@marimo-hub/source-control-git/file-tree';
export type { FileTree } from '@marimo-hub/source-control-git/file-tree';
import { blobId, applyChanges } from '@marimo-hub/source-control-git/file-tree';
import type { FileTree, TreeEntry } from '@marimo-hub/source-control-git/file-tree';

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
		if (normalizeProviderCommit(stringField(result, 'commitId')) !== normalizedSha)
			throw new UnavailableError('Azure DevOps returned a different commit');
		return result;
	}
	async files(sha: string, options: SourceReadOptions = {}): Promise<FileTree> {
		const commit = await this.commit(sha, options);
		const treeId = normalizeProviderCommit(stringField(commit, 'treeId'));
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
			const objectId = normalizeProviderCommit(stringField(entry, 'objectId'));
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
		return readTreeWorkspace({
			provider: 'Azure DevOps',
			rootPath,
			tree: () => this.files(commit, options),
			blob: (entry, limit) => this.blob(entry, limit, options),
		});
	}

	desired(base: FileTree, changes: readonly SourceControlChange[]): FileTree {
		return applyChanges(base, changes);
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
