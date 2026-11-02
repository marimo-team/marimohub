import { Navigate, useParams } from 'react-router-dom';
import { useProjectAppsQuery } from '@/api/apps';
import { useProjectQuery } from '@/api/hooks';
import { ProjectMembersPanel } from '@/components/Project/ProjectMembersDialog';
import { ProjectIntegrationsPanel } from '@/components/Project/ProjectIntegrationsDialog';
import { Page } from '@/components/ui';
import { ProjectCloudAccessButton } from './ProjectCloudAccessButton';

export function ProjectSettingsPage({ section }: { section: 'members' | 'integrations' }) {
	const { pid = '' } = useParams();
	const access = useProjectAppsQuery(pid);
	if (access.data.pages[0].project?.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	return <ProjectSettingsContent pid={pid} section={section} />;
}

function ProjectSettingsContent({
	pid,
	section,
}: {
	pid: string;
	section: 'members' | 'integrations';
}) {
	const { data: project } = useProjectQuery(pid);
	if (!project.your_role || project.your_role === 'app-user')
		return <Navigate to={`/apps?project_id=${encodeURIComponent(pid)}`} replace />;
	const title = section === 'members' ? 'Members' : 'Integrations';
	return (
		<Page
			title={title}
			context={project.name}
			subtitle={section === 'members' ? 'Manage who can access this project.' : undefined}
			mobileActions="inline"
			actions={
				section === 'integrations' ? (
					<ProjectCloudAccessButton key={pid} project={project} />
				) : undefined
			}
		>
			{section === 'members' ? (
				<ProjectMembersPanel key={pid} project={project} />
			) : (
				<ProjectIntegrationsPanel key={pid} project={project} modalEditor />
			)}
		</Page>
	);
}
