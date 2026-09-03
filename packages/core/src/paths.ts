import type {
	CliAuthorizationId,
	OAuthAuthorizationId,
	OAuthClientId,
	IntegrationId,
	JobId,
	NotebookId,
	ProposalId,
	ProjectId,
	RunId,
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
	/** Optional packed copy fast path for restoring a synced sandbox. */
	workspaceArchive: string;
	workspacePrefix: string;
	workspaceFile: (rel: string) => string;
	/** Pull-source Git metadata, stored outside the workspace mirror. */
	gitPrefix: string;
	gitFile: (rel: string) => string;
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
	/** Short-lived CAS claim serializing mutations of the workspace namespace. */
	workspaceMutationClaim: string;
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
	proposal: (proposalId: ProposalId) => ProposalPaths;
	/** Prefix of the notebook's job definitions: `projects/{pid}/notebooks/{nid}/jobs/`. */
	jobsPrefix: string;
	jobIndexPrefix: string;
	jobIndex: (createdAt: string, jobId: JobId) => string;
	job: (jobId: JobId) => JobPaths;
}

export interface JobRunPaths {
	/** Prefix of everything under this run (record + captured outputs), for delete. */
	base: string;
	/** The run record (`run.json`): CAS-managed, written only by `JobRunService`. */
	record: string;
	/** Write-once captured HTML output of a finished run. */
	html: string;
	/** Write-once stdout+stderr of the export command (capped). */
	logs: string;
}

export interface JobPaths {
	/** Prefix of everything under this job (definition, occurrences, runs), for delete. */
	base: string;
	/** The job definition head (`job.json`): CAS-managed, written only by `JobsService`. */
	head: string;
	/**
	 * Scheduled-fire claims, one immutable create-if-absent object per occurrence,
	 * keyed by the occurrence's UTC minute (`20260902T0600Z.json`). The claim is
	 * the fire-exactly-once anchor across replicas and ticks.
	 */
	occurrencesPrefix: string;
	occurrence: (occurrenceKey: string) => string;
	/** Immutable newest-first index entries for paginating run history. */
	runIndexPrefix: string;
	runIndex: (runId: RunId) => string;
	runsPrefix: string;
	run: (runId: RunId) => JobRunPaths;
}

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function reverseRunId(runId: RunId): string {
	return Array.from(
		runId.slice(4),
		(char) => CROCKFORD_BASE32[31 - CROCKFORD_BASE32.indexOf(char)],
	).join('');
}

export interface ProposalPaths {
	base: string;
	meta: string;
	publication: string;
	change: (index: number) => string;
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
	/** CAS-owned project alert destinations. */
	alerts: string;
	notebook: (nid: NotebookId) => NotebookPaths;
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
	const git = `${prefix}/git`;
	return {
		code: `${prefix}/notebook.py`,
		deps: `${prefix}/pyproject.toml`,
		meta: `${prefix}/version.json`,
		workspaceArchive: `${prefix}/workspace.zip`,
		workspacePrefix: `${workspace}/`,
		workspaceFile: (rel: string) => `${workspace}/${rel}`,
		gitPrefix: `${git}/`,
		gitFile: (rel: string) => `${git}/${rel}`,
		html: `${prefix}/notebook.html`,
		session: `${prefix}/session.json`,
	};
}

