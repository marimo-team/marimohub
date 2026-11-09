import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loggingCommand, loggingFiles } from './logging';
import { buildMarimoLaunch } from './marimoLaunch';
import { shellQuote } from './shell';

const python = process.env.MARIMO_INTEGRATION_PYTHON;
// CI pre-creates these venvs from the same requirements file so the suite never reaches PyPI.
const preparedEnvironments = {
	missing: process.env.MARIMOHUB_TEST_LOGGING_ENV_MISSING,
	conflicting: process.env.MARIMOHUB_TEST_LOGGING_ENV_CONFLICTING,
};
const conflictingRequirements = fileURLToPath(
	new URL('./fixtures/logging_conflicting_requirements.txt', import.meta.url),
);
const conflictingOtelVersion = /^opentelemetry-sdk==(\S+)$/m.exec(
	readFileSync(conflictingRequirements, 'utf8'),
)![1];
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(Boolean(python))('notebook OTLP logging', () => {
	it.each([
		'python',
		'logger-filter',
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

describe.runIf(Boolean(python) && process.platform !== 'win32')('forked notebook logging', () => {
	it.each([
		'fork',
		'raw-fork',
		'fork-locked-state',
		'fork-after-shutdown',
		'fork-initialization-failure',
		'fork-proxy',
		'fork-proxy-bypass',
		'fork-proxy-env-cleared',
	])('exports safely after %s', (mode) => runScenario(mode, 'logging_fork.py'), 30_000);
});

async function runScenario(
	mode: string,
	fixture = 'logging_driver.py',
	runtimePython = python!,
	extraEnv: NodeJS.ProcessEnv = {},
) {
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
		loggingDirectory: directory,
	});
	const command = ['edit', 'app', 'job'].includes(mode)
		? plan.start
		: loggingCommand(
				mode === 'disabled' ? undefined : directory,
				`${shellQuote(runtimePython)} workload.py`,
			);
	const { stdout, stderr } = await exec(python!, ['driver.py', directory, mode, command], {
		cwd: root,
		env: {
			...process.env,
			UV_PROJECT_ENVIRONMENT: resolve(dirname(runtimePython), '..'),
			...extraEnv,
		},
		timeout: 65_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	expect(stderr).not.toContain('private-token');
	expect(JSON.parse(stdout)).toMatchObject({ ok: true });
}

describe.runIf(Boolean(python))('notebook logging failure isolation', () => {
	it.each([
		'empty-success',
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
		'missing-level-hook',
		'missing-sigterm-hook',
		'missing-both-hooks',
		'unavailable-marimo',
		'exporter-exception',
		'partial-success',
		'malformed-response',
		'oversized-response',
		'retry-after',
		'retry-after-limit',
		'record-encoding',
		'logger-filter-encoding',
		'logger-filter-delivery',
		'logger-filter-invalid',
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

describe.runIf(Boolean(python))('logging package isolation', () => {
	let environments: string | undefined;
	let missing: string;
	let conflicting: string;
	beforeAll(async () => {
		const pythons: Record<string, string> = {};
		for (const [name, packages] of [
			['missing', []],
			['conflicting', ['-r', conflictingRequirements]],
		] as const) {
			let env = preparedEnvironments[name];
			if (!env) {
				environments ??= await mkdtemp(join(tmpdir(), 'mhub-logging-envs-'));
				env = join(environments, name);
				const { stdout } = await exec(python!, [
					'-c',
					'from importlib.metadata import version; print(version("marimo"))',
				]);
				await exec('uv', ['venv', '--python', python!, env]);
				await exec(
					'uv',
					['pip', 'install', '--python', env, `marimo==${stdout.trim()}`, ...packages],
					{
						timeout: 120_000,
					},
				);
			}
			pythons[name] = join(env, 'bin/python');
		}
		missing = pythons.missing;
		conflicting = pythons.conflicting;
	}, 180_000);
	afterAll(async () => {
		if (environments) await rm(environments, { recursive: true, force: true });
	});

	it.each(
		['missing', 'conflicting'].flatMap((environment) =>
			['python', 'edit', 'app', 'job'].map((mode) => ({ environment, mode })),
		),
	)(
		'exports from $mode with $environment OTel packages',
		({ environment, mode }) =>
			runScenario(
				mode,
				'logging_driver.py',
				environment === 'missing' ? missing : conflicting,
				environment === 'conflicting'
					? { MARIMOHUB_TEST_OTEL_VERSION: conflictingOtelVersion }
					: {},
			),
		70_000,
	);
	it.each([
		'without-otel',
		'with-old-otel',
		'with-current-otel',
		'typed-values',
		'oversized-record',
		'cyclic-extras',
	])(
		'exports JSON without installing packages: %s',
		(mode) =>
			runScenario(
				mode,
				'logging_isolation.py',
				mode === 'with-current-otel' ? python! : mode === 'with-old-otel' ? conflicting : missing,
				{
					MARIMOHUB_TEST_OTEL_VERSION:
						mode === 'with-current-otel'
							? '1.40.0'
							: mode === 'with-old-otel'
								? conflictingOtelVersion
								: 'absent',
				},
			),
		30_000,
	);
});
