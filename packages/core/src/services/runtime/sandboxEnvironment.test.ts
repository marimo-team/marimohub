import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertValidEnvironmentName } from '../integrations/environmentName';
import { INTEGRATIONS_DIR_ENV } from '../integrations/bundle';
import {
	HUB_SANDBOX_ENV,
	projectSessionEnv,
	SANDBOX_IMAGE_MARIMO_ENV,
	SANDBOX_INTEGRATIONS_DIR_ENV,
} from './sandboxEnvironment';

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
