import type { IntegrationEntry, KindDescriptor } from '../../ports/integrations';
import { AMBIENT_ENV_CONFLICT_HELP, INTEGRATION_TEST_HELP } from './environmentHelp';

export { AMBIENT_ENV_CONFLICT_HELP, INTEGRATION_TEST_HELP } from './environmentHelp';

export interface ValidatableIntegration extends Pick<
	IntegrationEntry,
	'name' | 'kind' | 'enabled' | 'shadowed'
> {
	id: string;
}

export interface IntegrationValidationFinding {
	severity: 'warning' | 'error';
	title: string;
	message: string;
	integrationIds: string[];
}

export interface IntegrationValidation {
	id: string;
	validate(
		integrations: readonly ValidatableIntegration[],
		kinds: readonly Pick<KindDescriptor, 'kind'>[],
	): IntegrationValidationFinding[];
}

export interface IntegrationValidationResult extends IntegrationValidationFinding {
	ruleId: string;
}

// List entries omit configuration and secrets, so shared-variable checks are advisories.
function sharedEnvironmentValidation(
	id: string,
	kinds: readonly string[],
	title: string,
	variables: string,
): IntegrationValidation {
	return {
		id,
		validate(integrations) {
			const connections = integrations.filter((entry) => kinds.includes(entry.kind));
			if (connections.length < 2) return [];
			return [
				{
					severity: 'warning',
					title,
					message:
						`${connections.map((entry) => entry.name).join(', ')} are enabled. ` +
						`If they export different values for ${variables}, notebooks cannot start. ` +
						`${AMBIENT_ENV_CONFLICT_HELP} ${INTEGRATION_TEST_HELP}`,
					integrationIds: connections.map((entry) => entry.id),
				},
			];
		},
	};
}

export const integrationValidations: readonly IntegrationValidation[] = [
	sharedEnvironmentValidation(
		's3-shared-environment',
		['s3'],
		'Multiple S3 connections: check shared AWS settings',
		'shared AWS variables',
	),
	sharedEnvironmentValidation(
		'google-shared-environment',
		['gcs', 'bigquery'],
		'Multiple Google Cloud connections: check shared settings',
		'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_PROJECT',
	),
	sharedEnvironmentValidation(
		'azure-shared-environment',
		['azure_blob'],
		'Multiple Azure Blob connections: check shared settings',
		'shared Azure storage or identity variables',
	),
	{
		id: 'unavailable-kind',
		validate(integrations, kinds) {
			const available = new Set(kinds.map((kind) => kind.kind));
			const unavailable = integrations.filter((entry) => !available.has(entry.kind));
			if (unavailable.length === 0) return [];
			return [
				{
					severity: 'error',
					title: 'Integration kinds unavailable',
					message:
						`Unavailable: ${unavailable.map((entry) => `${entry.name} (${entry.kind})`).join(', ')}. ` +
						'Restore these kinds or disable the affected integrations before starting notebooks.',
					integrationIds: unavailable.map((entry) => entry.id),
				},
			];
		},
	},
];

export function validateIntegrations(
	integrations: readonly ValidatableIntegration[],
	kinds: readonly Pick<KindDescriptor, 'kind'>[],
	validations: readonly IntegrationValidation[] = integrationValidations,
): IntegrationValidationResult[] {
	const effective = integrations.filter((entry) => entry.enabled && !entry.shadowed);
	return validations.flatMap((validation) =>
		validation.validate(effective, kinds).map((finding) => ({
			...finding,
			ruleId: validation.id,
		})),
	);
}
