// The API response shapes are defined ONCE, in the core zod schemas, surfaced
// through the OpenAPI document, and code-generated into `@marimo-hub/client`.
// The web consumes those generated types here instead of re-declaring them, so
// a field added in core flows through to the UI without a parallel hand-written
// copy drifting out of sync.

import type {
	components,
	SnapshotProjectEntry,
	SnapshotNotebookEntry,
	Project as ClientProject,
	ProjectFederation as ClientProjectFederation,
	Capabilities as ClientCapabilities,
	NotebookMeta as ClientNotebookMeta,
	NotebookDetail as ClientNotebookDetail,
	NotebookVersion as ClientNotebookVersion,
	GitNotebookCreateResult as ClientGitNotebookCreateResult,
	SyncToken as ClientSyncToken,
	Session as ClientSession,
	ResolvedUser as ClientResolvedUser,
	ApiResponse as ClientApiResponse,
	ApiError as ClientApiError,
} from '@marimo-hub/client';

// Aliases onto the generated client types. Names kept stable so existing web
// imports (`ProjectSummary`, `NotebookEntry`, ...) continue to work.
export type ProjectSummary = SnapshotProjectEntry;
/** The full project meta returned by `GET /api/v1/projects/:id` (includes `federation`). */
export type ProjectDetail = ClientProject;
/** Per-project workload-identity federation opt-in. */
export type ProjectFederation = ClientProjectFederation;
// The client re-exports the raw OpenAPI `components` but no named alias for
// these two, so they're derived here.
export type ProjectMember = components['schemas']['ProjectMember'];
export type ProjectRole = ProjectMember['role'];
/** Deployment capability flags from `GET /api/v1/capabilities`. */
export type Capabilities = ClientCapabilities;
export type NotebookEntry = SnapshotNotebookEntry;
export type NotebookMeta = ClientNotebookMeta;
export type NotebookDetail = ClientNotebookDetail;
/** A saved notebook revision from `GET .../versions`. */
export type NotebookVersion = ClientNotebookVersion;
/** Result of creating a git-synced notebook (`POST .../notebooks/git`). */
export type GitNotebookCreateResult = ClientGitNotebookCreateResult;
/** A sync URL + write-once token, returned on synced-notebook creation and token rotation. */
export type SyncToken = ClientSyncToken;
export type Session = ClientSession;
/** A resolved user identity ({ id, email, name }) from `GET /api/v1/users`. */
export type ResolvedUser = ClientResolvedUser;
export type ApiResponse<T> = ClientApiResponse<T>;
export type ApiError = ClientApiError;

// Web-local: the `GET .../versions/{vid}` payload. Inlined in the OpenAPI doc
// (no named component), so declared here like `User`/`ServerVersion` below.
export interface NotebookVersionDetail {
	version: NotebookVersion;
	code: string;
}

// Web-local: the `/api/v1/me` payload. The OpenAPI doc inlines this response (no
// named `User` component), so the generated client exposes no equivalent type.
// Kept here as the single web-side declaration of the authenticated-user shape.
export interface User {
	id: string;
	email: string;
	logout_url?: string | null;
}

// Web-local: the `/api/v1/version` payload. Inlined in the OpenAPI doc (no named
// component), so — like `User` above — it's declared here rather than imported
// from the generated client.
export interface ServerVersion {
	/** Deployment version (short git SHA / release tag), or `dev` when unset. */
	version: string;
	/** Server Docker image reference (`repo:tag`), or null when not baked in. */
	image: string | null;
	/** Sandbox/kernel image the deployment runs, or null when unset. */
	sandbox_image: string | null;
	/** ISO timestamp this replica/process started, or null when unset. */
	started_at: string | null;
	/** Replica identity (pod/host name), or null when unset. */
	replica: string | null;
	/** Node.js runtime version, or null when unknown. */
	node: string | null;
	/** Resolved adapter selectors, for at-a-glance ops/debugging. */
	backends: {
		storage: string;
		compute: string;
		auth: string;
	};
}
