import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@marimo-hub/client';
import { apiClient, apiData } from './client';
import { previewKeys } from './queryKeys';

export type NotebookPreview = components['schemas']['NotebookPreview'];
export function hasNotebookPreviews(
	capabilities: { source_control?: { preview_providers?: string[] } } | undefined,
): boolean {
	return capabilities?.source_control?.preview_providers?.includes('github') ?? false;
}
export type PreviewInput = {
	name: string;
	source: { type: 'branch'; branch: string } | { type: 'commit'; commit: string };
	compute_profile?: string;
	expires_at?: string;
	pull_request?: number;
};
export function usePreviewsQuery(pid: string, nid: string) {
	return useQuery({
		queryKey: previewKeys.list(pid, nid),
		queryFn: async ({ signal }) =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/previews', {
						params: { path: { pid, nid } },
						signal,
					}),
				)
			).items,
		refetchInterval: 15_000,
		gcTime: 0,
	});
}
export function usePreviewQuery(pid: string, nid: string, prid: string) {
	return useQuery({
		queryKey: previewKeys.detail(pid, nid, prid),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/previews/{prid}', {
					params: { path: { pid, nid, prid } },
					signal,
				}),
			),
		refetchInterval: 15_000,
		retry: false,
		gcTime: 0,
	});
}
export function useCreatePreview(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: PreviewInput & { requestKey: string }) => {
			const { requestKey, ...body } = input;
			return apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/previews', {
					params: { path: { pid, nid } },
					headers: { 'Idempotency-Key': requestKey },
					body,
				}),
			);
		},
		onSuccess: () => client.invalidateQueries({ queryKey: previewKeys.list(pid, nid) }),
	});
}
export function useDeletePreview(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (prid: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/previews/{prid}', {
					params: { path: { pid, nid, prid } },
				}),
			),
		onSuccess: (_data, prid) =>
			Promise.all([
				client.invalidateQueries({ queryKey: previewKeys.list(pid, nid) }),
				client.invalidateQueries({ queryKey: previewKeys.detail(pid, nid, prid) }),
			]),
	});
}
