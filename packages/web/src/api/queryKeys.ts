export const userKeys = {
	all: ['user'] as const,
	me: () => [...userKeys.all, 'me'] as const,
	// `ids` is pre-sorted+deduped by the hook so the key is stable regardless of
	// the caller's ordering.
	resolve: (ids: readonly string[]) => [...userKeys.all, 'resolve', ids] as const,
	search: (query: string) => [...userKeys.all, 'search', query] as const,
	tokens: () => [...userKeys.all, 'tokens'] as const,
};

export const projectKeys = {
	all: ['projects'] as const,
	list: () => [...projectKeys.all, 'list'] as const,
	/** Full multi-page roster for pickers; distinct from the first-page `list`. */
	pickerList: () => [...projectKeys.all, 'list', 'all'] as const,
	detail: (projectId: string) => [...projectKeys.all, 'detail', projectId] as const,
	members: (projectId: string) => [...projectKeys.all, 'members', projectId] as const,
	alerts: (projectId: string) => [...projectKeys.all, 'alerts', projectId] as const,
	integrations: (projectId: string) => [...projectKeys.all, 'integrations', projectId] as const,
	integration: (projectId: string, integrationId: string) =>
		[...projectKeys.all, 'integrations', projectId, integrationId] as const,
};

export const browseKeys = {
	all: ['browse'] as const,
	capability: (projectId: string, integrationId: string) =>
		[...browseKeys.all, projectId, integrationId, 'capability'] as const,
	/** Colocated with the key shape above so a change cannot silently break it. */
	isCapability: (key: readonly unknown[]) => key[0] === 'browse' && key[3] === 'capability',
	namespaces: (projectId: string, integrationId: string, parent: readonly string[]) =>
		[...browseKeys.all, projectId, integrationId, 'namespaces', parent] as const,
	tables: (projectId: string, integrationId: string, namespace: readonly string[]) =>
		[...browseKeys.all, projectId, integrationId, 'tables', namespace] as const,
	schema: (projectId: string, integrationId: string, namespace: readonly string[], table: string) =>
		[...browseKeys.all, projectId, integrationId, 'schema', namespace, table] as const,
	objectBuckets: (projectId: string, integrationId: string) =>
		[...browseKeys.all, projectId, integrationId, 'object-buckets'] as const,
	objects: (projectId: string, integrationId: string, bucket: string, prefix: string) =>
		[...browseKeys.all, projectId, integrationId, 'objects', bucket, prefix] as const,
	objectSearch: (
		projectId: string,
		integrationId: string,
		bucket: string,
		prefix: string,
		query: string,
	) =>
		[...browseKeys.all, projectId, integrationId, 'object-search', bucket, prefix, query] as const,
	objectDetail: (
		projectId: string,
		integrationId: string,
		bucket: string,
		key: string,
		versionId?: string,
	) =>
		[
			...browseKeys.all,
			projectId,
			integrationId,
			'object-detail',
			bucket,
			key,
			versionId ?? null,
		] as const,
	objectVersions: (projectId: string, integrationId: string, bucket: string, key: string) =>
		[...browseKeys.all, projectId, integrationId, 'object-versions', bucket, key] as const,
};

export const integrationKeys = {
	/** Deployment-wide catalog; kind schemas are static for a deployment. */
	kinds: () => ['integration-kinds'] as const,
	/** Org-wide instances (super-admin managed, inherited by every project). */
	org: () => ['org-integrations'] as const,
	orgDetail: (integrationId: string) => ['org-integrations', integrationId] as const,
};

export const notebookKeys = {
	all: ['notebooks'] as const,
	list: (projectId: string) => [...notebookKeys.all, 'list', { projectId }] as const,
	detail: (projectId: string, notebookId: string) =>
		[...notebookKeys.all, 'detail', { projectId, notebookId }] as const,
	versions: (projectId: string, notebookId: string) =>
		[...notebookKeys.all, 'versions', { projectId, notebookId }] as const,
	version: (projectId: string, notebookId: string, versionId: string) =>
		[...notebookKeys.all, 'version', { projectId, notebookId, versionId }] as const,
	html: (projectId: string, notebookId: string, versionId?: string) =>
		[...notebookKeys.all, 'html', { projectId, notebookId, versionId: versionId ?? null }] as const,
};

export const systemKeys = {
	all: ['system'] as const,
	version: () => [...systemKeys.all, 'version'] as const,
	capabilities: () => [...systemKeys.all, 'capabilities'] as const,
};

export interface AuditLogFilters {
	from: string;
	to: string;
	event: string;
	actor: string;
	projectId: string;
}

export const auditKeys = {
	all: ['audit-events'] as const,
	list: (filters: AuditLogFilters) => [...auditKeys.all, 'list', filters] as const,
};

export const adminKeys = {
	all: ['admin'] as const,
	users: () => [...adminKeys.all, 'users'] as const,
	config: () => [...adminKeys.all, 'config'] as const,
};

export const sessionKeys = {
	all: ['sessions'] as const,
	detail: (sid: string) => [...sessionKeys.all, 'detail', sid] as const,
	listByProject: (projectId: string) => [...sessionKeys.all, 'list', { projectId }] as const,
	editor: (projectId: string, notebookId: string) =>
		[...sessionKeys.all, 'editor', { projectId, notebookId }] as const,
};
