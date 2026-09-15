import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, apiData } from './client';

export const deepLinkKeys = {
	resolve: (slug: string) => ['deep-links', 'resolve', slug] as const,
	list: (pid: string, nid: string) => ['deep-links', 'list', pid, nid] as const,
};

export function useDeepLinkQuery(slug: string) {
	return useQuery({
		queryKey: deepLinkKeys.resolve(slug),
		queryFn: ({ signal }) =>
			apiData(apiClient.GET('/api/v1/deep-links/{slug}', { params: { path: { slug } }, signal })),
		staleTime: 0,
		gcTime: 0,
	});
}

export function useDeepLinksQuery(pid: string, nid: string) {
	return useQuery({
		queryKey: deepLinkKeys.list(pid, nid),
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/deep-links', {
					params: { path: { pid, nid } },
					signal,
				}),
			),
		staleTime: 0,
		gcTime: 0,
	});
}

export function useRegisterDeepLink(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		meta: { suppressErrorToast: true },
		mutationFn: (slug: string) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/deep-links', {
					params: { path: { pid, nid } },
					body: { slug },
				}),
			),
		onSuccess: () => client.invalidateQueries({ queryKey: ['deep-links'] }),
	});
}

export function useReleaseDeepLink(pid: string, nid: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ slug, registration_id }: { slug: string; registration_id: string }) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/deep-links/{slug}', {
					params: { path: { pid, nid, slug }, query: { registration_id } },
				}),
			),
		onSuccess: () => client.invalidateQueries({ queryKey: ['deep-links'] }),
	});
}
