import { describe, expect, it } from 'vitest';
import { LocalResourceConstraintPolicy } from '@marimo-hub/core';
import { ConfigError } from './errors';
import { makeResourceSecurity } from './resourceSecurity';

function getConfigError(run: () => unknown): ConfigError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return error as ConfigError;
	}
	throw new Error('Expected configuration to fail');
}

describe('makeResourceSecurity', () => {
	it('is disabled when no classification order is configured', () => {
		expect(makeResourceSecurity({})).toBeUndefined();
	});

	it('wires the local constraint adapter from the configured order', () => {
		const security = makeResourceSecurity({
			MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: 'UNCLASSIFIED, CUI, SECRET',
		});
		expect(security?.constraints).toBeInstanceOf(LocalResourceConstraintPolicy);
		expect(security?.subjectContext).toBeUndefined();
	});

	it.each([
		['a repeated classification', 'SECRET,SECRET'],
		['a whitespace token', 'TOP SECRET'],
		['an empty list', ' , , '],
		['an oversized token', `S${'x'.repeat(64)}`],
	])('rejects %s in the classification order', (_name, value) => {
		const error = getConfigError(() =>
			makeResourceSecurity({ MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: value }),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER');
	});

	it.each([
		['MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND', 'library'],
		['MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY', '/etc/marimohub/subject-context.mjs'],
	])('rejects %s without a classification order', (key, value) => {
		const error = getConfigError(() => makeResourceSecurity({ [key]: value }));
		expect(error.opts.variable).toBe(key);
		expect(error.message).toMatch(/CLASSIFICATION_ORDER/);
	});

	it('rejects an unknown subject-context backend', () => {
		const error = getConfigError(() =>
			makeResourceSecurity({
				MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: 'CUI,SECRET',
				MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND: 'remote',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND');
		expect(error.message).toMatch(/expected library/);
	});

	it('rejects a provider module path without the library selector', () => {
		const error = getConfigError(() =>
			makeResourceSecurity({
				MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: 'CUI,SECRET',
				MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY: '/etc/marimohub/subject-context.mjs',
			}),
		);
		expect(error.opts.variable).toBe('MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY');
		expect(error.message).toMatch(/SUBJECT_CONTEXT_BACKEND=library/);
	});

	it('requires the provider to be preloaded when selected (createFromEnvAsync)', () => {
		const env = {
			MARIMOHUB_AUTHZ_CLASSIFICATION_ORDER: 'CUI,SECRET',
			MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND: 'library',
			MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_LIBRARY: '/etc/marimohub/subject-context.mjs',
		};
		const error = getConfigError(() => makeResourceSecurity(env));
		expect(error.opts.variable).toBe('MARIMOHUB_AUTHZ_SUBJECT_CONTEXT_BACKEND');
		expect(error.message).toMatch(/createFromEnvAsync/);

		const provider = { resolve: async () => null };
		const security = makeResourceSecurity(env, { subjectContext: provider });
		expect(security?.subjectContext).toBe(provider);
	});
});
