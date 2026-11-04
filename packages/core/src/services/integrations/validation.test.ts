import { describe, expect, it } from 'vitest';
import { validateIntegrations } from './validation';
import type { IntegrationValidation, ValidatableIntegration } from './validation';

const kinds = ['s3', 'gcs', 'bigquery', 'azure_blob', 'postgres'].map((kind) => ({ kind }));
const integration = (
	id: string,
	kind: string,
	overrides: Partial<ValidatableIntegration> = {},
): ValidatableIntegration => ({ id, name: id, kind, enabled: true, ...overrides });

describe('integration validation', () => {
	it('accepts an empty deployment', () => {
		expect(validateIntegrations([], [])).toEqual([]);
	});

	it('reports every active integration when the kind catalog is empty', () => {
		const results = validateIntegrations(
			[
				integration('first', 'custom'),
				integration('second', 'custom'),
				integration('disabled', 'other', { enabled: false }),
			],
			[],
		);
		expect(results).toEqual([
			expect.objectContaining({
				ruleId: 'unavailable-kind',
				severity: 'error',
				integrationIds: ['first', 'second'],
			}),
		]);
		expect(results[0].message).toContain('first (custom), second (custom)');
		expect(results[0].message).not.toContain('disabled');
	});

	it('does not resurrect an inherited integration when its project override is disabled', () => {
		expect(
			validateIntegrations(
				[
					integration('org', 'unavailable', { name: 'warehouse', shadowed: true }),
					integration('project', 'unavailable', { name: 'warehouse', enabled: false }),
				],
				kinds,
			),
		).toEqual([]);
	});

	it('groups three connections into one advisory without including configuration or secrets', () => {
		const entries = ['one', 'two', 'three'].map((id) =>
			Object.freeze({
				...integration(id, 's3'),
				config: { auth: { secret_access_key: 'must-not-leak' } },
			}),
		);
		const results = validateIntegrations(Object.freeze(entries), kinds);
		expect(results).toHaveLength(1);
		expect(results[0].integrationIds).toEqual(['one', 'two', 'three']);
		expect(results[0].message).toContain('one, two, three');
		expect(JSON.stringify(results)).not.toContain('must-not-leak');
	});

	it.each([
		['s3', 's3', 's3-shared-environment'],
		['gcs', 'gcs', 'google-shared-environment'],
		['gcs', 'bigquery', 'google-shared-environment'],
		['azure_blob', 'azure_blob', 'azure-shared-environment'],
	])('warns about shared exports for %s and %s', (first, second, ruleId) => {
		const results = validateIntegrations(
			[integration('one', first), integration('two', second), integration('unrelated', 'postgres')],
			kinds,
		);
		expect(results).toEqual([
			expect.objectContaining({
				ruleId,
				severity: 'warning',
				integrationIds: ['one', 'two'],
			}),
		]);
		expect(results[0].message).toContain('If they export different values');
		expect(results[0].message).toContain('Ambient env');
	});

	it('does not warn about independent providers or a single connection', () => {
		expect(
			validateIntegrations(
				[
					integration('aws', 's3'),
					integration('google', 'gcs'),
					integration('azure', 'azure_blob'),
				],
				kinds,
			),
		).toEqual([]);
	});

	it('excludes disabled and overridden entries from every rule', () => {
		expect(
			validateIntegrations(
				[
					integration('active', 's3'),
					integration('disabled', 's3', { enabled: false }),
					integration('overridden', 's3', { shadowed: true }),
					integration('disabled-custom', 'custom', { enabled: false }),
					integration('overridden-custom', 'custom', { shadowed: true }),
				],
				kinds,
			),
		).toEqual([]);
	});

	it('returns independent findings with only their affected integrations', () => {
		const results = validateIntegrations(
			[
				integration('s3-one', 's3'),
				integration('s3-two', 's3'),
				integration('google-one', 'gcs'),
				integration('google-two', 'bigquery'),
				integration('custom', 'custom'),
			],
			kinds,
		);
		expect(
			results.map(({ ruleId, severity, integrationIds }) => ({ ruleId, severity, integrationIds })),
		).toEqual([
			{
				ruleId: 's3-shared-environment',
				severity: 'warning',
				integrationIds: ['s3-one', 's3-two'],
			},
			{
				ruleId: 'google-shared-environment',
				severity: 'warning',
				integrationIds: ['google-one', 'google-two'],
			},
			{ ruleId: 'unavailable-kind', severity: 'error', integrationIds: ['custom'] },
		]);
		expect(results[2].message).toContain('custom (custom)');
	});

	it('accepts deployment-specific kinds', () => {
		const entries = [integration('custom', 'custom')];
		const availableKinds = [{ kind: 'custom' }];
		expect(validateIntegrations(entries, availableKinds)).toEqual([]);
	});

	it('preserves multiple findings from a rule and filters its inputs', () => {
		const validation: IntegrationValidation = {
			id: 'per-integration-policy',
			validate(integrations, availableKinds) {
				expect(availableKinds).toEqual(kinds);
				return integrations.map((entry) => ({
					severity: 'error',
					title: 'Policy violation',
					message: `Review ${entry.name}.`,
					integrationIds: [entry.id],
				}));
			},
		};
		const results = validateIntegrations(
			[
				integration('one', 's3'),
				integration('two', 'gcs'),
				integration('disabled', 's3', { enabled: false }),
				integration('overridden', 'gcs', { shadowed: true }),
			],
			kinds,
			[validation],
		);
		expect(results).toEqual([
			expect.objectContaining({
				ruleId: validation.id,
				severity: 'error',
				integrationIds: ['one'],
			}),
			expect.objectContaining({
				ruleId: validation.id,
				severity: 'error',
				integrationIds: ['two'],
			}),
		]);
	});
});
