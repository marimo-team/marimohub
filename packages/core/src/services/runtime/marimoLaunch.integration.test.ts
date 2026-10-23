import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMarimoLaunch } from './marimoLaunch';

const exec = promisify(execFile);

// CI pins uv for reproducibility. All package resolution is offline.
describe.runIf(process.env.MARIMOHUB_UV_INTEGRATION === '1')(
	'inline dependency installation',
	{ timeout: 180_000 },
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
			if (name === 'marimo') {
				files['marimo/__init__.py'] = strToU8(
					`__version__ = "${version}"\ndef main():\n    import json\n    from importlib.metadata import distributions\n    print(json.dumps({d.metadata['Name']: d.version for d in distributions()}))\n`,
				);
				files['marimo/__main__.py'] = strToU8('from . import main\nmain()\n');
				files[`${info}/entry_points.txt`] = strToU8('[console_scripts]\nmarimo = marimo:main\n');
			}
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
				wheel('mhub_runtime', '1.0.0', ['marimo==0.0.1', 'mhub_runtime_dep==1.0.0']),
				wheel('mhub_runtime', '2.0.0', ['marimo==0.0.2']),
				wheel('mhub_runtime', '3.0.0', ['mhub_missing_dep==1.0.0']),
				wheel('mhub_runtime_dep', '1.0.0'),
			]);
			await run('uv', ['venv', '--python', '>=3.11', '.venv']);
			await run('uv', ['pip', 'install', '--python', '.venv', 'marimo==0.0.1']);
		}, 90_000);

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

		async function runWithPackages(runtimePackages: string[]) {
			const plan = buildMarimoLaunch(
				{ notebookFile: 'notebook.py', port: 2718, host: '127.0.0.1', runtimePackages },
				'uv-script-pins',
			);
			const { stdout } = await run('sh', ['-c', plan.start]);
			return JSON.parse(stdout) as Record<string, string>;
		}

		it('adds runtime packages without modifying sources or the base env, then removes the layer on restart', async () => {
			const code = header(['mhub_inline_dep==2.0.0']);
			await setup(code, ['mhub_project_dep==1.0.0']);
			const pyproject = await readFile(join(root, 'pyproject.toml'), 'utf8');
			const enabled = await runWithPackages(['mhub-runtime==1.0.0']);
			expect(enabled).toMatchObject({
				marimo: '0.0.1',
				mhub_runtime: '1.0.0',
				mhub_runtime_dep: '1.0.0',
				mhub_project_dep: '1.0.0',
				mhub_inline_dep: '2.0.0',
			});
			const disabled = await runWithPackages([]);
			expect(disabled).not.toHaveProperty('mhub_runtime');
			expect(disabled).not.toHaveProperty('mhub_runtime_dep');
			expect(disabled).toMatchObject({
				marimo: '0.0.1',
				mhub_project_dep: '1.0.0',
				mhub_inline_dep: '2.0.0',
			});
			expect(await readFile(join(root, 'notebook.py'), 'utf8')).toBe(code);
			expect(await readFile(join(root, 'pyproject.toml'), 'utf8')).toBe(pyproject);
		});

		it('preserves a runtime package explicitly declared by the notebook when the integration is disabled', async () => {
			await setup(header(['mhub_runtime==1.0.0']));
			await runWithPackages(['mhub-runtime==1.0.0']);
			expect(await runWithPackages([])).toMatchObject({ mhub_runtime: '1.0.0' });
		});

		it.each([
			['an incompatible marimo pin', 'mhub-runtime==2.0.0'],
			['an unavailable version', 'mhub-runtime==99.0.0'],
			['an unavailable transitive dependency', 'mhub-runtime==3.0.0'],
		])(
			'recovers from %s without changing sources or the base environment',
			async (_, requirement) => {
				const code = header(['mhub_inline_dep==2.0.0']);
				await setup(code, ['mhub_project_dep==1.0.0']);
				const pyproject = await readFile(join(root, 'pyproject.toml'), 'utf8');
				const baseline = await runWithPackages([]);
				await expect(runWithPackages([requirement])).rejects.toMatchObject({
					stdout: '',
					stderr: expect.stringMatching(/No solution found/i),
				});
				expect(await runWithPackages([])).toEqual(baseline);
				expect(await runWithPackages(['mhub-runtime==1.0.0'])).toMatchObject({
					marimo: '0.0.1',
					mhub_runtime: '1.0.0',
				});
				expect(await runWithPackages([])).toEqual(baseline);
				expect(await readFile(join(root, 'notebook.py'), 'utf8')).toBe(code);
				expect(await readFile(join(root, 'pyproject.toml'), 'utf8')).toBe(pyproject);
			},
		);

		it('stops before resolving the runtime layer when the base marimo installation is missing', async () => {
			await setup(header([]));
			await run('uv', ['pip', 'uninstall', '--python', '.venv', 'marimo']);
			const plan = buildMarimoLaunch({
				notebookFile: 'notebook.py',
				port: 2718,
				host: '127.0.0.1',
				runtimePackages: ['mhub-runtime==99.0.0'],
			});
			await expect(run('sh', ['-c', plan.start])).rejects.toMatchObject({
				stdout: '',
				stderr: expect.stringContaining('PackageNotFoundError'),
			});
			await expect(importedVersions('marimo')).rejects.toMatchObject({
				stderr: expect.stringContaining('ModuleNotFoundError'),
			});
		});

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
