import type { Bucket } from '../ports/bucket';
import { noopMetrics } from '../ports/metrics';
import type { Metrics } from '../ports/metrics';
import type { NotebookId, ProjectId, SessionId, UserId } from '../ids';
import { paths } from '../paths';
import { traced } from '../tracing';
import type { AttrExtractors } from '../tracing';
import { CatalogService } from './catalog/CatalogService';
import { EventService } from './catalog/EventService';
import { IdempotencyService } from './catalog/IdempotencyService';
import { IdentityService } from './identity/IdentityService';
import { MaintenanceService } from './catalog/MaintenanceService';
import { NotebookService } from './content/NotebookService';
import { ProjectService } from './content/ProjectService';
import { SessionService } from './runtime/SessionService';
import { TokenService } from './tokens/TokenService';

export { CatalogService } from './catalog/CatalogService';
export { EventService, MAX_EVENT_RANGE_DAYS } from './catalog/EventService';
export { IdempotencyService } from './catalog/IdempotencyService';
export { SyncedNotebookService } from './content/SyncedNotebookService';
export { IdentityService } from './identity/IdentityService';
export { MaintenanceService } from './catalog/MaintenanceService';
export type { ExpireSnapshotsOptions, PruneEventsOptions } from './catalog/MaintenanceService';
export { MaintenanceLock } from './catalog/MaintenanceLock';
export { MAX_VERSIONS, NotebookService } from './content/NotebookService';
export type {
	CreateSyncedNotebookInput,
	SyncNotebookInput,
	UpdateSyncedNotebookSourceInput,
} from '../integrations/syncedSource';
export { ProjectService } from './content/ProjectService';
export { AesGcmSecretCodec } from './secrets/AesGcmSecretCodec';
export type { AesGcmSecretCodecOptions } from './secrets/AesGcmSecretCodec';
export { assertValidEnvironmentName } from './integrations/environmentName';
export {
	MAX_INTEGRATIONS_PER_SCOPE,
	OrgIntegrationsStore,
	ProjectIntegrationsStore,
} from './integrations/ProjectIntegrationsStore';
export type { IntegrationsStoreOptions } from './integrations/ProjectIntegrationsStore';
export type { OrgIntegrationsService, ProjectIntegrationsService } from './integrations/contracts';
export { IntegrationRegistry } from './integrations/registry';
export { defineIntegration, envSegment } from './integrations/sdk';
export type { IntegrationDefinition, RenderInput, RenderOutput } from './integrations/sdk';
export { SECRET_MARK, zSecret } from './integrations/secretFields';
export {
	assertValidIntegrationName,
	INTEGRATIONS_DIR,
	INTEGRATIONS_DIR_ENV,
} from './integrations/bundle';
export {
	athena,
	azureBlob,
	bigquery,
	clickhouse,
	customEnv,
	databricks,
	defaultRegistry,
	gcs,
	huggingFace,
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergRest,
	icebergSql,
	mongodb,
	motherduck,
	mysql,
	postgres,
	pyspark,
	redshift,
	s3,
	snowflake,
	sqlserver,
	trino,
	wandb,
} from './integrations/kinds';
export { ReconciliationService } from './runtime/ReconciliationService';
export type { ReconcileResult } from './runtime/ReconciliationService';
export { kernelActiveConnections, SessionLifecycleService } from './runtime/sessionLifecycle';
export type {
	ConnectionProbe,
	SessionLifecycleConfig,
	SweepResult,
} from './runtime/sessionLifecycle';
export {
	bearerToken,
	hashPatSecret,
	isPatRequest,
	isPersonalAccessToken,
	PAT_PREFIX,
	TokenService,
} from './tokens/TokenService';
export type { CreatedToken, CreateTokenInput } from './tokens/TokenService';
export { composeAuthenticators } from './tokens/composeAuthenticators';
export { listAllKeys } from './catalog/storage';
export {
	mutateObject,
	mutateObjectWithOutcome,
	withCasRetry,
	type CasRetryOptions,
	type CasWriter,
	type ObjectMutationOutcome,
} from './catalog/cas';
export {
	createWorkspaceLoadStrategies,
	DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
	SandboxProvisioner,
} from './runtime/SandboxProvisioner';
export type {
	BucketConfig,
	ProvisionOptions,
	ProvisionResult,
	SessionEnv,
	WorkspaceLoadContext,
	WorkspaceLoadStrategies,
	WorkspaceLoadStrategy,
} from './runtime/SandboxProvisioner';
export { captureWorkspace, restoreWorkspace } from './runtime/sandboxFiles';
export { ProxyExposure, SubdomainExposure } from './runtime/sandboxExposure';
export {
	ACTIVE_STATUSES,
	isTerminal,
	MODE_POLICY,
	nextStatus,
	PRESENT_STATUSES,
	type SessionEvent,
	sessionMode,
	type SessionModePolicy,
	sessionModePolicy,
	sessionPersistsEdits,
	TERMINAL_STATUSES,
} from './runtime/sessionState';
export {
	canStartSessionMode,
	type SessionAction,
	type SessionActor,
	sessionCan,
	sessionGrants,
} from './runtime/sessionAuthz';
export { signProxyToken, verifyProxyToken } from './runtime/proxyToken';
export { resolveBaseImage } from './runtime/resolveBaseImage';
export { probeKernelLiveness } from './runtime/kernelProbe';
export type { KernelLiveness, KernelProbe, KernelProbeOptions } from './runtime/kernelProbe';
export { runPreflight } from './runtime/preflight';
export type {
	CheckOutcome,
	CheckResult,
	CheckStatus,
	PreflightCheck,
	PreflightReport,
	RunPreflightOptions,
} from './runtime/preflight';
export { WorkloadIdentityIssuer } from './identity/WorkloadIdentityIssuer';
export type { WifClaims, JwksKey } from './identity/WorkloadIdentityIssuer';
export { s3CredsToEnv } from './identity/s3CredsEnv';
export { exchangeFederatedStorageEnv, projectSubject } from './identity/federation';
export {
	buildMarimoAiToml,
	marimoAiContributor,
	mintAiSessionToken,
	verifyAiSessionToken,
	MARIMOHUB_AI_PROVIDER,
} from './ai/aiSessionConfig';
export type { AiSessionConfig, AiTokenClaims } from './ai/aiSessionConfig';
export {
	assembleMarimoToml,
	marimoConfigToSessionEnv,
	marimoNotebookDefaults,
	marimoSharingDisabled,
} from './marimoConfig';
export type { MarimoConfigContributor } from './marimoConfig';
export {
	captureFilesystemSnapshot,
	createOrRestoreSandbox,
	reapFilesystemSnapshots,
	resolveRestoreSnapshot,
} from './content/filesystemSnapshots';
export { SessionService } from './runtime/SessionService';
export { SessionRetirer, TakeoverRetirementError } from './runtime/SessionRetirer';
export type { SessionRetirerDeps } from './runtime/SessionRetirer';

