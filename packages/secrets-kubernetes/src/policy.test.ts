import { describe, expect, it } from 'vitest';
import { parseKubernetesSecretPolicies } from './policy';

const PROJECT = 'proj-0000000000000000';

describe('parseKubernetesSecretPolicies', () => {
	it('accepts wildcard and project-scoped rules', () => {
		expect(
			parseKubernetesSecretPolicies([
				{ namespace: 'connections-a', name: 'provider.example', projects: '*' },
				{ namespace: 'connections-b', name: 'provider', projects: [PROJECT] },
			]),
		).toEqual([
			{ namespace: 'connections-a', name: 'provider.example', projects: '*' },
			{ namespace: 'connections-b', name: 'provider', projects: [PROJECT] },
		]);
	});

	it.each([undefined, null, {}, [], 'rules'])('rejects a non-empty-array violation %#', (value) => {
		expect(() => parseKubernetesSecretPolicies(value)).toThrow(/non-empty JSON array/);
	});

	it.each([
		null,
		[],
		'something',
		{ namespace: 'connections', name: 'provider', projects: '*', typo: true },
	])('rejects malformed rule %#', (rule) => {
		expect(() => parseKubernetesSecretPolicies([rule])).toThrow(/rule 1/);
	});

	it.each(['', 'Connections', '-connections', 'connections-', 'connections_1', 'a'.repeat(64)])(
		'rejects invalid namespace %j',
		(namespace) => {
			expect(() =>
				parseKubernetesSecretPolicies([{ namespace, name: 'provider', projects: '*' }]),
			).toThrow(/invalid namespace/);
		},
	);

	it.each([
		'',
		'Provider',
		'-provider',
		'provider-',
		'provider..example',
		'provider_example',
		'a'.repeat(64),
		`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
	])('rejects invalid Secret name %j', (name) => {
		expect(() =>
			parseKubernetesSecretPolicies([{ namespace: 'connections', name, projects: '*' }]),
		).toThrow(/invalid Secret name/);
	});

	it.each([undefined, null, '', 'all', [], {}, [PROJECT, 1], ['not-a-project']])(
		'rejects invalid projects %#',
		(projects) => {
			expect(() =>
				parseKubernetesSecretPolicies([{ namespace: 'connections', name: 'provider', projects }]),
			).toThrow(/projects/);
		},
	);

	it('rejects duplicate project IDs', () => {
		expect(() =>
			parseKubernetesSecretPolicies([
				{ namespace: 'connections', name: 'provider', projects: [PROJECT, PROJECT] },
			]),
		).toThrow(/duplicate project ID/);
	});

	it('rejects duplicate namespace and Secret pairs', () => {
		expect(() =>
			parseKubernetesSecretPolicies([
				{ namespace: 'connections', name: 'provider', projects: '*' },
				{ namespace: 'connections', name: 'provider', projects: [PROJECT] },
			]),
		).toThrow(/duplicates an earlier Secret/);
	});

	it('does not include policy identifiers in validation errors', () => {
		const error = (() => {
			try {
				parseKubernetesSecretPolicies([
					{ namespace: 'private-namespace', name: 'Sensitive_Name', projects: '*' },
				]);
			} catch (caught) {
				return caught;
			}
		})();
		expect(String(error)).not.toContain('private-namespace');
		expect(String(error)).not.toContain('Sensitive_Name');
	});
});
