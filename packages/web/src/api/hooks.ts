import {
	useInfiniteQuery,
	useQuery,
	useSuspenseQuery,
	useMutation,
	keepPreviousData,
} from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { apiClient, apiData, apiDataWithResponse, apiErrorFromResponse } from './client';
import { useApiMutation, useInvalidate } from './mutation';
import { isApiErrorCode, isNotFoundError, notebookPath } from './request';
import { sanitizeFilename, triggerDownload } from '../lib/download';
import {
	userKeys,
	projectKeys,
	notebookKeys,
	sessionKeys,
	systemKeys,
	integrationKeys,
	browseKeys,
	auditKeys,
	adminKeys,
} from './queryKeys';
import type { AuditLogFilters } from './queryKeys';
import type {
	AssignableProjectRole,
	AdminUser,
	IntegrationEntry,
	NotebookChangeRequest,
	NotebookDetail,
	ResolvedUser,
	ProjectFederation,
	ProjectAlertKind,
} from '../types';

/** How often the notebook table re-polls runtime status, in ms. */
const SESSIONS_POLL_INTERVAL_MS = 5_000;

/**
 * Deployment-scoped facts (identity, version, capabilities): fixed for the life
 * of a page load, so they are held fresh forever and a failure is not retried —
 * the dependent UI just renders nothing rather than spamming the endpoint.
 */
const IMMUTABLE_QUERY = { staleTime: Number.POSITIVE_INFINITY, retry: false } as const;

export type { AuditLogFilters } from './queryKeys';

export function useAuditLogsQuery(filters: AuditLogFilters) {
	return useInfiniteQuery({
		queryKey: auditKeys.list(filters),
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			apiData(
				apiClient.GET('/api/v1/events', {
					params: {
						query: {
							from: filters.from,
							to: filters.to,
							limit: 50,
							...(pageParam ? { cursor: pageParam } : {}),
							...(filters.event ? { event: filters.event } : {}),
							...(filters.actor ? { actor: filters.actor } : {}),
							...(filters.projectId ? { project_id: filters.projectId } : {}),
						},
					},
				}),
			),
		getNextPageParam: (lastPage) => lastPage.next_cursor,
	});
}

// Auth
export function useUserQuery() {
	return useQuery({
		queryKey: userKeys.me(),
		queryFn: () => apiData(apiClient.GET('/api/v1/me')),
		...IMMUTABLE_QUERY,
	});
}

// Personal access tokens (self-service, on the account menu)

/** The caller's API tokens, newest first — metadata only, never a secret. */
export function useApiTokensQuery(enabled = true) {
	return useQuery({
		queryKey: userKeys.tokens(),
		queryFn: () => apiData(apiClient.GET('/api/v1/me/tokens')),
		enabled,
	});
}

/** Mint a token. The response's `token` is shown once and never retrievable again. */
export function useCreateApiToken() {
	return useApiMutation(
		(body: { name: string; expires_in_days?: number }) =>
			apiData(apiClient.POST('/api/v1/me/tokens', { body })),
		() => [userKeys.tokens()],
	);
}

export function useRevokeApiToken() {
	return useApiMutation(
		(tokenId: string) =>
			apiData(
				apiClient.DELETE('/api/v1/me/tokens/{tokenId}', {
					params: { path: { tokenId } },
				}),
			),
		() => [userKeys.tokens()],
	);
}

// System

/** Deployment metadata for the footer info popover. */
export function useVersionQuery() {
	return useQuery({
		queryKey: systemKeys.version(),
		queryFn: () => apiData(apiClient.GET('/api/v1/version')),
		...IMMUTABLE_QUERY,
	});
}

/**
 * Deployment capability flags (e.g. whether WIF is configured). Never throws
 * into the error boundary: consumers (NotebookPage, Project) deliberately treat
 * a failed probe as "grant nothing" rather than crashing the page.
 */
export function useCapabilitiesQuery(enabled = true) {
	return useQuery({
		queryKey: systemKeys.capabilities(),
		queryFn: () => apiData(apiClient.GET('/api/v1/capabilities')),
		enabled,
		...IMMUTABLE_QUERY,
	});
}

/** A map of user id → resolved identity. Unknown ids are simply absent. */
export type UserDirectory = Record<string, ResolvedUser>;

/**
 * Resolve a set of opaque user ids (notebook `author`, session `user_id`) into
 * `{ id, email, name }` for display. Ids are deduped + sorted so the query key
 * (and cache entry) is stable regardless of input ordering; the query is
 * disabled when there is nothing to resolve. Identities change rarely, so the
 * result is held fresh for a while to avoid re-fetching as rows re-render.
 */
export function useUsersQuery(ids: readonly (string | undefined)[]) {
	const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
	return useQuery({
		queryKey: userKeys.resolve(unique),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/users', {
					params: { query: { ids: unique.join(',') } },
				}),
			),
		enabled: unique.length > 0,
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * Search the user directory (email/name/id substring) for the add-member
 * picker. Disabled below two characters; previous results are kept while a new
 * query is in flight so the option list doesn't flicker as the user types.
 */
export function useUserSearchQuery(query: string) {
	const q = query.trim();
	return useQuery({
		queryKey: userKeys.search(q),
		queryFn: () => apiData(apiClient.GET('/api/v1/users/search', { params: { query: { q } } })),
		enabled: q.length >= 2,
		staleTime: 30 * 1000,
		placeholderData: keepPreviousData,
	});
}

// Admin (super-admin pages)

/** The full user directory (everyone who has signed in at least once), name-sorted. */
export function useAdminUsersQuery() {
	return useSuspenseQuery({
		queryKey: adminKeys.users(),
		queryFn: async () => (await apiData(apiClient.GET('/api/v1/admin/users'))).items,
	});
}

