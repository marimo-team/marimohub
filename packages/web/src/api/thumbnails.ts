import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, apiData, apiErrorFromResponse } from './client';
import { withBasePath } from '@/lib/basePath';

export const thumbnailKey = (pid: string, nid: string) => ['thumbnail', pid, nid] as const;
export const thumbnailUrl = (pid: string, nid: string) =>
	withBasePath(
		`/api/v1/projects/${encodeURIComponent(pid)}/notebooks/${encodeURIComponent(nid)}/thumbnail`,
	);

export function useThumbnail(pid: string, nid: string, enabled = true) {
	return useQuery({
		queryKey: thumbnailKey(pid, nid),
		enabled,
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/thumbnail', {
					params: { path: { pid, nid } },
				}),
			),
	});
}

export function useSaveThumbnail(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: async (image: Blob | null) => {
			const response = await fetch(thumbnailUrl(pid, nid), {
				method: image ? 'PUT' : 'DELETE',
				credentials: 'same-origin',
				...(image ? { body: image, headers: { 'Content-Type': 'image/png' } } : {}),
			});
			if (!response.ok) throw await apiErrorFromResponse(response, 'Could not save thumbnail');
			return response.json();
		},
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: thumbnailKey(pid, nid) });
		},
	});
}
