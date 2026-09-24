import type { SourceControlRegistry } from '@marimo-hub/core/ports/source-control';
import type { ProjectId } from '@marimo-hub/core/ids';
import { ForbiddenError } from '@marimo-hub/core/errors';
import { allowsProjectResource } from '@marimo-hub/core/project-resource-policy';
import { GitHubAppPublisher, parseGitHubRepository } from '@marimo-hub/source-control-github';
import type { Env } from './env';
import { ConfigError } from './errors';
import { projectResourceRules } from './projectResourcePolicy';
import { ConfiguredSourceControlRegistry } from './sourceControlRegistry';

const GITHUB_APP_ID_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY';

type SourceControlConfig = {
	sourceControl?: SourceControlRegistry;
};

export function makeSourceControl(env: Env): SourceControlConfig {
	const appId = env[GITHUB_APP_ID_ENV]?.trim();
	const privateKey = env[GITHUB_APP_PRIVATE_KEY_ENV]?.trim();
	if (!appId && !privateKey) return {};
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

	// One credential, two capabilities: the GitHub App publishes change requests
	// and serves server-initiated pull sync.
	let github: GitHubAppPublisher;
	try {
		github = new GitHubAppPublisher({ appId, privateKey });
	} catch {
		throw new ConfigError(`Invalid ${GITHUB_APP_PRIVATE_KEY_ENV}`, {
			variable: GITHUB_APP_PRIVATE_KEY_ENV,
		});
	}

	const variable = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES';
	const rules = projectResourceRules(env, variable);
	const canonical = (repository: string) => {
		const { owner, repo } = parseGitHubRepository(repository);
		return `${owner}/${repo}`.toLowerCase();
	};
	if (rules) {
		try {
			for (const rule of rules) if (rule.resource !== '*') rule.resource = canonical(rule.resource);
		} catch {
			throw new ConfigError(`${variable} contains an invalid GitHub repository.`, { variable });
		}
	}
	const authorize = rules
		? (repository: string, projectId?: ProjectId) => {
				if (!allowsProjectResource(rules, canonical(repository), projectId)) {
					throw new ForbiddenError('Repository is not allowed for this project.');
				}
			}
		: undefined;
	return { sourceControl: new ConfiguredSourceControlRegistry([github], [github], authorize) };
}
