import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiClient, apiData } from './client';

export function useAppsQuery(projectId?: string, search = '') {
	return useInfiniteQuery({
		queryKey: ['apps', 'list', projectId, search],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/apps', {
					params: { query: { project_id: projectId, q: search || undefined, cursor: pageParam } },
					signal,
				}),
			),
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useAppQuery(pid: string, nid: string) {
	return useQuery({
		queryKey: ['apps', 'detail', pid, nid],
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/app', {
					params: { path: { pid, nid } },
					signal,
				}),
			),
		staleTime: 0,
	});
}
