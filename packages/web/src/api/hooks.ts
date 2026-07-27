import { useQuery, useSuspenseQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from './client';
import { useApiMutation } from './mutation';
import {
	del,
	fetchItems,
	isApiErrorCode,
	isNotFoundError,
	notebookPath,
	patchJson,
	post,
	postJson,
	projectPath,
	putJson,
} from './request';
import { sanitizeFilename, triggerDownload } from '../lib/download';
import { userKeys, projectKeys, notebookKeys, sessionKeys, systemKeys } from './queryKeys';
import type {
	User,
	ResolvedUser,
	ProjectSummary,
	ProjectDetail,
	ProjectFederation,
	ProjectMember,
	ProjectRole,
	Capabilities,
	NotebookEntry,
	NotebookMeta,
	NotebookDetail,
	NotebookVersion,
	NotebookVersionDetail,
	GitNotebookCreateResult,
	SyncToken,
	ServerVersion,
	Session,
	SecretEntry,
	ApiToken,
	ApiTokenCreated,
} from '../types';

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
		queryFn: () => apiFetch<User>('/api/v1/me'),
		...IMMUTABLE_QUERY,
	});
}

// Personal access tokens (self-service, on the account menu)

/** The caller's API tokens, newest first — metadata only, never a secret. */
export function useApiTokensQuery(enabled = true) {
	return useQuery({
		queryKey: userKeys.tokens(),
		queryFn: () => apiFetch<ApiToken[]>('/api/v1/me/tokens'),
		enabled,
	});
}

/** Mint a token. The response's `token` is shown once and never retrievable again. */
export function useCreateApiToken() {
	return useApiMutation(
		(body: { name: string; expires_in_days?: number }) =>
			postJson<ApiTokenCreated>('/api/v1/me/tokens', body),
		() => [userKeys.tokens()],
	);
}

export function useRevokeApiToken() {
	return useApiMutation(
		(tokenId: string) => del(`/api/v1/me/tokens/${tokenId}`),
		() => [userKeys.tokens()],
	);
}

// System

/** Deployment metadata for the footer info popover. */
export function useVersionQuery() {
	return useQuery({
		queryKey: systemKeys.version(),
		queryFn: () => apiFetch<ServerVersion>('/api/v1/version'),
		...IMMUTABLE_QUERY,
	});
}

/** Deployment capability flags (e.g. whether WIF is configured). */
export function useCapabilitiesQuery() {
	return useQuery({
		queryKey: systemKeys.capabilities(),
		queryFn: () => apiFetch<Capabilities>('/api/v1/capabilities'),
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
			apiFetch<UserDirectory>(`/api/v1/users?ids=${encodeURIComponent(unique.join(','))}`),
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
		queryFn: () => apiFetch<ResolvedUser[]>(`/api/v1/users/search?q=${encodeURIComponent(q)}`),
		enabled: q.length >= 2,
		staleTime: 30 * 1000,
		placeholderData: keepPreviousData,
	});
}

// Projects
export function useProjectsQuery() {
	return useSuspenseQuery({
		queryKey: projectKeys.list(),
		queryFn: () => fetchItems<ProjectSummary>('/api/v1/projects'),
	});
}

export function useProjectQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: projectKeys.detail(projectId),
		// Full project meta (incl. `federation`), not the snapshot summary the list returns.
		queryFn: () => apiFetch<ProjectDetail>(projectPath(projectId)),
	});
}

export function useCreateProject() {
	return useApiMutation(
		(body: { name: string; description: string }) =>
			postJson<ProjectSummary>('/api/v1/projects', body),
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
		}) => patchJson<ProjectDetail>(projectPath(projectId), body),
		({ projectId }) => [projectKeys.list(), projectKeys.detail(projectId)],
	);
}

export function useDeleteProject() {
	return useApiMutation(
		(projectId: string) => del(projectPath(projectId)),
		() => [projectKeys.list()],
	);
}

