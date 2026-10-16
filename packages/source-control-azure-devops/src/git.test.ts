import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { git, smartHttpResponse } from '@marimo-hub/source-control-git/testing/fake-git-server';
import { AzureDevOpsSourceControl } from './index';

it('fetches an uppercase commit over authenticated smart HTTP without persisting credentials', async () => {
	const root = await mkdtemp(join(tmpdir(), 'azure-git-test-'));
	const source = join(root, 'source');
	const restored = join(root, 'restored');
	try {
		await mkdir(source);
		await mkdir(restored);
		git(source, ['init', '-b', 'main']);
		await writeFile(join(source, 'app.py'), 'print(1)');
		git(source, ['add', '.']);
		git(source, ['commit', '-m', 'Initial']);
		const commit = git(source, ['rev-parse', 'HEAD']);
		const repository = 'https://dev.azure.com/acme/Project%20One/_git/notebooks';
		const adapter = new AzureDevOpsSourceControl(
			{
				organization: 'acme',
				credential: { getToken: async () => ({ token: 'private-test-token' }) },
			},
			{
				fetcher: async (url, init) => {
					expect(url.startsWith(`${repository}/`)).toBe(true);
					expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-test-token');
					expect(init?.redirect).toBe('error');
					return smartHttpResponse(source, url, init);
				},
			},
		);
		const files = await adapter.fetchGitDirectory(repository, commit.toUpperCase(), 'main');
		for (const file of files) {
			const destination = join(restored, '.git', file.path);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, file.bytes);
		}
		const config = new TextDecoder().decode(files.find((file) => file.path === 'config')!.bytes);
		expect(config).toContain(repository);
		expect(config).not.toContain('private-test-token');
		await writeFile(join(restored, 'app.py'), 'print(1)');
		expect(git(restored, ['rev-parse', 'HEAD'])).toBe(commit);
		expect(git(restored, ['status', '--porcelain'])).toBe('');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

it('honors caller cancellation while acquiring the token', async () => {
	const fetcher = vi.fn<typeof fetch>();
	const adapter = new AzureDevOpsSourceControl(
		{ organization: 'acme', credential: { getToken: () => new Promise(() => {}) } },
		{ fetcher },
	);
	const caller = new AbortController();
	const reason = new Error('Canceled by caller');
	const pending = adapter.fetchGitDirectory(
		'https://dev.azure.com/acme/Project/_git/notebooks',
		'a'.repeat(40),
		'main',
		{ signal: caller.signal },
	);
	caller.abort(reason);
	await expect(pending).rejects.toBe(reason);
	expect(fetcher).not.toHaveBeenCalled();
});