// Attribute allowlists for the traced wrappers below: stable identifiers and
// bucket keys only — never raw arguments, which can carry secrets (the PAT
// bearer in TokenService.verify, emails in IdentityService.getByEmail/search,
// notebook content).
const project = (id: ProjectId) => ({ 'marimohub.project_id': id });
const user = (id: UserId) => ({ 'marimohub.user_id': id });
const notebook = (projectId: ProjectId, notebookId: NotebookId) => ({
	...project(projectId),
	'marimohub.notebook_id': notebookId,
});
const session = (projectId: ProjectId, id: SessionId) => ({
	...project(projectId),
	'marimohub.session_id': id,
});
const bucketKey = (key: string | string[]) => ({ 'bucket.key': key });
const scope = (scope: string) => ({ 'marimohub.scope': scope });

const bucketAttrs: AttrExtractors<Bucket> = {
	get: bucketKey,
	head: bucketKey,
	put: bucketKey,
	delete: bucketKey,
	list: (options) => ({ 'bucket.prefix': options?.prefix }),
};

export interface CreateServicesOptions {
	/**
	 * Wrap the bucket and every service in OTEL spans (one per method call).
	 * Enable only when a global tracer provider is registered — otherwise the
	 * wrappers pay Proxy overhead to produce non-recording spans.
	 */
	tracing?: boolean;
}

/**
 * Compose the domain services over a bucket. `metrics` is optional and defaults
 * to a no-op, so tests and library-mode callers are unaffected; entrypoints pass
 * a real emitter (e.g. the wide-event logger) to light up observability.
 */