// Project members
export function useProjectMembersQuery(projectId: string) {
	return useQuery({
		queryKey: projectKeys.members(projectId),
		queryFn: () => apiFetch<ProjectMember[]>(`${projectPath(projectId)}/members`),
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
			postJson<ProjectDetail>(`${projectPath(projectId)}/members`, body),
		() => memberKeys(projectId),
	);
}

// `uid` is the member's user id or invite email; emails need URL-encoding.
const memberPath = (projectId: string, uid: string) =>
	`${projectPath(projectId)}/members/${encodeURIComponent(uid)}`;

export function useUpdateMemberRole(projectId: string) {
	return useApiMutation(
		({ uid, role }: { uid: string; role: ProjectRole }) =>
			putJson<ProjectDetail>(memberPath(projectId, uid), { role }),
		() => memberKeys(projectId),
	);
}

export function useRemoveMember(projectId: string) {
	return useApiMutation(
		(uid: string) => del(memberPath(projectId, uid)),
		() => memberKeys(projectId),
	);
}

/** A 404 from the secrets routes means the deployment has the feature disabled. */
export function isSecretsDisabledError(err: unknown): boolean {
	return isApiErrorCode(err, 'NOT_FOUND');
}

const secretsPath = (projectId: string) => `${projectPath(projectId)}/secrets`;

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
				return await apiFetch<SecretEntry[]>(secretsPath(projectId));
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
			putJson<SecretEntry>(
				`${secretsPath(projectId)}/${encodeURIComponent(input.name)}`,
				referenceBody(input),
			),
		() => [projectKeys.secrets(projectId)],
	);
}

export function useValidateSecret(projectId: string) {
	return useMutation({
		mutationFn: (input: ReferenceInput) =>
			postJson<{ ok: boolean; reason?: string }>(
				`${secretsPath(projectId)}/validate`,
				referenceBody(input),
			),
	});
}

export function useDeleteSecret(projectId: string) {
	return useApiMutation(
		(name: string) => del(`${secretsPath(projectId)}/${encodeURIComponent(name)}`),
		() => [projectKeys.secrets(projectId)],
	);
}

// Notebooks
const notebooksPath = (projectId: string) => `${projectPath(projectId)}/notebooks`;

export function useNotebooksQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: notebookKeys.list(projectId),
		queryFn: () => fetchItems<NotebookEntry>(notebooksPath(projectId)),
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
	// Freshness options for consumers that compare against the notebook HEAD (the
	// app page's staleness banner): versions are committed server-side
	// (snapshotter, teardown), which no client-side invalidation ever observes.
	// `refetchIntervalMs` polls for a long-lived view; `staleTime: 0` re-reads on
	// mount instead, for a short-lived one that must not trust the shared cache.
	options: { refetchIntervalMs?: number; staleTime?: number } = {},
) {
	return useQuery({
		queryKey: notebookKeys.detail(projectId, notebookId),
		queryFn: () => apiFetch<NotebookDetail>(notebookPath(projectId, notebookId)),
		staleTime: options.staleTime ?? 5 * 60 * 1000,
		refetchInterval: options.refetchIntervalMs,
	});
}

export function useCreateNotebook(projectId: string) {
	return useApiMutation(
		(body: { title: string; description: string; code: string; base_image?: string }) =>
			postJson<NotebookMeta>(notebooksPath(projectId), body),
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
			postJson<NotebookMeta>(
				`${notebookPath(projectId, notebookId)}/duplicate`,
				title ? { title } : {},
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
		}) => postJson<GitNotebookCreateResult>(`${notebooksPath(projectId)}/git`, body),
		() => [notebookKeys.list(projectId)],
	);
}

/** Rotate a synced notebook's sync token, invalidating the old one. */
export function useRotateSyncToken(projectId: string) {
	return useMutation({
		mutationFn: (notebookId: string) =>
			post<SyncToken>(`${notebookPath(projectId, notebookId)}/sync-token/rotate`),
	});
}

export function useUpdateNotebook(projectId: string) {
	return useApiMutation(
		({ notebookId, ...body }: { notebookId: string; title?: string; base_image?: string | null }) =>
			patchJson<NotebookMeta>(notebookPath(projectId, notebookId), body),
		({ notebookId }) => [notebookKeys.list(projectId), notebookKeys.detail(projectId, notebookId)],
	);
}

export function useDeleteNotebook(projectId: string) {
	return useApiMutation(
		(notebookId: string) => del(notebookPath(projectId, notebookId)),
		() => [notebookKeys.list(projectId)],
	);
}

