import { useParams } from 'react-router-dom';
import { useProjectQuery } from '@/api/hooks';
import { ProjectMembersPanel } from '@/components/Project/ProjectMembersPanel';
import { ProjectIntegrationsPanel } from '@/components/Project/ProjectIntegrationsDialog';
import { Page } from '@/components/ui';
import { ProjectCloudAccessButton } from './ProjectCloudAccessButton';

export function ProjectSettingsPage({ section }: { section: 'members' | 'integrations' }) {
	const { pid = '' } = useParams();
	const { data: project } = useProjectQuery(pid);
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
