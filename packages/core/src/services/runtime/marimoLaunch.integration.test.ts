import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMarimoLaunch } from './marimoLaunch';

const exec = promisify(execFile);

// CI supplies the same uv version as the sandbox image. All package resolution is offline.
describe.runIf(process.env.MARIMOHUB_UV_INTEGRATION === '1')(
	'inline dependency installation',
	() => {
		let root: string;
		let env: NodeJS.ProcessEnv;

		const run = (command: string, args: string[] = []) =>
			exec(command, args, { cwd: root, env, timeout: 30_000 });

		async function wheel(name: string, version: string, dependencies: string[] = []) {
			const info = `${name}-${version}.dist-info`;
			const requirements = dependencies
				.map((dependency) => `Requires-Dist: ${dependency}\n`)
				.join('');
			const files: Record<string, Uint8Array> = {
				[`${name}/__init__.py`]: strToU8(`__version__ = "${version}"\n`),
				[`${info}/METADATA`]: strToU8(
					`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n${requirements}`,
				),
				[`${info}/WHEEL`]: strToU8(
					'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
				),
			};
			files[`${info}/RECORD`] = strToU8(
				[...Object.keys(files), `${info}/RECORD`].map((path) => `${path},,\n`).join(''),
			);
			await writeFile(join(root, 'wheels', `${name}-${version}-py3-none-any.whl`), zipSync(files));
		}

		beforeEach(async () => {
			root = await mkdtemp(join(tmpdir(), 'marimohub-inline-'));
			await mkdir(join(root, 'wheels'));
			env = {
				PATH: `${join(root, '.venv', 'bin')}${delimiter}${process.env.PATH}`,
				UV_NO_CONFIG: '1',
				UV_CACHE_DIR: join(root, 'cache'),
				UV_PROJECT_ENVIRONMENT: join(root, '.venv'),
				UV_PYTHON_DOWNLOADS: 'never',
				UV_OFFLINE: '1',
				UV_NO_INDEX: '1',
				UV_FIND_LINKS: join(root, 'wheels'),
			};
			await Promise.all([
				wheel('mhub_inline_dep', '1.0.0'),
				wheel('mhub_inline_dep', '2.0.0'),
				wheel('mhub_project_dep', '1.0.0'),
				wheel('mhub_marimo_only', '1.0.0'),
				wheel('mhub_marimo_only', '2.0.0'),
				wheel('marimo', '0.0.1', ['mhub_marimo_only==1.0.0']),
				wheel('marimo', '0.0.2', ['mhub_marimo_only==2.0.0']),
			]);
			await run('uv', ['venv', '--python', '>=3.11', '.venv']);
			await run('uv', ['pip', 'install', '--python', '.venv', 'marimo==0.0.1']);
		});

		afterEach(async () => {
			if (root) await rm(root, { recursive: true, force: true });
		});

		async function setup(code: string, projectDependencies: string[] = []) {
			await writeFile(join(root, 'notebook.py'), code);
			if (projectDependencies.length > 0) {
				await writeFile(
					join(root, 'pyproject.toml'),
					`[project]\nname = "notebook"\nversion = "0.0.0"\nrequires-python = ">=3.11"\ndependencies = ${JSON.stringify(projectDependencies)}\n`,
				);
			}
			const plan = buildMarimoLaunch(
				{ notebookFile: 'notebook.py', port: 2718, host: '127.0.0.1' },
				'uv-script-pins',
			);
			for (const step of plan.setup) await run('sh', ['-c', step.command]);
		}

		const header = (dependencies: string[]) =>
			`# /// script\n# dependencies = ${JSON.stringify(dependencies)}\n# ///\nimport marimo\n`;

		async function importedVersions(...packages: string[]) {
			const { stdout } = await run('uv', [
				'run',
				'--no-sync',
				'python',
				'-c',
				'import importlib, json, sys; print(json.dumps({name: importlib.import_module(name).__version__ for name in sys.argv[1:]}))',
				...packages,
			]);
			return JSON.parse(stdout) as Record<string, string>;
		}

		it('installs into the kernel environment and preserves the image marimo and notebook source', async () => {
			const code = header(['mhub_inline_dep==2.0.0', 'marimo==0.0.2']);
			await setup(code, ['mhub_project_dep==1.0.0']);
			expect(
				await importedVersions('mhub_inline_dep', 'mhub_project_dep', 'marimo', 'mhub_marimo_only'),
			).toEqual({
				mhub_inline_dep: '2.0.0',
				mhub_project_dep: '1.0.0',
				marimo: '0.0.1',
				mhub_marimo_only: '1.0.0',
			});
			expect(await readFile(join(root, 'notebook.py'), 'utf8')).toBe(code);
			expect(await readFile(join(root, 'pyproject.toml'), 'utf8')).not.toContain('mhub_inline_dep');
		});

		it('applies inline pins after conflicting project pins', async () => {
			await setup(header(['mhub_inline_dep==2.0.0']), ['mhub_inline_dep==1.0.0']);
			expect(await importedVersions('mhub_inline_dep')).toEqual({ mhub_inline_dep: '2.0.0' });
			expect(await readFile(join(root, 'pyproject.toml'), 'utf8')).toContain(
				'mhub_inline_dep==1.0.0',
			);
		});

		it('installs inline dependencies without a pyproject and respects environment markers', async () => {
			await setup(
				header([
					'mhub_inline_dep==2.0.0; python_version >= "3.11"',
					'mhub_inline_dep==99.0.0; python_version < "3.0"',
				]),
			);
			expect(await importedVersions('mhub_inline_dep')).toEqual({ mhub_inline_dep: '2.0.0' });
		});

		it('accepts an empty dependency list without removing image packages', async () => {
			await setup(header([]));
			expect(await importedVersions('marimo')).toEqual({ marimo: '0.0.1' });
		});

		it.each([
			['invalid TOML', '# /// script\n# dependencies = [invalid\n# ///', /TOML|parse/i],
			['unclosed metadata', '# /// script\n# dependencies = []', /closing|unclosed/i],
			['unresolvable dependencies', header(['mhub_inline_dep==99.0.0']), /No solution found/i],
		] as const)('stops setup for %s', async (_, code, error) => {
			await expect(setup(code)).rejects.toMatchObject({ stderr: expect.stringMatching(error) });
			await expect(
				readFile(join(root, '.venv', 'marimohub-script-requirements.txt')),
			).rejects.toThrow();
		});
	},
);
