import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import git from 'isomorphic-git';
import type { GitHttpRequest, HttpClient } from 'isomorphic-git';
import { BadRequestError, MAX_WORKSPACE_FILE_BYTES, UnavailableError } from '@marimo-hub/core';
import type { SourceWorkspaceFile } from '@marimo-hub/core';
import type { GitHubFetch } from './githubClient';

function repositorySizeError(repository: string): BadRequestError {
	return new BadRequestError(
		`The Git data for ${repository} exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte pull-source limit; reduce the repository history or use push sync`,
	);
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

function responseBody(response: Response, repository: string): AsyncIterableIterator<Uint8Array> {
	const body = response.body;
	return (async function* () {
		if (!body) return;
		const reader = body.getReader();
		let received = 0;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				received += next.value.byteLength;
				if (received > MAX_WORKSPACE_FILE_BYTES) throw repositorySizeError(repository);
				yield next.value;
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	})();
}

function gitHttp(fetcher: GitHubFetch, repository: string): HttpClient {
	return {
		request: async (request) => {
			const body = await requestBody(request.body);
			const response = await fetcher(request.url, {
				method: request.method,
				headers: request.headers,
				body: body?.buffer,
			});
			const contentLength = Number(response.headers.get('content-length'));
			if (Number.isFinite(contentLength) && contentLength > MAX_WORKSPACE_FILE_BYTES) {
				throw repositorySizeError(repository);
			}
			return {
				url: response.url || request.url,
				method: request.method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers.entries()),
				body: responseBody(response, repository),
			};
		},
	};
}

async function collectFiles(root: string, repository: string): Promise<SourceWorkspaceFile[]> {
	const files: SourceWorkspaceFile[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const info = await stat(path);
			if (info.size > MAX_WORKSPACE_FILE_BYTES) throw repositorySizeError(repository);
			files.push({
				path: relative(root, path).split('\\').join('/'),
				bytes: new Uint8Array(await readFile(path)),
			});
		}
	}
	await visit(root);
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
		return await collectFiles(gitdir, options.repository);
	} catch (error) {
		if (error instanceof BadRequestError || error instanceof UnavailableError) throw error;
		throw new UnavailableError('GitHub Git data could not be fetched', { cause: error });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
