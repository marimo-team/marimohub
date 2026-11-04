import { apiClient, apiData } from './client';
import { useApiMutation } from './mutation';
import { projectThumbnailsKey, thumbnailKey } from './thumbnails';
import { appKeys, jobKeys, notebookKeys, previewKeys, projectKeys } from './queryKeys';

export function useMoveNotebook(projectId: string) {
	return useApiMutation(
		(input: {
			notebookId: string;
			destination: string;
			updatedAt: string;
			idempotencyKey: string;
		}) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/move', {
					params: {
						path: { pid: projectId, nid: input.notebookId },
						header: { 'idempotency-key': input.idempotencyKey, 'if-match': `"${input.updatedAt}"` },
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
	);
}
