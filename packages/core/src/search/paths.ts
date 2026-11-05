import type { ProjectId } from '../ids';
import type { SearchScope } from './contracts';

export const searchPaths = {
	refresh: (pid: ProjectId) => `_system/search/refresh/${pid}.json`,
	projects: '_system/search/projects/',
	cursor: '_system/search/cursor.json',
	lock: '_system/search/lock.json',
	scope({ projectId, source }: SearchScope) {
		const prefix = `${searchPaths.projects}${encodeURIComponent(projectId)}/${encodeURIComponent(source)}`;
		return {
			head: `${prefix}/head.json`,
			checkpoint: `${prefix}/crawl.json`,
			pages: `${prefix}/pages/`,
			page: (id: string) => `${prefix}/pages/${encodeURIComponent(id)}.json`,
			snapshots: `${prefix}/snapshots/`,
			snapshot: (id: string) => `${prefix}/snapshots/${encodeURIComponent(id)}.json`,
		};
	},
};
