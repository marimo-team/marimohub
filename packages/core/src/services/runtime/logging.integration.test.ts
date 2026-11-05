import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loggingCommand, loggingFiles, LOGGING_PACKAGES } from './logging';
import { buildMarimoLaunch } from './marimoLaunch';
import { shellQuote } from './shell';

const python = process.env.MARIMO_INTEGRATION_PYTHON;
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(Boolean(python))('notebook OTLP logging', () => {
	it.each([
		'python',
		'edit',
		'app',
		'job',
		'failure',
		'disabled',
		'overflow',
		'redirect',
		'kernel-exit',
		'initialization-failure',
	])('exports and shuts down correctly: %s', (mode) => runScenario(mode), 70_000);
});

async function runScenario(mode: string, fixture = 'logging_driver.py') {
	const root = await mkdtemp(
		join(tmpdir(), mode === 'shell-path' ? "mhub logs ' $(touch unexpected) " : 'mhub-logging-'),
	);
	roots.push(root);
	const files = loggingFiles(
		[
			{
				name: 'logs',
				url: 'http://127.0.0.1:1/v1/logs',
				headers: { Authorization: 'Bearer private-token' },
				level: 'DEBUG',
				serviceName: 'test-service',
				attributes: { 'marimohub.project_id': 'project-test' },
			},
		],
		{ sandboxId: 'sandbox-test', notebookId: 'notebook-test', mode },
	);
	for (const file of files) {
		const path = join(root, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.content);
	}
	const directory = dirname(join(root, files[0].path));
	await copyFile(new URL(`./fixtures/${fixture}`, import.meta.url), join(root, 'driver.py'));
	await copyFile(
		new URL('./fixtures/logging_receiver.py', import.meta.url),
		join(root, 'logging_receiver.py'),
	);
	const plan = buildMarimoLaunch({
		notebookFile: 'notebook.py',
		host: '127.0.0.1',
		port: 2718,
		mode: mode === 'job' ? 'job' : mode === 'app' ? 'app' : 'edit',
		runtimePackages: [...LOGGING_PACKAGES],
		loggingDirectory: directory,
	});
	const command = ['edit', 'app', 'job'].includes(mode)
		? plan.start
		: loggingCommand(
				mode === 'disabled' ? undefined : directory,
				`${shellQuote(python!)} workload.py`,
			);
	const { stdout, stderr } = await exec(python!, ['driver.py', directory, mode, command], {
		cwd: root,
		env: { ...process.env, UV_PROJECT_ENVIRONMENT: resolve(dirname(python!), '..') },
		timeout: 65_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	expect(stderr).not.toContain('private-token');
	expect(JSON.parse(stdout)).toMatchObject({ ok: true });
}

describe.runIf(Boolean(python))('notebook logging failure isolation', () => {
	it.each([
		'http-400',
		'http-401',
		'http-403',
		'http-429',
		'http-500',
		'http-503',
		'retry-success',
		'connection-refused',
		'response-timeout',
		'connection-reset',
		'tls-error',
		'shutdown-deadline',
		'invalid-json',
		'missing-config',
		'partial-config',
		'partial-initialization',
		'worker-start-failure',
		'exporter-exception',
		'shutdown-exception',
		'record-encoding',
		'sitecustomize-failure',
		'existing-handler',
		'netrc',
		'shell-path',
		'concurrent-records',
		'unicode-records',
	])(
		'keeps notebook execution safe through %s',
		(mode) => runScenario(mode, 'logging_failures.py'),
		30_000,
	);
});
