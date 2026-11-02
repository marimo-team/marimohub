import { Navigate, useLocation } from 'react-router-dom';
import { useProjectsQuery } from '@/api/hooks';
import { ProjectList } from '@/components/ProjectList/ProjectList';
import { useAuth } from '@/context/AuthContext';
import { readLastProject } from './lastProject';

export function WorkspaceHome() {
	const { user } = useAuth();
	const location = useLocation();
	const projects = useProjectsQuery(
		{ status: 'active' },
		{ enabled: Boolean(user && !user.app_only && !location.search), throwOnError: false },
	);
	if (user?.app_only) return <Navigate to="/apps" replace />;
	if (location.search) return <Navigate to={`/projects${location.search}`} replace />;
	if (projects.isPending)
		return <output className="m-auto text-sm text-muted-foreground">Loading projects…</output>;
	const previous = user ? readLastProject(user.id) : null;
	const project =
		!projects.isError &&
		(projects.data?.find((item) => item.id === previous) ?? projects.data?.[0]);
	return project ? (
		<Navigate to={`/projects/${encodeURIComponent(project.id)}`} replace />
	) : (
		<ProjectList />
	);
}