export function useSetUserSuspension() {
	return useApiMutation(
		({ userId, suspended }: { userId: string; suspended: boolean }): Promise<AdminUser> =>
			suspended
				? apiData(
						apiClient.PUT('/api/v1/users/{id}/suspension', {
							params: { path: { id: userId } },
						}),
					)
				: apiData(
						apiClient.DELETE('/api/v1/users/{id}/suspension', {
							params: { path: { id: userId } },
						}),
					),
		() => [adminKeys.users()],
	);
}

/** The deployment's configuration, grouped per the config spec, secrets redacted server-side. */
export function useDeploymentConfigQuery() {
	return useSuspenseQuery({
		queryKey: adminKeys.config(),
		queryFn: () => apiData(apiClient.GET('/api/v1/admin/config')),
	});
}

// Projects
export function useProjectsQuery() {
	return useSuspenseQuery({
		queryKey: projectKeys.list(),
		queryFn: async () => (await apiData(apiClient.GET('/api/v1/projects'))).items,
	});
}

export function useProjectQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: projectKeys.detail(projectId),
		// Full project meta (incl. `federation`), not the snapshot summary the list returns.
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}', {
					params: { path: { pid: projectId } },
				}),
			),
	});
}

export function useCreateProject() {
	return useApiMutation(
		(body: { name: string; description: string }) =>
			apiData(apiClient.POST('/api/v1/projects', { body })),
		() => [projectKeys.list()],
	);
}

export function useUpdateProject() {
	return useApiMutation(
		// Partial update: callers send only the fields they change.
		({
			projectId,
			...body
		}: {
			projectId: string;
			name?: string;
			description?: string;
			tags?: string[];
			federation?: ProjectFederation;
		}) =>
			apiData(
				apiClient.PATCH('/api/v1/projects/{pid}', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		({ projectId }) => [projectKeys.list(), projectKeys.detail(projectId)],
	);
}

export function useDeleteProject() {
	return useApiMutation(
		(projectId: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}', {
					params: { path: { pid: projectId } },
				}),
			),
		() => [projectKeys.list()],
	);
}

export type CreateProjectAlertDestination =
	| { name: string; type: 'slack'; kinds: ProjectAlertKind[]; webhook_url: string }
	| {
			name: string;
			type: 'webhook';
			kinds: ProjectAlertKind[];
			url: string;
			signing_secret: string;
	  };

export function useProjectAlertsQuery(projectId: string, enabled = true) {
	return useQuery({
		queryKey: projectKeys.alerts(projectId),
		queryFn: async () =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects/{pid}/alert-destinations', {
						params: { path: { pid: projectId } },
					}),
				)
			).items,
		enabled,
	});
}

export function useCreateProjectAlert(projectId: string) {
	return useApiMutation(
		(body: CreateProjectAlertDestination) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/alert-destinations', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => [projectKeys.alerts(projectId)],
	);
}

export function useUpdateProjectAlert(projectId: string) {
	return useApiMutation(
		({
			id,
			updatedAt,
			...body
		}: {
			id: string;
			updatedAt: string;
			name?: string;
			kinds?: ProjectAlertKind[];
			enabled?: boolean;
			webhook_url?: string;
			url?: string;
			signing_secret?: string;
		}) =>
			apiData(
				apiClient.PATCH('/api/v1/projects/{pid}/alert-destinations/{aid}', {
					params: {
						path: { pid: projectId, aid: id },
						header: { 'if-match': updatedAt },
					},
					body,
				}),
			),
		() => [projectKeys.alerts(projectId)],
	);
}

export function useDeleteProjectAlert(projectId: string) {
	return useApiMutation(
		({ id, updatedAt }: { id: string; updatedAt: string }) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/alert-destinations/{aid}', {
					params: {
						path: { pid: projectId, aid: id },
						header: { 'if-match': updatedAt },
					},
				}),
			),
		() => [projectKeys.alerts(projectId)],
	);
}

export function useTestProjectAlert(projectId: string) {
	return useApiMutation(
		({ id, updatedAt }: { id: string; updatedAt: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/alert-destinations/{aid}/test', {
					params: {
						path: { pid: projectId, aid: id },
						header: { 'if-match': updatedAt },
					},
				}),
			),
		() => [projectKeys.alerts(projectId)],
	);
}

// Project members
export function useProjectMembersQuery(projectId: string) {
	return useQuery({
		queryKey: projectKeys.members(projectId),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/members', {
					params: { path: { pid: projectId } },
				}),
			),
	});
}

/** A project's member list and its detail both carry membership — drop both. */
const memberKeys = (projectId: string) => [
	projectKeys.members(projectId),
	projectKeys.detail(projectId),
];

export function useAddMember(projectId: string) {
	return useApiMutation(
		// Exactly one of user_id / email, enforced server-side (422).
		(body: { user_id?: string; email?: string; role: AssignableProjectRole }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/members', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => memberKeys(projectId),
	);
}

export function useUpdateMemberRole(projectId: string) {
	return useApiMutation(
		({ uid, role }: { uid: string; role: AssignableProjectRole }) =>
			apiData(
				apiClient.PUT('/api/v1/projects/{pid}/members/{uid}', {
					params: { path: { pid: projectId, uid } },
					body: { role },
				}),
			),
		() => memberKeys(projectId),
	);
}

export function useRemoveMember(projectId: string) {
	return useApiMutation(
		(uid: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/members/{uid}', {
					params: { path: { pid: projectId, uid } },
				}),
			),
		() => memberKeys(projectId),
	);
}

// Integrations

/** A 404 from the integrations routes means the deployment has them disabled. */
export function isIntegrationsDisabledError(err: unknown): boolean {
	return isApiErrorCode(err, 'NOT_FOUND');
}

/** Static kind catalog, or `null` when integrations are disabled. */
export function useIntegrationKindsQuery(enabled = true) {
	return useQuery({
		queryKey: integrationKeys.kinds(),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		queryFn: async () => {
			try {
				return await apiData(apiClient.GET('/api/v1/integrations/kinds'));
			} catch (err) {
				if (isIntegrationsDisabledError(err)) return null;
				throw err;
			}
		},
	});
}

export type IntegrationsScope = { pid: string } | 'org';

