import type { SourceControlRegistry } from '@marimo-hub/core/ports/source-control';
import type { GitProvider } from '@marimo-hub/core/git-repo';
import { ForbiddenError } from '@marimo-hub/core/errors';
import { allowsProjectResource } from '@marimo-hub/core/project-resource-policy';
import {
	GitHubAppPublisher,
	githubOrigin,
	parseGitHubRepository,
} from '@marimo-hub/source-control-github';
import {
	AzureDevOpsSourceControl,
	ClientSecretCredential,
	parseAzureRepository,
	validateOrganization,
} from '@marimo-hub/source-control-azure-devops';
import type { Env } from './env';
import { ConfigError } from './errors';
import { projectResourceRules } from './projectResourcePolicy';
import { ConfiguredSourceControlRegistry } from './sourceControlRegistry';
import type { AuthorizeRepository, SourceControlRegistration } from './sourceControlRegistry';

const GITHUB_APP_ID_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY';

type SourceControlConfig = {
	sourceControl?: SourceControlRegistry;
};

function makeGitHubSourceControl(env: Env): SourceControlRegistration | undefined {
	const appId = env[GITHUB_APP_ID_ENV]?.trim();
	const privateKey = env[GITHUB_APP_PRIVATE_KEY_ENV]?.trim();
	if (!appId && !privateKey) return undefined;
	if (!appId) {
		throw new ConfigError(`${GITHUB_APP_ID_ENV} is required when GitHub publishing is configured`, {
			variable: GITHUB_APP_ID_ENV,
		});
	}
	if (!/^[1-9]\d*$/.test(appId)) {
		throw new ConfigError(`${GITHUB_APP_ID_ENV} must be a positive integer`, {
			variable: GITHUB_APP_ID_ENV,
		});
	}
	if (!privateKey) {
		throw new ConfigError(
			`${GITHUB_APP_PRIVATE_KEY_ENV} is required when GitHub publishing is configured`,
			{ variable: GITHUB_APP_PRIVATE_KEY_ENV },
		);
	}

	const urlVariable = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_SERVER_URL';
	let url: string;
	try {
		url = githubOrigin(env[urlVariable]?.trim() || undefined);
	} catch {
		throw new ConfigError(`${urlVariable} must be an HTTPS origin without a path`, {
			variable: urlVariable,
		});
	}
	let github: GitHubAppPublisher;
	try {
		github = new GitHubAppPublisher({ appId, privateKey, url });
	} catch {
		throw new ConfigError(`Invalid ${GITHUB_APP_PRIVATE_KEY_ENV}`, {
			variable: GITHUB_APP_PRIVATE_KEY_ENV,
		});
	}

	return {
		reader: github,
		publisher: github,
		repositoryHosts: { [new URL(url).host]: github.provider },
		authorize: repositoryPolicy(
			env,
			'MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES',
			'GitHub',
			(repository) => {
				const { owner, repo } = parseGitHubRepository(repository, url);
				return `${url}/${owner}/${repo}`.toLowerCase();
			},
		),
	};
}

function makeAzureSourceControl(env: Env): SourceControlRegistration | undefined {
	const organization = env.MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ORGANIZATION?.trim();
	const tenantId = env.MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_TENANT_ID?.trim();
	const clientId = env.MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_ID?.trim();
	const clientSecret = env.MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_CLIENT_SECRET?.trim();
	if (!organization && !tenantId && !clientId && !clientSecret) return undefined;
	const variable = 'MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ORGANIZATION';
	try {
		validateOrganization(organization ?? '');
	} catch {
		throw new ConfigError(`${variable} must name an Azure DevOps Services organization`, {
			variable,
		});
	}
	if ((tenantId || clientId || clientSecret) && !(tenantId && clientId && clientSecret)) {
		throw new ConfigError(
			'MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_TENANT_ID, CLIENT_ID, and CLIENT_SECRET must be set together',
		);
	}
	const azure = new AzureDevOpsSourceControl({
		organization: organization!,
		credential:
			tenantId && clientId && clientSecret
				? new ClientSecretCredential(tenantId, clientId, clientSecret)
				: undefined,
	});
	return {
		reader: azure,
		publisher: azure,
		repositoryHosts: { 'dev.azure.com': azure.provider },
		authorize: repositoryPolicy(
			env,
			'MARIMOHUB_SOURCE_CONTROL_AZURE_DEVOPS_ALLOWED_REPOSITORIES',
			'Azure DevOps',
			(repository) => parseAzureRepository(repository, organization).url.toLowerCase(),
		),
	};
}

function repositoryPolicy(
	env: Env,
	variable: string,
	label: string,
	canonical: (repository: string) => string,
): AuthorizeRepository | undefined {
	const rules = projectResourceRules(env, variable);
	if (!rules) return undefined;
	try {
		for (const rule of rules) if (rule.resource !== '*') rule.resource = canonical(rule.resource);
	} catch {
		throw new ConfigError(`${variable} contains an invalid ${label} repository.`, { variable });
	}
	return (repository, projectId) => {
		if (!allowsProjectResource(rules, canonical(repository), projectId))
			throw new ForbiddenError('Repository is not allowed for this project.');
	};
}

const SOURCE_CONTROL_FACTORIES = {
	github: makeGitHubSourceControl,
	gitlab: null,
	'azure-devops': makeAzureSourceControl,
} satisfies Record<GitProvider, ((env: Env) => SourceControlRegistration | undefined) | null>;

export function makeSourceControl(env: Env): SourceControlConfig {
	const registrations = Object.values(SOURCE_CONTROL_FACTORIES).flatMap(
		(factory) => factory?.(env) ?? [],
	);
	return registrations.length === 0
		? {}
		: { sourceControl: new ConfiguredSourceControlRegistry(registrations) };
}