function jobPaths(notebookBase: string, jobId: JobId): JobPaths {
	const base = `${notebookBase}/jobs/${jobId}`;
	return {
		base: `${base}/`,
		head: `${base}/job.json`,
		occurrencesPrefix: `${base}/occurrences/`,
		occurrence: (occurrenceKey: string) => `${base}/occurrences/${occurrenceKey}.json`,
		runIndexPrefix: `${base}/run-index/`,
		runIndex: (runId: RunId) => `${base}/run-index/${reverseRunId(runId)}.json`,
		runsPrefix: `${base}/runs/`,
		run: (runId: RunId) => {
			const runBase = `${base}/runs/${runId}`;
			return {
				base: `${runBase}/`,
				record: `${runBase}/run.json`,
				html: `${runBase}/output.html`,
				logs: `${runBase}/logs.txt`,
			};
		},
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
		workspaceMutationClaim: `${base}/workspace_mutation_claim.json`,
		// workspace/ = latest-only mirror of the sandbox working dir.
		// notebook.py + pyproject.toml are the always-present source files;
		// everything else is present only under PERSIST_WORKSPACE=workspace.
		workspacePrefix: `${workspace}/`,
		workspaceFile: (rel: string) => `${workspace}/${rel}`,
		code: `${workspace}/notebook.py`,
		deps: `${workspace}/pyproject.toml`,
		version: (vid: VersionId) => versionPaths(base, vid),
		jobsPrefix: `${base}/jobs/`,
		jobIndexPrefix: `${base}/job-index/`,
		jobIndex: (createdAt: string, jobId: JobId) => `${base}/job-index/${createdAt}_${jobId}.json`,
		job: (jobId: JobId) => jobPaths(base, jobId),
		proposal: (proposalId: ProposalId) => {
			const proposalBase = `${base}/proposals/${proposalId}`;
			return {
				base: `${proposalBase}/`,
				meta: `${proposalBase}/proposal.json`,
				publication: `${proposalBase}/publication.json`,
				change: (index: number) => `${proposalBase}/changes/${index}`,
			};
		},
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
		alerts: `${base}/alerts.json`,
		notebook: (nid: NotebookId) => notebookPaths(base, nid),
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
	versionPruneCutoff: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/version-prune-cutoffs/${projectId}/${notebookId}.json`,
	versionPruneCutoffsForProject: (projectId: ProjectId) =>
		`_system/version-prune-cutoffs/${projectId}/`,
	/**
	 * Per-notebook app-singleton claim (see `AppClaimSchema`): names the `run`
	 * session that owns the notebook's shared app sandbox. CAS-managed via
	 * `SessionService.claimApp`/`releaseApp` only.
	 */
	appClaim: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/apps/${projectId}/${notebookId}.json`,
	appClaimsForProject: (projectId: ProjectId) => `_system/apps/${projectId}/`,
	editorClaim: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/editors/${projectId}/${notebookId}.json`,
	editorClaimsForProject: (projectId: ProjectId) => `_system/editors/${projectId}/`,
	identity: (userId: UserId) => `_system/identities/${encodeURIComponent(userId)}.json`,
	identitiesPrefix: '_system/identities/',
	// One mutable record per personal access token, keyed by the id embedded in
	// the presented token so verification is a single GET (no index object).
	token: (tokenId: TokenId) => `_system/tokens/${tokenId}.json`,
	tokensPrefix: '_system/tokens/',
	cliAuthorization: (id: CliAuthorizationId) => `_system/cli-authorizations/${id}.json`,
	cliAuthorizationsPrefix: '_system/cli-authorizations/',
	cliDeviceUserCode: (code: string) => `_system/cli-device-user-codes/${code}.json`,
	cliDeviceUserCodesPrefix: '_system/cli-device-user-codes/',
	oauthClient: (id: OAuthClientId) => `_system/oauth-clients/${id}.json`,
	oauthClientsPrefix: '_system/oauth-clients/',
	oauthAuthorization: (id: OAuthAuthorizationId) => `_system/oauth-authorizations/${id}.json`,
	oauthAuthorizationsPrefix: '_system/oauth-authorizations/',
	eventsPrefix: '_system/events/',
	eventsForDate: (date: string) => `_system/events/${date}/`,
	event: (date: string, id: string) => `_system/events/${date}/${id}.json`,
	eventIdempotencyForDate: (date: string) => `_system/events/${date}/_idempotency/`,
	eventIdempotency: (date: string, id: string) =>
		`_system/events/${date}/_idempotency/${encodeURIComponent(id)}.json`,
	idempotencyPrefix: '_system/idempotency/',
	idempotencyKey: (digest: string) => `_system/idempotency/${digest}.json`,
	proposalPayloadMarkersPrefix: '_system/proposal-payloads/',
	proposalPayloadMarker: (projectId: ProjectId, notebookId: NotebookId, proposalId: ProposalId) =>
		`_system/proposal-payloads/${projectId}/${notebookId}/${proposalId}.json`,
	/**
	 * First-seen marker for a recordless sandbox the compute provider reports
	 * without a `createdAt`. Written once when the reconciler first observes such an
	 * orphan and deleted when it is reaped or vanishes — an append-only bound on how
	 * long a timestamp-less orphan can leak (see ReconciliationService Rule 3).
	 */
	reconcileOrphansPrefix: '_system/reconcile/orphans/',
	reconcileOrphan: (sandboxId: SandboxId) =>
		`_system/reconcile/orphans/${encodeURIComponent(sandboxId)}.json`,
	sandboxDiagnosticLeasesPrefix: '_system/sandbox-diagnostics/',
	sandboxDiagnosticLease: (userId: UserId) =>
		`_system/sandbox-diagnostics/${encodeURIComponent(userId)}.json`,
	/**
	 * One immutable marker per run. Terminal markers remain until the scheduler
	 * completes the run's durable finalization work.
	 */
	jobRunMarkersPrefix: '_system/job-runs/',
	jobRunMarkersForProject: (projectId: ProjectId) => `_system/job-runs/${projectId}/`,
	jobRunMarker: (projectId: ProjectId, runId: RunId) =>
		`_system/job-runs/${projectId}/${runId}.json`,
	jobOperationClaimsForProject: (projectId: ProjectId) => `_system/job-operations/${projectId}/`,
	jobOperationClaimsForNotebook: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/job-operations/${projectId}/${notebookId}/`,
	jobOperationClaim: (projectId: ProjectId, notebookId: NotebookId, jobId: JobId) =>
		`_system/job-operations/${projectId}/${notebookId}/${jobId}.json`,
	jobDeletionClaimsForProject: (projectId: ProjectId) => `_system/job-deletions/${projectId}/`,
	jobDeletionClaimsForNotebook: (projectId: ProjectId, notebookId: NotebookId) =>
		`_system/job-deletions/${projectId}/${notebookId}/`,
	jobDeletionClaim: (projectId: ProjectId, notebookId: NotebookId, jobId: JobId) =>
		`_system/job-deletions/${projectId}/${notebookId}/${jobId}.json`,
	/** Advisory lease guarding the single-writer maintenance sweep (see MaintenanceLock). */
	maintenanceLock: '_system/_maintenance.lock',
	/** Advisory lease for the session-lifecycle sweep — its own key, so the two loops
	 * (which share a replica and holder id) can never release each other's lease. */
	sessionLifecycleLock: '_system/_session_lifecycle.lock',
	/** Advisory lease for the job scheduler tick — its own key for the same reason. */
	jobSchedulerLock: '_system/_jobs.lock',
	/**
	 * Org-scoped integration instance, inherited by every project:
	 * `_system/integrations/{iid}/…`. Same layout and mutability classes as the
	 * project-scoped tree (CAS-managed head, immutable versions, per-name claim),
	 * written only by `OrgIntegrationsStore`.
	 */
	orgIntegration: (iid: IntegrationId) => integrationPaths('_system', iid),
	orgIntegrationsPrefix: '_system/integrations/',
	orgIntegrationNameClaim: (name: string) =>
		`_system/integrations/_names/${encodeURIComponent(name)}.json`,
	project: projectPaths,
} as const;
