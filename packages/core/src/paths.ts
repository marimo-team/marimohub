import type {
	IntegrationId,
	NotebookId,
	ProjectId,
	SandboxId,
	SessionId,
	SnapshotId,
	TokenId,
	UserId,
	VersionId,
} from './ids';

export interface VersionPaths {
	code: string;
	deps: string;
	meta: string;
	workspacePrefix: string;
	workspaceFile: (rel: string) => string;
	/** Optional rendered HTML snapshot captured on teardown (`notebook.html`). */
	html: string;
	/** Optional marimo session-state snapshot captured on teardown (`session.json`). */
	session: string;
}

export interface NotebookPaths {
	/** Base directory: `projects/{pid}/notebooks/{nid}` */
	base: string;
	meta: string;
	readme: string;
	source: string;
	integrationSyncToken: string;
	/**
	 * Pointer to the notebook's current CoreWeave-native filesystem snapshot
	 * (`fs_snapshot.json`). A per-notebook, mutable, last-writer-wins sidecar —
	 * written ONLY by the snapshot path, never by commitSession/update/delete, so
	 * those teardown-path rewrites of meta.json/source.json cannot clobber it.
	 * Present only when MARIMOHUB_COMPUTE_COREWEAVE_FILESYSTEM_SNAPSHOT is enabled.
	 */
	fsSnapshot: string;
	/**
	 * Prefix of the `workspace/` folder: `projects/{pid}/notebooks/{nid}/workspace/`.
	 * `workspace/` is the latest-only mirror of the sandbox working directory.
	 */
	workspacePrefix: string;
	/** Key for a file at `rel` inside `workspace/`, e.g. `workspaceFile('data/cars.csv')`. */
	workspaceFile: (rel: string) => string;
	code: string;
	deps: string;
	version: (vid: VersionId) => VersionPaths;
}

export interface IntegrationPaths {
	/**
	 * The integration's head record (`integration.json`): kind, name, enabled,
	 * `current_version` pointer. CAS-managed via `mutateObject` — written only by
	 * `ProjectIntegrationsStore`.
	 */
	head: string;
	/** Immutable config-version record, keyed by zero-padded version number. */
	version: (n: number) => string;
	/** Prefix of everything under this integration (head + versions), for delete. */
	base: string;
}

export interface ProjectPaths {
	meta: string;
	notebook: (nid: NotebookId) => NotebookPaths;
	/** Project-scoped secret entry: `projects/{pid}/secrets/<name>.json`. */
	secret: (name: string) => string;
	/** Prefix of the project's secrets: `projects/{pid}/secrets/`. */
	secretsPrefix: string;
	/** Project-scoped integration instance: `projects/{pid}/integrations/{iid}/…`. */
	integration: (iid: IntegrationId) => IntegrationPaths;
	/** Prefix of the project's integrations: `projects/{pid}/integrations/`. */
	integrationsPrefix: string;
	/**
	 * Per-name singleton claim anchoring integration-name uniqueness (the same
	 * claim class as the app claim; see `SingletonClaimConfig`). `_names` cannot
	 * collide with an instance dir — ids are always `intg-…`.
	 */
	integrationNameClaim: (name: string) => string;
}

function versionPaths(base: string, vid: VersionId): VersionPaths {
	const prefix = `${base}/versions/${vid}`;
	const workspace = `${prefix}/workspace`;
	return {
		code: `${prefix}/notebook.py`,
		deps: `${prefix}/pyproject.toml`,
		meta: `${prefix}/version.json`,
		workspacePrefix: `${workspace}/`,
		workspaceFile: (rel: string) => `${workspace}/${rel}`,
		html: `${prefix}/notebook.html`,
		session: `${prefix}/session.json`,
	};
}

function notebookPaths(projectBase: string, nid: NotebookId): NotebookPaths {
	const base = `${projectBase}/notebooks/${nid}`;
	const workspace = `${base}/workspace`;
	return {
		base,
		meta: `${base}/meta.json`,
		readme: `${base}/README.md`,
		source: `${base}/source.json`,
		integrationSyncToken: `${base}/integration_sync_token.json`,
		fsSnapshot: `${base}/fs_snapshot.json`,
		// workspace/ = latest-only mirror of the sandbox working dir.
		// notebook.py + pyproject.toml are the always-present source files;
		// everything else is present only under PERSIST_WORKSPACE=workspace.
		workspacePrefix: `${workspace}/`,
		workspaceFile: (rel: string) => `${workspace}/${rel}`,
		code: `${workspace}/notebook.py`,
		deps: `${workspace}/pyproject.toml`,
		version: (vid: VersionId) => versionPaths(base, vid),
	};
}

