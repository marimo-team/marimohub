import type { IntegrationEntry, KindDescriptor } from '../../ports/integrations';
import { sharedEnvironmentConflictHelp } from './environmentHelp';

export { AMBIENT_ENV_CONFLICT_HELP, INTEGRATION_TEST_HELP } from './environmentHelp';

export type ValidationKind = Pick<KindDescriptor, 'kind' | 'shared_environment'>;

export interface ValidatableIntegration extends Pick<
	IntegrationEntry,
	'name' | 'kind' | 'enabled' | 'shadowed' | 'ambient_env'
> {
	id: string;
}

export interface IntegrationValidationFinding {
	severity: 'warning' | 'error';
	title: string;
	message: string;
	/** Fix that needs manager rights; UIs show it only to users who can act on it. */
	remedy?: string;
	integrationIds: string[];
}

export interface IntegrationValidation {
	id: string;
	validate(
		integrations: readonly ValidatableIntegration[],
		kinds: readonly ValidationKind[],
	): IntegrationValidationFinding[];
}

export interface IntegrationValidationResult extends IntegrationValidationFinding {
	ruleId: string;
}

// List entries omit configuration and secrets, so shared-variable checks are advisories.
const sharedEnvironmentValidation: IntegrationValidation = {
	id: 'shared-environment',
	validate(integrations, kinds) {
		const sharedByKind = new Map(
			kinds.flatMap(({ kind, shared_environment }) =>
				shared_environment ? [[kind, shared_environment] as const] : [],
			),
		);
		const groups = new Map<
			string,
			{
				shared: NonNullable<ValidationKind['shared_environment']>;
				entries: ValidatableIntegration[];
			}
		>();
		for (const entry of integrations) {
			const shared = sharedByKind.get(entry.kind);
			if (!shared || entry.ambient_env === false) continue;
			const group = groups.get(shared.group) ?? { shared, entries: [] };
			group.entries.push(entry);
			groups.set(shared.group, group);
		}
		return [...groups.values()]
			.filter(({ entries }) => entries.length >= 2)
			.map(({ shared, entries }) => {
				return {
					severity: 'warning',
					title: `Multiple ${shared.title} connections: check shared settings`,
					message:
						`${entries.map((entry) => entry.name).join(', ')} are enabled. ` +
						`If they export different values for ${shared.variables}, notebooks cannot start.`,
					remedy: sharedEnvironmentConflictHelp(
						entries.some((entry) => entry.ambient_env !== undefined),
					),
					integrationIds: entries.map((entry) => entry.id),
				};
			});
	},
};

export const integrationValidations: readonly IntegrationValidation[] = [
	sharedEnvironmentValidation,
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
	kinds: readonly ValidationKind[],
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
