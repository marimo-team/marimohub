import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { createRunId, createSessionId } from '../../ids';
import type { IntegrationId } from '../../ids';
import { bundleIntegrations, INTEGRATIONS_DIR, INTEGRATIONS_DIR_ENV } from './bundle';
import type { RenderedIntegration } from './bundle';
import type { RenderOutput } from './sdk';

const rendered = (name: string, output: RenderOutput): RenderedIntegration => ({
	id: 'intg-0000000000000001' as IntegrationId,
	name,
	kind: 'synthetic',
	version: 1,
	output,
});

const bundle = (items: RenderedIntegration[]) =>
	bundleIntegrations(items, { kind: 'session', id: createSessionId() });

const file = (path: string, content = 'x') => ({ files: [{ path, content }] });
const yaml = (path: string, value: Record<string, unknown> = { a: 1 }) => ({
	yamlFiles: [{ path, value }],
});

describe('runtime package ownership', () => {
	it('names all conflicting owners across normalized aliases, excluding unrelated integrations', () => {
		expect(() =>
			bundle([
				rendered('unrelated', { runtimePackages: ['other==1.0.0'] }),
				rendered('org-studio', { runtimePackages: ['Marimo_Studio[deno]==0.4.1'] }),
				rendered('project-studio', { runtimePackages: ['marimo.studio[typst]==0.4.1'] }),
				rendered('new-studio', { runtimePackages: ['marimo-studio==0.4.2'] }),
			]),
		).toThrow(
			new ValidationError(
				'Integrations "org-studio", "project-studio", "new-studio" require different versions of runtime package "marimo-studio".',
			),
		);
	});
	it('merges compatible contributions without exposing ownership in runtime requirements', () => {
		expect(
			bundle([
				rendered('first', { runtimePackages: ['Marimo_Studio[deno]==0.4.1'] }),
				rendered('second', { runtimePackages: ['marimo-studio[typst]==0.4.1'] }),
				rendered('empty', {}),
			]).runtimePackages,
		).toEqual(['marimo-studio[deno,typst]==0.4.1']);
	});
});

it('identifies a job run without encoding it as a session in the manifest', () => {
	const runId = createRunId();
	const result = bundleIntegrations([], { kind: 'job-run', id: runId });
	const manifest = result.files.find((item) => item.path.endsWith('/manifest.json'));
	expect(JSON.parse(manifest?.content ?? '')).toMatchObject({
		workload_kind: 'job-run',
		workload_id: runId,
	});
	expect(manifest?.content).not.toContain('session_id');
});

