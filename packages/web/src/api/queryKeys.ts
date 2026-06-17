export const userKeys = {
	all: ['user'] as const,
	me: () => [...userKeys.all, 'me'] as const,
};

export const projectKeys = {
	all: ['projects'] as const,
	list: () => [...projectKeys.all, 'list'] as const,
};

export const notebookKeys = {
	all: ['notebooks'] as const,
	list: (projectId: string) => [...notebookKeys.all, 'list', { projectId }] as const,
};

export const sessionKeys = {
	all: ['sessions'] as const,
	detail: (sid: string) => [...sessionKeys.all, 'detail', sid] as const,
};