function integrationsListKey(scope: IntegrationsScope) {
	return scope === 'org' ? integrationKeys.org() : projectKeys.integrations(scope.pid);
}

interface CursorPage<T> {
	items: T[];
	next_cursor: string | null;
}

async function listAllCursorPages<T>(
	loadPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
	repeatedCursorMessage: string,
): Promise<T[]> {
	const items: T[] = [];
	const followed = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await loadPage(cursor);
		items.push(...page.items);
		cursor = page.next_cursor ?? undefined;
		if (cursor !== undefined) {
			if (followed.has(cursor)) throw new Error(repeatedCursorMessage);
			followed.add(cursor);
		}
	} while (cursor !== undefined);
	return items;
}

async function listAllIntegrations(scope: IntegrationsScope): Promise<IntegrationEntry[]> {
	return listAllCursorPages(async (cursor) => {
		const query = { limit: 500, ...(cursor ? { cursor } : {}) };
		return apiData(
			scope === 'org'
				? apiClient.GET('/api/v1/org/integrations', { params: { query } })
				: apiClient.GET('/api/v1/projects/{pid}/integrations', {
						params: { path: { pid: scope.pid }, query },
					}),
		);
	}, 'Integration listing did not advance; refusing a partial result.');
}

/**
 * Keys stale after any mutation in the scope. Org changes also invalidate every
 * project's list — inherited entries are embedded there. Browse results are
 * derived from the mutated config (names, capability, snippets), so they go
 * stale too: project-wide for a project mutation, everywhere for an org one
 * (inherited instances are browsable from every project).
 */
function integrationsInvalidations(scope: IntegrationsScope, integrationId?: string) {
	const detail =
		integrationId === undefined
			? []
			: [
					scope === 'org'
						? integrationKeys.orgDetail(integrationId)
						: projectKeys.integration(scope.pid, integrationId),
				];
	return scope === 'org'
		? [integrationKeys.org(), [...projectKeys.all, 'integrations'], browseKeys.all, ...detail]
		: [projectKeys.integrations(scope.pid), [...browseKeys.all, scope.pid], ...detail];
}

/** Returns `null` when integrations are disabled for this deployment. */
export function useIntegrationsQuery(scope: IntegrationsScope, enabled = true) {
	return useQuery({
		queryKey: integrationsListKey(scope),
		enabled,
		retry: (count, err) => !isIntegrationsDisabledError(err) && count < 2,
		queryFn: async () => {
			try {
				return await listAllIntegrations(scope);
			} catch (err) {
				if (isIntegrationsDisabledError(err)) return null;
				throw err;
			}
		},
	});
}

/** Fetches the current config with secret fields redacted. */
export function useIntegrationDetailQuery(scope: IntegrationsScope, integrationId?: string) {
	return useQuery({
		queryKey:
			scope === 'org'
				? integrationKeys.orgDetail(integrationId ?? '')
				: projectKeys.integration(scope.pid, integrationId ?? ''),
		enabled: Boolean(integrationId),
		queryFn: async () => {
			const iid = integrationId ?? '';
			const result = await apiDataWithResponse(
				scope === 'org'
					? apiClient.GET('/api/v1/org/integrations/{iid}', { params: { path: { iid } } })
					: apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}', {
							params: { path: { pid: scope.pid, iid } },
						}),
			);
			return {
				detail: result.data,
				etag: result.response.headers.get('etag') ?? undefined,
			};
		},
	});
}

export function useCreateIntegration(scope: IntegrationsScope) {
	return useApiMutation(
		(body: { kind: string; name: string; config: Record<string, unknown> }) =>
			apiData(
				scope === 'org'
					? apiClient.POST('/api/v1/org/integrations', { body })
					: apiClient.POST('/api/v1/projects/{pid}/integrations', {
							params: { path: { pid: scope.pid } },
							body,
						}),
			),
		() => integrationsInvalidations(scope),
	);
}

export function useUpdateIntegration(scope: IntegrationsScope) {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({
			id,
			etag,
			...body
		}: {
			id: string;
			etag?: string;
			name?: string;
			enabled?: boolean;
			config?: Record<string, unknown>;
			change_note?: string;
		}) =>
			apiData(
				scope === 'org'
					? apiClient.PATCH('/api/v1/org/integrations/{iid}', {
							params: { path: { iid: id }, header: etag ? { 'if-match': etag } : {} },
							body,
						})
					: apiClient.PATCH('/api/v1/projects/{pid}/integrations/{iid}', {
							params: {
								path: { pid: scope.pid, iid: id },
								header: etag ? { 'if-match': etag } : {},
							},
							body,
						}),
			),
		onSuccess: (_data, variables) => invalidate(...integrationsInvalidations(scope, variables.id)),
		onError: (err, variables) => {
			// A 412 means the cached ETag is stale. Refetch so the "reload and try
			// again" guidance in the toast is a re-render away, not a re-open.
			if (isApiErrorCode(err, 'PRECONDITION_FAILED')) {
				invalidate(...integrationsInvalidations(scope, variables.id));
			}
		},
	});
}

export function useDeleteIntegration(scope: IntegrationsScope) {
	return useApiMutation(
		(id: string) =>
			apiData(
				scope === 'org'
					? apiClient.DELETE('/api/v1/org/integrations/{iid}', { params: { path: { iid: id } } })
					: apiClient.DELETE('/api/v1/projects/{pid}/integrations/{iid}', {
							params: { path: { pid: scope.pid, iid: id } },
						}),
			),
		() => integrationsInvalidations(scope),
	);
}

