import type { ProjectList } from '@/components/ProjectList/ProjectList';
import type { Project } from '@/components/Project/Project';
import type { WorkspaceHome } from '@/components/Workspace/WorkspaceHome';
import type { WorkspaceLayout } from '@/components/Workspace/WorkspaceLayout';
import type { QueryClient } from '@tanstack/react-query';
import { matchRoutes } from 'react-router-dom';
import { userQueryOptions } from '@/api/hooks';
import { prefetchAppLink } from '@/api/deepLinks';
import {
	prefetchProjectSource,
	prefetchAppEntry,
	projectRosterQueryOptions,
} from '@/api/routePrefetch';
import { readLastProject } from '@/components/Workspace/lastProject';
import { appBasePath } from './basePath';

export interface InitialRoutes {
	Layout?: typeof WorkspaceLayout;
	Home?: typeof WorkspaceHome;
	Project?: typeof Project;
	Projects?: typeof ProjectList;
}

export async function preloadInitialRoute(client: QueryClient): Promise<InitialRoutes> {
	const pathname = window.location.pathname;
	const base = appBasePath();
	const path = base === '/' ? pathname : pathname.slice(base.length) || '/';
	const search = window.location.search;
	const notebook = matchRoutes(
		[{ path: '/projects/:pid/notebooks/:nid' }, { path: '/projects/:pid/notebooks/:nid/app' }],
		path,
	)?.[0];
	if (notebook) {
		void prefetchAppEntry(client, notebook.params.pid!, notebook.params.nid!);
		return {};
	}
	const link = matchRoutes([{ path: '/app/*' }], path)?.[0];
	if (link) {
		void prefetchAppLink(client, link.params['*'] ?? '');
		return {};
	}
	if (/^\/(cli|oauth)\//.test(path) || /^\/projects\/[^/]+\/notebooks\//.test(path)) return {};
	const layout = import('@/components/Workspace/WorkspaceLayout');
	const index = matchRoutes([{ path: '/projects/:pid' }], path)?.[0];
	if (index) {
		const data = prefetchProjectSource(client, index.params.pid!, search);
		const [shell, page] = await Promise.all([layout, import('@/components/Project/Project'), data]);
		// A resolved React.lazy import still suspends on its first render.
		return { Layout: shell.WorkspaceLayout, Project: page.Project };
	}
	if (path === '/') {
		const home = import('@/components/Workspace/WorkspaceHome');
		const project = import('@/components/Project/Project');
		const projects = import('@/components/ProjectList/ProjectList');
		const user = await client.fetchQuery(userQueryOptions()).catch(() => null);
		if (user && !user.app_only && !search) {
			const remembered = readLastProject(user.id);
			const pid =
				remembered ?? (await client.fetchQuery(projectRosterQueryOptions()).catch(() => []))[0]?.id;
			if (pid) await prefetchProjectSource(client, pid, '');
		}
		const [shell, landing, page, list] = await Promise.all([layout, home, project, projects]);
		return {
			Layout: shell.WorkspaceLayout,
			Home: landing.WorkspaceHome,
			Project: page.Project,
			Projects: list.ProjectList,
		};
	}
	return { Layout: (await layout).WorkspaceLayout };
}
