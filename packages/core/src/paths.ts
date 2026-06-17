import type { NotebookId, ProjectId, SessionId, SnapshotId, UserId, VersionId } from './ids';

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

export interface ProjectPaths {
	meta: string;
	notebook: (nid: NotebookId) => NotebookPaths;
	/** Project-scoped secret entry: `projects/{pid}/secrets/<name>.json`. */
	secret: (name: string) => string;
	/** Prefix of the project's secrets: `projects/{pid}/secrets/`. */
	secretsPrefix: string;
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

function projectPaths(pid: ProjectId): ProjectPaths {
	const base = `projects/${pid}`;
	return {
		meta: `${base}/project.json`,
		notebook: (nid: NotebookId) => notebookPaths(base, nid),
		secret: (name: string) => `${base}/secrets/${encodeURIComponent(name)}.json`,
		secretsPrefix: `${base}/secrets/`,
	};
}

export const paths = {
	catalog: '_system/catalog.json',
	snapshot: (id: SnapshotId) => `_system/snapshots/${id}.json`,
	snapshotsPrefix: '_system/snapshots/',
	// Sessions are partitioned by project so a project-scoped read
	// (`listActiveByProject`, `findReusable`) lists only `_system/sessions/{pid}/`
	// instead of the whole prefix. Deployment-wide sweeps (reaper, per-user count)
	// still list `sessionsPrefix` recursively. See plan 029.
	session: (projectId: ProjectId, id: SessionId) => `_system/sessions/${projectId}/${id}.json`,
	sessionsPrefix: '_system/sessions/',
	sessionsForProject: (projectId: ProjectId) => `_system/sessions/${projectId}/`,
	identity: (userId: UserId) => `_system/identities/${encodeURIComponent(userId)}.json`,
	identitiesPrefix: '_system/identities/',
	eventsPrefix: '_system/events/',
	eventsForDate: (date: string) => `_system/events/${date}/`,
	event: (date: string, id: string) => `_system/events/${date}/${id}.json`,
	idempotencyPrefix: '_system/idempotency/',
	idempotencyKey: (digest: string) => `_system/idempotency/${digest}.json`,
	/** Advisory lease guarding the single-writer maintenance sweep (see MaintenanceLock). */
	maintenanceLock: '_system/_maintenance.lock',
	/** Advisory lease for the session-lifecycle sweep — its own key, so the two loops
	 * (which share a replica and holder id) can never release each other's lease. */
	sessionLifecycleLock: '_system/_session_lifecycle.lock',
	project: projectPaths,
} as const;
