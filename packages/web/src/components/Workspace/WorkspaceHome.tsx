import { Navigate, useLocation } from 'react-router-dom';
import { useProjectRoster } from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { readLastProject } from './lastProject';

export function WorkspaceHome() {
	const { user } = useAuth();
	const location = useLocation();
	const previous = user ? readLastProject(user.id) : null;
	const projects = useProjectRoster({
		enabled: Boolean(user && !user.app_only && !location.search && !previous),
		throwOnError: false,
	});
	if (user?.app_only) return <Navigate to="/apps" replace />;
	if (location.search) return <Navigate to={`/projects${location.search}`} replace />;
	if (previous) return <Navigate to={`/projects/${encodeURIComponent(previous)}`} replace />;
	if (projects.isPending)
		return <output className="m-auto text-sm text-muted-foreground">Loading projects…</output>;
	const project = !projects.isError && projects.data?.[0];
	return project ? (
		<Navigate to={`/projects/${encodeURIComponent(project.id)}`} replace />
	) : (
		<Navigate to="/projects" replace />
	);
}
