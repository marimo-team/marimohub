import { useEffect } from 'react';
import type { InfiniteData } from '@tanstack/react-query';
import {
	infiniteQueryOptions,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
	useSuspenseInfiniteQuery,
} from '@tanstack/react-query';
import { apiClient, apiData } from './client';
import { isNotFoundError } from './request';
import { appKeys } from './queryKeys';

function fetchAppsPage(
	projectId: string | undefined,
	search: string,
	cursor: string | undefined,
	signal: AbortSignal,
) {
	return apiData(
		apiClient.GET('/api/v1/apps', {
			params: { query: { project_id: projectId, q: search || undefined, cursor } },
			signal,
		}),
	);
}

function appsQueryOptions(projectId?: string, search = '') {
	return infiniteQueryOptions({
		queryKey: appKeys.list(projectId, search),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => fetchAppsPage(projectId, search, pageParam, signal),
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
}

export function useAppsQuery(projectId?: string, search = '') {
	return useInfiniteQuery(appsQueryOptions(projectId, search));
}

type ProjectAccessPage = Awaited<ReturnType<typeof fetchAppsPage>> & { missing: boolean };

export function useProjectAppsQuery(projectId: string) {
	const client = useQueryClient();
	const query = useSuspenseInfiniteQuery({
		queryKey: appKeys.projectAccess(projectId),
		initialPageParam: undefined as string | undefined,
		staleTime: 60_000,
		queryFn: async ({ pageParam, signal }): Promise<ProjectAccessPage> => {
			try {
				const page = await fetchAppsPage(projectId, '', pageParam, signal);
				// An app-user redirect can reuse the authorized list, but never the missing sentinel.
				if (
					!signal.aborted &&
					pageParam === undefined &&
					client.getQueryData(appKeys.list(projectId)) === undefined
				)
					client.setQueryData(appKeys.list(projectId), { pages: [page], pageParams: [undefined] });
				return { ...page, missing: false };
			} catch (error) {
				if (!isNotFoundError(error)) throw error;
				return { items: [], next_cursor: null, missing: true, project: undefined };
			}
		},
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	useEffect(
		() => () => {
			// StrictMode restores observers before this runs; only discard an abandoned negative result.
			queueMicrotask(() => {
				const key = appKeys.projectAccess(projectId);
				const cached = client
					.getQueryCache()
					.find<InfiniteData<ProjectAccessPage>>({ queryKey: key, exact: true });
				if (cached?.getObserversCount() === 0 && cached.state.data?.pages[0].missing)
					client.removeQueries({ queryKey: key, exact: true });
			});
		},
		[client, projectId],
	);
	return query;
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
