import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { projectQueryOptions } from './hooks';
import { apiClient, apiData } from './client';
import { appKeys } from './queryKeys';

export const deepLinkKeys = {
	resolve: (slug: string) => ['deep-links', 'resolve', slug] as const,
	list: (pid: string, nid: string) => ['deep-links', 'list', pid, nid] as const,
};

function resolveAppLink(client: QueryClient, slug: string, signal?: AbortSignal) {
	return apiData(
		apiClient.GET('/api/v1/deep-links/{slug}', { params: { path: { slug } }, signal }),
	).then((link) => {
		if (link.app && !signal?.aborted) {
			client.setQueryData(
				appKeys.detail(link.target.project_id, link.target.notebook_id),
				link.app,
			);
			if (link.app.your_role !== 'app-user')
				void client.prefetchQuery(projectQueryOptions(link.target.project_id));
		}
		return link;
	});
}

// Consume boot lookups once: revisiting a slug must resolve its current target.
const bootLookups = new WeakMap<QueryClient, Map<string, ReturnType<typeof resolveAppLink>>>();

export function prefetchAppLink(client: QueryClient, slug: string) {
	const lookups = bootLookups.get(client) ?? new Map();
	bootLookups.set(client, lookups);
	if (!lookups.has(slug)) {
		const pending = resolveAppLink(client, slug);
		lookups.set(slug, pending);
		void pending.catch(() => {});
	}
	return lookups.get(slug)!;
}

function takeBootAppLink(client: QueryClient, slug: string) {
	const lookups = bootLookups.get(client);
	const pending = lookups?.get(slug);
	lookups?.delete(slug);
	return pending;
}

export function useDeepLinkQuery(slug: string) {
	const client = useQueryClient();
	return useQuery({
		queryKey: deepLinkKeys.resolve(slug),
		// Reading context.signal opts into cancellation; boot lookups must survive StrictMode.
		queryFn: (context) =>
			takeBootAppLink(client, slug) ?? resolveAppLink(client, slug, context.signal),
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
