// Shared domain enums — the single source of truth for the small set of closed
// string unions used across the schema, services, and the API layer. Kept here
// (rather than inline `z.enum([...])`) so the core persistence schemas and the
// API response schemas validate against the same list instead of two hand-kept
// copies that can drift.

/** Lifecycle of a notebook. 'deleted' is a soft-delete tombstone. */
export const NOTEBOOK_STATUSES = ['draft', 'active', 'archived', 'deleted'] as const;
export type NotebookStatus = (typeof NOTEBOOK_STATUSES)[number];

/** Lifecycle of a project. 'deleted' is a soft-delete tombstone. */
export const PROJECT_STATUSES = ['active', 'deleted'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Lifecycle of a kernel session. Live: `starting` (provisioning), `running`.
 * Leaving: `terminating` (stop requested, teardown in flight). Terminal (sticky):
 * `terminated` (clean stop), `failed` (provision/runtime error), `expired` (TTL).
 * Transitions are enforced by `services/runtime/sessionState.ts`.
 */
export const SESSION_STATUSES = [
	'starting',
	'running',
	'terminating',
	'terminated',
	'failed',
	'expired',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * How a session's kernel serves the notebook. `edit` is the marimo editor
 * (shared, exclusive, or discard-only according to its policy); `app` serves it read-only via
 * `marimo run` — a per-notebook singleton shared by all editors, provisioned
 * copy-only, never written back. Named for what the user gets (an app), not
 * the CLI subcommand that implements it.
 */
export const SESSION_MODES = ['edit', 'app'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Whether project editors share one persistent sandbox or use exclusive ownership. */
export const EDITOR_SANDBOX_SHARING_VALUES = ['shared', 'exclusive'] as const;
export type EditorSandboxSharing = (typeof EDITOR_SANDBOX_SHARING_VALUES)[number];

/** Where a notebook's source lives. `git` = a git repo push-synced from an external host. */
export const SOURCE_TYPES = ['local', 'git'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Project membership roles, ordered low→high privilege by `RANK` in authz.ts
 * (`viewer` < `editor` < `manager` < `admin`). Each role subsumes the ones
 * below it.
 *
 * - `viewer`  — read-only: list/open projects & notebooks, read notebook code
 *   and versions. Cannot mutate anything.
 * - `editor`  — everything a viewer can, plus create/update/delete notebooks,
 *   save versions, and start/stop kernel sessions. Cannot change the project
 *   itself or its membership.
 * - `manager` — everything an editor can, plus update/delete the project and
 *   manage its members.
 * - `admin`   — reserved for project owners, deployment super admins, and
 *   grandfathered member rows. It currently has the same project capabilities
 *   as manager. A project's `owner` is implicitly `admin`.
 *
 * The deployment-wide fallback for a logged-in non-member is set by
 * `MARIMOHUB_DEFAULT_ROLE` (see authz.ts `effectiveRole`); `none` there means
 * non-members get no role and cannot even see the project.
 */
export const ROLES = ['admin', 'manager', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that project managers may grant to members and deployment defaults. */
export const ASSIGNABLE_ROLES = ['manager', 'editor', 'viewer'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * What an effective `viewer` gets (config: MARIMOHUB_VIEWER_MODE), ordered
 * least → most access; each tier is a superset of the previous. `static`
 * serves the last captured HTML snapshot — no compute, no code execution.
 * `applications` additionally admits viewers to the shared notebook app.
 * `ephemeral-sandbox` additionally provisions a real edit kernel whose session
 * is never written back (no version, snapshot, or workspace mutation on
 * teardown). Editors and above are unaffected.
 */
export const VIEWER_MODES = ['static', 'applications', 'ephemeral-sandbox'] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];

/**
 * The session modes an effective viewer may start or attach to, per viewer
 * mode — the single table behind every viewer-admission branch. What the
 * admitted session IS comes from `MODE_POLICY[mode].viewerSession`.
 */
export const VIEWER_SESSION_MODES: Record<ViewerMode, readonly SessionMode[]> = {
	static: [],
	applications: ['app'],
	'ephemeral-sandbox': ['app', 'edit'],
};

/**
 * The `VIEWER_SESSION_MODES` row for a possibly-unset viewer mode. Unset — and
 * any out-of-enum value an untyped library caller wires into the policy —
 * fails closed to `static` (grant nothing) instead of throwing inside an
 * authorization gate.
 */
export function viewerSessionModes(mode: ViewerMode | undefined): readonly SessionMode[] {
	return VIEWER_SESSION_MODES[mode ?? 'static'] ?? VIEWER_SESSION_MODES.static;
}

/** Port the marimo kernel listens on inside every sandbox (provisioner + probes). */
export const MARIMO_PORT = 2718;

// Size caps — the single source of truth for the memory ceilings that keep a
// single oversized file from OOMing the service. Bucket adapters buffer an
// object's whole body inside `get()`, and the sandbox seam is request/response
// (buffered) in every compute adapter, so we never stream — instead we refuse to
// read/accept anything past these caps. Enforced via the size known *before* the
// read (`BucketObject.size` / `FileInfo.size`) so the bytes are never buffered.

/**
 * Per-file cap for the workspace round-trip (restore from / capture into the
 * bucket). A single file beyond this is skipped (logged) rather than read into
 * memory, where it would also be base64-inflated ~1.33×.
 */
export const MAX_WORKSPACE_FILE_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Per-file cap for session artifacts read off the sandbox on teardown (marimo's
 * rendered HTML and session JSON, plus the source files). An artifact beyond
 * this is omitted rather than buffered into a string.
 */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Cap on inbound HTTP request bodies. The API buffers request bodies in full
 * (Hono parses JSON in memory), so this bounds the ingest path (e.g. notebook
 * code POSTs) before anything is buffered.
 */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Max concurrent object reads when a service scans a prefix (list-then-get-each).
 * Object storage handles high request concurrency well, so this turns an N-round-
 * trip sequential scan into bounded-parallel fan-out — bounded so a huge prefix
 * can't open unbounded sockets. Used with `mapWithConcurrency`.
 */
export const BUCKET_SCAN_CONCURRENCY = 16;

/**
 * Max concurrent object writes when a saga step persists a batch of blobs (e.g. a
 * notebook create, or a git-sync push whose file count is unbounded). Bounds the
 * fan-out so a large push can't fire thousands of simultaneous puts. Used by
 * `compensableWrite`.
 */
export const BUCKET_WRITE_CONCURRENCY = 16;
