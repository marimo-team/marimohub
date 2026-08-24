import type {
	SourceControlPublisher,
	SourceControlReader,
	SourceControlRegistry,
} from '@marimo-hub/core';
import { GitHubAppPublisher } from '@marimo-hub/source-control-github';
import type { Env } from './env';
import { ConfigError } from './errors';

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

	return {
		sourceControl: sourceControlRegistry([github], [github]),
	};
}
