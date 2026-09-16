import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { notebookBridgeRuntime } from '../src/runtime';
import { harness } from './harness';

const versions = ['0.23.10', '0.24.2'];
const exec = promisify(execFile);
const test = base.extend<{ runtime: { root: string; launcher: string } }>({
	// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
	runtime: async ({}, provide) => {
		const root = await mkdtemp(join(tmpdir(), 'marimohub-bridge-'));
		const payload = notebookBridgeRuntime();
		try {
			await Promise.all(
				payload.files.map(({ name, content }) => writeFile(join(root, name), content)),
			);
			await provide({ root, launcher: join(root, payload.launcher) });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
});

const notebook = `import marimo
app = marimo.App()
@app.cell
def _():
    import marimo as mo
    return (mo,)
@app.cell
def _(mo):
    params = mo.query_params()
    return (params,)
@app.cell
def _(mo, params):
    set_query = mo.ui.button(label="Set query", on_click=lambda _: params.set("id", "456"))
    append_query = mo.ui.button(label="Append query", on_click=lambda _: params.append("tag", "one"))
    delete_query = mo.ui.button(label="Delete query", on_click=lambda _: params.remove("id"))
    clear_query = mo.ui.button(label="Clear query", on_click=lambda _: params.clear())
    mo.vstack([mo.hstack([set_query, append_query, delete_query, clear_query]), mo.md("Current id: " + str(params["id"]))])
    return (set_query, append_query, delete_query, clear_query)
if __name__ == "__main__":
    app.run()
`;

async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => {
		socket.listen(0, '127.0.0.1', resolve);
	});
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('Missing port');
	await new Promise<void>((resolve) => {
		socket.close(() => resolve());
	});
	return address.port;
}

for (const version of versions) {
	for (const mode of ['run', 'edit']) {
		test(`Python query mutations with marimo ${version} ${mode}`, async ({ page, runtime }) => {
			const host = await harness();
			const { root } = runtime;
			await writeFile(join(root, 'notebook.py'), notebook);
			const port = await freePort();
			let logs = '';
			const child = spawn(
				'uv',
				[
					'run',
					'--no-project',
					'--with',
					`marimo==${version}`,
					'python',
					runtime.launcher,
					'--quiet',
					mode,
					join(root, 'notebook.py'),
					'--headless',
					'--no-token',
					'--host',
					'127.0.0.1',
					'--port',
					String(port),
				],
				{
					cwd: root,
					env: { ...process.env, MARIMOHUB_BRIDGE_PARENT_ORIGIN: host.hostOrigin },
					stdio: ['ignore', 'pipe', 'pipe'],
					detached: true,
				},
			);
			child.stdout.on('data', (data: Buffer) => {
				logs += data.toString();
			});
			child.stderr.on('data', (data: Buffer) => {
				logs += data.toString();
			});
			const url = `http://127.0.0.1:${port}/`;
			try {
				await expect(async () => {
					expect(child.exitCode, logs).toBeNull();
					expect((await fetch(url)).ok).toBe(true);
				}).toPass({ timeout: 120_000 });
				await page.goto(`${host.hostOrigin}/?child=${encodeURIComponent(`${url}?id=123`)}`);
				await expect
					.poll(() => page.evaluate(() => window.bridge?.status), { timeout: 30_000 })
					.toBe('connected');
				const frame = page.frameLocator('iframe');
				await expect(frame.getByText('Current id: 123', { exact: true })).toBeVisible({
					timeout: 30_000,
				});
				const loads = await page.evaluate(() => window.loads);
				await frame.getByRole('button', { name: 'Set query', exact: true }).click();
				await expect(page).toHaveURL(`${host.hostOrigin}/?id=456`);
				await frame.getByRole('button', { name: 'Append query', exact: true }).click();
				await expect(page).toHaveURL(`${host.hostOrigin}/?id=456&tag=one`);
				await frame.getByRole('button', { name: 'Delete query', exact: true }).click();
				await expect(page).toHaveURL(`${host.hostOrigin}/?tag=one`);
				await frame.getByRole('button', { name: 'Clear query', exact: true }).click();
				await expect(page).toHaveURL(`${host.hostOrigin}/`);
				expect(await page.evaluate(() => window.loads)).toBe(loads);
				expect(logs).not.toContain('notebook_bridge_unavailable');
				await page.evaluate(() => window.navigateNotebook('?id=789'));
				await expect.poll(() => page.evaluate(() => window.loads)).toBe(loads + 1);
				await expect(page).toHaveURL(`${host.hostOrigin}/?id=789`);
				await expect(page.locator('iframe')).toHaveAttribute('src', `${url}?id=789`);
				await expect.poll(() => page.evaluate(() => window.bridge.status)).toBe('connected');
				if (mode === 'run') {
					await expect(frame.getByText('Current id: 789', { exact: true })).toBeVisible({
						timeout: 30_000,
					});
					await frame.getByRole('button', { name: 'Set query', exact: true }).click();
				} else {
					// Editors reconnect their kernel; verify the new document's bridge without requiring Python state restoration.
					await frame.locator('html').evaluate(() => history.replaceState({}, '', '?id=456'));
				}
				await expect(page).toHaveURL(`${host.hostOrigin}/?id=456`);
				expect(await page.evaluate(() => window.loads)).toBe(loads + 1);
			} finally {
				if (child.pid && child.exitCode === null) {
					const exited = new Promise<void>((resolve) => {
						child.once('exit', () => resolve());
					});
					process.kill(-child.pid, 'SIGKILL');
					await exited;
				}
				await host.close();
			}
		});
	}
}

test('installs offline in a custom environment, skips matching artifacts and repairs a recreated environment', async ({
	runtime,
}) => {
	const { root } = runtime;
	const environment = join(root, 'custom environment');
	const python = join(environment, 'bin/python');
	const source = `import runpy; runpy.run_path(${JSON.stringify(runtime.launcher)})["install"](); import marimohub_notebook_bridge`;
	for (let generation = 0; generation < 2; generation++) {
		await exec('uv', ['venv', environment]);
		await exec(python, ['-c', source], { env: { ...process.env, UV_OFFLINE: 'true' } });
		// With uv unavailable, a second launch succeeds only when identity detection skips installation.
		await exec(python, ['-c', source], { env: { ...process.env, PATH: '' } });
		await rm(environment, { recursive: true, force: true });
	}
});

for (const version of versions) {
	test(`failed offline installation preserves the marimo ${version} CLI`, async ({ runtime }) => {
		const { root } = runtime;
		await writeFile(
			join(root, 'install.json'),
			JSON.stringify({ identity: 'force-reinstall', wheel: 'missing.whl' }),
		);
		const { stdout, stderr } = await exec(
			'uv',
			[
				'run',
				'--no-project',
				'--with',
				`marimo==${version}`,
				'python',
				runtime.launcher,
				'--version',
			],
			{
				env: {
					...process.env,
					UV_OFFLINE: 'true',
					MARIMOHUB_BRIDGE_PARENT_ORIGIN: 'https://private-origin.example',
				},
			},
		);
		expect(stdout).toContain(version);
		const diagnostics = stderr
			.split('\n')
			.filter((line) => line.includes('notebook_bridge_unavailable'));
		expect(diagnostics).toHaveLength(1);
		expect(JSON.parse(diagnostics[0])).toEqual({
			event: 'notebook_bridge_unavailable',
			reason: 'install_failed',
		});
		expect(stderr).not.toContain('private-origin.example');
	});
}
