import { useQuery, useSuspenseQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { apiClient, apiData, apiDataWithResponse } from './client';
import { useApiMutation } from './mutation';
import { isApiErrorCode, isNotFoundError, notebookPath } from './request';
import { sanitizeFilename, triggerDownload } from '../lib/download';
import {
	userKeys,
	projectKeys,
	notebookKeys,
	sessionKeys,
	systemKeys,
	integrationKeys,
} from './queryKeys';
import type { NotebookDetail, ResolvedUser, ProjectFederation, ProjectRole } from '../types';

/** How often the notebook table re-polls runtime status, in ms. */
const SESSIONS_POLL_INTERVAL_MS = 5_000;

/**
 * Deployment-scoped facts (identity, version, capabilities): fixed for the life
 * of a page load, so they are held fresh forever and a failure is not retried —
 * the dependent UI just renders nothing rather than spamming the endpoint.
 */
const IMMUTABLE_QUERY = { staleTime: Number.POSITIVE_INFINITY, retry: false } as const;

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

/** Deployment capability flags (e.g. whether WIF is configured). */
export function useCapabilitiesQuery() {
	return useQuery({
		queryKey: systemKeys.capabilities(),
		queryFn: () => apiData(apiClient.GET('/api/v1/capabilities')),
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
		(body: { user_id?: string; email?: string; role: ProjectRole }) =>
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
		({ uid, role }: { uid: string; role: ProjectRole }) =>
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

/** A 404 from the secrets routes means the deployment has the feature disabled. */
export function isSecretsDisabledError(err: unknown): boolean {
	return isApiErrorCode(err, 'NOT_FOUND');
}

/**
 * List a project's secret entries (metadata only — never a value). Resolves to
 * `null` when the deployment has secrets disabled (the route 404s) so the UI can
 * hide the section instead of surfacing an error.
 */
export function useProjectSecretsQuery(projectId: string, enabled = true) {
	return useQuery({
		queryKey: projectKeys.secrets(projectId),
		enabled,
		retry: (count, err) => !isSecretsDisabledError(err) && count < 2,
		queryFn: async () => {
			try {
				return await apiData(
					apiClient.GET('/api/v1/projects/{pid}/secrets', {
						params: { path: { pid: projectId } },
					}),
				);
			} catch (err) {
				if (isSecretsDisabledError(err)) return null;
				throw err;
			}
		},
	});
}

interface ReferenceInput {
	name: string;
	backend: string;
	locator: string;
	expand?: 'json';
	prefix?: string;
}

/** The reference body sent to PUT/validate (the `name` lives in the path). */
function referenceBody({ backend, locator, expand, prefix }: ReferenceInput) {
	return {
		kind: 'reference' as const,
		backend,
		locator,
		...(expand ? { expand } : {}),
		...(prefix ? { prefix } : {}),
	};
}

export function usePutSecret(projectId: string) {
	return useApiMutation(
		(input: ReferenceInput) =>
			apiData(
				apiClient.PUT('/api/v1/projects/{pid}/secrets/{name}', {
					params: { path: { pid: projectId, name: input.name } },
					body: referenceBody(input),
				}),
			),
		() => [projectKeys.secrets(projectId)],
	);
}

export function useValidateSecret(projectId: string) {
	return useMutation({
		mutationFn: (input: ReferenceInput) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/secrets/validate', {
					params: { path: { pid: projectId } },
					body: referenceBody(input),
				}),
			),
	});
}

export function useDeleteSecret(projectId: string) {
	return useApiMutation(
		(name: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/secrets/{name}', {
					params: { path: { pid: projectId, name } },
				}),
			),
		() => [projectKeys.secrets(projectId)],
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

/** Returns `null` when integrations are disabled for this deployment. */
export function useProjectIntegrationsQuery(projectId: string, enabled = true) {
	return useQuery({
		queryKey: projectKeys.integrations(projectId),
		enabled,
		retry: (count, err) => !isIntegrationsDisabledError(err) && count < 2,
		queryFn: async () => {
			try {
				return await apiData(
					apiClient.GET('/api/v1/projects/{pid}/integrations', {
						params: { path: { pid: projectId } },
					}),
				);
			} catch (err) {
				if (isIntegrationsDisabledError(err)) return null;
				throw err;
			}
		},
	});
}

/** Fetches the current config with secret fields redacted. */
export function useIntegrationDetailQuery(projectId: string, integrationId: string | undefined) {
	return useQuery({
		queryKey: projectKeys.integration(projectId, integrationId ?? ''),
		enabled: Boolean(integrationId),
		queryFn: async () => {
			const result = await apiDataWithResponse(
				apiClient.GET('/api/v1/projects/{pid}/integrations/{iid}', {
					params: { path: { pid: projectId, iid: integrationId ?? '' } },
				}),
			);
			return {
				detail: result.data,
				etag: result.response.headers.get('etag') ?? undefined,
			};
		},
	});
}

export function useCreateIntegration(projectId: string) {
	return useApiMutation(
		(body: { kind: string; name: string; config: Record<string, unknown> }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
		() => [projectKeys.integrations(projectId)],
	);
}

export function useUpdateIntegration(projectId: string) {
	return useApiMutation(
		({
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
				apiClient.PATCH('/api/v1/projects/{pid}/integrations/{iid}', {
					params: {
						path: { pid: projectId, iid: id },
						header: etag ? { 'if-match': etag } : {},
					},
					body,
				}),
			),
		(variables) => [
			projectKeys.integrations(projectId),
			projectKeys.integration(projectId, variables.id),
		],
	);
}

export function useDeleteIntegration(projectId: string) {
	return useApiMutation(
		(id: string) =>
			apiData(
				apiClient.DELETE('/api/v1/projects/{pid}/integrations/{iid}', {
					params: { path: { pid: projectId, iid: id } },
				}),
			),
		() => [projectKeys.integrations(projectId)],
	);
}

/** Tests either an unsaved config or a stored integration by id. */
export function useTestIntegration(projectId: string) {
	return useMutation({
		mutationFn: (body: { kind: string; config: Record<string, unknown> } | { id: string }) =>
			apiData(
				apiClient.POST('/api/v1/projects/{pid}/integrations/test', {
					params: { path: { pid: projectId } },
					body,
				}),
			),
	});
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

/** The latest captured HTML output snapshot, or null when no version has one yet. */
export interface NotebookHtmlSnapshot {
	html: string;
	/** When the snapshot was captured (`X-Marimohub-Captured-At`), for the banner. */
	capturedAt: string | null;
}

/** Fetch the latest HTML snapshot; `NO_HTML_SNAPSHOT` is an empty state. */
export function useNotebookHtmlQuery(projectId: string, notebookId: string) {
	return useQuery({
		queryKey: notebookKeys.html(projectId, notebookId),
		queryFn: async (): Promise<NotebookHtmlSnapshot | null> => {
			const res = await fetch(`${notebookPath(projectId, notebookId)}/html`);
			if (res.status === 404) {
				// Only "exists but never ran" is the empty state; a deleted/hidden
				// notebook (code NOT_FOUND) must surface as an error, not "no outputs".
				const body = (await res.json().catch(() => null)) as {
					error?: { code?: string };
				} | null;
				if (body?.error?.code === 'NO_HTML_SNAPSHOT') return null;
				throw new Error('Notebook not found');
			}
			if (!res.ok) throw new Error(`Failed to load notebook outputs (HTTP ${res.status})`);
			return {
				html: await res.text(),
				capturedAt: res.headers.get('X-Marimohub-Captured-At'),
			};
		},
		staleTime: 5 * 60 * 1000,
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
 * The create-session request. Sent with no body for `edit` (byte-identical to
 * the pre-`mode` client) and `{ mode: "app" }` for the shared app singleton —
 * the server attaches ANY editor to the notebook's running app.
 */
function startSessionRequest(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app',
	computeProfile?: 'default',
) {
	const params = { path: { pid: projectId, nid: notebookId } };
	const body = {
		...(mode === 'app' ? { mode } : {}),
		...(computeProfile ? { compute_profile: computeProfile } : {}),
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
) {
	return useMutation({
		mutationFn: () => startSessionRequest(projectId, notebookId, mode, computeProfile),
	});
}

export function useStartSession(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app' = 'edit',
) {
	return useStartSessionRequest(projectId, notebookId, mode);
}

export function useStartSessionWithDefault(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app' = 'edit',
) {
	return useStartSessionRequest(projectId, notebookId, mode, 'default');
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

export function useStopSession(projectId: string, notebookId: string) {
	return useApiMutation(
		(sessionId: string) => stopSessionRequest(projectId, notebookId, sessionId),
		() => [sessionKeys.listByProject(projectId)],
	);
}
