import { Bell, Puzzle, Users } from 'lucide-react';
import { useCapabilitiesQuery } from '@/api/hooks';
import { canManageProject } from '@/lib/roles';
import type { ProjectDetail } from '@/types';
import { SidebarLink } from './SidebarLink';

export function ProjectSettingsNavigation({
	project,
	section,
	onNavigate,
}: {
	project: ProjectDetail;
	section: string | null;
	onNavigate?: () => void;
}) {
	const { data: capabilities } = useCapabilitiesQuery();
	const alertsAvailable =
		capabilities?.project_alerts?.available && canManageProject(project.your_role);
	return (
		<nav aria-label="Project settings" className="space-y-0.5 border-t border-sidebar-border pt-2">
			<SidebarLink
				label="Members"
				icon={Users}
				to={`/projects/${encodeURIComponent(project.id)}/members`}
				active={section === 'members'}
				onNavigate={onNavigate}
			/>
			<SidebarLink
				label="Integrations"
				icon={Puzzle}
				to={`/projects/${encodeURIComponent(project.id)}/integrations`}
				active={section === 'integrations'}
				onNavigate={onNavigate}
			/>
			{alertsAvailable && (
				<SidebarLink
					label="Alerts"
					icon={Bell}
					to={`/projects/${encodeURIComponent(project.id)}/alerts`}
					active={section === 'alerts'}
					onNavigate={onNavigate}
				/>
			)}
		</nav>
	);
}
