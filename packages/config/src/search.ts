import { AuthorizationService } from '@marimo-hub/core';
import {
	NotebookSource,
	IntegrationSource,
	SearchService,
	SearchIndexer,
} from '@marimo-hub/core/search';
import type { SearchSource } from '@marimo-hub/core/search';
import { BucketSearchIndex } from '@marimo-hub/search-bucket';
import { HttpEmbeddings } from '@marimo-hub/embeddings-http';
import type { ApiDeps } from '@marimo-hub/api';
import { parseEnumOr } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

export function makeSearch(env: Env, deps: ApiDeps): ApiDeps['search'] {
	const backend = parseEnumOr(env, 'MARIMOHUB_SEARCH_BACKEND', ['off', 'bucket'], 'off');
	if (backend === 'off') return undefined;
	const embeddings = makeEmbeddings(env);
	const authz = new AuthorizationService(deps.policy, deps.resourceSecurity);
	const { catalog, projects, notebooks } = deps.services;
	const sources: SearchSource[] = [new NotebookSource(deps.bucket, catalog, notebooks, authz)];
	if (deps.integrations)
		sources.push(new IntegrationSource(deps.integrations, authz, Boolean(deps.dataBrowser)));
	const index = new BucketSearchIndex(deps.bucket, undefined, deps.metrics);
	return {
		service: new SearchService(index, sources, catalog, projects, authz, embeddings),
		indexer: new SearchIndexer(
			deps.bucket,
			index,
			sources,
			catalog,
			projects,
			embeddings,
			undefined,
			deps.metrics,
		),
	};
}

function makeEmbeddings(env: Env): HttpEmbeddings | undefined {
	const endpoint = env.MARIMOHUB_SEARCH_EMBEDDING_URL;
	const model = env.MARIMOHUB_SEARCH_EMBEDDING_MODEL;
	const apiKey = env.MARIMOHUB_SEARCH_EMBEDDING_API_KEY;
	if (apiKey && !endpoint && !model)
		throw new ConfigError('Embedding API key requires an embedding URL and model', {
			variable: 'MARIMOHUB_SEARCH_EMBEDDING_API_KEY',
		});
	if (Boolean(endpoint) !== Boolean(model))
		throw new ConfigError('Embedding URL and model must be configured together', {
			variable: 'MARIMOHUB_SEARCH_EMBEDDING_URL',
		});
	if (!endpoint || !model) return undefined;
	try {
		return new HttpEmbeddings(endpoint, model, apiKey);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid embedding endpoint';
		if (message === 'Embedding identity exceeds budget')
			throw new ConfigError(
				'MARIMOHUB_SEARCH_EMBEDDING_URL and MARIMOHUB_SEARCH_EMBEDDING_MODEL together exceed the 512-character embedding identity budget',
			);
		throw new ConfigError(message, { variable: 'MARIMOHUB_SEARCH_EMBEDDING_URL' });
	}
}
