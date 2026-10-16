import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import isomorphicGit from 'isomorphic-git';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import {
	MAX_GIT_DIRECTORY_BYTES,
	MAX_GIT_DIRECTORY_FILES,
	MAX_GIT_EXPANDED_BYTES,
	MAX_GIT_EXPANDED_FILES,
	MAX_GIT_FETCH_BYTES,
} from '@marimo-hub/core/ports/source-control';
import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import type { GitFetch } from './index';
import { collectGitDirectoryFiles, GitFetchByteLimit, materializeGitDirectory } from './index';
import { pushGitTree } from './publish';

const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[], input?: string | Uint8Array): string {
	return execFileSync('git', args, {
		cwd,
		input,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test Author',
			GIT_AUTHOR_EMAIL: 'author@example.com',
			GIT_COMMITTER_NAME: 'Test Committer',
			GIT_COMMITTER_EMAIL: 'committer@example.com',
		},
	}).trim();
}

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function packetLine(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		`${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`,
	);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function uploadPackFetcher(repository: string): GitFetch {
	return async (url, init) => {
		if (url.includes('/info/refs')) {
			const advertised = execFileSync('git', [
				'upload-pack',
				'--stateless-rpc',
				'--advertise-refs',
				repository,
			]);
			const body = concat(
				packetLine('# service=git-upload-pack\n'),
				new TextEncoder().encode('0000'),
				new Uint8Array(advertised),
			);
			return new Response(body.buffer, {
				headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
			});
		}
		const request = init?.body
			? new Uint8Array(await new Response(init.body).arrayBuffer())
			: undefined;
		const result = execFileSync('git', ['upload-pack', '--stateless-rpc', repository], {
			input: request,
		});
		return new Response(new Uint8Array(result), {
			headers: { 'content-type': 'application/x-git-upload-pack-result' },
		});
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const ORIGINS = [
	'https://github.com',
	'https://git.acme.corp',
	'https://dev.azure.com/org/project/_git',
];

// Git subprocess tests; need headroom when the whole suite shares the CPU.
describe('materializeGitDirectory', { timeout: 15_000 }, () => {
	it.each([
		new ConflictError('GitLab rejected the request'),
		new ForbiddenError('GitLab access was denied'),
		new NotFoundError('GitLab object was not found'),
	])('classifies provider fetch failures as unavailable: %s', async (cause) => {
		Object.assign(cause, { providerStatus: 409 });
		const error = await materializeGitDirectory({
			repository: 'owner/repo',
			remoteUrl: 'https://gitlab.com/owner/repo.git',
			commit: 'a'.repeat(40),
			branch: 'main',
			authorization: 'Bearer token',
			fetcher: async () => {
				throw cause;
			},
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(UnavailableError);
		expect(error).toMatchObject({
			message: 'Git data could not be fetched',
			cause,
			providerStatus: 409,
		});
	});

	it('caps the combined bytes from all smart-HTTP responses', () => {
		const limit = new GitFetchByteLimit('owner/repo');
		limit.record(Math.ceil(MAX_GIT_FETCH_BYTES / 2));
		expect(() => limit.record(Math.floor(MAX_GIT_FETCH_BYTES / 2) + 1)).toThrow(
			`${MAX_GIT_FETCH_BYTES}-byte pull-source limit`,
		);
	});

	it.each(ORIGINS)('restores a signed, credential-free Git tree from %s', async (origin) => {
		const source = await temporaryDirectory('marimohub-git-source-');
		git(source, ['init', '-b', 'main']);
		await writeFile(join(source, 'app.py'), 'print("signed")\n');
		git(source, ['add', 'app.py']);
		const tree = git(source, ['write-tree']);
		const commitBody = [
			`tree ${tree}`,
			'author Test Author <author@example.com> 1700000000 +0000',
			'committer Test Committer <committer@example.com> 1700000000 +0000',
			'gpgsig -----BEGIN PGP SIGNATURE-----',
			' fake-signature-fixture',
			' -----END PGP SIGNATURE-----',
			'',
			'Signed fixture',
			'',
		].join('\n');
		const commit = git(source, ['hash-object', '-t', 'commit', '-w', '--stdin'], commitBody);
		git(source, ['update-ref', 'refs/heads/main', commit]);

		const files = await materializeGitDirectory({
			repository: `${origin}/owner/repo`,
			remoteUrl: `${origin}/owner/repo.git`,
			commit,
			branch: 'main',
			authorization: 'Bearer installation-secret',
			fetcher: async (url, init) => {
				expect(url.startsWith(`${origin}/owner/repo.git/`)).toBe(true);
				return uploadPackFetcher(source)(url, init);
			},
		});
		expect(files.map((file) => file.path)).toEqual(
			expect.arrayContaining(['HEAD', 'config', 'index', 'shallow']),
		);
		const config = new TextDecoder().decode(files.find((file) => file.path === 'config')?.bytes);
		expect(config).toContain(`${origin}/owner/repo.git`);
		expect(config).not.toContain('installation-secret');

		const restored = await temporaryDirectory('marimohub-git-restored-');
		await writeFile(join(restored, 'app.py'), 'print("signed")\n');
		for (const file of files) {
			const path = join(restored, '.git', file.path);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, file.bytes);
		}
		expect(git(restored, ['rev-parse', 'HEAD'])).toBe(commit);
		expect(git(restored, ['status', '--porcelain'])).toBe('');
	});

	it('produces valid Git metadata for a branch containing a double quote', async () => {
		const branch = 'feature/"quoted';
		const source = await temporaryDirectory('marimohub-git-quoted-branch-source-');
		git(source, ['init', '-b', branch]);
		await writeFile(join(source, 'app.py'), 'print("quoted branch")\n');
		git(source, ['add', 'app.py']);
		git(source, ['commit', '-m', 'Add app']);
		const commit = git(source, ['rev-parse', 'HEAD']);

		const files = await materializeGitDirectory({
			repository: 'owner/repo',
			remoteUrl: 'https://github.com/owner/repo.git',
			commit,
			branch,
			authorization: 'Bearer installation-secret',
			fetcher: uploadPackFetcher(source),
		});
		const restored = await temporaryDirectory('marimohub-git-quoted-branch-restored-');
		await writeFile(join(restored, 'app.py'), 'print("quoted branch")\n');
		for (const file of files) {
			const path = join(restored, '.git', file.path);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, file.bytes);
		}

		expect(git(restored, ['branch', '--show-current'])).toBe(branch);
		expect(git(restored, ['status', '--porcelain'])).toBe('');
	});
	it('materializes a native Git pack containing delta-compressed files', async () => {
		const source = await temporaryDirectory('marimohub-git-delta-source-');
		git(source, ['init', '-b', 'main']);
		const contents = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`).join('');
		await writeFile(join(source, 'first.txt'), contents);
		await writeFile(join(source, 'second.txt'), contents.replace('line 100', 'changed 100'));
		git(source, ['add', '.']);
		git(source, ['commit', '-m', 'Similar files']);
		git(source, ['repack', '-adf']);
		const packdir = join(source, '.git', 'objects', 'pack');
		const idx = (await readdir(packdir)).find((path) => path.endsWith('.idx'))!;
		expect(git(source, ['verify-pack', '-v', join(packdir, idx)])).toMatch(
			/ blob\s+\d+ \d+ \d+ \d+ [a-f0-9]{40}/,
		);
		const files = await materializeGitDirectory({
			repository: 'owner/deltas',
			remoteUrl: 'https://github.com/owner/deltas.git',
			commit: git(source, ['rev-parse', 'HEAD']),
			branch: 'main',
			authorization: 'Bearer token',
			fetcher: uploadPackFetcher(source),
		});
		expect(files.map((file) => file.path)).toContain('index');
	});

	it.each([false, true])(
		'cancels an oversized HTTP response even if cancellation fails: %s',
		async (failCancellation) => {
			const cancel = vi.fn(async () => {
				if (failCancellation) throw new Error('Cancellation failed');
			});
			const fetcher: GitFetch = async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: { 'content-length': String(MAX_GIT_FETCH_BYTES + 1) },
				});
			await expect(
				materializeGitDirectory({
					repository: 'owner/large-repo',
					remoteUrl: 'https://github.com/owner/large-repo.git',
					commit: 'a'.repeat(40),
					branch: 'main',
					authorization: 'Bearer token',
					fetcher,
				}),
			).rejects.toBeInstanceOf(BadRequestError);
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{
			kind: 'large file',
			count: 1,
			size: MAX_WORKSPACE_FILE_BYTES + 1,
			limit: `${MAX_WORKSPACE_FILE_BYTES}-byte`,
		},
		{
			kind: 'many files',
			count: MAX_GIT_EXPANDED_FILES + 1,
			size: 0,
			limit: `${MAX_GIT_EXPANDED_FILES}-file`,
		},
		{
			kind: 'cumulative bytes',
			count: 5,
			size: Math.floor(MAX_GIT_EXPANDED_BYTES / 5) + 1,
			limit: `${MAX_GIT_EXPANDED_BYTES}-byte`,
		},
	])('rejects compressed $kind before writing a checkout', async ({ count, size, limit }) => {
		const source = await temporaryDirectory('marimohub-git-expansion-source-');
		git(source, ['init', '-b', 'main']);
		for (let index = 0; index < count; index++) {
			const file = join(source, `file-${index}`);
			await writeFile(file, '');
			await truncate(file, size);
		}
		git(source, ['add', '.']);
		git(source, ['commit', '-m', 'Oversized tree']);
		const checkout = vi.spyOn(isomorphicGit, 'checkout');
		const readCommit = vi.spyOn(isomorphicGit, 'readCommit');
		try {
			await expect(
				materializeGitDirectory({
					repository: 'owner/expanded',
					remoteUrl: 'https://github.com/owner/expanded.git',
					commit: git(source, ['rev-parse', 'HEAD']),
					branch: 'main',
					authorization: 'Bearer token',
					fetcher: uploadPackFetcher(source),
				}),
			).rejects.toThrow(limit);
			expect(checkout).not.toHaveBeenCalled();
			if (size > MAX_WORKSPACE_FILE_BYTES) expect(readCommit).not.toHaveBeenCalled();
		} finally {
			checkout.mockRestore();
			readCommit.mockRestore();
		}
	});

	it.each(['tree', 'commit'] as const)(
		'rejects repeated %s entries before creating checkout directories',
		async (type) => {
			const source = await temporaryDirectory('marimohub-git-directory-expansion-');
			git(source, ['init', '-b', 'main']);
			const empty = git(source, ['mktree'], '');
			const object =
				type === 'tree' ? empty : git(source, ['commit-tree', empty, '-m', 'Submodule']);
			const mode = type === 'tree' ? '040000' : '160000';
			const tree = git(
				source,
				['mktree'],
				Array.from(
					{ length: MAX_GIT_EXPANDED_FILES + 1 },
					(_, index) => `${mode} ${type} ${object}\tdirectory-${index}\n`,
				).join(''),
			);
			const commit = git(source, ['commit-tree', tree, '-m', 'Many empty directories']);
			git(source, ['update-ref', 'refs/heads/main', commit]);
			const checkout = vi.spyOn(isomorphicGit, 'checkout');
			try {
				await expect(
					materializeGitDirectory({
						repository: 'owner/expanded',
						remoteUrl: 'https://github.com/owner/expanded.git',
						commit,
						branch: 'main',
						authorization: 'Bearer token',
						fetcher: uploadPackFetcher(source),
					}),
				).rejects.toThrow(`${MAX_GIT_EXPANDED_FILES}-directory limit`);
				expect(checkout).not.toHaveBeenCalled();
			} finally {
				checkout.mockRestore();
			}
		},
	);

	it('rejects a materialized Git directory beyond the file-count cap', async () => {
		const gitdir = await temporaryDirectory('marimohub-git-many-files-');
		for (let index = 0; index < MAX_GIT_DIRECTORY_FILES + 1; index++) {
			await writeFile(join(gitdir, `object-${index}`), '');
		}

		await expect(collectGitDirectoryFiles(gitdir, 'owner/many-files')).rejects.toThrow(
			`${MAX_GIT_DIRECTORY_FILES}-file limit`,
		);
	});

	it('rejects cumulative materialized bytes beyond the cap', async () => {
		const gitdir = await temporaryDirectory('marimohub-git-expanded-');
		const fileSize = Math.floor(MAX_GIT_DIRECTORY_BYTES / 5) + 1;
		for (let index = 0; index < 5; index++) {
			const path = join(gitdir, `object-${index}`);
			await writeFile(path, '');
			await truncate(path, fileSize);
		}

		await expect(collectGitDirectoryFiles(gitdir, 'owner/expanded')).rejects.toThrow(
			`${MAX_GIT_DIRECTORY_BYTES}-byte limit`,
		);
	});

	it('preserves a symlink index entry when the workspace omits the symlink', async () => {
		const source = await temporaryDirectory('marimohub-git-symlink-source-');
		git(source, ['init', '-b', 'main']);
		await writeFile(join(source, 'app.py'), 'print("app")\n');
		await symlink('app.py', join(source, 'app-link.py'));
		git(source, ['add', 'app.py', 'app-link.py']);
		git(source, ['commit', '-m', 'Add app and symlink']);
		const commit = git(source, ['rev-parse', 'HEAD']);

		const files = await materializeGitDirectory({
			repository: 'owner/repo',
			remoteUrl: 'https://github.com/owner/repo.git',
			commit,
			branch: 'main',
			authorization: 'Bearer installation-secret',
			fetcher: uploadPackFetcher(source),
		});
		const restored = await temporaryDirectory('marimohub-git-symlink-restored-');
		await writeFile(join(restored, 'app.py'), 'print("app")\n');
		for (const file of files) {
			const path = join(restored, '.git', file.path);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, file.bytes);
		}

		expect(git(restored, ['status', '--porcelain'])).toBe('D app-link.py');
	});
});

describe('pushGitTree failure classification', () => {
	it.each([
		{
			cause: new Error('Connection reset'),
			message: 'Git proposal branch could not be pushed',
			type: UnavailableError,
		},
		{
			cause: new ConflictError('Git proposal branch changed while publishing'),
			message: 'Git proposal branch changed while publishing',
			type: ConflictError,
		},
		{
			cause: Object.assign(new ForbiddenError('GitLab access was denied'), { providerStatus: 403 }),
			message: 'GitLab access was denied',
			type: ForbiddenError,
		},
	])('reports $message', async ({ cause, message, type }) => {
		const source = await temporaryDirectory('marimohub-git-push-error-');
		git(source, ['init', '-b', 'main']);
		const tree = git(source, ['mktree'], '');
		const commit = git(source, ['commit-tree', tree, '-m', 'Initial commit']);
		git(source, ['update-ref', 'refs/heads/main', commit]);
		const push = vi.spyOn(isomorphicGit, 'push').mockRejectedValue(cause);
		try {
			const error = await pushGitTree({
				repository: 'owner/repo',
				remoteUrl: 'https://gitlab.com/owner/repo.git',
				commit,
				branch: 'main',
				authorization: 'Bearer token',
				fetcher: uploadPackFetcher(source),
				headBranch: 'proposal',
				expectedHead: null,
				tree: new Map(),
				contents: new Map(),
				message: 'Propose changes',
			}).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(type);
			expect(error).toMatchObject({ message });
			if (type === UnavailableError) expect(error).toHaveProperty('cause', cause);
			else expect(error).toBe(cause);
		} finally {
			push.mockRestore();
		}
	});
});
