import { queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { appQueryOptions } from './apps';
import { apiClient, apiData } from './client';
import { projectKeys } from './queryKeys';
import {
	projectQueryOptions,
	projectsQueryOptions,
	projectSessionsQueryOptions,
	notebooksQueryOptions,
} from './hooks';
import { readListFilters } from '@/lib/listFilters';

export const NOTEBOOK_STATUS_FILTERS = [
	{ value: 'active', label: 'Active' },
	{ value: 'draft', label: 'Draft' },
	{ value: 'archived', label: 'Archived' },
	{ value: 'deleted', label: 'Deleted' },
] as const;

export function prefetchProjectSource(client: QueryClient, pid: string, search: string) {
	const filters = readListFilters(new URLSearchParams(search), NOTEBOOK_STATUS_FILTERS);
	void client.prefetchQuery(projectSessionsQueryOptions(pid));
	return Promise.all([
		client.prefetchQuery(projectQueryOptions(pid)),
		client.prefetchInfiniteQuery(notebooksQueryOptions(pid, filters)),
	]);
}

export function prefetchAppEntry(client: QueryClient, pid: string, nid: string) {
	return Promise.all([
		client.prefetchQuery(projectQueryOptions(pid)),
		client.prefetchQuery(appQueryOptions(pid, nid)),
	]);
}

export function projectRosterQueryOptions() {
	return queryOptions({
		...projectsQueryOptions({ status: 'active' }),
		staleTime: 5 * 60_000,
	});
}

export function firstProjectQueryOptions() {
	return queryOptions({
		queryKey: [...projectKeys.list(), 'first-active'],
		staleTime: 60_000,
		queryFn: async () =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects', {
						params: { query: { status: 'active', limit: 1 } },
					}),
				)
			).items[0] ?? null,
	});
}
