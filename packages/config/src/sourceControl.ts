import type {
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
} from '@marimo-hub/core';
import type { ProjectId } from '@marimo-hub/core/ids';
import { ForbiddenError } from '@marimo-hub/core/errors';
import { allowsProjectResource } from '@marimo-hub/core/project-resource-policy';
import { GitHubAppPublisher, parseGitHubRepository } from '@marimo-hub/source-control-github';
import type { Env } from './env';
import { ConfigError } from './errors';
import { projectResourceRules } from './projectResourcePolicy';

const GITHUB_APP_ID_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY';

type SourceControlConfig = {
	sourceControl?: SourceControlRegistry;
};

function sourceControlRegistry(
	publishers: readonly SourceControlPublisher[],
	readers: readonly SourceControlReader[],
): SourceControlRegistry {
	const publishersByProvider = new Map(
		publishers.map((publisher) => [publisher.provider, publisher]),
	);
	const readersByProvider = new Map(readers.map((reader) => [reader.provider, reader]));
	if (
		publishersByProvider.size !== publishers.length ||
		readersByProvider.size !== readers.length
	) {
		throw new ConfigError('Source-control provider ids must be unique');
	}
	return {
		getPublisher: (provider) => publishersByProvider.get(provider),
		getReader: (provider) => readersByProvider.get(provider),
		publisherProviders: () => [...publishersByProvider.keys()],
		readerProviders: () => [...readersByProvider.keys()],
		pullSourceProviders: () =>
			[...readersByProvider.values()]
				.filter((reader) => reader.fetchGitDirectory)
				.map((reader) => reader.provider),
	};
}

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
	const registry = sourceControlRegistry([github], [github]);
	if (!rules) return { sourceControl: registry };
	const assertRepository = (repository: string, projectId?: ProjectId) => {
		if (!allowsProjectResource(rules, canonical(repository), projectId)) {
			throw new ForbiddenError('Repository is not allowed for this project.');
		}
	};
	return {
		sourceControl: {
			...registry,
			getReader(provider, projectId) {
				const reader = registry.getReader(provider);
				if (!reader) return;
				return {
					provider,
					supportsRepository: (repository) => {
						if (!reader.supportsRepository(repository)) return false;
						assertRepository(repository, projectId);
						return true;
					},
					getBranchHead: async (repository, branch) => {
						assertRepository(repository, projectId);
						return reader.getBranchHead(repository, branch);
					},
					fetchWorkspace: async (repository, commit, rootPath) => {
						assertRepository(repository, projectId);
						return reader.fetchWorkspace(repository, commit, rootPath);
					},
					...(reader.fetchGitDirectory
						? {
								fetchGitDirectory: async (repository: string, commit: string, branch: string) => {
									assertRepository(repository, projectId);
									return reader.fetchGitDirectory!(repository, commit, branch);
								},
							}
						: {}),
				};
			},
			getPublisher(provider, projectId) {
				const publisher = registry.getPublisher(provider);
				if (!publisher) return;
				return {
					provider,
					openChangeRequest: async (input) => {
						assertRepository(input.repository, projectId);
						return publisher.openChangeRequest(input);
					},
					...(publisher.updateChangeRequest
						? {
								updateChangeRequest: async (
									input: Parameters<NonNullable<SourceControlPublisher['updateChangeRequest']>>[0],
								) => {
									assertRepository(input.repository, projectId);
									return publisher.updateChangeRequest!(input);
								},
							}
						: {}),
				};
			},
		},
	};
}
