import {
	infiniteQueryOptions,
	useInfiniteQuery,
	useQuery,
	useSuspenseInfiniteQuery,
} from '@tanstack/react-query';
import { apiClient, apiData } from './client';
import { isNotFoundError } from './request';
import { appKeys } from './queryKeys';

function appsQueryOptions(projectId?: string, search = '') {
	return infiniteQueryOptions({
		queryKey: appKeys.list(projectId, search),
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

export function useAppsQuery(projectId?: string, search = '') {
	return useInfiniteQuery(appsQueryOptions(projectId, search));
}

export function useProjectAppsQuery(projectId: string) {
	const options = appsQueryOptions(projectId);
	return useSuspenseInfiniteQuery({
		...options,
		queryFn: async (context) => {
			try {
				return { ...(await options.queryFn!(context)), missing: false };
			} catch (error) {
				if (!isNotFoundError(error)) throw error;
				return { items: [], next_cursor: null, missing: true, project: undefined };
			}
		},
	});
}

export function useAppQuery(
	pid: string,
	nid: string,
	options: {
		refetchIntervalMs?: (error: Error | null) => number | undefined;
	} = {},
) {
	const { refetchIntervalMs } = options;
	return useQuery({
		queryKey: appKeys.detail(pid, nid),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/app', {
					params: { path: { pid, nid } },
					signal,
				}),
			),
		// Short enough that role changes surface on a later visit, without refetching on
		// every focus and remount.
		staleTime: 30_000,
		refetchInterval: refetchIntervalMs && ((query) => refetchIntervalMs(query.state.error)),
	});
}
