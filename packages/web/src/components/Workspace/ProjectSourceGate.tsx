import { useEffect } from 'react';
import { QueryErrorResetBoundary, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useProjectAppsQuery } from '@/api/apps';
import { projectQueryOptions } from '@/api/hooks';
import { isApiErrorCode, isNotFoundError } from '@/api/request';
import { userKeys } from '@/api/queryKeys';
import type { User } from '@/types';
import { forgetProject } from './lastProject';
import { Navigate, Outlet, useMatch, useParams } from 'react-router-dom';
import { ProjectRoute } from '@/components/Project/projectRoute';

export function ProjectSourceGate() {
	const { pid = '' } = useParams();
	const client = useQueryClient();
	const isIndex = useMatch('/projects/:pid') !== null;
	if (isIndex) ProjectRoute.preload();
	const appOnly = client.getQueryData<User>(userKeys.me())?.app_only === true;
	const project = useQuery({
		...projectQueryOptions(pid),
		enabled: !appOnly,
		throwOnError: (error, query) =>
			!isNotFoundError(error) &&
			(query.state.data === undefined ||
				isApiErrorCode(error, 'UNAUTHORIZED') ||
				isApiErrorCode(error, 'FORBIDDEN')),
	});
	if (appOnly) return <ProjectAppAccessGate pid={pid} />;
	if (project.isPending || (!project.data && project.isFetching))
		return <output>Checking project access…</output>;
	if (isNotFoundError(project.error)) return <ProjectAppAccessGate pid={pid} />;
	if (project.data?.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	return <Outlet />;
}

// Project metadata hides app-user projects; the apps endpoint distinguishes them from missing ones.
function ProjectAppAccessGate({ pid }: { pid: string }) {
	// A parent remount would consume the retry reset before this query mounts.
	return (
		<QueryErrorResetBoundary>
			{({ reset }) => (
				<ErrorBoundary key={pid} onRetry={reset}>
					<ProjectAppAccess pid={pid} />
				</ErrorBoundary>
			)}
		</QueryErrorResetBoundary>
	);
}

function ProjectAppAccess({ pid }: { pid: string }) {
	const client = useQueryClient();
	const access = useProjectAppsQuery(pid);
	const missing = access.data?.pages[0].missing && !access.isFetching;
	useEffect(() => {
		const user = client.getQueryData<User>(userKeys.me());
		if (missing && user) forgetProject(user.id, pid);
	}, [client, missing, pid]);
	if (!access.isFetchedAfterMount || (access.data?.pages[0].missing && access.isFetching))
		return <output>Checking project access…</output>;
	if (missing) return <Navigate to="/projects" replace />;
	if (access.data?.pages[0].project?.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	return <Outlet />;
}
