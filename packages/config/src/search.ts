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
	const apiKey = env.MARIMOHUB_SEARCH_EMBEDDING_API_KEY;
	if (apiKey && !env.MARIMOHUB_SEARCH_EMBEDDING_URL && !env.MARIMOHUB_SEARCH_EMBEDDING_MODEL)
		throw new ConfigError('Embedding API key requires an embedding URL and model', {
			variable: 'MARIMOHUB_SEARCH_EMBEDDING_API_KEY',
		});
	if (backend === 'off') return undefined;
	const revision = Number(env.MARIMOHUB_SEARCH_BUILD_REVISION ?? '1');
	if (!Number.isSafeInteger(revision) || revision < 1)
		throw new ConfigError('Search build revision must be a positive safe integer', {
			variable: 'MARIMOHUB_SEARCH_BUILD_REVISION',
		});
	const endpoint = env.MARIMOHUB_SEARCH_EMBEDDING_URL;
	const model = env.MARIMOHUB_SEARCH_EMBEDDING_MODEL;
	if (Boolean(endpoint) !== Boolean(model))
		throw new ConfigError('Embedding URL and model must be configured together', {
			variable: 'MARIMOHUB_SEARCH_EMBEDDING_URL',
		});
	const embeddings = endpoint && model ? new HttpEmbeddings(endpoint, model, apiKey) : undefined;
	const authz = new AuthorizationService(deps.policy, deps.resourceSecurity);
	const { catalog, projects, notebooks } = deps.services;
	const sources: SearchSource[] = [new NotebookSource(deps.bucket, catalog, notebooks, authz)];
	if (deps.integrations)
		sources.push(new IntegrationSource(deps.integrations, authz, Boolean(deps.dataBrowser)));
	const index = new BucketSearchIndex(deps.bucket);
	return {
		service: new SearchService(index, sources, catalog, projects, authz, embeddings),
		indexer: new SearchIndexer(
			deps.bucket,
			index,
			sources,
			catalog,
			projects,
			embeddings,
			revision,
		),
	};
}
