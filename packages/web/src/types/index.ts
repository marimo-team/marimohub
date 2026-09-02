// The API response shapes are defined ONCE, in the core zod schemas, surfaced
// through the OpenAPI document, and code-generated into `@marimo-hub/client`.
// The web consumes those generated types here instead of re-declaring them, so
// a field added in core flows through to the UI without a parallel hand-written
// copy drifting out of sync.

import type {
	components,
	paths,
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
	DeploymentInfo as ClientDeploymentInfo,
	User as ClientUser,
	IntegrationKind as ClientIntegrationKind,
	IntegrationEntry as ClientIntegrationEntry,
	IntegrationDetail as ClientIntegrationDetail,
	IntegrationTestResult as ClientIntegrationTestResult,
	IntegrationBrowseCapability as ClientIntegrationBrowseCapability,
	IntegrationBrowseNamespacePage as ClientIntegrationBrowseNamespacePage,
	IntegrationBrowseTablePage as ClientIntegrationBrowseTablePage,
	IntegrationTableSchema as ClientIntegrationTableSchema,
	IntegrationTablePreview as ClientIntegrationTablePreview,
	IntegrationObjectBucket as ClientIntegrationObjectBucket,
	IntegrationObjectEntry as ClientIntegrationObjectEntry,
	IntegrationObjectDetail as ClientIntegrationObjectDetail,
	IntegrationObjectVersion as ClientIntegrationObjectVersion,
	IntegrationObjectPreview as ClientIntegrationObjectPreview,
	ResolvedUser as ClientResolvedUser,
	ApiToken as ClientApiToken,
	ApiTokenCreated as ClientApiTokenCreated,
	AuditLogEntry as ClientAuditLogEntry,
	AuditLogPage as ClientAuditLogPage,
	AdminUser as ClientAdminUser,
	DeploymentConfig as ClientDeploymentConfig,
	SandboxStartupReport as ClientSandboxStartupReport,
	ApiResponse as ClientApiResponse,
	ApiError as ClientApiError,
} from '@marimo-hub/client';

// Aliases onto the generated client types. Names kept stable so existing web
// imports (`ProjectSummary`, `NotebookEntry`, ...) continue to work.
export type ProjectSummary = SnapshotProjectEntry;
type ProjectListQuery = NonNullable<paths['/api/v1/projects']['get']['parameters']['query']>;
export type ProjectListFilters = Pick<ProjectListQuery, 'q' | 'status' | 'tag'>;
/** The full project meta returned by `GET /api/v1/projects/:id` (includes `federation`). */
export type ProjectDetail = ClientProject;
/** Per-project workload-identity federation opt-in. */
export type ProjectFederation = ClientProjectFederation;
// The client re-exports the raw OpenAPI `components` but no named aliases for
// these role types, so they're derived here.
export type ProjectMember = components['schemas']['ProjectMember'];
export type ProjectRole = ProjectMember['role'];
export type AssignableProjectRole = components['schemas']['AssignableRole'];
/** Deployment capability flags from `GET /api/v1/capabilities`. */
export type Capabilities = ClientCapabilities;
export type ProjectAlertDestination = components['schemas']['ProjectAlertDestination'];
type CreateProjectAlertDestinationBody =
	paths['/api/v1/projects/{pid}/alert-destinations']['post']['requestBody']['content']['application/json'];
export type ProjectAlertKind = NonNullable<CreateProjectAlertDestinationBody['kinds']>[number];
export type NotebookEntry = SnapshotNotebookEntry;
type NotebookListQuery = NonNullable<
	paths['/api/v1/projects/{pid}/notebooks']['get']['parameters']['query']
