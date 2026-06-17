import { useQuery, useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
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
} from '../types';

/** How often the notebook table re-polls runtime status, in ms. */
const SESSIONS_POLL_INTERVAL_MS = 5_000;

/** A page of a list endpoint: items plus an opaque cursor for the next page. */
interface Paginated<T> {
	items: T[];
	next_cursor: string | null;
}

// Auth
export function useUserQuery() {
	return useQuery({
		queryKey: userKeys.me(),
		queryFn: () => apiFetch<User>('/api/v1/me'),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

// System

/**
 * Fetch deployment metadata for the footer info popover. Effectively immutable
 * for the life of a page load, so it's held fresh forever; `retry: false` keeps a
 * failure from spamming — the footer just shows nothing.
 */
export function useVersionQuery() {
	return useQuery({
		queryKey: systemKeys.version(),
		queryFn: () => apiFetch<ServerVersion>('/api/v1/version'),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

/** Deployment capability flags (e.g. whether WIF is configured). Fixed per page load. */
export function useCapabilitiesQuery() {
	return useQuery({
		queryKey: systemKeys.capabilities(),
		queryFn: () => apiFetch<Capabilities>('/api/v1/capabilities'),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
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
export function useUsersQuery(ids: readonly string[]) {
	const unique = [...new Set(ids.filter(Boolean))].sort();
	return useQuery({
		queryKey: userKeys.resolve(unique),
		queryFn: () =>
			apiFetch<UserDirectory>(`/api/v1/users?ids=${encodeURIComponent(unique.join(','))}`),
		enabled: unique.length > 0,
		staleTime: 5 * 60 * 1000,
	});
}

// Projects
export function useProjectsQuery() {
	return useSuspenseQuery({
		queryKey: projectKeys.list(),
		queryFn: async () => (await apiFetch<Paginated<ProjectSummary>>('/api/v1/projects')).items,
	});
}

export function useProjectQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: projectKeys.detail(projectId),
		// Full project meta (incl. `federation`), not the snapshot summary the list returns.
		queryFn: () => apiFetch<ProjectDetail>(`/api/v1/projects/${projectId}`),
	});
}

export function useCreateProject() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { name: string; description: string }) =>
			apiFetch<ProjectSummary>('/api/v1/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
		},
	});
}

export function useUpdateProject() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			projectId,
			...body
		}: {
			// Partial update: callers send only the fields they change.
			projectId: string;
			name?: string;
			description?: string;
			tags?: string[];
			federation?: ProjectFederation;
		}) =>
			apiFetch<ProjectDetail>(`/api/v1/projects/${projectId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: (_data, { projectId }) => {
			void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
			void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
		},
	});
}

export function useDeleteProject() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (projectId: string) =>
			apiFetch<void>(`/api/v1/projects/${projectId}`, { method: 'DELETE' }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
		},
	});
}

// Project members
export function useProjectMembersQuery(projectId: string) {
	return useQuery({
		queryKey: projectKeys.members(projectId),
		queryFn: () => apiFetch<ProjectMember[]>(`/api/v1/projects/${projectId}/members`),
	});
}

/** Invalidate a project's member list and detail (both carry membership). */
function useInvalidateMembers(projectId: string) {
	const queryClient = useQueryClient();
	return () => {
		void queryClient.invalidateQueries({ queryKey: projectKeys.members(projectId) });
		void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
	};
}

export function useAddMember(projectId: string) {
	const invalidate = useInvalidateMembers(projectId);
	return useMutation({
		mutationFn: (body: { user_id: string; role: ProjectRole }) =>
			apiFetch<ProjectDetail>(`/api/v1/projects/${projectId}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: invalidate,
	});
}