// Version keys are zero-padded so lexicographic key order == version order
// (mirroring the ULID convention for events/versions). 6 digits bounds a single
// integration at 999,999 config revisions — far past any real edit history.
const INTEGRATION_VERSION_PAD = 6;

function integrationPaths(projectBase: string, iid: IntegrationId): IntegrationPaths {
	const base = `${projectBase}/integrations/${iid}`;
	return {
		base: `${base}/`,
		head: `${base}/integration.json`,
		version: (n: number) =>
			`${base}/versions/${String(n).padStart(INTEGRATION_VERSION_PAD, '0')}.json`,
	};
}

function projectPaths(pid: ProjectId): ProjectPaths {
	const base = `projects/${pid}`;
	return {
		meta: `${base}/project.json`,
		notebook: (nid: NotebookId) => notebookPaths(base, nid),
		secret: (name: string) => `${base}/secrets/${encodeURIComponent(name)}.json`,
		secretsPrefix: `${base}/secrets/`,
		integration: (iid: IntegrationId) => integrationPaths(base, iid),
		integrationsPrefix: `${base}/integrations/`,
		integrationNameClaim: (name: string) =>
			`${base}/integrations/_names/${encodeURIComponent(name)}.json`,
	};
}

export const paths = {
	catalog: '_system/catalog.json',
	snapshot: (id: SnapshotId) => `_system/snapshots/${id}.json`,
	snapshotsPrefix: '_system/snapshots/',
	// Sessions are partitioned by project so a project-scoped read
	// (`listActiveByProject`, `findReusable`) lists only `_system/sessions/{pid}/`
	// instead of the whole prefix. Deployment-wide sweeps (reaper, per-user count)
	// still list `sessionsPrefix` recursively.
	session: (projectId: ProjectId, id: SessionId) => `_system/sessions/${projectId}/${id}.json`,
	sessionsPrefix: '_system/sessions/',
	sessionsForProject: (projectId: ProjectId) => `_system/sessions/${projectId}/`,
	/**
	 * Per-notebook app-singleton claim (see `AppClaimSchema`): names the `run`
	 * session that owns the notebook's shared app sandbox. CAS-managed via
	 * `SessionService.claimApp`/`releaseApp` only.
	 */
	appClaim: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/apps/${projectId}/${notebookId}.json`,
	appClaimsForProject: (projectId: ProjectId) => `_system/apps/${projectId}/`,
	identity: (userId: UserId) => `_system/identities/${encodeURIComponent(userId)}.json`,
	identitiesPrefix: '_system/identities/',
	// One mutable record per personal access token, keyed by the id embedded in
	// the presented token so verification is a single GET (no index object).
	token: (tokenId: TokenId) => `_system/tokens/${tokenId}.json`,
	tokensPrefix: '_system/tokens/',
	eventsPrefix: '_system/events/',
	eventsForDate: (date: string) => `_system/events/${date}/`,
	event: (date: string, id: string) => `_system/events/${date}/${id}.json`,
	idempotencyPrefix: '_system/idempotency/',
	idempotencyKey: (digest: string) => `_system/idempotency/${digest}.json`,
	/**
	 * First-seen marker for a recordless sandbox the compute provider reports
	 * without a `createdAt`. Written once when the reconciler first observes such an
	 * orphan and deleted when it is reaped or vanishes — an append-only bound on how
	 * long a timestamp-less orphan can leak (see ReconciliationService Rule 3).
	 */
	reconcileOrphansPrefix: '_system/reconcile/orphans/',
	reconcileOrphan: (sandboxId: SandboxId) =>
		`_system/reconcile/orphans/${encodeURIComponent(sandboxId)}.json`,
	/** Advisory lease guarding the single-writer maintenance sweep (see MaintenanceLock). */
	maintenanceLock: '_system/_maintenance.lock',
	/** Advisory lease for the session-lifecycle sweep — its own key, so the two loops
	 * (which share a replica and holder id) can never release each other's lease. */
	sessionLifecycleLock: '_system/_session_lifecycle.lock',
	project: projectPaths,
} as const;