/** Copies an integration; the server re-encrypts inline values and preserves references. */
export function useCopyIntegration(projectId: string) {
	return useApiMutation(
		(body: { source_project_id: string; source_integration_id: string; name?: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/copy', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => [projectKeys.integrations(projectId)],
	);
}

/**
 * Non-suspense project list for pickers rendered inside dialogs. Walks every
 * page (unlike the first-page home list) so the roster is COMPLETE — a
 * truncated result would silently hide older projects from the picker. The
 * loop is bounded by a cycle guard instead of a page cap: a repeated cursor
 * (the realistic paging bug) fails the query loudly rather than truncating.
 */
export function useProjectPickerQuery(enabled: boolean) {
	return useQuery({
		queryKey: projectKeys.pickerList(),
		enabled,
		queryFn: () =>
			listAllCursorPages(
				(cursor) =>
					apiData(
						apiClient.GET('/api/v1/projects', {
							params: { query: { limit: 500, ...(cursor ? { cursor } : {}) } },
						}),
					),
				'Project listing did not advance; refusing a partial roster.',
			),
	});
}

/** Non-suspense project detail, used to check the caller's role before copying. */
export function useProjectRoleQuery(projectId: string | undefined) {
	return useQuery({
		queryKey: projectKeys.detail(projectId ?? ''),
		enabled: Boolean(projectId),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}', { params: { path: { pid: projectId ?? '' } } }),
			),
	});
}

/** Tests either an unsaved config or a stored integration by id. */
export function useTestIntegration(scope: IntegrationsScope) {
	return useMutation({
		mutationFn: (
			body:
				| { source: 'draft'; kind: string; config: Record<string, unknown>; id?: string }
				| { source: 'stored'; id: string },
		) =>
			apiData(
				scope === 'org'
					? apiClient.POST('/api/v1/org/integrations/test', { body })
					: apiClient.POST('/api/v1/projects/{pid}/integrations/test', {
							params: { path: { pid: scope.pid } },
							body,
						}),
			),
	});
}

// Data browser (read-only catalog metadata over an integration)

/**
 * Multi-part namespaces ride in one query param, parts joined by U+001F — the
 * separator the API defines, so namespace parts containing dots round-trip.
 */
const NAMESPACE_JOINER = '\u001f';

/** Server-side TTLs are 60s (lists) / 300s (schemas); mirror them client-side. */
const BROWSE_LIST_STALE_MS = 60_000;
const BROWSE_SCHEMA_STALE_MS = 300_000;

/**
 * While a refresh round is in flight, browse lookups carry `fresh=true`, which
 * makes the server bypass its own metadata cache (and refresh it). A counter,
 * not a boolean, so overlapping rounds cannot reset each other's flag.
 */
let bypassBrowseCache = 0;
const freshQuery = () => (bypassBrowseCache > 0 ? { fresh: 'true' as const } : {});
const browsePath = (projectId: string, integrationId: string) => ({
	pid: projectId,
	iid: integrationId,
});
const cursorQuery = (cursor: string | null): { cursor?: string } => (cursor ? { cursor } : {});
const nextCursor = (page: { next_cursor: string | null }) => page.next_cursor;

/**
 * Client-side mirror of the server's 30 fresh ops/min/user budget, spent in
 * PAGE fetches — refetching an infinite query re-fetches every retained page.
 * Rolling: repeated refreshes within the window share the allowance instead
 * of resetting it, so mashing Refresh cannot fill the tree with 429s.
 */
const FRESH_BUDGET_PER_MINUTE = 30;
const FRESH_WINDOW_MS = 60_000;
const freshSpend: number[] = [];

/** Test hook: forgets fresh-refresh spend so suites stay order-independent. */
export function resetBrowseRefreshBudgetForTests(): void {
	freshSpend.length = 0;
}

/** Server operations a refetch of this query costs (one per retained page). */
function refetchCost(query: { state: { data?: unknown } }): number {
	const data = query.state.data as { pages?: unknown[] } | undefined;
	return Array.isArray(data?.pages) ? Math.max(data.pages.length, 1) : 1;
}

/**
 * Refresh the browse view. Mounted queries refetch with `fresh=true`
 * SEQUENTIALLY while their page cost fits the remaining rolling budget; the
 * overflow refetches without the flag (server-cached, still current within
 * its TTL). Unmounted results (collapsed nodes, other integrations) cannot be
 * refetched, so they are dropped outright: their next expansion fetches
 * instead of replaying a stale client entry.
 */
export async function refreshBrowseQueries(queryClient: QueryClient): Promise<void> {
	queryClient.removeQueries({ queryKey: browseKeys.all, type: 'inactive' });
	const active = queryClient.getQueryCache().findAll({ queryKey: browseKeys.all, type: 'active' });

	const now = Date.now();
	while (freshSpend.length > 0 && now - freshSpend[0] >= FRESH_WINDOW_MS) freshSpend.shift();
	let remaining = FRESH_BUDGET_PER_MINUTE - freshSpend.length;
	const freshRound: typeof active = [];
	const overflow: typeof active = [];
	for (const query of active) {
		// Capability lookups never carry `fresh` (that route is uncached
		// server-side), so charging them would waste budget slots on requests
		// that spend nothing — they just ride the plain round below.
		if (browseKeys.isCapability(query.queryKey)) {
			overflow.push(query);
			continue;
		}
		const cost = refetchCost(query);
		if (cost <= remaining) {
			remaining -= cost;
			freshRound.push(query);
		} else {
			overflow.push(query);
		}
	}

	bypassBrowseCache += 1;
	try {
		for (const query of freshRound) {
			const cost = refetchCost(query);
			await queryClient.refetchQueries({ queryKey: query.queryKey, exact: true });
			const at = Date.now();
			for (let i = 0; i < cost; i++) freshSpend.push(at);
		}
	} finally {
		bypassBrowseCache -= 1;
	}
	await Promise.all(
		overflow.map((query) => queryClient.refetchQueries({ queryKey: query.queryKey, exact: true })),
	);
}

export function useBrowseCapabilityQuery(projectId: string, integrationId: string, enabled = true) {
	return useQuery({
		queryKey: browseKeys.capability(projectId, integrationId),
		enabled,
		staleTime: BROWSE_LIST_STALE_MS,
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse', {
					params: { path: browsePath(projectId, integrationId) },
					signal,
				}),
			),
	});
}

