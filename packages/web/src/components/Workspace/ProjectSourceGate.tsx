import { Navigate, Outlet, useParams } from 'react-router-dom';
import { useProjectAppsQuery } from '@/api/apps';

// Project detail routes 404 for app users, so the apps listing (which still
// resolves their role) decides before any source page fetches.
export function ProjectSourceGate() {
	const { pid = '' } = useParams();
	const access = useProjectAppsQuery(pid);
	if (access.data.pages[0].project?.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	return <Outlet />;
}
