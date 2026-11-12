import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { createApi } from '@marimo-hub/api';
import { createFromEnv } from '@marimo-hub/config';
import { CatalogService, UserId } from '@marimo-hub/core';
import { describe, expect, it } from 'vitest';
import { localDevEnv } from './devSetup';

const exec = promisify(execFile);
const binary = process.env.MARIMOHUB_TEST_CLI;

describe.skipIf(!binary)('CLI archive push against filesystem storage', () => {
	it('publishes tar and zip, preserves idempotency, and rejects source mismatches', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'mohub-push-'));
		const checkout = join(directory, 'checkout');
		await mkdir(checkout);
		await writeFile(join(checkout, 'app.py'), 'print("published")\n');
		await writeFile(join(checkout, '.marimohubignore'), 'secret\n');
		await writeFile(join(checkout, 'secret'), 'do not upload');
		const deps = createFromEnv({
			...localDevEnv({}),
			MARIMOHUB_STORAGE_BACKEND: 'fs',
			MARIMOHUB_STORAGE_FS_ROOT: join(directory, 'storage'),
		});
		const actor = UserId.parse('user');
		await new CatalogService(deps.bucket).initialize(actor);
		const project = await deps.services.projects.createProject(
			{ name: 'Published apps', description: '' },
			actor,
		);
		const notebook = await deps.services.notebooks.synced.create(
			project.id,
			{
				title: 'App',
				description: '',
				repo: 'org/repo',
				branch: 'main',
				entry_notebook: 'app.py',
			},
			actor,
		);
		const app = createApi(deps);
		const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
		await new Promise<void>((done) => {
			if (server.listening) done();
			else server.once('listening', done);
		});
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('missing server address');
		const env = {
			...process.env,
			MARIMOHUB_URL: `http://127.0.0.1:${address.port}`,
			MARIMOHUB_SYNC_TOKEN: notebook.sync_token!,
			MARIMOHUB_NO_UPDATE_CHECK: 'true',
		};
		const args = [
			'--no-update-check',
			'--output',
			'json',
			'notebooks',
			'push',
			'--pid',
			project.id,
			'--nid',
			notebook.meta.id,
			'--repo',
			'org/repo',
			'--branch',
			'main',
			'--commit',
			'abc123',
		];
		try {
			const push = async (extra: string[] = []) =>
				JSON.parse(
					(await exec(resolve(binary!), [...args, ...extra], { cwd: checkout, env })).stdout,
				);
			const first = await push();
			expect(first).toEqual({ version_id: expect.any(String), synced: true });
			expect(await push(['--format', 'zip'])).toEqual({ version_id: null, synced: false });
			await expect(
				exec(
					resolve(binary!),
					args.map((arg) => (arg === 'org/repo' ? 'wrong/repo' : arg)),
					{ cwd: checkout, env },
				),
			).rejects.toThrow('Sync source mismatch');
			await expect(
				exec(resolve(binary!), args, {
					cwd: checkout,
					env: { ...env, MARIMOHUB_SYNC_TOKEN: 'mhsync_invalid' },
				}),
			).rejects.toThrow('Invalid sync token');
			const dry = JSON.parse(
				(
					await exec(resolve(binary!), [...args, '--dry-run'], {
						cwd: checkout,
						env: { ...env, MARIMOHUB_SYNC_TOKEN: '' },
					})
				).stdout,
			);
			expect(dry).toMatchObject({ files: ['.marimohubignore', 'app.py'] });
			await exec(resolve(binary!), args.slice(0, args.indexOf('--repo')), {
				cwd: checkout,
				env: {
					...env,
					GITHUB_REPOSITORY: 'org/repo',
					GITHUB_REF_NAME: 'main',
					GITHUB_SHA: 'abc123',
				},
			});
			const secondProject = await deps.services.projects.createProject(
				{ name: 'Second project', description: '' },
				actor,
			);
			const secondNotebook = await deps.services.notebooks.synced.create(
				secondProject.id,
				{
					title: 'Second app',
					description: '',
					repo: 'org/repo',
					branch: 'main',
					entry_notebook: 'app.py',
				},
				actor,
			);
			const manifest = join(directory, 'apps.json');
			await writeFile(
				manifest,
				JSON.stringify([
					{ path: '', pid: project.id, nid: notebook.meta.id, secret: 'SYNC_FIRST' },
					{ path: '', pid: secondProject.id, nid: secondNotebook.meta.id, secret: 'SYNC_SECOND' },
				]),
			);
			const bulkArgs = [
				'--no-update-check',
				'--output',
				'json',
				'notebooks',
				'push',
				'--manifest',
				manifest,
				'--repo',
				'org/repo',
				'--branch',
				'main',
				'--commit',
				'bulk123',
			];
			const bulkEnv = {
				...env,
				SYNC_FIRST: notebook.sync_token!,
				SYNC_SECOND: secondNotebook.sync_token!,
			};
			const bulk = JSON.parse(
				(await exec(resolve(binary!), bulkArgs, { cwd: checkout, env: bulkEnv })).stdout,
			);
			expect(bulk).toEqual({
				notebooks: [
					{
						pid: project.id,
						nid: notebook.meta.id,
						success: true,
						data: { synced: true, version_id: expect.any(String) },
					},
					{
						pid: secondProject.id,
						nid: secondNotebook.meta.id,
						success: true,
						data: { synced: true, version_id: expect.any(String) },
					},
				],
			});
			await expect(
				exec(resolve(binary!), bulkArgs, {
					cwd: checkout,
					env: { ...bulkEnv, SYNC_SECOND: 'mhsync_invalid' },
				}),
			).rejects.toMatchObject({
				stdout: expect.stringContaining('Invalid sync token'),
				stderr: expect.stringContaining('1 notebook pushes failed'),
			});
		} finally {
			await new Promise<void>((done, reject) =>
				server.close((error) => (error ? reject(error) : done())),
			);
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