export function useBrowseNamespacesQuery(
	projectId: string,
	integrationId: string,
	parent: readonly string[],
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: browseKeys.namespaces(projectId, integrationId, parent),
		enabled,
		staleTime: BROWSE_LIST_STALE_MS,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/namespaces', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							...(parent.length > 0 ? { parent: parent.join(NAMESPACE_JOINER) } : {}),
							...cursorQuery(pageParam),
							...freshQuery(),
						},
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useBrowseTablesQuery(
	projectId: string,
	integrationId: string,
	namespace: readonly string[],
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: browseKeys.tables(projectId, integrationId, namespace),
		enabled,
		staleTime: BROWSE_LIST_STALE_MS,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/tables', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							namespace: namespace.join(NAMESPACE_JOINER),
							...cursorQuery(pageParam),
							...freshQuery(),
						},
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useBrowseTableSchemaQuery(
	projectId: string,
	integrationId: string,
	namespace: readonly string[],
	table: string,
	enabled = true,
) {
	return useQuery({
		queryKey: browseKeys.schema(projectId, integrationId, namespace, table),
		enabled,
		staleTime: BROWSE_SCHEMA_STALE_MS,
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/schema', {
					params: {
						path: browsePath(projectId, integrationId),
						query: { namespace: namespace.join(NAMESPACE_JOINER), table, ...freshQuery() },
					},
					signal,
				}),
			),
	});
}

function useAbortableBrowseMutation<TInput, TData>(
	run: (input: TInput, signal: AbortSignal) => Promise<TData>,
	identityKey: string,
) {
	const active = useRef<AbortController | undefined>(undefined);
	useEffect(
		() => () => {
			active.current?.abort();
		},
		[identityKey],
	);
	return useMutation({
		mutationFn: (input: TInput) => {
			active.current?.abort();
			const controller = new AbortController();
			active.current = controller;
			return run(input, controller.signal).finally(() => {
				if (active.current === controller) active.current = undefined;
			});
		},
		// Consumers render preview failures inline; aborts (unmount, supersede)
		// must not surface as toasts either.
		meta: { suppressErrorToast: true },
	});
}

export function useBrowseTablePreview(projectId: string, integrationId: string) {
	return useAbortableBrowseMutation(
		(input: { namespace: string[]; table: string; limit?: number }, signal) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/{iid}/browse/preview', {
					params: { path: browsePath(projectId, integrationId) },
					body: input,
					signal,
				}),
			),
		`${projectId}\0${integrationId}`,
	);
}

export function useDataQuerySchemaQuery(
	projectId: string,
	integrationId: string,
	focus?: { namespace: readonly string[]; table: string } | null,
	enabled = true,
) {
	return useQuery({
		queryKey: browseKeys.querySchema(
			projectId,
			integrationId,
			focus?.namespace ?? [],
			focus?.table ?? '',
		),
		enabled,
		staleTime: BROWSE_SCHEMA_STALE_MS,
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/query/schema', {
					params: {
						path: browsePath(projectId, integrationId),
						query: focus
							? {
									focus_namespace: focus.namespace.join(NAMESPACE_JOINER),
									focus_table: focus.table,
								}
							: {},
					},
					signal,
				}),
			),
	});
}

export function useRunDataQuery(projectId: string, integrationId: string) {
	return useMutation({
		mutationFn: ({ sql, signal }: { sql: string; signal?: AbortSignal }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/{iid}/browse/query', {
					params: { path: browsePath(projectId, integrationId) },
					body: { sql },
					signal,
				}),
			),
	});
}

export function useGenerateDataQuerySql(projectId: string, integrationId: string) {
	return useMutation({
		mutationFn: (body: { mode: 'generate' | 'revise'; instruction: string; sql?: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/{iid}/browse/query/generate', {
					params: { path: browsePath(projectId, integrationId) },
					body,
				}),
			),
	});
}

export function useObjectBucketsQuery(projectId: string, integrationId: string, enabled = true) {
	return useInfiniteQuery({
		queryKey: browseKeys.objectBuckets(projectId, integrationId),
		enabled,
		staleTime: BROWSE_LIST_STALE_MS,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/objects/buckets', {
					params: {
						path: browsePath(projectId, integrationId),
						query: { ...cursorQuery(pageParam), ...freshQuery() },
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useObjectsQuery(
	projectId: string,
	integrationId: string,
	bucket: string,
	prefix: string,
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: browseKeys.objects(projectId, integrationId, bucket, prefix),
		enabled: enabled && bucket !== '',
		staleTime: BROWSE_LIST_STALE_MS,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/objects', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							bucket,
							...(prefix ? { prefix } : {}),
							...cursorQuery(pageParam),
							...freshQuery(),
						},
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useObjectSearchQuery(
	projectId: string,
	integrationId: string,
	bucket: string,
	prefix: string,
	query: string,
) {
	return useInfiniteQuery({
		queryKey: browseKeys.objectSearch(projectId, integrationId, bucket, prefix, query),
		enabled: bucket !== '' && query.trim().length >= 2,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/objects/search', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							bucket,
							query: query.trim(),
							...(prefix ? { prefix } : {}),
							...cursorQuery(pageParam),
						},
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useObjectDetailQuery(
	projectId: string,
	integrationId: string,
	bucket: string,
	key: string,
	versionId?: string,
) {
	return useQuery({
		queryKey: browseKeys.objectDetail(projectId, integrationId, bucket, key, versionId),
		enabled: bucket !== '' && key !== '',
		staleTime: BROWSE_LIST_STALE_MS,
		queryFn: ({ signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/objects/head', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							bucket,
							key,
							...(versionId ? { version_id: versionId } : {}),
						},
					},
					signal,
				}),
			),
	});
}

export function useObjectVersionsQuery(
	projectId: string,
	integrationId: string,
	bucket: string,
	key: string,
	enabled = true,
) {
	return useInfiniteQuery({
		queryKey: browseKeys.objectVersions(projectId, integrationId, bucket, key),
		enabled: enabled && bucket !== '' && key !== '',
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}/browse/objects/versions', {
					params: {
						path: browsePath(projectId, integrationId),
						query: {
							bucket,
							key,
							...cursorQuery(pageParam),
						},
					},
					signal,
				}),
			),
		getNextPageParam: nextCursor,
	});
}

