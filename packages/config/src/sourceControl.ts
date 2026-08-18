import type { SourceControlPublisher, SourceControlPublisherRegistry } from '@marimo-hub/core';
import { GitHubAppPublisher } from '@marimo-hub/source-control-github';
import type { Env } from './env';
import { ConfigError } from './errors';

const GITHUB_APP_ID_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID';
const GITHUB_APP_PRIVATE_KEY_ENV = 'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY';

type SourceControlPublishingConfig = {
	sourceControlPublishers?: SourceControlPublisherRegistry;
};

function publisherRegistry(
	publishers: readonly SourceControlPublisher[],
): SourceControlPublisherRegistry {
	const byProvider = new Map(publishers.map((publisher) => [publisher.provider, publisher]));
	if (byProvider.size !== publishers.length) {
		throw new ConfigError('Source-control publisher provider ids must be unique');
	}
	return {
		getPublisher: (provider) => byProvider.get(provider),
		configuredProviders: () => [...byProvider.keys()],
	};
}

export function makeSourceControlPublishing(env: Env): SourceControlPublishingConfig {
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

	let publisher: GitHubAppPublisher;
	try {
		publisher = new GitHubAppPublisher({ appId, privateKey });
	} catch {
		throw new ConfigError(`Invalid ${GITHUB_APP_PRIVATE_KEY_ENV}`, {
			variable: GITHUB_APP_PRIVATE_KEY_ENV,
		});
	}

	return {
		sourceControlPublishers: publisherRegistry([publisher]),
	};
}
