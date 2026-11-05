import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loggingFiles } from './logging';
import { buildMarimoLaunch } from './marimoLaunch';

const python = process.env.MARIMO_INTEGRATION_PYTHON;
const exec = promisify(execFile);

describe.runIf(Boolean(python))('uv-sandbox logging runtime', () => {
	it.each([{ runtimePackages: [] }, { runtimePackages: ['rich==13.9.4'] }])(
		'provisions marimo outside an empty base environment with runtime packages $runtimePackages',
		async ({ runtimePackages }) => {
			const root = await mkdtemp(join(tmpdir(), 'mhub-sandbox-logging-'));
			const received: string[] = [];
			const server = createServer((request, response) => {
				let body = '';
				request.setEncoding('utf8');
				request.on('data', (chunk: string) => {
					body += chunk;
				});
				request.on('end', () => {
					received.push(body);
					response.setHeader('Content-Type', 'application/json');
					response.end('{}');
				});
			});
			try {
				await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
				const address = server.address();
				if (!address || typeof address === 'string') throw new Error('No receiver port');
				const { stdout } = await exec(python!, [
					'-c',
					'from importlib.metadata import version; print(version("marimo"))',
				]);
				const version = stdout.trim();
				await writeFile(
					join(root, 'pyproject.toml'),
					`[project]\nname = "logging-test"\nversion = "0.0.0"\nrequires-python = ">=3.12"\ndependencies = []\n[tool.uv]\noverride-dependencies = ["marimo==${version}"]\n`,
				);
				const directory = join(root, 'logging');
				await mkdir(directory);
				for (const file of loggingFiles(
					[
						{
							name: 'logs',
							url: `http://127.0.0.1:${address.port}/v1/logs`,
							headers: {},
							level: 'INFO',
							serviceName: 'sandbox-test',
							attributes: {},
						},
					],
					{ sandboxId: 'sandbox-test', notebookId: 'notebook-test', mode: 'job' },
				)) {
					await writeFile(join(directory, basename(file.path)), file.content);
				}
				await writeFile(
					join(root, 'notebook.py'),
					`# /// script
# requires-python = ">=3.12"
# dependencies = ["marimo==${version}"]
# ///
import marimo
app = marimo.App()
@app.cell
def _():
    import logging
    logging.warning("sandbox-notebook-record")
    return
if __name__ == "__main__":
    app.run()
`,
				);
				const env = {
					...process.env,
					PATH: `${dirname(python!)}:${process.env.PATH}`,
					UV_PROJECT_ENVIRONMENT: join(root, '.venv'),
					UV_PYTHON: python!,
				};
				await exec('uv', ['venv', '--python', python!, env.UV_PROJECT_ENVIRONMENT], {
					cwd: root,
					env,
				});
				const basePython = join(env.UV_PROJECT_ENVIRONMENT, 'bin/python');
				const checkEmpty = () =>
					exec(basePython, [
						'-c',
						'from importlib.util import find_spec; assert find_spec("marimo") is None',
					]);
				await checkEmpty();
				const plan = buildMarimoLaunch(
					{
						notebookFile: 'notebook.py',
						host: '127.0.0.1',
						port: 2718,
						mode: 'job',
						outputFile: 'output.html',
						loggingDirectory: directory,
						runtimePackages,
					},
					'uv-sandbox',
				);
				const { stderr } = await exec('/bin/sh', ['-c', plan.start], {
					cwd: root,
					env,
					timeout: 90_000,
				});
				expect(stderr).not.toContain('initialization_failed');
				expect(stderr).not.toContain('delivery_failed');
				expect(await readFile(join(root, 'output.html'), 'utf8')).toContain('<html');
				expect(received.some((body) => body.includes('sandbox-notebook-record'))).toBe(true);
				await checkEmpty();
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(root, { recursive: true, force: true });
			}
		},
		120_000,
	);
});