export function useObjectPreview(projectId: string, integrationId: string) {
	return useAbortableBrowseMutation(
		(input: { bucket: string; key: string; version_id?: string; limit?: number }, signal) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/{iid}/browse/objects/preview', {
					params: { path: browsePath(projectId, integrationId) },
					body: input,
					signal,
				}),
			),
		`${projectId}\0${integrationId}`,
	);
}

export function objectContentUrl(input: {
	projectId: string;
	integrationId: string;
	bucket: string;
	key: string;
	versionId?: string;
	etag?: string;
	inline?: boolean;
}): string {
	const params = new URLSearchParams({ bucket: input.bucket, key: input.key });
	if (input.versionId) params.set('version_id', input.versionId);
	if (input.etag) params.set('etag', input.etag);
	if (input.inline) params.set('inline', 'true');
	return `/api/v1/projects/${encodeURIComponent(input.projectId)}/integrations/${encodeURIComponent(input.integrationId)}/browse/objects/content?${params}`;
}

// Notebooks

export function useNotebooksQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: notebookKeys.list(projectId),
		queryFn: async () =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects/{pid}/notebooks', {
						params: { path: { pid: projectId } },
					}),
				)
			).items,
	});
}

/**
 * Fetch a single notebook's detail (meta + source). Plain `useQuery` (not
 * suspense) so the notebook page can render its shell — and start the kernel —
 * without blocking on metadata; the "created by" line fills in when it arrives.
 */
export function useNotebookQuery(
	projectId: string,
	notebookId: string,
	// Freshness options for consumers that compare against the notebook HEAD
	// (the staleness banners): versions are committed server-side (snapshotter,
	// teardown, git push), which no client-side invalidation ever observes.
	// `refetchIntervalMs` polls for a long-lived view — pass a function when the
	// interval depends on the fetched detail (e.g. poll only git-synced sources);
	// `staleTime: 0` re-reads on mount instead, for a short-lived one that must
	// not trust the shared cache.
	options: {
		refetchIntervalMs?: number | ((notebook: NotebookDetail | undefined) => number | undefined);
		staleTime?: number;
	} = {},
) {
	const { refetchIntervalMs } = options;
	return useQuery({
		queryKey: notebookKeys.detail(projectId, notebookId),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}', {
					params: { path: { pid: projectId, nid: notebookId } },
				}),
			),
		staleTime: options.staleTime ?? 5 * 60 * 1000,
		refetchInterval:
			typeof refetchIntervalMs === 'function'
				? (query) => refetchIntervalMs(query.state.data)
				: refetchIntervalMs,
	});
}

export function useCreateNotebook(projectId: string) {
	return useApiMutation(
		(body: {
			title: string;
			description: string;
			code: string;
			base_image?: string;
			compute_profile?: string;
		}) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => [notebookKeys.list(projectId)],
	);
}

/**
 * Duplicate a notebook into a fresh local copy in the same project. The server
 * defaults the title to `"<title> (copy)"` when none is given; git-synced
 * notebooks are copied as detached local notebooks.
 */
export function useDuplicateNotebook(projectId: string) {
	return useApiMutation(
		({ notebookId, title }: { notebookId: string; title?: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/duplicate', {
					params: { path: { pid: projectId, nid: notebookId } },
					body: title ? { title } : {},
				}),
			),
		() => [notebookKeys.list(projectId)],
	);
}

/** Create a git-synced notebook; the response carries its write-once sync token. */
export function useCreateSyncedNotebook(projectId: string) {
	return useApiMutation(
		(body: {
			title: string;
			description: string;
			repo: string;
			branch: string;
			root_path?: string;
			entry_notebook: string;
		}) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/git', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => [notebookKeys.list(projectId)],
	);
}

/** Rotate a synced notebook's sync token, invalidating the old one. */
export function useRotateSyncToken(projectId: string) {
	return useMutation({
		mutationFn: (notebookId: string) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sync-token/rotate', {
					params: { path: { pid: projectId, nid: notebookId } },
				}),
			),
	});
}

export function useUpdateGitSource(projectId: string) {
	return useApiMutation(
		({
			notebookId,
			...body
		}: {
			notebookId: string;
			repo: string;
			branch: string;
			root_path: string;
			entry_notebook: string;
		}) =>
			apiData(
				apiClient.PATCH('/api/v1/projects/{pid}/notebooks/{nid}/source', {
					params: { path: { pid: projectId, nid: notebookId } },
					body,
				}),
			),
		({ notebookId }) => [notebookKeys.list(projectId), notebookKeys.detail(projectId, notebookId)],
	);
}

export function useUpdateNotebook(projectId: string) {
	return useApiMutation(
		({
			notebookId,
			...body
		}: {
			notebookId: string;
			title?: string;
			base_image?: string | null;
			compute_profile?: string | null;
		}) =>
			apiData(
				apiClient.PATCH('/api/v1/projects/{pid}/notebooks/{nid}', {
					params: { path: { pid: projectId, nid: notebookId } },
					body,
				}),
			),
		({ notebookId }) => [notebookKeys.list(projectId), notebookKeys.detail(projectId, notebookId)],
	);
}

export function useDeleteNotebook(projectId: string) {
	return useApiMutation(
		(notebookId: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}', {
					params: { path: { pid: projectId, nid: notebookId } },
				}),
			),
		() => [notebookKeys.list(projectId)],
	);
}

/** Fetch the notebook's current `.py` source and save it as `<title>.py`. */
export function useDownloadNotebookFile(projectId: string) {
	return useMutation({
		mutationFn: async ({ notebookId, title }: { notebookId: string; title: string }) => {
			const { code } = await apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/content', {
					params: { path: { pid: projectId, nid: notebookId } },
				}),
			);
			triggerDownload(`${sanitizeFilename(title)}.py`, new Blob([code], { type: 'text/x-python' }));
		},
	});
}

