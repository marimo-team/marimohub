import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import git from 'isomorphic-git';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import {
	GitDirectoryLimitTracker,
	MAX_GIT_EXPANDED_BYTES,
	MAX_GIT_EXPANDED_FILES,
} from '@marimo-hub/core/ports/source-control';
import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import type { SourceWorkspaceFile } from '@marimo-hub/core/ports/source-control';
import { assertGitPackLimits } from './packLimits';
import { isSafeGitEntryName } from './fileTree';
import { gitHttp, gitTransportError } from './transport';
import type { GitFetch, GitTransportTimeouts } from './transport';
export { GitFetchByteLimit, gitHttp } from './transport';
export type { GitFetch, GitHttpOptions, GitTransportTimeouts } from './transport';

export async function assertGitTreeLimits(
	directory: string,
	commit: string,
	repository: string,
): Promise<void> {
	let fileCount = 0;
	let directoryCount = 0;
	let totalBytes = 0;
	const { commit: head } = await git.readCommit({ fs, dir: directory, oid: commit });
	const pending = [head.tree];
	const sizes = new Map<string, number>();
	while (pending.length > 0) {
		const oid = pending.pop()!;
		const { tree } = await git.readTree({ fs, dir: directory, oid });
		const names = new Set<string>();
		for (const entry of tree) {
			if (!isSafeGitEntryName(entry.path) || names.has(entry.path))
				throw new BadRequestError('Git tree contains an unsafe path');
			names.add(entry.path);
			if (entry.type === 'tree' || entry.type === 'commit') {
				// Empty trees and submodules create directories without adding blob entries.
				directoryCount += 1;
				if (directoryCount > MAX_GIT_EXPANDED_FILES) {
					throw new BadRequestError(
						`The expanded Git data for ${repository} exceeds the ${MAX_GIT_EXPANDED_FILES}-directory limit; reduce the repository history or use push sync`,
					);
				}
				if (entry.type === 'tree') pending.push(entry.oid);
				continue;
			}
			if (entry.type !== 'blob') continue;
			fileCount += 1;
			if (fileCount > MAX_GIT_EXPANDED_FILES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} exceeds the ${MAX_GIT_EXPANDED_FILES}-file limit; reduce the repository history or use push sync`,
				);
			}
			let size = sizes.get(entry.oid);
			if (size === undefined) {
				const { blob } = await git.readBlob({ fs, dir: directory, oid: entry.oid });
				size = blob.byteLength;
				sizes.set(entry.oid, size);
			}
			if (size > MAX_WORKSPACE_FILE_BYTES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} contains a file beyond the ${MAX_WORKSPACE_FILE_BYTES}-byte limit; reduce the repository history or use push sync`,
				);
			}
			totalBytes += size;
			if (totalBytes > MAX_GIT_EXPANDED_BYTES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} exceeds the ${MAX_GIT_EXPANDED_BYTES}-byte limit; reduce the repository history or use push sync`,
				);
			}
		}
	}
}

export async function collectGitDirectoryFiles(
	root: string,
	repository: string,
): Promise<SourceWorkspaceFile[]> {
	const entries: { path: string; relativePath: string }[] = [];
	const limits = new GitDirectoryLimitTracker();
	async function scan(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await scan(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const info = await stat(path);
			const relativePath = relative(root, path).split('\\').join('/');
			try {
				limits.add(relativePath, info.size);
			} catch (error) {
				if (error instanceof BadRequestError) {
					throw new BadRequestError(
						`The Git data for ${repository} is outside pull-source limits: ${error.message}; reduce the repository history or use push sync`,
					);
				}
				throw error;
			}
			entries.push({ path, relativePath });
		}
	}
	await scan(root);
	const files: SourceWorkspaceFile[] = [];
	for (const { path, relativePath } of entries) {
		files.push({
			path: relativePath,
			bytes: new Uint8Array(await readFile(path)),
		});
	}
	return files;
}

export interface GitFetchOptions {
	repository: string;
	remoteUrl: string;
	commit: string;
	branch: string;
	authorization: string;
	fetcher: GitFetch;
	signal?: AbortSignal;
	timeouts?: GitTransportTimeouts;
}

export function gitTransport(options: GitFetchOptions) {
	return gitHttp({
		fetcher: options.fetcher,
		repository: options.repository,
		remoteUrl: options.remoteUrl,
		signal: options.signal,
		timeouts: options.timeouts,
	});
}

export async function withFetchedGit<T>(
	options: GitFetchOptions,
	action: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), 'marimohub-git-'));
	const remoteUrl = options.remoteUrl;
	// Fetch indexes the pack after writing it; reject unsafe expansion at that boundary.
	const guardedFs = {
		promises: {
			...fs.promises,
			writeFile: async (...args: Parameters<typeof fs.promises.writeFile>) => {
				const [path, data] = args;
				if (typeof path !== 'string') throw new BadRequestError('Invalid Git file path');
				if (path.endsWith('.pack')) {
					if (!(data instanceof Uint8Array)) throw new BadRequestError('Invalid Git pack');
					await assertGitPackLimits(data, options.repository);
				}
				return fs.promises.writeFile(...args);
			},
		},
	};
	const http = gitTransport(options);
	try {
		try {
			await git.init({ fs, dir: directory, defaultBranch: options.branch });
			await git.addRemote({ fs, dir: directory, remote: 'origin', url: remoteUrl });
			const result = await git.fetch({
				fs: guardedFs,
				http,
				dir: directory,
				url: remoteUrl,
				ref: options.branch,
				remoteRef: options.commit,
				singleBranch: true,
				depth: 1,
				tags: false,
				headers: {
					authorization: options.authorization,
				},
			});
			if (result.fetchHead !== options.commit) {
				throw new UnavailableError('Git server returned a different commit than requested');
			}
			await git.writeRef({
				fs,
				dir: directory,
				ref: `refs/heads/${options.branch}`,
				value: options.commit,
				force: true,
			});
			await git.writeRef({
				fs,
				dir: directory,
				ref: `refs/remotes/origin/${options.branch}`,
				value: options.commit,
				force: true,
			});
			await assertGitTreeLimits(directory, options.commit, options.repository);
		} catch (error) {
			options.signal?.throwIfAborted();
			throw gitTransportError(error, 'Git data could not be fetched', http);
		}
		return await action(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function materializeGitDirectory(
	options: GitFetchOptions,
): Promise<SourceWorkspaceFile[]> {
	return withFetchedGit(options, async (directory) => {
		try {
			await git.checkout({ fs, dir: directory, ref: options.branch, force: true });
			return await collectGitDirectoryFiles(join(directory, '.git'), options.repository);
		} catch (error) {
			throw gitTransportError(error, 'Git data could not be materialized');
		}
	});
}