>;
export type NotebookListFilters = Pick<NotebookListQuery, 'q' | 'status' | 'tag'>;
export type NotebookMeta = ClientNotebookMeta;
export type NotebookDetail = ClientNotebookDetail;
/** A saved notebook revision from `GET .../versions`. */
export type NotebookVersion = ClientNotebookVersion;
export type NotebookChangeRequest = components['schemas']['OpenNotebookChangeRequestResult'];
/** Result of creating a git-synced notebook (`POST .../notebooks/git`). */
export type GitNotebookCreateResult = ClientGitNotebookCreateResult;
/** A sync URL + write-once token, returned on synced-notebook creation and token rotation. */
export type SyncToken = ClientSyncToken;
export type Session = ClientSession;
/** A notebook job definition from `GET .../jobs`. */
export type Job = components['schemas']['Job'];
export type JobSchedule = components['schemas']['JobSchedule'];
export type JobCreateBody = components['schemas']['JobCreateBody'];
export type JobUpdateBody = components['schemas']['JobUpdateBody'];
/** One execution of a job, from `GET .../jobs/{jid}/runs`. */
export type JobRun = components['schemas']['JobRun'];
export type JobRunStatus = JobRun['status'];
export type SecondarySurfaceId = NonNullable<
	components['schemas']['SessionCreateBody']['surfaces']
>[number];
export type Surface = components['schemas']['Surface'];
export type EditorSessionState = components['schemas']['EditorSessionState'];
/** An integration kind's catalog card + JSON Schema for its config form. */
export type IntegrationKind = ClientIntegrationKind;
/** A project integration list item (no config). */
export type IntegrationEntry = ClientIntegrationEntry;
/** An integration with its redacted config. */
export type IntegrationDetail = ClientIntegrationDetail;
/** Outcome of the integration "Test" probe. */
export type IntegrationTestResult = ClientIntegrationTestResult;
export type QueryReadinessCheck = components['schemas']['IntegrationQueryReadinessCheck'];
/** Whether one integration instance can be browsed (and why not). */
export type IntegrationBrowseCapability = ClientIntegrationBrowseCapability;
export type IntegrationBrowseNamespacePage = ClientIntegrationBrowseNamespacePage;
export type IntegrationBrowseTablePage = ClientIntegrationBrowseTablePage;
/** Columns, partitioning, and load snippet for a browsed table. */
export type IntegrationTableSchema = ClientIntegrationTableSchema;
export type IntegrationTablePreview = ClientIntegrationTablePreview;
export type IntegrationObjectBucket = ClientIntegrationObjectBucket;
export type IntegrationObjectEntry = ClientIntegrationObjectEntry;
export type IntegrationObjectDetail = ClientIntegrationObjectDetail;
export type IntegrationObjectVersion = ClientIntegrationObjectVersion;
export type IntegrationObjectPreview = ClientIntegrationObjectPreview;
/** A resolved user identity ({ id, email, name }) from `GET /api/v1/users`. */
export type ResolvedUser = ClientResolvedUser;
/** A personal access token's metadata (never the secret). */
export type ApiToken = ClientApiToken;
export type TokenGrant = NonNullable<ClientApiToken['grant']>;
/** The token-create response: metadata plus the one-time plaintext `token`. */
export type ApiTokenCreated = ClientApiTokenCreated;
export type AuditLogEntry = ClientAuditLogEntry;
export type AuditLogPage = ClientAuditLogPage;
/** A directory entry on the super-admin users page. */
export type AdminUser = ClientAdminUser;
/** Redacted deployment configuration for the super-admin settings page. */
export type DeploymentConfig = ClientDeploymentConfig;
export type SandboxStartupReport = ClientSandboxStartupReport;
export type PolicyAnalyzerMetadata = components['schemas']['PolicyAnalyzerMetadata'];
export type PolicySuiteResult = components['schemas']['PolicySuiteResult'];
export type PolicySuiteV1 =
	paths['/api/v1/admin/policy-analyzer/evaluate']['post']['requestBody']['content']['application/json'];
export type ApiResponse<T> = ClientApiResponse<T>;
export type ApiError = ClientApiError;
export type User = ClientUser;
export type ServerVersion = ClientDeploymentInfo;