/** The workspace archive is binary, so it bypasses the JSON client. */
export function useDownloadWorkspace(projectId: string) {
	return useMutation({
		mutationFn: async ({ notebookId, title }: { notebookId: string; title: string }) => {
			const res = await fetch(`${notebookPath(projectId, notebookId)}/workspace.zip`);
			if (!res.ok) {
				throw new Error(`Failed to download workspace (${res.status})`);
			}
			triggerDownload(`${sanitizeFilename(title)}-workspace.zip`, await res.blob());
		},
	});
}

// Notebook versions

/**
 * A notebook's saved versions, newest first (the API's order). Single page
 * (100) for now — histories longer than that need a "Load more" follow-up.
 */
export function useNotebookVersionsQuery(projectId: string, notebookId: string) {
	return useQuery({
		queryKey: notebookKeys.versions(projectId, notebookId),
		queryFn: async () =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/versions', {
						params: { path: { pid: projectId, nid: notebookId } },
					}),
				)
			).items,
	});
}

/** A single version's metadata + code. Versions are immutable, so cache forever. */
export function useNotebookVersionQuery(
	projectId: string,
	notebookId: string,
	versionId: string | null,
) {
	return useQuery({
		queryKey: notebookKeys.version(projectId, notebookId, versionId ?? ''),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/versions/{vid}', {
					params: {
						path: { pid: projectId, nid: notebookId, vid: versionId ?? '' },
					},
				}),
			),
		enabled: !!versionId,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** A captured HTML output snapshot, or null when none exists (yet). */
export interface NotebookHtmlSnapshot {
	html: string;
	/** When the snapshot was captured (`X-Marimohub-Captured-At`), for the banner. */
	capturedAt: string | null;
	/** The version it was captured for (`X-Marimohub-Version-Id`), for staleness. */
	versionId: string | null;
}

function htmlSnapshotPath(projectId: string, notebookId: string, versionId?: string): string {
	const base = notebookPath(projectId, notebookId);
	return versionId ? `${base}/versions/${versionId}/html` : `${base}/html`;
}

async function fetchHtmlSnapshot(
	projectId: string,
	notebookId: string,
	versionId?: string,
): Promise<NotebookHtmlSnapshot | null> {
	const res = await fetch(htmlSnapshotPath(projectId, notebookId, versionId));
	if (res.status === 404) {
		const error = await apiErrorFromResponse(
			res,
			versionId ? 'Version not found' : 'Notebook not found',
		);
		if (isApiErrorCode(error, 'NO_HTML_SNAPSHOT')) return null;
		throw error;
	}
	if (!res.ok) {
		throw await apiErrorFromResponse(res, `Failed to load notebook outputs (HTTP ${res.status})`);
	}
	return {
		html: await res.text(),
		capturedAt: res.headers.get('X-Marimohub-Captured-At'),
		versionId: res.headers.get('X-Marimohub-Version-Id'),
	};
}

/**
 * Fetch the latest HTML snapshot (or a specific version's when `versionId` is
 * set); `NO_HTML_SNAPSHOT` is an empty state.
 */
export function useNotebookHtmlQuery(projectId: string, notebookId: string, versionId?: string) {
	return useQuery({
		queryKey: notebookKeys.html(projectId, notebookId, versionId),
		queryFn: () => fetchHtmlSnapshot(projectId, notebookId, versionId),
		// A pinned version's snapshot is immutable; only the latest alias can change.
		// It can be pruned server-side, but keeping the cached copy then is deliberate:
		// a refetch would yank rendered outputs into the empty state mid-view, and the
		// in-memory cache expires with the session anyway.
		staleTime: versionId ? Infinity : 5 * 60 * 1000,
	});
}

/** Download the latest outputs snapshot as a standalone .html file. */
export function useDownloadOutputsHtml(projectId: string) {
	return useMutation({
		mutationFn: async ({ notebookId, title }: { notebookId: string; title: string }) => {
			const snapshot = await fetchHtmlSnapshot(projectId, notebookId);
			if (!snapshot) {
				throw new Error('No outputs have been captured yet — run the notebook first');
			}
			triggerDownload(
				`${sanitizeFilename(title)}.html`,
				new Blob([snapshot.html], { type: 'text/html' }),
			);
		},
	});
}

/**
 * Restore a version as the new current save. The server cuts a NEW version
 * carrying the old code (history stays intact), so this refreshes the version
 * list as well as the notebook itself.
 */
export function useRestoreVersion(projectId: string, notebookId: string) {
	return useApiMutation(
		(versionId: string) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/versions/{vid}/restore', {
					params: {
						path: { pid: projectId, nid: notebookId, vid: versionId },
					},
				}),
			),
		() => [
			notebookKeys.versions(projectId, notebookId),
			notebookKeys.detail(projectId, notebookId),
			notebookKeys.list(projectId),
		],
	);
}

// Sessions

/**
 * Poll a project's active sessions (`starting`/`running`/`idle`) to drive the
 * per-notebook runtime-status indicators in the notebook table. Plain `useQuery`
 * (not suspense) so a background poll never suspends the table; TanStack pauses
 * interval refetch while the tab is unfocused, so this stays cheap.
 */
export function useProjectSessionsQuery(projectId: string, enabled = true) {
	return useQuery({
		queryKey: sessionKeys.listByProject(projectId),
		queryFn: async () =>
			(
				await apiData(
					apiClient.GET('/api/v1/projects/{pid}/sessions', {
						params: { path: { pid: projectId } },
					}),
				)
			).items,
		refetchInterval: SESSIONS_POLL_INTERVAL_MS,
		enabled,
	});
}

/**
 * Provisioning a cold sandbox can take a while (the kernel may build its uv venv
 * on first boot), and teardown saves the notebook and destroys the sandbox
 * synchronously with no server-side budget bounding it — so both override the
 * client's default 20s timeout. Must exceed the provisioner's waitForPort budget.
 */