describe('rendered path collisions', () => {
	it('rejects a file nested under a sibling integration file', () => {
		expect(() =>
			bundle([rendered('first', file('foo')), rendered('second', file('foo/bar'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file rendered on a sibling integration directory', () => {
		expect(() =>
			bundle([rendered('first', file('foo/bar')), rendered('second', file('foo'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file nested under a rendered YAML file, and the reverse', () => {
		expect(() =>
			bundle([rendered('first', yaml('cfg')), rendered('second', file('cfg/x'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([rendered('first', file('cfg/x')), rendered('second', yaml('cfg'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a deep nesting collision and a self-collision within one integration', () => {
		expect(() =>
			bundle([rendered('first', file('a/b/c')), rendered('second', file('a/b/c/d/e'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([
				rendered('solo', {
					files: [
						{ path: 'a', content: 'x' },
						{ path: 'a/b', content: 'y' },
					],
				}),
			]),
		).toThrow(/needs it to be a directory/);
	});

	it('still rejects an exact cross-integration file collision', () => {
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', file('same'))]),
		).toThrow(/both render "same"/);
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', yaml('same'))]),
		).toThrow(/both render "same"/);
	});

	it('permits sibling paths that merely share a name prefix, and merges shared YAML', () => {
		const result = bundle([
			rendered('first', file('trino/prod.json')),
			rendered('second', file('trino/prod-client.crt')),
			rendered('third', yaml('.pyiceberg.yaml', { catalog: { a: 1 } })),
			rendered('fourth', yaml('.pyiceberg.yaml', { catalog: { b: 2 } })),
		]);
		const paths = result.files.map((f) => f.path);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod.json`);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod-client.crt`);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('a: 1');
		expect(merged?.content).toContain('b: 2');
	});
});

describe('process-wide YAML settings', () => {
	// The real case: the BigQuery catalog requires legacy-current-snapshot-id, so
	// it cannot share a session with a catalog that turns it off.
	it('names both integrations and the setting when a root property disagrees', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'true' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'false' })),
			]),
		).toThrow(/Integrations "warehouse" and "lakehouse" disagree on "legacy-current-snapshot-id"/);
	});

	// An integration that merely wrote a different key into the same file is not
	// party to the dispute, and naming it sends the admin after the wrong config.
	it('names only the two integrations that set the conflicting key', () => {
		let message = '';
		try {
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('bystander', yaml('.pyiceberg.yaml', { catalog: { b: { uri: 'https://b' } } })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'max-workers': '8' })),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "max-workers"/);
		expect(message).not.toContain('bystander');
	});

	it('names every integration that set the value now being contradicted', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakeshore', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'max-workers': '8' })),
			]),
		).toThrow(/Integrations "warehouse", "lakeshore" and "lakehouse" disagree on "max-workers"/);
	});

	it('names the owners of a nested subtree replaced by a scalar', () => {
		let message = '';
		try {
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { catalog: { a: { uri: 'https://a' } } })),
				rendered('bystander', yaml('.pyiceberg.yaml', { 'max-workers': '4' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { catalog: 'off' })),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "catalog"/);
		expect(message).not.toContain('bystander');
	});

	it('reports the nested key path and keeps unrelated nested keys out of the blame', () => {
		let message = '';
		try {
			bundle([
				rendered(
					'warehouse',
					yaml('.pyiceberg.yaml', { catalog: { shared: { uri: 'https://a' } } }),
				),
				rendered(
					'bystander',
					yaml('.pyiceberg.yaml', { catalog: { other: { uri: 'https://b' } } }),
				),
				rendered(
					'lakehouse',
					yaml('.pyiceberg.yaml', { catalog: { shared: { uri: 'https://c' } } }),
				),
			]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Integrations "warehouse" and "lakehouse" disagree on "uri"/);
		expect(message).toContain('.pyiceberg.yaml:catalog:shared');
		expect(message).not.toContain('bystander');
	});

	it('still names an owner when the contradicted value was an empty object', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { catalog: {} })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { catalog: 'off' })),
			]),
		).toThrow(/Integrations "warehouse" and "lakehouse" disagree on "catalog"/);
	});

	it('still merges disjoint catalogs into one file', () => {
		const result = bundle([
			rendered('a', yaml('.pyiceberg.yaml', { catalog: { a: { uri: 'https://a' } } })),
			rendered('b', yaml('.pyiceberg.yaml', { catalog: { b: { uri: 'https://b' } } })),
		]);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('https://a');
		expect(merged?.content).toContain('https://b');
	});
});

