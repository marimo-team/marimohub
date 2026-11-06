import type { QueryClient } from '@tanstack/react-query';
import type { ProjectSummary } from '@/types';
import { apiClient, apiData } from './client';
import { useApiMutation } from './mutation';
import { projectThumbnailsKey, thumbnailKey } from './thumbnails';
import { appKeys, jobKeys, notebookKeys, previewKeys, projectKeys } from './queryKeys';

export function useMoveNotebook(projectId: string) {
	return useApiMutation(
		(input: { notebookId: string; destination: string; updatedAt: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/move', {
					params: {
						path: { pid: projectId, nid: input.notebookId },
						header: { 'if-match': `"${input.updatedAt}"` },
					},
					body: { destination_project_id: input.destination },
				}),
			),
		(input) => [
			projectKeys.all,
			notebookKeys.all,
			jobKeys.all,
			previewKeys.all,
			appKeys.all,
			['workspace-search'],
			projectThumbnailsKey(projectId),
			projectThumbnailsKey(input.destination),
			thumbnailKey(projectId, input.notebookId),
			thumbnailKey(input.destination, input.notebookId),
		],
		{ suppressErrorToast: true },
	);
}

export function useCancelNotebookMove(projectId: string) {
	return useApiMutation(
		(input: { notebookId: string; destination: string }) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/move', {
					params: { path: { pid: projectId, nid: input.notebookId } },
				}),
			),
		(input) => [
			notebookKeys.all,
			projectKeys.detail(projectId),
			projectKeys.detail(input.destination),
		],
	);
}

/** Reads any project roster already in the cache, so naming a destination costs no request. */
export function cachedProjectName(queryClient: QueryClient, projectId: string): string | undefined {
	for (const [, data] of queryClient.getQueriesData({ queryKey: projectKeys.list() })) {
		if (!Array.isArray(data)) continue;
		const match = (data as ProjectSummary[]).find((project) => project.id === projectId);
		if (match) return match.name;
	}
	return undefined;
}
