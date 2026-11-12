import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

let fixture: string;
const manifest = {
	name: '@marimo-hub/iac',
	version: '1.2.3',
	repository: { type: 'git', url: 'https://example.com/repo.git' },
	publishConfig: { access: 'public' },
};
const deno = {
	imports: {
		'@marimo-hub/iac': 'npm:@marimo-hub/iac@1.2.3',
		'@marimo-hub/iac/runner': 'npm:@marimo-hub/iac@1.2.3/runner',
		other: 'npm:other@1',
	},
	tasks: { plan: 'deno run script.ts' },
};
function write(relative: string, value: unknown) {
	const path = join(fixture, relative);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function run(script: string, releaseRef?: string) {
	const env = { ...process.env };
	delete env.RELEASE_REF;
	if (releaseRef !== undefined) env.RELEASE_REF = releaseRef;
	return spawnSync(process.execPath, [join(fixture, 'scripts', script)], { encoding: 'utf8', env });
}
beforeEach(() => {
	fixture = mkdtempSync(join(tmpdir(), 'iac-release-'));
	write('package.json', { version: '1.2.3' });
	write('packages/iac/package.json', manifest);
	write('examples/integration-iac/deno/deno.json', deno);
	mkdirSync(join(fixture, 'scripts'));
	for (const script of ['iac-release.mjs', 'check-iac-release.mjs', 'prepare-iac-release.mjs'])
		copyFileSync(new URL(script, import.meta.url), join(fixture, 'scripts', script));
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('release validation', () => {
	it('accepts only the matching root, package and tag version', () => {
		expect(run('check-iac-release.mjs', 'refs/tags/v1.2.3').status).toBe(0);
	});
	it.each([
		undefined,
		'',
		'refs/heads/v1.2.3',
		'refs/tags/v1.2.4',
		'refs/tags/v1.2.3-beta.1',
		'v1.2.3',
	])('rejects release ref %s', (ref) => {
		expect(run('check-iac-release.mjs', ref).status).not.toBe(0);
	});
	it('rejects a package/root mismatch', () => {
		write('packages/iac/package.json', { ...manifest, version: '1.2.2' });
		expect(run('check-iac-release.mjs', 'refs/tags/v1.2.3').status).not.toBe(0);
	});
	it.each(['1.2.3-beta.1', '01.2.3', 'invalid', null])(
		'rejects unsupported version %s even when versions and ref match',
		(version) => {
			write('package.json', { version });
			write('packages/iac/package.json', { ...manifest, version });
			expect(run('check-iac-release.mjs', `refs/tags/v${version}`).status).not.toBe(0);
		},
	);
});
describe('release preparation', () => {
	it('updates both pinned imports and preserves unrelated metadata', () => {
		write('package.json', { version: '2.0.0' });
		expect(run('prepare-iac-release.mjs').status).toBe(0);
		expect(JSON.parse(readFileSync(join(fixture, 'packages/iac/package.json'), 'utf8'))).toEqual({
			...manifest,
			version: '2.0.0',
		});
		expect(
			JSON.parse(readFileSync(join(fixture, 'examples/integration-iac/deno/deno.json'), 'utf8')),
		).toEqual({
			...deno,
			imports: {
				...deno.imports,
				'@marimo-hub/iac': 'npm:@marimo-hub/iac@2.0.0',
				'@marimo-hub/iac/runner': 'npm:@marimo-hub/iac@2.0.0/runner',
			},
		});
	});
	it.each(['missing', 'malformed', 'imports-missing', 'imports-array'])(
		'does not partially bump package when Deno config is %s',
		(kind) => {
			write('package.json', { version: '2.0.0' });
			const path = join(fixture, 'examples/integration-iac/deno/deno.json');
			if (kind === 'missing') rmSync(path);
			else if (kind === 'malformed') writeFileSync(path, '{');
			else writeFileSync(path, JSON.stringify(kind === 'imports-array' ? { imports: [] } : {}));
			const before = readFileSync(join(fixture, 'packages/iac/package.json'), 'utf8');
			expect(run('prepare-iac-release.mjs').status).not.toBe(0);
			expect(readFileSync(join(fixture, 'packages/iac/package.json'), 'utf8')).toBe(before);
		},
	);
	it.each([undefined, 'bad', '1.2.3-beta.1', '01.2.3'])(
		'rejects version %s before changing either file',
		(version) => {
			write('package.json', { version });
			const paths = ['packages/iac/package.json', 'examples/integration-iac/deno/deno.json'];
			const before = paths.map((path) => readFileSync(join(fixture, path), 'utf8'));
			expect(run('prepare-iac-release.mjs').status).not.toBe(0);
			expect(paths.map((path) => readFileSync(join(fixture, path), 'utf8'))).toEqual(before);
		},
	);
});

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}
interface WorkflowJob {
	if?: string;
	needs?: string;
	permissions?: Record<string, string>;
	environment?: string;
	steps: WorkflowStep[];
}
const workflow = parse(
	readFileSync(new URL('../.github/workflows/iac.yml', import.meta.url), 'utf8'),
) as { permissions: Record<string, string>; jobs: Record<string, WorkflowJob> };
describe('publish workflow', () => {
	it('limits identity tokens to the artifact-only manual publish job', () => {
		expect(workflow.permissions['id-token']).toBeUndefined();
		for (const [name, job] of Object.entries(workflow.jobs))
			if (name !== 'publish') expect(job.permissions?.['id-token']).toBeUndefined();
		const publish = workflow.jobs.publish;
		expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
		expect(publish.environment).toBe('npm');
		expect(publish.if).toBe("github.event_name == 'workflow_dispatch' && inputs.publish");
		expect(workflow.jobs.package.if).toBe(publish.if);
		expect(publish.needs).toBe('package');
		expect(workflow.jobs.package.needs).toBe('compatibility');
		expect(publish.steps.some((step) => step.uses?.startsWith('actions/checkout'))).toBe(false);
		expect(publish.steps.some((step) => step.uses?.startsWith('actions/download-artifact'))).toBe(
			true,
		);
		const setup = publish.steps.find((step) => step.uses?.startsWith('actions/setup-node'))!;
		expect(setup.with?.['registry-url']).toBeUndefined();
		expect(setup.with?.['package-manager-cache']).toBe(false);
		expect(JSON.stringify(publish)).not.toMatch(
			/NPM_TOKEN|NODE_AUTH_TOKEN|npmrc|pnpm|npm install|npm ci/,
		);
	});
	it.each([
		{ count: 0, npmStatus: 0 },
		{ count: 2, npmStatus: 0 },
		{ count: 1, npmStatus: 17 },
		{ count: 1, npmStatus: 0 },
	])('guards and executes exact tarball publish with stub npm: %j', ({ count, npmStatus }) => {
		const script = workflow.jobs.publish.steps.find(
			(step) => step.name === 'Publish release artifact',
		)!.run!;
		const directory = join(fixture, 'iac-package');
		mkdirSync(directory);
		mkdirSync(join(fixture, 'bin'));
		for (let index = 0; index < count; index++)
			writeFileSync(join(directory, `artifact-${index}.tgz`), 'fixture');
		const log = join(fixture, 'npm-args');
		writeFileSync(
			join(fixture, 'bin/npm'),
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$NPM_TEST_LOG"\nexit "$NPM_TEST_EXIT"\n',
			{ mode: 0o755 },
		);
		const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
			encoding: 'utf8',
			env: {
				PATH: `${join(fixture, 'bin')}:/usr/bin:/bin`,
				RUNNER_TEMP: fixture,
				NPM_TEST_LOG: log,
				NPM_TEST_EXIT: String(npmStatus),
			},
		});
		if (count !== 1) {
			expect(result.status).not.toBe(0);
			expect(() => readFileSync(log)).toThrow();
		} else {
			expect(result.status).toBe(npmStatus);
			expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
				'publish',
				join(directory, 'artifact-0.tgz'),
				'--ignore-scripts',
				'--registry=https://registry.npmjs.org',
			]);
		}
	});
});

