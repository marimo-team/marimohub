import { readTreeWorkspace } from '@marimo-hub/source-control-git/workspace';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import { WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import type {
	SourceControlChange,
	SourceReadOptions,
	SourceWorkspaceFile,
} from '@marimo-hub/core/ports/source-control';
import { assertBlobContents, FileTreeBuilder } from '@marimo-hub/source-control-git/file-tree';
import type { FileTree, TreeEntry } from '@marimo-hub/source-control-git/file-tree';
import {
	normalizeCommit,
	normalizeProviderCommit,
} from '@marimo-hub/source-control-git/validation';
import { record, stringField } from './client';
import type { GitLabClient } from './client';
import type { GitLabRepository } from './repository';

export async function list(
	client: GitLabClient,
	repo: GitLabRepository,
	path: string,
	query: Record<string, string>,
	options: SourceReadOptions = {},
): Promise<unknown[]> {
	const result: unknown[] = [];
	for (let page = 1; page <= 21; page++) {
		const response = await client.json(
			repo,
			path,
			{ ...query, per_page: '100', page: String(page) },
			options,
		);
		if (!Array.isArray(response.value)) throw new UnavailableError('Invalid GitLab list response');
		result.push(...response.value);
		if (result.length > 2001)
			throw new BadRequestError('GitLab response contains too many entries');
		const next = response.headers.get('x-next-page');
		if (next === '' || (!next && response.value.length < 100)) return result;
		if (next && next !== String(page + 1)) throw new UnavailableError('Invalid GitLab pagination');
	}
	throw new BadRequestError('GitLab response contains too many pages');
}

export class GitLabTrees {
	constructor(
		private readonly client: GitLabClient,
		private readonly repo: GitLabRepository,
	) {}
	async commit(sha: string, options: SourceReadOptions = {}) {
		const id = normalizeCommit(sha);
		const value = record(
			(await this.client.json(this.repo, `/repository/commits/${id}`, {}, options)).value,
		);
		if (normalizeProviderCommit(stringField(value, 'id')) !== id)
			throw new UnavailableError('GitLab returned a different commit');
		return value;
	}
	async files(sha: string, options: SourceReadOptions = {}): Promise<FileTree> {
		const ref = normalizeCommit(sha);
		await this.commit(ref, options);
		const entries = await list(
			this.client,
			this.repo,
			'/repository/tree',
			{ ref, recursive: 'true' },
			options,
		);
		const tree = new FileTreeBuilder('GitLab');
		for (const item of entries) {
			const entry = record(item);
			tree.add({
				path: stringField(entry, 'path'),
				type: entry.type,
				mode: stringField(entry, 'mode'),
				objectId: entry.id,
			});
		}
		return tree.build();
	}
	async blob(entry: TreeEntry, limit: number, options: SourceReadOptions = {}) {
		const bytes = await this.unverifiedBlob(entry, limit, options);
		assertBlobContents(bytes, entry.objectId, 'GitLab');
		return bytes;
	}
	// readTreeWorkspace verifies blob contents itself.
	private async unverifiedBlob(entry: TreeEntry, limit: number, options: SourceReadOptions) {
		const { bytes } = await this.client.data(
			this.repo,
			`/repository/blobs/${entry.objectId}/raw`,
			{},
			options,
			limit,
		);
		return bytes;
	}
	async workspace(
		sha: string,
		rootPath: string,
		options: SourceReadOptions = {},
	): Promise<SourceWorkspaceFile[]> {
		return readTreeWorkspace({
			provider: 'GitLab',
			rootPath,
			tree: () => this.files(sha, options),
			blob: (entry, limit) => this.unverifiedBlob(entry, limit, options),
		});
	}

	async contents(current: FileTree, desired: FileTree, changes: readonly SourceControlChange[]) {
		const supplied = new Map(
			changes.flatMap((change) =>
				change.operation === 'delete' ? [] : [[change.path, change.content] as const],
			),
		);
		const result = new Map<string, Uint8Array>();
		let total = 0;
		for (const [path, entry] of desired) {
			if (current.get(path)?.objectId === entry.objectId) continue;
			const bytes =
				supplied.get(path) ??
				(await this.blob(
					entry,
					Math.min(WORKSPACE_LIMITS.maxFileBytes, WORKSPACE_LIMITS.maxTotalBytes - total),
				));
			total += bytes.length;
			if (bytes.length > WORKSPACE_LIMITS.maxFileBytes || total > WORKSPACE_LIMITS.maxTotalBytes)
				throw new BadRequestError('Proposal exceeds workspace limits');
			result.set(path, bytes);
		}
		return result;
	}
}
