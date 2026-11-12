import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, apiData } from './client';

const key = ['github-account'] as const;
export function useGitHubAccount(enabled = true) {
	return useQuery({
		queryKey: key,
		enabled,
		queryFn: ({ signal }) => apiData(apiClient.GET('/api/v1/me/github', { signal })),
		retry: false,
	});
}
export function useConnectGitHub() {
	return useMutation({
		mutationFn: () => apiData(apiClient.POST('/api/v1/me/github/connect')),
		onSuccess: ({ url }) => {
			window.location.assign(url);
		},
	});
}
export function useDisconnectGitHub() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () => apiData(apiClient.DELETE('/api/v1/me/github')),
		onSuccess: () => client.invalidateQueries({ queryKey: key }),
	});
}