it.each([
	['10.9.9', false],
	['11.5.0', false],
	['11.5.1', true],
	['12.0.0', true],
	['invalid', false],
])('executes the publishing npm version guard for %s', (version, accepted) => {
	const script = workflow.jobs.publish.steps.find(
		(step) => step.name === 'Check npm trusted publishing support',
	)!.run!;
	const bin = join(fixture, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'npm'),
		'#!/bin/sh\ntest "$1" = "--version" || exit 99\nprintf "%s\\n" "$NPM_TEST_VERSION"\n',
		{ mode: 0o755 },
	);
	const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
		encoding: 'utf8',
		env: {
			PATH: `${bin}:${join(process.execPath, '..')}:/usr/bin:/bin`,
			NPM_TEST_VERSION: String(version),
		},
	});
	expect(result.status === 0).toBe(accepted);
});
it.each([{ value: null }, { value: [] }, { value: { name: 'wrong-package', version: '1.2.3' } }])(
	'validates package identity before either release write %#',
	({ value }) => {
		write('packages/iac/package.json', value);
		const paths = ['packages/iac/package.json', 'examples/integration-iac/deno/deno.json'];
		const before = paths.map((path) => readFileSync(join(fixture, path), 'utf8'));
		expect(run('prepare-iac-release.mjs').status).not.toBe(0);
		expect(paths.map((path) => readFileSync(join(fixture, path), 'utf8'))).toEqual(before);
	},
);