export function useUpdateMemberRole(projectId: string) {
	const invalidate = useInvalidateMembers(projectId);
	return useMutation({
		mutationFn: ({ uid, role }: { uid: string; role: ProjectRole }) =>
			apiFetch<ProjectDetail>(`/api/v1/projects/${projectId}/members/${uid}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role }),
			}),
		onSuccess: invalidate,
	});
}

export function useRemoveMember(projectId: string) {
	const invalidate = useInvalidateMembers(projectId);
	return useMutation({
		mutationFn: (uid: string) =>
			apiFetch<void>(`/api/v1/projects/${projectId}/members/${uid}`, { method: 'DELETE' }),
		onSuccess: invalidate,
	});
}

// Notebooks
export function useNotebooksQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: notebookKeys.list(projectId),
		queryFn: async () =>
			(await apiFetch<Paginated<NotebookEntry>>(`/api/v1/projects/${projectId}/notebooks`)).items,
	});
}

/**
 * Fetch a single notebook's detail (meta + source). Plain `useQuery` (not
 * suspense) so the notebook page can render its shell — and start the kernel —
 * without blocking on metadata; the "created by" line fills in when it arrives.
 */
export function useNotebookQuery(projectId: string, notebookId: string) {
	return useQuery({
		queryKey: notebookKeys.detail(projectId, notebookId),
		queryFn: () =>
			apiFetch<NotebookDetail>(`/api/v1/projects/${projectId}/notebooks/${notebookId}`),
		staleTime: 5 * 60 * 1000,
	});
}

export function useCreateNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { title: string; description: string; code: string }) =>
			apiFetch<NotebookMeta>(`/api/v1/projects/${projectId}/notebooks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

/**
 * Duplicate a notebook into a fresh local copy in the same project. The server
 * defaults the title to `"<title> (copy)"` when none is given; git-synced
 * notebooks are copied as detached local notebooks.
 */
export function useDuplicateNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ notebookId, title }: { notebookId: string; title?: string }) =>
			apiFetch<NotebookMeta>(`/api/v1/projects/${projectId}/notebooks/${notebookId}/duplicate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(title ? { title } : {}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

/** Create a git-synced notebook; the response carries its write-once sync token. */
export function useCreateSyncedNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: {
			title: string;
			description: string;
			repo: string;
			branch: string;
			root_path?: string;
			entry_notebook: string;
		}) =>
			apiFetch<GitNotebookCreateResult>(`/api/v1/projects/${projectId}/notebooks/git`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

/** Rotate a synced notebook's sync token, invalidating the old one. */
export function useRotateSyncToken(projectId: string) {
	return useMutation({
		mutationFn: (notebookId: string) =>
			apiFetch<SyncToken>(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/sync-token/rotate`,
				{ method: 'POST' },
			),
	});
}

export function useUpdateNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ notebookId, ...body }: { notebookId: string; title?: string }) =>
			apiFetch<NotebookMeta>(`/api/v1/projects/${projectId}/notebooks/${notebookId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: (_data, { notebookId }) => {
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
			void queryClient.invalidateQueries({ queryKey: notebookKeys.detail(projectId, notebookId) });
		},
	});
}

export function useDeleteNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (notebookId: string) =>
			apiFetch<void>(`/api/v1/projects/${projectId}/notebooks/${notebookId}`, {
				method: 'DELETE',
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

/** Fetch the notebook's current `.py` source and save it as `<title>.py`. */
export function useDownloadNotebookFile(projectId: string) {
	return useMutation({
		mutationFn: async ({ notebookId, title }: { notebookId: string; title: string }) => {
			const { code } = await apiFetch<{ code: string }>(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/content`,
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
			const res = await fetch(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/workspace.zip`,
			);
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
				await apiFetch<Paginated<NotebookVersion>>(
					`/api/v1/projects/${projectId}/notebooks/${notebookId}/versions`,
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
			apiFetch<NotebookVersionDetail>(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/versions/${versionId}`,
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
			const res = await fetch(`/api/v1/projects/${projectId}/notebooks/${notebookId}/html`);
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
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (versionId: string) =>
			apiFetch<NotebookMeta>(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/versions/${versionId}/restore`,
				{ method: 'POST' },
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: notebookKeys.versions(projectId, notebookId),
			});
			void queryClient.invalidateQueries({ queryKey: notebookKeys.detail(projectId, notebookId) });
			void queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

// Sessions

/**
 * Poll a project's active sessions (`starting`/`running`/`idle`) to drive the
 * per-notebook runtime-status indicators in the notebook table. Plain `useQuery`
 * (not suspense) so a background poll never suspends the table; TanStack pauses
 * interval refetch while the tab is unfocused, so this stays cheap.
 */
export function useProjectSessionsQuery(projectId: string) {
	return useQuery({
		queryKey: sessionKeys.listByProject(projectId),
		queryFn: async () =>
			(await apiFetch<Paginated<Session>>(`/api/v1/projects/${projectId}/sessions`)).items,
		refetchInterval: SESSIONS_POLL_INTERVAL_MS,
	});
}

export function useStartSession(projectId: string, notebookId: string) {
	return useMutation({
		mutationFn: () =>
			// Provisioning a cold sandbox can take a while (the kernel may build its uv
			// venv on first boot), so override the client's default 20s timeout. Must
			// exceed the provisioner's waitForPort budget.
			apiFetch<Session>(`/api/v1/projects/${projectId}/notebooks/${notebookId}/sessions`, {
				method: 'POST',
				timeout: 150_000, // 2.5 minutes
			}),
	});
}

export function useStopSession(projectId: string, notebookId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (sessionId: string) =>
			apiFetch<void>(
				`/api/v1/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}`,
				{
					method: 'DELETE',
				},
			),
		onSuccess: () => {
			// Refresh the status indicators right away rather than waiting for the poll.
			void queryClient.invalidateQueries({ queryKey: sessionKeys.listByProject(projectId) });
		},
	});
}
