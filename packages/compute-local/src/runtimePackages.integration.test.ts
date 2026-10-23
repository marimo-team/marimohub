import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildMarimoLaunch } from '@marimo-hub/core/marimo-launch';
import { describe, expect, it } from 'vitest';
import { prepareMarimoCommand } from './index';

const exec = promisify(execFile);

describe.runIf(process.env.MARIMOHUB_UV_INTEGRATION === '1')('local runtime packages', () => {
	it('launches from an empty base environment without changing notebook dependencies', async () => {
		const root = await mkdtemp(join(tmpdir(), 'marimohub-local-runtime-'));
		const env = {
			PATH: process.env.PATH,
			UV_NO_CONFIG: '1',
			UV_OFFLINE: '1',
			UV_NO_INDEX: '1',
			UV_PYTHON_DOWNLOADS: 'never',
			UV_CACHE_DIR: join(root, 'cache'),
			UV_PROJECT_ENVIRONMENT: join(root, '.venv'),
			UV_FIND_LINKS: root,
		};
		const run = (command: string, args: string[]) =>
			exec(command, args, { cwd: root, env, timeout: 30_000 });
		try {
			// Tiny offline wheels keep this regression independent of PyPI and Studio releases.
			await run('python3', [
				'-c',
				`
import zipfile
for name, version, requirements in [('marimo', '0.0.1', ''), ('studio_fixture', '1.0.0', 'Requires-Dist: marimo==0.0.1\\n')]:
    info = f'{name}-{version}.dist-info'
    files = {
        f'{name}/__init__.py': '',
        f'{name}/__main__.py': 'import studio_fixture; print("launched")\\n',
        f'{info}/METADATA': f'Metadata-Version: 2.1\\nName: {name}\\nVersion: {version}\\n{requirements}',
        f'{info}/WHEEL': 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
    }
    files[f'{info}/RECORD'] = ''.join(f'{path},,\\n' for path in [*files, f'{info}/RECORD'])
    with zipfile.ZipFile(f'{name}-{version}-py3-none-any.whl', 'w') as wheel:
        for path, content in files.items():
            wheel.writestr(path, content)
`,
			]);
			const pyproject =
				'[project]\nname = "notebook"\nversion = "0.0.0"\nrequires-python = ">=3.11"\ndependencies = []\n';
			await writeFile(join(root, 'pyproject.toml'), pyproject);
			await run('uv', ['venv', '--python', '>=3.11', '.venv']);
			const { start } = buildMarimoLaunch({
				notebookFile: 'notebook.py',
				port: 2718,
				host: '127.0.0.1',
				runtimePackages: ['studio-fixture==1.0.0'],
			});
			await expect(run('sh', ['-c', start])).rejects.toMatchObject({
				stderr: expect.stringContaining('PackageNotFoundError'),
			});
			expect((await run('sh', ['-c', prepareMarimoCommand(start, '127.0.0.1')])).stdout).toBe(
				'launched\n',
			);
			await expect(
				run('uv', ['run', '--no-sync', 'python', '-c', 'import marimo']),
			).rejects.toMatchObject({ stderr: expect.stringContaining('ModuleNotFoundError') });
			expect(await readFile(join(root, 'pyproject.toml'), 'utf8')).toBe(pyproject);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
