import type { Bucket } from '../ports/bucket';
import { noopMetrics } from '../ports/metrics';
import type { Metrics } from '../ports/metrics';
import type { UserId } from '../ids';
import { paths } from '../paths';
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
export { EventService } from './catalog/EventService';
export { IdempotencyService } from './catalog/IdempotencyService';
export { SyncedNotebookService } from './content/SyncedNotebookService';
export { IdentityService } from './identity/IdentityService';
export { MaintenanceService } from './catalog/MaintenanceService';
export type { ExpireSnapshotsOptions, PruneEventsOptions } from './catalog/MaintenanceService';
export { MaintenanceLock } from './catalog/MaintenanceLock';
export { MAX_VERSIONS, NotebookService } from './content/NotebookService';
export type { CreateSyncedNotebookInput, SyncNotebookInput } from '../integrations/syncedSource';
export { ProjectService } from './content/ProjectService';
export { ProjectSecretsStore } from './secrets/ProjectSecretsStore';
export type { ProjectSecretsStoreOptions } from './secrets/ProjectSecretsStore';
export { assertValidSecretName } from './secrets/secretName';
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
export { mutateObject, withCasRetry, type CasRetryOptions } from './catalog/cas';
export { createWorkspaceLoadStrategies, SandboxProvisioner } from './runtime/SandboxProvisioner';
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
	nextStatus,
	PRESENT_STATUSES,
	type SessionEvent,
	TERMINAL_STATUSES,
} from './runtime/sessionState';
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
	aiConfigToSessionEnv,
	buildMarimoAiToml,
	mintAiSessionToken,
	verifyAiSessionToken,
	MARIMOHUB_AI_PROVIDER,
} from './ai/aiSessionConfig';
export type { AiSessionConfig, AiTokenClaims, SessionEnvFragment } from './ai/aiSessionConfig';
export {
	captureFilesystemSnapshot,
	createOrRestoreSandbox,
	reapFilesystemSnapshots,
	resolveRestoreSnapshot,
} from './content/filesystemSnapshots';
export { SessionService } from './runtime/SessionService';

/**
 * Compose the domain services over a bucket. `metrics` is optional and defaults
 * to a no-op, so tests and library-mode callers are unaffected; entrypoints pass
 * a real emitter (e.g. the wide-event logger) to light up observability.
 */
export function createServices(bucket: Bucket, metrics: Metrics = noopMetrics) {
	const events = new EventService(bucket);
	const catalog = new CatalogService(bucket, metrics, events);
	const projects = new ProjectService(bucket, catalog, metrics);
	const notebooks = new NotebookService(bucket, catalog, metrics);
	const sessions = new SessionService(bucket, metrics);
	const identities = new IdentityService(bucket);
	const tokens = new TokenService(bucket, identities);
	const maintenance = new MaintenanceService(bucket, metrics);
	const idempotency = new IdempotencyService(bucket);
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
