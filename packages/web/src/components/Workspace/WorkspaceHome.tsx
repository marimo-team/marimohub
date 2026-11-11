import { Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { firstProjectQueryOptions } from '@/api/routePrefetch';
import { useAuth } from '@/context/AuthContext';
import { readLastProject } from './lastProject';

export function WorkspaceHome() {
	const { user } = useAuth();
	const location = useLocation();
	const previous = user ? readLastProject(user.id) : null;
	const projects = useQuery({
		...firstProjectQueryOptions(),
		enabled: Boolean(user && !user.app_only && !location.search && !previous),
		throwOnError: false,
	});
	if (user?.app_only) return <Navigate to="/apps" replace />;
	if (location.search) return <Navigate to={`/projects${location.search}`} replace />;
	if (previous) return <Navigate to={`/projects/${encodeURIComponent(previous)}`} replace />;
	if (projects.isPending)
		return <output className="m-auto text-sm text-muted-foreground">Loading projects…</output>;
	const project = !projects.isError && projects.data;
	return project ? (
		<Navigate to={`/projects/${encodeURIComponent(project.id)}`} replace />
	) : (
		<Navigate to="/projects" replace />
	);
}