const SESSION_LIFECYCLE_TIMEOUT_MS = 150_000; // 2.5 minutes

/**
 * Plain edit creates have no body for compatibility. App mode, profile fallback,
 * and temporary intent add only their explicit fields.
 */
function startSessionRequest(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app',
	computeProfile?: 'default',
	editIntent?: 'temporary',
) {
	const params = { path: { pid: projectId, nid: notebookId } };
	const body = {
		...(mode === 'app' ? { mode } : {}),
		...(computeProfile ? { compute_profile: computeProfile } : {}),
		...(editIntent ? { edit_intent: editIntent } : {}),
	};
	return apiData(
		Object.keys(body).length > 0
			? apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions', {
					params,
					body,
					timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
				})
			: apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions', {
					params,
					timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
				}),
	);
}

// An abort surfaces as a failed stop, which halts a restart half-done (app
// stopped, never restarted) while the server tears down anyway.
function stopSessionRequest(projectId: string, notebookId: string, sessionId: string) {
	return apiData(
		apiClient.DELETE('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}', {
			params: { path: { pid: projectId, nid: notebookId, sid: sessionId } },
			timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
		}),
	);
}

function useStartSessionRequest(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app',
	computeProfile?: 'default',
	editIntent?: 'temporary',
) {
	return useMutation({
		mutationFn: () => startSessionRequest(projectId, notebookId, mode, computeProfile, editIntent),
		// useNotebookSession renders start failures as the inline session panel.
		meta: { suppressErrorToast: true },
	});
}

export function useStartSession(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app' = 'edit',
	editIntent?: 'temporary',
) {
	return useStartSessionRequest(projectId, notebookId, mode, undefined, editIntent);
}

export function useStartSessionWithDefault(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app' = 'edit',
	editIntent?: 'temporary',
) {
	return useStartSessionRequest(projectId, notebookId, mode, 'default', editIntent);
}

async function restartSessionRequest(
	projectId: string,
	notebookId: string,
	sessionId: string,
	mode: 'edit' | 'app',
) {
	try {
		await stopSessionRequest(projectId, notebookId, sessionId);
	} catch (err) {
		// A reaped session is already stopped, so the requested restart can continue.
		if (!isNotFoundError(err)) throw err;
	}
	return startSessionRequest(projectId, notebookId, mode);
}

export function useRestartApp(projectId: string, notebookId: string) {
	return useApiMutation(
		(sessionId: string) => restartSessionRequest(projectId, notebookId, sessionId, 'app'),
		() => [sessionKeys.listByProject(projectId)],
	);
}

export function useRestartSession(projectId: string) {
	return useApiMutation(
		({ notebookId, sessionId }: { notebookId: string; sessionId: string }) =>
			restartSessionRequest(projectId, notebookId, sessionId, 'edit'),
		() => [sessionKeys.listByProject(projectId)],
	);
}

export function useStopSession(
	projectId: string,
	notebookId: string,
	opts?: { suppressErrorToast?: boolean },
) {
	return useApiMutation(
		(sessionId: string) => stopSessionRequest(projectId, notebookId, sessionId),
		() => [sessionKeys.listByProject(projectId)],
		opts?.suppressErrorToast ? { suppressErrorToast: true } : undefined,
	);
}

export function useOpenNotebookChangeRequest(projectId: string, notebookId: string) {
	type PublishAction = 'open' | 'update' | 'create-new';
	type PublishInput = { sessionId: string; title?: string; action: PublishAction };
	const [activeChangeRequest, setActiveChangeRequest] = useState<NotebookChangeRequest>();
	const attempt = useRef<{ signature: string; idempotencyKey: string } | undefined>(undefined);
	const mutation = useMutation({
		mutationFn: ({ sessionId, title, action }: PublishInput) => {
			const targetProposalId = action === 'update' ? activeChangeRequest?.proposal_id : undefined;
			if (action === 'update' && !targetProposalId) {
				throw new Error('Cannot update a change request before one has been opened');
			}
			const signature = `${action}:${targetProposalId ?? ''}`;
			if (attempt.current?.signature !== signature) {
				attempt.current = { signature, idempotencyKey: crypto.randomUUID() };
			}
			return apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/change-requests', {
					params: {
						path: { pid: projectId, nid: notebookId, sid: sessionId },
						header: { 'idempotency-key': attempt.current.idempotencyKey },
					},
					body: {
						...(title ? { title } : {}),
						...(targetProposalId ? { target_proposal_id: targetProposalId } : {}),
					},
					timeout: 120_000,
				}),
			);
		},
		onSuccess: (data) => {
			attempt.current = undefined;
			setActiveChangeRequest(data);
		},
		onError: (error) => {
			if (isApiErrorCode(error, 'PROPOSAL_RETRY_REQUIRED')) {
				attempt.current = undefined;
			}
		},
	});
	return { ...mutation, activeChangeRequest };
}

export function useEditorSessionQuery(
	projectId: string,
	notebookId: string,
	enabled = true,
	currentUserId?: string,
) {
	return useQuery({
		queryKey: sessionKeys.editor(projectId, notebookId),
		queryFn: () =>
			apiData(
				apiClient.GET('/api/v1/projects/{pid}/notebooks/{nid}/editor-session', {
					params: { path: { pid: projectId, nid: notebookId } },
				}),
			),
		enabled,
		refetchInterval: (query) =>
			currentUserId && query.state.data?.holder?.user_id === currentUserId ? false : 10_000,
	});
}

export function useTakeoverEditorSession(projectId: string, notebookId: string) {
	return useApiMutation(
		(body: {
			takeover_id: string;
			expected_holder_session_id: string;
			expected_activity: 'active' | 'idle' | 'unknown' | 'starting';
			acknowledge_disruption: true;
		}) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/notebooks/{nid}/editor-session/takeover', {
					params: { path: { pid: projectId, nid: notebookId } },
					body,
					timeout: 300_000,
				}),
			),
		() => [sessionKeys.editor(projectId, notebookId), sessionKeys.listByProject(projectId)],
	);
}
