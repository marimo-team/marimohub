export const userKeys = {
	all: ['user'] as const,
	me: () => [...userKeys.all, 'me'] as const,
	// `ids` is pre-sorted+deduped by the hook so the key is stable regardless of
	// the caller's ordering.
	resolve: (ids: readonly string[]) => [...userKeys.all, 'resolve', ids] as const,
};

export const projectKeys = {
	all: ['projects'] as const,
	list: () => [...projectKeys.all, 'list'] as const,
	detail: (projectId: string) => [...projectKeys.all, 'detail', projectId] as const,
	members: (projectId: string) => [...projectKeys.all, 'members', projectId] as const,
	secrets: (projectId: string) => [...projectKeys.all, 'secrets', projectId] as const,
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
	html: (projectId: string, notebookId: string) =>
		[...notebookKeys.all, 'html', { projectId, notebookId }] as const,
};

export const systemKeys = {
	all: ['system'] as const,
	version: () => [...systemKeys.all, 'version'] as const,
	capabilities: () => [...systemKeys.all, 'capabilities'] as const,
};

export const sessionKeys = {
	all: ['sessions'] as const,
	detail: (sid: string) => [...sessionKeys.all, 'detail', sid] as const,
	listByProject: (projectId: string) => [...sessionKeys.all, 'list', { projectId }] as const,
};
