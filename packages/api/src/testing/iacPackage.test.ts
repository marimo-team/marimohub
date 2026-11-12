import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { defaultRegistry, ProjectIntegrationsStore } from '@marimo-hub/core';
import { createInitializedBucket, createTestApi, expectOk } from './index';

const run = promisify(execFile);

describe.skipIf(!process.env.MARIMOHUB_IAC_SMOKE)('packed IaC package', () => {
	it('installs outside the workspace and converges against the Hub from Node and Deno', async ({
		onTestFinished,
	}) => {
		const directory = await mkdtemp(join(tmpdir(), 'marimohub-iac-'));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const bucket = await createInitializedBucket();
		const integrations = new ProjectIntegrationsStore({ bucket, registry: defaultRegistry() });
		const { app, request } = createTestApi({ bucket, deps: { integrations } });
		const { id } = await expectOk<{ id: string }>(
			await request('POST', '/projects', { name: 'IaC', description: '' }),
			201,
		);
		const hub = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const response = await app.request(`http://localhost${req.url}`, {
				method: req.method,
				headers: { 'content-type': 'application/json' },
				...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(Buffer.from(await response.arrayBuffer()));
		});
		onTestFinished(async () => {
			hub.closeAllConnections();
			await new Promise<void>((done) => hub.close(() => done()));
		});
		await new Promise<void>((done) => hub.listen(0, '127.0.0.1', done));
		const address = hub.address();
		if (!address || typeof address === 'string') throw new Error('Missing Hub address');
		const packageDir = resolve('../iac');
		const { stdout } = await run('npm', [
			'pack',
			packageDir,
			'--pack-destination',
			directory,
			'--json',
			'--ignore-scripts',
		]);
		const [{ filename }] = JSON.parse(stdout) as { filename: string }[];
		const tarball = await readFile(join(directory, filename));
		const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
			name: string;
			version: string;
		};
		const registry = createServer((req, res) => {
			if (req.url === '/iac.tgz') {
				res.end(tarball);
				return;
			}
			const location = registry.address();
			if (!location || typeof location === 'string') {
				res.writeHead(500).end();
				return;
			}
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					name: manifest.name,
					'dist-tags': { latest: manifest.version },
					versions: {
						[manifest.version]: {
							...manifest,
							dist: {
								tarball: `http://127.0.0.1:${location.port}/iac.tgz`,
								integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
							},
						},
					},
				}),
			);
		});
		onTestFinished(async () => {
			registry.closeAllConnections();
			await new Promise<void>((done) => registry.close(() => done()));
		});
		await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
		{
			const location = registry.address();
			if (!location || typeof location === 'string') throw new Error('Missing registry address');
			await writeFile(join(directory, '.npmrc'), `registry=http://127.0.0.1:${location.port}/\n`);
			await writeFile(
				join(directory, 'package.json'),
				JSON.stringify({ type: 'module', dependencies: { [manifest.name]: manifest.version } }),
			);
			await writeFile(
				join(directory, 'smoke.ts'),
				`import { createHub, integration } from '@marimo-hub/iac';\nimport type { IntegrationSpec } from '@marimo-hub/iac';\nconst target = createHub({ url: 'http://127.0.0.1:${address.port}', token: 'test' }).project('${id}').integrations;\nconst spec: IntegrationSpec = integration('agent_context', 'instructions', { instructions: 'Use polars.' });\nawait target.upsert(spec);\nconst result = await target.upsert(spec);\nif (result.action !== 'unchanged') throw new Error('Did not converge');\nconsole.log('converged');\n`,
			);
			await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
				cwd: directory,
			});
			expect((await run(process.execPath, ['smoke.ts'], { cwd: directory })).stdout).toContain(
				'converged',
			);
			await writeFile(
				join(directory, 'deno.json'),
				JSON.stringify({
					nodeModulesDir: 'auto',
					lock: true,
					imports: {
						'@marimo-hub/iac': `npm:@marimo-hub/iac@${manifest.version}`,
						'@marimo-hub/iac/runner': `npm:@marimo-hub/iac@${manifest.version}/runner`,
					},
				}),
			);
			await writeFile(
				join(directory, 'integrations.ts'),
				await readFile(resolve('../../examples/integration-iac/deno/integrations.ts'), 'utf8'),
			);
			await rm(join(directory, 'node_modules'), { recursive: true, force: true });
			await run('deno', ['install'], {
				cwd: directory,
				env: { ...process.env, DENO_DIR: join(directory, '.deno') },
			});
			await run('deno', ['check', 'smoke.ts', 'integrations.ts'], {
				cwd: directory,
				env: { ...process.env, DENO_DIR: join(directory, '.deno') },
			});
			const lock = await readFile(join(directory, 'deno.lock'), 'utf8');
			expect(lock).toContain(manifest.version);
			expect(lock).toContain('integrity');
			if (process.env.MARIMOHUB_IAC_LOCK_PATH)
				await writeFile(process.env.MARIMOHUB_IAC_LOCK_PATH, lock);
			expect(
				(
					await run(
						'deno',
						['run', '--no-prompt', '--frozen', `--allow-net=127.0.0.1:${address.port}`, 'smoke.ts'],
						{ cwd: directory, env: { ...process.env, DENO_DIR: join(directory, '.deno') } },
					)
				).stdout,
			).toContain('converged');
		}
	}, 120_000);
});
