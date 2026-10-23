import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertValidEnvironmentName } from '../integrations/environmentName';
import { INTEGRATIONS_DIR_ENV } from '../integrations/bundle';
import {
	HUB_SANDBOX_ENV,
	mergeSessionEnv,
	projectSessionEnv,
	SANDBOX_IMAGE_MARIMO_ENV,
	SANDBOX_INTEGRATIONS_DIR_ENV,
} from './sandboxEnvironment';
import type { SessionEnv } from './sandboxEnvironment';

const repoFile = (path: string) =>
	readFileSync(fileURLToPath(new URL(`../../../../../${path}`, import.meta.url)), 'utf8');

function marimoNamesSetBy(path: string): string[] {
	const source = repoFile(path).replaceAll('\\\n', ' ');
	const names = new Set<string>();
	for (const line of source.split('\n')) {
		if (!/^\s*(ENV|export)\s/.test(line)) continue;
		for (const [, name] of line.matchAll(/\b(_?MARIMO_[A-Z0-9_]*)=/g)) names.add(name);
	}
	return [...names].sort();
}

describe('sandbox image marimo environment', () => {
	it('pins only names listed as image-pinned and reserved', () => {
		const names = marimoNamesSetBy('images/marimo-sandbox/Dockerfile');
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(SANDBOX_IMAGE_MARIMO_ENV).toContain(name);
			expect(() => assertValidEnvironmentName(name)).toThrow(/reserved/);
		}
	});

	it('lists every name the reference image pins', () => {
		expect(marimoNamesSetBy('images/marimo-sandbox/Dockerfile')).toEqual(
			[...SANDBOX_IMAGE_MARIMO_ENV].sort(),
		);
	});
});

describe('HUB_SANDBOX_ENV', () => {
	it('matches the integrations bundle directory variable', () => {
		expect(SANDBOX_INTEGRATIONS_DIR_ENV).toBe(INTEGRATIONS_DIR_ENV);
	});

	it.each(HUB_SANDBOX_ENV)('reserves %s', (name) => {
		expect(() => assertValidEnvironmentName(name)).toThrow(/reserved/);
	});
});

describe('projectSessionEnv', () => {
	it('preserves runtime packages and files while demoting marimo settings', () => {
		const render = {
			vars: { MARIMO_OUTPUT_MAX_BYTES: '1000' },
			files: [{ path: '/tmp/config', content: 'config' }],
			runtimePackages: ['marimo-studio==0.4.1'],
			startupScripts: ['/tmp/setup.sh'],
		};
		expect(projectSessionEnv(render)).toEqual({
			...render,
			vars: {},
			defaults: render.vars,
		});
	});
	it('applies project marimo settings as defaults and keeps other variables forced', () => {
		const files = [{ path: '/tmp/x', content: 'x' }];
		expect(
			projectSessionEnv({
				files,
				vars: {
					MARIMO_OUTPUT_MAX_BYTES: '1000',
					MARIMOHUB_PG_PROD_URL: 'postgres://db',
					MARIMOS: 'x',
					MY_FLAG: 'on',
				},
			}),
		).toEqual({
			files,
			vars: { MARIMOHUB_PG_PROD_URL: 'postgres://db', MARIMOS: 'x', MY_FLAG: 'on' },
			defaults: { MARIMO_OUTPUT_MAX_BYTES: '1000' },
		});
	});
});

describe('mergeSessionEnv', () => {
	it('retains CSS order and rejects competing bundled heads', () => {
		const base = {
			marimoPresentation: { cssFiles: ['/a.css', '/b.css'], htmlHeadFile: '/head.html' },
		};
		const same = mergeSessionEnv(base, {
			marimoPresentation: { cssFiles: ['/b.css', '/c.css'], htmlHeadFile: '/head.html' },
		});
		expect(same.marimoPresentation).toEqual({
			cssFiles: ['/a.css', '/b.css', '/c.css'],
			htmlHeadFile: '/head.html',
		});
		expect(() =>
			mergeSessionEnv(base, { marimoPresentation: { htmlHeadFile: '/other.html' } }),
		).toThrow('Cannot combine');
	});
	it.each([
		[{ workspaceLoadMode: 'copy-only' as const }, {}],
		[{}, { workspaceLoadMode: 'copy-only' as const }],
	])('preserves a copy-only requirement from either layer', (base, add) => {
		expect(mergeSessionEnv(base, add).workspaceLoadMode).toBe('copy-only');
	});
	it.each([undefined, {}])('accepts an empty base %j and omits an empty package layer', (base) => {
		expect(mergeSessionEnv(base, {})).toEqual({ files: [], vars: {}, defaults: {} });
	});

	it('appends files and packages while later variables and defaults take precedence', () => {
		const base: SessionEnv = {
			files: [{ path: '/tmp/base', content: 'base' }],
			runtimePackages: ['first-tool==1.0.0'],
			startupScripts: ['/tmp/first.sh'],
			vars: { KEEP: 'base', OVERRIDE: 'base' },
			defaults: { KEEP_DEFAULT: 'base', OVERRIDE: 'base-default' },
		};
		const add: SessionEnv = {
			files: [{ path: '/tmp/added', content: 'added' }],
			runtimePackages: ['second-tool==1.0.0'],
			startupScripts: ['/tmp/second.sh'],
			vars: { OVERRIDE: 'added' },
			defaults: { OVERRIDE: 'added-default' },
		};
		const original = structuredClone({ base, add });
		const merged = mergeSessionEnv(base, add);
		expect(merged).toEqual({
			files: [...base.files!, ...add.files!],
			runtimePackages: ['first-tool==1.0.0', 'second-tool==1.0.0'],
			startupScripts: ['/tmp/first.sh', '/tmp/second.sh'],
			vars: { KEEP: 'base', OVERRIDE: 'added' },
			defaults: { KEEP_DEFAULT: 'base', OVERRIDE: 'added-default' },
		});
		merged.files!.push({ path: '/tmp/new', content: '' });
		merged.runtimePackages!.push('third-tool==1.0.0');
		merged.startupScripts!.push('/tmp/third.sh');
		merged.vars!.KEEP = 'changed';
		merged.defaults!.KEEP_DEFAULT = 'changed';
		expect({ base, add }).toEqual(original);
	});
});
