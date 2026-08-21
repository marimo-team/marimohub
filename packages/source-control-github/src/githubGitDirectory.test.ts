import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { BadRequestError, MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core';
import type { GitHubFetch } from './githubClient';
import { materializeGitDirectory } from './githubGitDirectory';

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

function uploadPackFetcher(repository: string): GitHubFetch {
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

describe('materializeGitDirectory', () => {
	it('preserves an exact signed commit and produces a clean credential-free working tree', async () => {
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
			repository: 'owner/repo',
			owner: 'owner',
			repo: 'repo',
			commit,
			branch: 'main',
			token: 'installation-secret',
			fetcher: uploadPackFetcher(source),
		});
		expect(files.map((file) => file.path)).toEqual(
			expect.arrayContaining(['HEAD', 'config', 'index', 'shallow']),
		);
		const config = new TextDecoder().decode(files.find((file) => file.path === 'config')?.bytes);
		expect(config).toContain('https://github.com/owner/repo.git');
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

	it('rejects a smart-HTTP response beyond the Git pack limit', async () => {
		const fetcher: GitHubFetch = async () =>
			new Response('too large', {
				headers: { 'content-length': String(MAX_WORKSPACE_FILE_BYTES + 1) },
			});
		await expect(
			materializeGitDirectory({
				repository: 'owner/large-repo',
				owner: 'owner',
				repo: 'large-repo',
				commit: 'a'.repeat(40),
				branch: 'main',
				token: 'token',
				fetcher,
			}),
		).rejects.toBeInstanceOf(BadRequestError);
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
			owner: 'owner',
			repo: 'repo',
			commit,
			branch: 'main',
			token: 'installation-secret',
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