describe('bundler-owned env', () => {
	it('rejects a kind that sets the integrations-dir var to another value', () => {
		expect(() =>
			bundle([rendered('greedy', { env: { [INTEGRATIONS_DIR_ENV]: '/tmp/evil' } })]),
		).toThrow(/different values/);
	});

	it('always exports the integrations dir, and tolerates a kind echoing it', () => {
		const result = bundle([
			rendered('echo', { env: { [INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR } }),
		]);
		expect(result.vars[INTEGRATIONS_DIR_ENV]).toBe(INTEGRATIONS_DIR);
	});
});

describe('data-source discovery env', () => {
	it('selects one complete discovery contract and warns about later claimants', () => {
		const result = bundle([
			rendered('staging', {
				discoveryEnv: {
					TRINO_HOST: 'staging.internal',
					TRINO_USER: 'staging-user',
					TRINO_CATALOG: 'hive',
				},
			}),
			rendered('prod', {
				discoveryEnv: { TRINO_HOST: 'prod.internal', TRINO_USER: 'prod-user' },
			}),
		]);

		expect(result.vars).toMatchObject({
			TRINO_HOST: 'prod.internal',
			TRINO_USER: 'prod-user',
		});
		expect(result.vars.TRINO_CATALOG).toBeUndefined();
		expect(result.warnings).toEqual([
			expect.stringMatching(/"staging".*"prod".*TRINO_HOST, TRINO_USER/),
		]);
	});

	it('keeps ordinary env collisions strict and records discovery warnings in the manifest', () => {
		expect(() =>
			bundle([
				rendered('first', { env: { SHARED: 'one' } }),
				rendered('second', { env: { SHARED: 'two' } }),
			]),
		).toThrow(/same environment variable/);

		const result = bundle([
			rendered('fallback', {
				warnings: ['Automatic discovery is unavailable.'],
			}),
		]);
		const manifest = result.files.find(({ path }) => path.endsWith('/manifest.json'));
		const parsed = JSON.parse(manifest?.content ?? '{}') as { warnings?: string[] };
		expect(parsed.warnings).toEqual(['Automatic discovery is unavailable.']);
	});
});

describe('package indexes', () => {
	const index = (name: string, isDefault = false): RenderOutput => ({
		packageIndexes: [{ name, url: `https://${name}.example/simple/`, default: isDefault }],
	});

	it('rejects two default indexes instead of silently choosing one', () => {
		expect(() =>
			bundle([rendered('one', index('one', true)), rendered('two', index('two', true))]),
		).toThrow('Only one package index can replace PyPI');
	});

	it('rejects duplicate index names and overrides of the generated default index', () => {
		expect(() => bundle([rendered('one', index('same')), rendered('two', index('same'))])).toThrow(
			'Package index names must be unique',
		);
		expect(() =>
			bundle([
				rendered('one', index('one', true)),
				rendered('custom', { env: { UV_DEFAULT_INDEX: 'https://other.example/simple/' } }),
			]),
		).toThrow(
			'Integration "custom" sets UV_DEFAULT_INDEX, but a package registry integration already ' +
				'replaces PyPI. Remove UV_DEFAULT_INDEX from the environment variables integration and ' +
				'use the package registry\'s "default index" option instead.',
		);
	});

	it('appends a hand-set UV_INDEX after the package registry indexes', () => {
		const result = bundle([
			rendered('custom', {
				env: { UV_INDEX: 'legacy=https://legacy.example/simple/ https://bare.example/simple/' },
			}),
			rendered('one', index('one')),
			rendered('two', index('two')),
		]);
		expect(result.vars.UV_INDEX).toBe(
			'one=https://one.example/simple/ two=https://two.example/simple/ ' +
				'legacy=https://legacy.example/simple/ https://bare.example/simple/',
		);
	});

	it('drops hand-set UV_INDEX entries that a package registry already provides', () => {
		const result = bundle([
			rendered('one', index('one')),
			rendered('custom', {
				env: { UV_INDEX: 'one=https://one.example/simple/  extra=https://extra.example/simple/' },
			}),
		]);
		expect(result.vars.UV_INDEX).toBe(
			'one=https://one.example/simple/ extra=https://extra.example/simple/',
		);
	});

	it('leaves a hand-set UV_INDEX untouched without a package registry', () => {
		const value = 'legacy=https://legacy.example/simple/';
		const result = bundle([rendered('custom', { env: { UV_INDEX: value } })]);
		expect(result.vars.UV_INDEX).toBe(value);
	});

	it.each([
		'not-a-url',
		'https://invalid host/simple/',
		'https://aws:private-token@example.com:invalid/simple/',
	])('rejects malformed package index URL %s with a safe validation error', (url) => {
		const render = () =>
			bundle([rendered('private', { packageIndexes: [{ name: 'private', url, default: false }] })]);
		expect(render).toThrow(ValidationError);
		expect(render).toThrow('Package index URL is invalid.');
		expect(render).not.toThrow(url);
	});

	it.each([
		'https://aws:token@example.com/simple/',
		'http://example.com/simple/',
		'https://example.com/simple/ other=https://other.example/',
	])('rejects unsafe package index URLs', (url) => {
		expect(() =>
			bundle([rendered('private', { packageIndexes: [{ name: 'private', url, default: false }] })]),
		).toThrow('HTTPS without embedded credentials');
	});
});

describe('agent context confinement', () => {
	it('rejects agent context emitted by another kind', () => {
		expect(() => bundle([rendered('other', { agentContext: { instructions: 'hello' } })])).toThrow(
			/Only agent_context/,
		);
	});
	it.each([
		'/home/appuser/.claude/CLAUDE.md',
		'../home/appuser/.claude/CLAUDE.md',
		'x/../../escape',
	])('keeps ordinary files confined: %s', (path) => {
		expect(() => bundle([rendered('other', file(path))])).toThrow(/invalid file path/);
	});
	it('reserves the context directory files against other integrations', () => {
		expect(() =>
			bundle([
				{
					...rendered('agents', { agentContext: { instructions: 'hello' } }),
					kind: 'agent_context',
				},
				rendered('other', file('agent-context/opencode.json')),
			]),
		).toThrow(/both render/);
	});
});

it('reserves the agent home cleanup manifest even without an agent integration', () => {
	expect(() => bundle([rendered('other', file('agent-context/home-files.json'))])).toThrow(
		/both render/,
	);
});

describe('startup script ownership', () => {
	it('orders integrations by name while preserving each kind’s script order', () => {
		const result = bundle([
			rendered('z-last', { ...file('z.sh'), startupScripts: ['z.sh'] }),
			rendered('a-first', {
				files: [
					{ path: 'b.sh', content: '' },
					{ path: 'a.sh', content: '' },
				],
				startupScripts: ['b.sh', 'a.sh'],
			}),
		]);
		expect(result.startupScripts).toEqual(
			['b.sh', 'a.sh', 'z.sh'].map((path) => `${INTEGRATIONS_DIR}/${path}`),
		);
	});
	it.each(['/tmp/escape.sh', '../escape.sh', 'manifest.json', 'missing.sh'])(
		'rejects invalid or unowned script %s',
		(path) => {
			expect(() => bundle([rendered('owner', { startupScripts: [path] })])).toThrow(
				ValidationError,
			);
		},
	);
	it.each([
		'startup/../escape.sh',
		'startup//setup.sh',
		'startup/./setup.sh',
		'startup\\setup.sh',
		'startup/setup\n.sh',
		'startup/setup\0.sh',
	])('rejects malformed hook paths even when backed by a rendered file %#', (path) => {
		expect(() => bundle([rendered('owner', { ...file(path), startupScripts: [path] })])).toThrow(
			/invalid file path/,
		);
	});
	it('rejects a YAML fragment as a runnable script', () => {
		expect(() =>
			bundle([rendered('owner', { ...yaml('setup.sh'), startupScripts: ['setup.sh'] })]),
		).toThrow(/must render its startup script/);
	});
	it('rejects competing ownership of an executable script', () => {
		expect(() =>
			bundle([
				rendered('first', { ...file('setup.sh', 'echo first'), startupScripts: ['setup.sh'] }),
				rendered('second', { ...file('setup.sh', 'echo second'), startupScripts: ['setup.sh'] }),
			]),
		).toThrow(/both render/);
	});
	it('rejects references to another integration’s file and repeated execution', () => {
		expect(() =>
			bundle([
				rendered('owner', file('setup.sh')),
				rendered('other', { startupScripts: ['setup.sh'] }),
			]),
		).toThrow(/must render its startup script/);
		expect(() =>
			bundle([
				rendered('owner', { ...file('setup.sh'), startupScripts: ['setup.sh', 'setup.sh'] }),
			]),
		).toThrow(/repeats startup script/);
	});
});

describe('presentation contributions', () => {
	it.each([{}, { presentation: {} }])(
		'omits presentation assets for empty contributions %j',
		(output) => {
			const result = bundle([rendered('empty', output)]);
			expect(result.marimoPresentation).toBeUndefined();
			expect(result.files.some((file) => file.path.includes('/presentation/'))).toBe(false);
		},
	);

	it('preserves raw content and input order while sorting CSS-only and HTML-only integrations', () => {
		const css = '/* café */\r\n@import url("https://example.com/theme.css");\r\n';
		const html = '<script>const text = "é < > &";</script>\r\n';
		const input = [
			rendered('z-css', { presentation: { css } }),
			rendered('a-head', { presentation: { htmlHead: html } }),
		];
		const original = structuredClone(input);
		const result = bundle(input);
		expect(input).toEqual(original);
		expect(result.files).toContainEqual({
			path: `${INTEGRATIONS_DIR}/presentation/z-css.css`,
			content: css,
		});
		expect(result.files).toContainEqual({
			path: `${INTEGRATIONS_DIR}/presentation/head.html`,
			content: html,
		});
	});

	it.each(['../escape', 'x/../../escape', 'x\\escape'])(
		'rejects unsafe stylesheet instance paths: %s',
		(name) => {
			expect(() => bundle([rendered(name, { presentation: { css: 'body {}' } })])).toThrow(
				ValidationError,
			);
		},
	);

	it('rejects duplicate stylesheet owners and YAML paths overlapping generated assets', () => {
		const theme = rendered('theme', {
			presentation: { css: 'body {}', htmlHead: '<meta name="team">' },
		});
		expect(() => bundle([theme, theme])).toThrow(ValidationError);
		expect(() => bundle([theme, rendered('yaml', yaml('presentation/head.html/child'))])).toThrow(
			ValidationError,
		);
	});

	it('does not activate agent context for presentation files', () => {
		const result = bundle([
			rendered('theme', { presentation: { css: 'body {}', htmlHead: '<meta name="team">' } }),
		]);
		expect(result.vars).not.toHaveProperty('MARIMOHUB_AGENT_CONTEXT_DIR');
		expect(result.marimoPresentation).toBeDefined();
	});
	it('orders separate stylesheets and joined HTML fragments by integration name', () => {
		const result = bundle([
			rendered('z-theme', {
				presentation: { css: 'body { color: red; }', htmlHead: '<meta name="z">' },
			}),
			rendered('a-theme', {
				presentation: {
					css: '@import url("https://example.com/font.css");',
					htmlHead: '<meta name="a">',
				},
			}),
		]);
		expect(result.marimoPresentation?.cssFiles).toEqual([
			`${INTEGRATIONS_DIR}/presentation/a-theme.css`,
			`${INTEGRATIONS_DIR}/presentation/z-theme.css`,
		]);
		expect(result.files).toContainEqual({
			path: `${INTEGRATIONS_DIR}/presentation/a-theme.css`,
			content: '@import url("https://example.com/font.css");',
		});
		expect(result.files).toContainEqual({
			path: result.marimoPresentation?.htmlHeadFile,
			content: '<meta name="a">\n<meta name="z">',
		});
	});

	it.each(['presentation/theme.css', 'presentation/head.html', 'presentation'])(
		'rejects file collisions at %s',
		(path) => {
			expect(() =>
				bundle([
					rendered('theme', { presentation: { css: 'body {}', htmlHead: '<meta name="theme">' } }),
					rendered('other', file(path)),
				]),
			).toThrow(ValidationError);
		},
	);
});