/** Fetch the notebook's current `.py` source and save it as `<title>.py`. */
export function useDownloadNotebookFile(projectId: string) {
	return useMutation({
		mutationFn: async ({ notebookId, title }: { notebookId: string; title: string }) => {
			const { code } = await apiFetch<{ code: string }>(
				`${notebookPath(projectId, notebookId)}/content`,
			);
			triggerDownload(`${sanitizeFilename(title)}.py`, new Blob([code], { type: 'text/x-python' }));
		},
	});
}

/**
 * Download the notebook's workspace as a zip. The endpoint returns binary (not
 * the JSON envelope), so this bypasses the typed `apiFetch` and uses a plain
 * same-origin `fetch` — the session cookie rides along automatically.
 */
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
const versionsPath = (projectId: string, notebookId: string) =>
	`${notebookPath(projectId, notebookId)}/versions`;

/**
 * A notebook's saved versions, newest first (the API's order). Single page
 * (100) for now — histories longer than that need a "Load more" follow-up.
 */
export function useNotebookVersionsQuery(projectId: string, notebookId: string) {
	return useQuery({
		queryKey: notebookKeys.versions(projectId, notebookId),
		queryFn: () => fetchItems<NotebookVersion>(versionsPath(projectId, notebookId)),
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
			apiFetch<NotebookVersionDetail>(`${versionsPath(projectId, notebookId)}/${versionId}`),
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

/**
 * Fetch the notebook's latest HTML snapshot for the viewer static mode. Raw
 * fetch, not `apiFetch`: the route serves `text/html`, not the JSON envelope.
 * A 404 (code `NO_HTML_SNAPSHOT`) resolves to null — the "no outputs yet"
 * empty state, not an error.
 */
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
			post<NotebookMeta>(`${versionsPath(projectId, notebookId)}/${versionId}/restore`),
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
		queryFn: () => fetchItems<Session>(`${projectPath(projectId)}/sessions`),
		refetchInterval: SESSIONS_POLL_INTERVAL_MS,
		enabled,
	});
}

/** Base URL of a notebook's session collection (also exported for the session hook). */
export const notebookSessionsPath = (projectId: string, notebookId: string) =>
	`${notebookPath(projectId, notebookId)}/sessions`;

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
function startSessionRequest(projectId: string, notebookId: string, mode: 'edit' | 'app') {
	const path = notebookSessionsPath(projectId, notebookId);
	const init = { timeout: SESSION_LIFECYCLE_TIMEOUT_MS };
	return mode === 'app' ? postJson<Session>(path, { mode }, init) : post<Session>(path, init);
}

// An abort surfaces as a failed stop, which halts a restart half-done (app
// stopped, never restarted) while the server tears down anyway.
function stopSessionRequest(projectId: string, notebookId: string, sessionId: string) {
	return del<void>(`${notebookSessionsPath(projectId, notebookId)}/${sessionId}`, {
		timeout: SESSION_LIFECYCLE_TIMEOUT_MS,
	});
}

export function useStartSession(
	projectId: string,
	notebookId: string,
	mode: 'edit' | 'app' = 'edit',
) {
	return useMutation({
		mutationFn: () => startSessionRequest(projectId, notebookId, mode),
	});
}

/**
 * Restart the shared app: stop the given session, then start a fresh one (which
 * picks up the notebook's current head — the staleness banner's action). The
 * stop is awaited so the fresh create can't reuse the dying sandbox.
 */
export function useRestartApp(projectId: string, notebookId: string) {
	return useApiMutation(
		async (sessionId: string) => {
			try {
				await stopSessionRequest(projectId, notebookId, sessionId);
			} catch (err) {
				// Already gone (stopped/reaped underneath us): the restart intent
				// still holds, so proceed to the fresh start.
				if (!isNotFoundError(err)) throw err;
			}
			return startSessionRequest(projectId, notebookId, 'app');
		},
		// Refresh the status indicators right away rather than waiting for the poll.
		() => [sessionKeys.listByProject(projectId)],
	);
}

export function useStopSession(projectId: string, notebookId: string) {
	return useApiMutation(
		(sessionId: string) => stopSessionRequest(projectId, notebookId, sessionId),
		() => [sessionKeys.listByProject(projectId)],
	);
}
