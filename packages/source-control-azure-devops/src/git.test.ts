import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { AzureDevOpsSourceControl } from './index';

it('fetches an uppercase commit over authenticated smart HTTP without persisting credentials', async () => {
	const root = await mkdtemp(join(tmpdir(), 'azure-git-test-'));
	const source = join(root, 'source');
	const restored = join(root, 'restored');
	const git = (dir: string, args: string[]) =>
		execFileSync('git', ['-C', dir, ...args], {
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Test',
				GIT_AUTHOR_EMAIL: 'test@example.com',
				GIT_COMMITTER_NAME: 'Test',
				GIT_COMMITTER_EMAIL: 'test@example.com',
			},
		}).trim();
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
					if (url.includes('/info/refs')) {
						const advertisement = execFileSync('git', [
							'upload-pack',
							'--stateless-rpc',
							'--advertise-refs',
							source,
						]);
						const service = '# service=git-upload-pack\n';
						const prefix = `${(Buffer.byteLength(service) + 4).toString(16).padStart(4, '0')}${service}0000`;
						return new Response(Buffer.concat([Buffer.from(prefix), advertisement]), {
							headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
						});
					}
					expect(new URL(url).pathname.endsWith('/git-upload-pack')).toBe(true);
					const body = init?.body
						? Buffer.from(await new Response(init.body).arrayBuffer())
						: undefined;
					const result = execFileSync('git', ['upload-pack', '--stateless-rpc', source], {
						input: body,
					});
					return new Response(result, {
						headers: { 'content-type': 'application/x-git-upload-pack-result' },
					});
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