export function createServices(
	rawBucket: Bucket,
	metrics: Metrics = noopMetrics,
	options?: CreateServicesOptions,
) {
	const wrap = <T extends object>(name: string, service: T, attrs?: AttrExtractors<T>): T =>
		options?.tracing ? traced(name, service, attrs) : service;

	// Wrapped as constructed, so cross-service calls (NotebookService →
	// CatalogService → Bucket) are traced too.
	const bucket = wrap('Bucket', rawBucket, bucketAttrs);
	const events = wrap('EventService', new EventService(bucket), {
		append: (event) => ({ 'marimohub.event': event.event, ...user(event.actor) }),
		getEvents: (date) => ({ 'marimohub.date': date }),
	});
	const catalog = wrap('CatalogService', new CatalogService(bucket, metrics, events), {
		initialize: user,
	});
	const projects = wrap('ProjectService', new ProjectService(bucket, catalog, metrics), {
		getProject: project,
		updateProject: project,
		deleteProject: project,
		hardDeleteProject: project,
		addMember: project,
		updateMemberRole: project,
		removeMember: project,
	});
	const notebooks = wrap('NotebookService', new NotebookService(bucket, catalog, metrics), {
		listNotebooks: project,
		createNotebook: project,
		getNotebook: notebook,
		getNotebookContent: notebook,
		duplicateNotebook: notebook,
		updateNotebook: notebook,
		restoreVersion: notebook,
		commitSession: notebook,
		deleteNotebook: notebook,
		hardDeleteNotebook: notebook,
		listVersions: notebook,
		getVersion: notebook,
		getLatestHtmlSnapshot: notebook,
		getFsSnapshot: notebook,
		setFsSnapshot: notebook,
	});
	const sessions = wrap('SessionService', new SessionService(bucket, metrics), {
		createSession: (input) => ({
			...notebook(input.project_id, input.notebook_id),
			...user(input.user_id),
		}),
		getSession: session,
		setRunning: session,
		extendExpiry: session,
		markSnapshotted: session,
		markSandboxReclaimed: session,
		heartbeat: session,
		beginTerminating: session,
		markTerminated: session,
		terminate: session,
		markFailed: session,
		listSessions: (notebookId) => ({ 'marimohub.notebook_id': notebookId }),
		listActiveByProject: project,
		countActiveAppsForProject: project,
		listActiveAppsForProject: project,
		countActiveForUser: user,
	});
	const identities = wrap('IdentityService', new IdentityService(bucket), {
		get: user,
		isSuspended: user,
		setSuspension: user,
	});
	const tokens = wrap('TokenService', new TokenService(bucket, identities), {
		list: user,
		revoke: (userId, tokenId) => ({ ...user(userId), 'marimohub.token_id': tokenId }),
	});
	const maintenance = wrap('MaintenanceService', new MaintenanceService(bucket, metrics));
	const idempotency = wrap('IdempotencyService', new IdempotencyService(bucket), {
		lookup: scope,
		record: scope,
	});
	return {
		catalog,
		events,
		projects,
		notebooks,
		sessions,
		identities,
		tokens,
		maintenance,
		idempotency,
	};
}

/**
 * Ensures the catalog and a default project exist.
 * Uses a cheap head() check — only does full init on first call.
 */
export async function ensureInitialized(bucket: Bucket, actor: UserId): Promise<void> {
	const exists = await bucket.head(paths.catalog);
	if (exists) return;

	const services = createServices(bucket);
	// initialize() is now atomic (create-if-absent on catalog.json), so concurrent
	// callers converge on a single catalog rather than clobbering one another.
	await services.catalog.initialize(actor);

	// Re-read snapshot in case a concurrent request already created the default
	// project. The default-project guard relies on createProject's CAS: a
	// concurrent default create is bounded by that CAS plus the length === 0
	// check, so a rare duplicate default project is acceptable (idempotency of
	// project creation is tracked separately). Do not add a lock here.
	const snapshot = await services.catalog.getCurrentSnapshot();
	if (snapshot.projects.length === 0) {
		await services.projects.createProject(
			{ name: 'My Projects', description: 'Default project' },
			actor,
		);
	}
}
