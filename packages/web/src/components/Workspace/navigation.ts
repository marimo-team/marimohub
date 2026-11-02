import { matchPath } from 'react-router-dom';

export interface WorkspaceNavigationSlot {
	to: string;
	available: boolean;
	allowed: boolean;
}

// Chat (MO-8290) is project scoped; Search (MO-8291) is global.
// Register destinations only when their routes and permission checks are available.
export interface WorkspaceNavigationSlots {
	search?: WorkspaceNavigationSlot;
	chat?: WorkspaceNavigationSlot;
}

export function workspaceRoute(pathname: string) {
	const pid = matchPath('/projects/:pid/*', pathname)?.params.pid;
	const jobs =
		matchPath('/projects/:pid/jobs/*', pathname) ??
		matchPath('/projects/:pid/notebooks/:nid/jobs/*', pathname);
	const section = jobs
		? 'jobs'
		: matchPath('/projects/:pid/data/*', pathname)
			? 'data'
			: matchPath('/projects/:pid/chat/*', pathname)
				? 'chat'
				: matchPath('/projects/:pid/members', pathname)
					? 'members'
					: matchPath('/projects/:pid/integrations', pathname)
						? 'integrations'
						: matchPath('/projects/:pid', pathname)
							? 'notebooks'
							: null;
	return { pid, section };
}
