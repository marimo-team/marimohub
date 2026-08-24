import fs from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import git from 'isomorphic-git';
import type { GitHttpRequest, HttpClient } from 'isomorphic-git';
import {
	BadRequestError,
	GitDirectoryLimitTracker,
	MAX_GIT_EXPANDED_BYTES,
	MAX_GIT_EXPANDED_FILES,
	MAX_GIT_FETCH_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
	UnavailableError,
} from '@marimo-hub/core';
import type { SourceWorkspaceFile } from '@marimo-hub/core';
import type { GitHubFetch } from './githubClient';

function repositorySizeError(repository: string, limit: number): BadRequestError {
	return new BadRequestError(
		`The Git data for ${repository} exceeds the ${limit}-byte pull-source limit; reduce the repository history or use push sync`,
	);
}

export class GitFetchByteLimit {
	private received = 0;

	constructor(private readonly repository: string) {}

	assertFits(size: number): void {
		if (!Number.isSafeInteger(size) || size < 0 || this.received + size > MAX_GIT_FETCH_BYTES) {
			throw repositorySizeError(this.repository, MAX_GIT_FETCH_BYTES);
		}
	}

	record(size: number): void {
		this.assertFits(size);
		this.received += size;
	}
}

async function requestBody(
	body: GitHttpRequest['body'],
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	if (!body) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function responseBody(
	response: Response,
	recordBytes: (size: number) => void,
): AsyncIterableIterator<Uint8Array> {
	const body = response.body;
	return (async function* () {
		if (!body) return;
		const reader = body.getReader();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				recordBytes(next.value.byteLength);
				yield next.value;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	})();
}

function gitHttp(fetcher: GitHubFetch, repository: string): HttpClient {
	const limit = new GitFetchByteLimit(repository);
	return {
		request: async (request) => {
			const body = await requestBody(request.body);
			const response = await fetcher(request.url, {
				method: request.method,
				headers: request.headers,
				body: body?.buffer,
			});
			const contentLength = Number(response.headers.get('content-length'));
			if (Number.isFinite(contentLength) && contentLength >= 0) {
				limit.assertFits(contentLength);
			}
			return {
				url: response.url || request.url,
				method: request.method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
				body: responseBody(response, (size) => limit.record(size)),
			};
		},
	};
}

export async function assertGitCheckoutLimits(root: string, repository: string): Promise<void> {
	let fileCount = 0;
	let totalBytes = 0;
	async function scan(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (directory === root && entry.name === '.git') continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await scan(path);
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const info = await lstat(path);
			fileCount += 1;
			totalBytes += info.size;
			if (info.size > MAX_WORKSPACE_FILE_BYTES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} contains a file beyond the ${MAX_WORKSPACE_FILE_BYTES}-byte limit; reduce the repository history or use push sync`,
				);
			}
			if (fileCount > MAX_GIT_EXPANDED_FILES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} exceeds the ${MAX_GIT_EXPANDED_FILES}-file limit; reduce the repository history or use push sync`,
				);
			}
			if (totalBytes > MAX_GIT_EXPANDED_BYTES) {
				throw new BadRequestError(
					`The expanded Git data for ${repository} exceeds the ${MAX_GIT_EXPANDED_BYTES}-byte limit; reduce the repository history or use push sync`,
				);
			}
		}
	}
	await scan(root);
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

export async function materializeGitDirectory(options: {
	repository: string;
	owner: string;
	repo: string;
	commit: string;
	branch: string;
	token: string;
	fetcher: GitHubFetch;
}): Promise<SourceWorkspaceFile[]> {
	const directory = await mkdtemp(join(tmpdir(), 'marimohub-git-'));
	const gitdir = join(directory, '.git');
	const remoteUrl = `https://github.com/${options.owner}/${options.repo}.git`;
	try {
		await git.init({ fs, dir: directory, defaultBranch: options.branch });
		await git.addRemote({ fs, dir: directory, remote: 'origin', url: remoteUrl });
		const result = await git.fetch({
			fs,
			http: gitHttp(options.fetcher, options.repository),
			dir: directory,
			url: remoteUrl,
			ref: options.branch,
			remoteRef: options.commit,
			singleBranch: true,
			depth: 1,
			tags: false,
			headers: {
				authorization: `Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
			},
		});
		if (result.fetchHead !== options.commit) {
			throw new UnavailableError('GitHub returned a different commit than requested');
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
		await git.setConfig({
			fs,
			dir: directory,
			path: `branch.${options.branch}.remote`,
			value: 'origin',
		});
		await git.setConfig({
			fs,
			dir: directory,
			path: `branch.${options.branch}.merge`,
			value: `refs/heads/${options.branch}`,
		});
		await git.checkout({ fs, dir: directory, ref: options.branch, force: true });
		await assertGitCheckoutLimits(directory, options.repository);
		return await collectGitDirectoryFiles(gitdir, options.repository);
	} catch (error) {
		if (error instanceof BadRequestError || error instanceof UnavailableError) throw error;
		throw new UnavailableError('GitHub Git data could not be fetched', { cause: error });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
