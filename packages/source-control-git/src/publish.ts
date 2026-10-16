import fs from 'node:fs';
import git from 'isomorphic-git';
import type { TreeEntry as GitTreeEntry } from 'isomorphic-git';
import {
	BadRequestError,
	ConflictError,
	DomainError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { isSafeWorkspaceRootPath, WORKSPACE_LIMITS } from '@marimo-hub/core/remote-workspace';
import { assertGitTreeLimits, gitHttp, withFetchedGit } from './index';
import type { GitFetchOptions } from './index';
import type { FileTree } from './fileTree';
import { normalizeCommit, validateBranch } from './validation';

export async function pushGitTree(
	options: GitFetchOptions & {
		headBranch: string;
		expectedHead: string | null;
		tree: FileTree;
		contents: ReadonlyMap<string, Uint8Array>;
		message: string;
	},
): Promise<string> {
	validateBranch(options.headBranch);
	const parent = normalizeCommit(options.commit);
	const expected =
		options.expectedHead === null ? '0'.repeat(40) : normalizeCommit(options.expectedHead);
	if (options.expectedHead !== null && expected !== parent)
		throw new ConflictError('Git publication parent does not match the expected branch');
	if (options.tree.size > WORKSPACE_LIMITS.maxFiles)
		throw new BadRequestError('Too many Git files');
	return withFetchedGit({ ...options, commit: parent }, async (dir) => {
		const directories = new Map<string, GitTreeEntry[]>([['', []]]);
		let total = 0;
		for (const [path, entry] of options.tree) {
			if (!path || !isSafeWorkspaceRootPath(path)) throw new BadRequestError('Invalid Git path');
			const parts = path.split('/');
			for (let length = 1; length < parts.length; length++) {
				const folder = parts.slice(0, length).join('/');
				if (options.tree.has(folder)) throw new BadRequestError('Overlapping Git paths');
				if (!directories.has(folder)) directories.set(folder, []);
				if (directories.size - 1 > WORKSPACE_LIMITS.maxFiles)
					throw new BadRequestError('Too many Git directories');
			}
			const oid = normalizeCommit(entry.objectId);
			const content = options.contents.get(path);
			if (content) {
				total += content.byteLength;
				if (
					content.byteLength > WORKSPACE_LIMITS.maxFileBytes ||
					total > WORKSPACE_LIMITS.maxTotalBytes
				)
					throw new BadRequestError('Git publication exceeds workspace limits');
				const written = await git.writeBlob({ fs, dir, blob: content });
				if (written !== oid) throw new BadRequestError('Git content does not match its object ID');
			}
			if (!['100644', '100755', '120000', '160000'].includes(entry.mode))
				throw new BadRequestError('Invalid Git file mode');
			directories.get(parts.slice(0, -1).join('/'))!.push({
				path: parts.at(-1)!,
				oid,
				mode: entry.mode,
				type: entry.mode === '160000' ? 'commit' : 'blob',
			});
		}
		const paths = [...directories.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
		let tree = '';
		for (const path of [...paths.filter((path) => path !== ''), '']) {
			tree = await git.writeTree({ fs, dir, tree: directories.get(path)! });
			if (path) {
				const parts = path.split('/');
				directories
					.get(parts.slice(0, -1).join('/'))!
					.push({ path: parts.at(-1)!, oid: tree, mode: '040000', type: 'tree' });
			}
		}
		const identity = {
			name: 'marimohub',
			email: 'noreply@marimo.io',
			timestamp: Math.floor(Date.now() / 1000),
			timezoneOffset: 0,
		};
		const commit = await git.writeCommit({
			fs,
			dir,
			commit: {
				tree,
				parent: [parent],
				author: identity,
				committer: identity,
				message: options.message,
			},
		});
		await git.writeRef({
			fs,
			dir,
			ref: `refs/heads/${options.headBranch}`,
			value: commit,
			force: true,
		});
		await assertGitTreeLimits(dir, commit, options.repository);
		const result = await git
			.push({
				fs,
				dir,
				http: gitHttp(options.fetcher, options.repository),
				url: options.remoteUrl,
				ref: `refs/heads/${options.headBranch}`,
				remoteRef: `refs/heads/${options.headBranch}`,
				headers: { authorization: options.authorization },
				onPrePush: ({ remoteRef }) => {
					// The push command includes this advertised old OID, fencing later server-side races too.
					if (remoteRef.oid !== expected)
						throw new ConflictError('Git proposal branch changed while publishing');
					return true;
				},
			})
			.catch((error: unknown) => {
				if (
					error instanceof git.Errors.GitPushError ||
					error instanceof git.Errors.PushRejectedError
				)
					throw new ConflictError('Git server rejected the proposal branch update');
				if (error instanceof DomainError) throw error;
				throw new UnavailableError('Git proposal branch could not be pushed', { cause: error });
			});
		if (!result.ok || !result.refs[`refs/heads/${options.headBranch}`]?.ok)
			throw new ConflictError('Git server rejected the proposal branch update');
		return commit;
	});
}
