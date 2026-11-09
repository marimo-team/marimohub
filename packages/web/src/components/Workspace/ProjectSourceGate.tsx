import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { userKeys } from '@/api/queryKeys';
import type { User } from '@/types';
import { forgetProject } from './lastProject';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useProjectAppsQuery } from '@/api/apps';

// Project detail routes 404 for app users, so the apps listing (which still
// resolves their role) decides before any source page fetches.
export function ProjectSourceGate() {
	const { pid = '' } = useParams();
	const client = useQueryClient();
	const access = useProjectAppsQuery(pid);
	const missing = access.data.pages[0].missing && !access.isFetching;
	useEffect(() => {
		const user = client.getQueryData<User>(userKeys.me());
		if (missing && user) forgetProject(user.id, pid);
	}, [client, missing, pid]);
	if (access.data.pages[0].missing) {
		if (access.isFetching) return <output>Checking project access…</output>;
		return <Navigate to="/projects" replace />;
	}
	if (access.data.pages[0].project?.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	return <Outlet />;
}
