import { useQuery } from '@tanstack/react-query';
import type { paths } from '@marimo-hub/client';
import { apiClient, apiData } from './client';

type SearchOperation = paths['/api/v1/search']['get'];
export type SearchResponse =
	SearchOperation['responses'][200]['content']['application/json']['data'];
export type SearchHit = SearchResponse['items'][number];
export type SearchKind = SearchHit['kind'];
export type SearchQuery = NonNullable<SearchOperation['parameters']['query']>;

export function useWorkspaceSearch(
	query: SearchQuery,
	userId: string | undefined,
	enabled: boolean,
) {
	return useQuery({
		queryKey: ['workspace-search', userId, enabled ? query : null],
		queryFn: ({ signal }) =>
			apiData(apiClient.GET('/api/v1/search', { params: { query }, signal })),
		enabled: Boolean(userId) && enabled,
		// Search results must be reauthorized on revisits, including browser history.
		gcTime: 0,
		staleTime: 0,
		retry: false,
		throwOnError: false,
	});
}
