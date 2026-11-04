import { PROJECT_SEARCH_ROUTE } from '@/lib/workspaceSearch';
import { matchPath, useLocation } from 'react-router-dom';

export function workspaceRoute(pathname: string) {
	const pid = matchPath('/projects/:pid/*', pathname)?.params.pid;
	const jobs =
		matchPath('/projects/:pid/jobs/*', pathname) ??
		matchPath('/projects/:pid/notebooks/:nid/jobs/*', pathname);
	const section = jobs
		? 'jobs'
		: matchPath(PROJECT_SEARCH_ROUTE, pathname)
			? 'search'
			: matchPath('/projects/:pid/chat', pathname)
				? 'chat'
				: matchPath('/projects/:pid/data/*', pathname)
					? 'data'
					: matchPath('/projects/:pid/members', pathname)
						? 'members'
						: matchPath('/projects/:pid/integrations', pathname)
							? 'integrations'
							: matchPath('/projects/:pid/alerts', pathname)
								? 'alerts'
								: matchPath('/projects/:pid', pathname)
									? 'notebooks'
									: null;
	return { pid, section };
}

export function useWorkspaceRoute() {
	return workspaceRoute(useLocation().pathname);
}
