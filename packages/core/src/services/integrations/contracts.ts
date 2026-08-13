import type { IntegrationId, ProjectId, UserId } from '../../ids';
import type {
	BrowseCapabilityResult,
	BrowseNamespacesRequest,
	BrowsePage,
	BrowsePageRequest,
	CopyIntegrationOptions,
	CreateIntegrationInput,
	IntegrationDetail,
	IntegrationEntry,
	IntegrationVersionPage,
	IntegrationVersionPageRequest,
	IntegrationSecretSources,
	KindDescriptor,
	SessionRender,
	SessionRenderContext,
	TableSchema,
	TablePreview,
	TablePreviewRequest,
	TestIntegrationRequest,
	TestResult,
	UpdateIntegrationInput,
} from '../../ports/integrations';
import type {
	ObjectBody,
	ObjectBrowseContext,
	ObjectBucket,
	ObjectDetail,
	ObjectEntry,
	ObjectIdentity,
	ObjectListRequest,
	ObjectOpenRequest,
	ObjectPage,
	ObjectPageRequest,
	ObjectPreview,
	ObjectPreviewRequest,
	ObjectSearchPage,
	ObjectSearchRequest,
	ObjectVersion,
	ObjectVersionRequest,
} from '../../ports/objectBrowser';
import type { PreviewCredentialVars } from './data-preview/programs';
import type { DataQueryResult } from './data-query';

/** Application service for project integrations and inherited organization integrations. */
export interface ProjectIntegrationsService {
	listKinds(): KindDescriptor[];
	secretSources(): IntegrationSecretSources;
	list(projectId: ProjectId): Promise<IntegrationEntry[]>;
	get(projectId: ProjectId, id: IntegrationId): Promise<IntegrationDetail>;
	create(
		projectId: ProjectId,
		input: CreateIntegrationInput,
		actor: UserId,
	): Promise<IntegrationDetail>;
	update(
		projectId: ProjectId,
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail>;
	/** Returns false when the integration was already absent. */
	delete(projectId: ProjectId, id: IntegrationId, expectedVersion?: string): Promise<boolean>;
	listVersions(
		projectId: ProjectId,
		id: IntegrationId,
		page?: IntegrationVersionPageRequest,
	): Promise<IntegrationVersionPage>;
	test(projectId: ProjectId, request: TestIntegrationRequest): Promise<TestResult>;
	/**
	 * Read-only catalog browsing. Unlike `get`/`test`, the id resolves
	 * project-first, then the inherited org tier (shadowed org instances read
	 * as absent) — the merged view members already have.
	 */
	browseCapability(
		projectId: ProjectId,
		id: IntegrationId,
		objectContext?: ObjectBrowseContext,
	): Promise<BrowseCapabilityResult>;
	browseNamespaces(
		projectId: ProjectId,
		id: IntegrationId,
		request: BrowseNamespacesRequest,
	): Promise<BrowsePage<string[]>>;
	browseTables(
		projectId: ProjectId,
		id: IntegrationId,
		namespace: string[],
		request: BrowsePageRequest,
	): Promise<BrowsePage<string>>;
	browseTableSchema(
		projectId: ProjectId,
		id: IntegrationId,
		namespace: string[],
		table: string,
		request?: Pick<TablePreviewRequest, 'query_user' | 'signal'>,
	): Promise<TableSchema>;
	browseTablePreview(
		projectId: ProjectId,
		id: IntegrationId,
		principal: { userId: UserId; email: string },
		sessionId: SessionRenderContext['sessionId'],
		namespace: string[],
		table: string,
		request: TablePreviewRequest,
		credentialVars?: PreviewCredentialVars,
	): Promise<TablePreview>;
	runDataQuery(
		projectId: ProjectId,
		id: IntegrationId,
		principal: { userId: UserId; email: string },
		sessionId: SessionRenderContext['sessionId'],
		sql: string,
		signal?: AbortSignal,
	): Promise<DataQueryResult>;
	browseObjectBuckets(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectPageRequest,
	): Promise<ObjectPage<ObjectBucket>>;
	browseObjects(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectListRequest,
	): Promise<ObjectPage<ObjectEntry>>;
	searchObjects(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectSearchRequest,
	): Promise<ObjectSearchPage>;
	browseObjectDetail(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectIdentity,
	): Promise<ObjectDetail>;
	browseObjectVersions(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectVersionRequest,
	): Promise<ObjectPage<ObjectVersion>>;
	browseObjectPreview(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectPreviewRequest,
	): Promise<ObjectPreview>;
	openObject(
		projectId: ProjectId,
		id: IntegrationId,
		context: ObjectBrowseContext,
		request: ObjectOpenRequest,
	): Promise<ObjectBody>;
	copy(
		sourceProjectId: ProjectId,
		id: IntegrationId,
		targetProjectId: ProjectId,
		options: CopyIntegrationOptions,
		actor: UserId,
	): Promise<IntegrationDetail>;
	/** Renders enabled project and unshadowed organization integrations for one session. */
	resolveForSession(
		projectId: ProjectId,
		context: SessionRenderContext,
	): Promise<SessionRender | undefined>;
}

/** Application service for deployment-wide integrations. */
export interface OrgIntegrationsService {
	listKinds(): KindDescriptor[];
	secretSources(): IntegrationSecretSources;
	list(): Promise<IntegrationEntry[]>;
	get(id: IntegrationId): Promise<IntegrationDetail>;
	create(input: CreateIntegrationInput, actor: UserId): Promise<IntegrationDetail>;
	update(
		id: IntegrationId,
		input: UpdateIntegrationInput,
		actor: UserId,
		expectedVersion?: string,
	): Promise<IntegrationDetail>;
	delete(id: IntegrationId, expectedVersion?: string): Promise<boolean>;
	listVersions(
		id: IntegrationId,
		page?: IntegrationVersionPageRequest,
	): Promise<IntegrationVersionPage>;
	test(request: TestIntegrationRequest): Promise<TestResult>;
}
