import { describe, expect, it } from 'vitest';
import { defaultRegistry } from './kinds';
import { validateIntegrations } from './validation';
import type { IntegrationValidation, ValidatableIntegration } from './validation';

const kinds = defaultRegistry()
	.describeAll()
	.filter(({ kind }) =>
		['s3', 'gcs', 'bigquery', 'azure_blob', 'postgres', 'wandb', 'huggingface'].includes(kind),
	);
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
		['s3', 's3', 'S3'],
		['gcs', 'gcs', 'Google Cloud'],
		['gcs', 'bigquery', 'Google Cloud'],
		['azure_blob', 'azure_blob', 'Azure Blob'],
	])('warns about shared exports for %s and %s', (first, second, title) => {
		const results = validateIntegrations(
			[
				integration('one', first, { ambient_env: true }),
				integration('two', second, { ambient_env: true }),
				integration('unrelated', 'postgres'),
			],
			kinds,
		);
		expect(results).toEqual([
			expect.objectContaining({
				ruleId: 'shared-environment',
				severity: 'warning',
				title: `Multiple ${title} connections: check shared settings`,
				integrationIds: ['one', 'two'],
			}),
		]);
		expect(results[0].message).toContain('If they export different values');
		expect(results[0].message).not.toContain('Ambient env');
		expect(results[0].remedy).toContain('Ambient env');
		expect(results[0].remedy).not.toContain('Connection tests');
	});

	it.each([
		['wandb', 'Weights & Biases'],
		['huggingface', 'Hugging Face'],
	])('warns about two %s integrations, which have no ambient env switch', (kind, title) => {
		const results = validateIntegrations(
			[integration('org-tracking', kind), integration('tracking', kind)],
			kinds,
		);
		expect(results).toEqual([
			expect.objectContaining({
				ruleId: 'shared-environment',
				title: `Multiple ${title} connections: check shared settings`,
				integrationIds: ['org-tracking', 'tracking'],
			}),
		]);
		expect(results[0].remedy).toContain('enable only one of them');
		expect(results[0].remedy).not.toContain('Ambient env');
	});

	it('clears the warning once all but one connection disables ambient env', () => {
		expect(
			validateIntegrations(
				[
					integration('one', 's3', { ambient_env: true }),
					integration('two', 's3', { ambient_env: false }),
					integration('three', 's3', { ambient_env: false }),
				],
				kinds,
			),
		).toEqual([]);
	});

	it('does not warn for a GCS connection and a default BigQuery connection', () => {
		expect(
			validateIntegrations(
				[
					integration('bucket', 'gcs', { ambient_env: true }),
					integration('warehouse', 'bigquery', { ambient_env: false }),
				],
				kinds,
			),
		).toEqual([]);
	});

	it('does not warn about independent providers or a single connection', () => {
		expect(
			validateIntegrations(
				[
					integration('aws', 's3'),
					integration('google', 'gcs'),
					integration('azure', 'azure_blob'),
					integration('tracking', 'wandb'),
					integration('models', 'huggingface'),
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
				ruleId: 'shared-environment',
				severity: 'warning',
				integrationIds: ['s3-one', 's3-two'],
			},
			{
				ruleId: 'shared-environment',
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
