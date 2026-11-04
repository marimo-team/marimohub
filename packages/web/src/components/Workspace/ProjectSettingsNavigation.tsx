import { Bell, Puzzle, Users } from 'lucide-react';
import { useCapabilitiesQuery } from '@/api/hooks';
import { ProjectAlertsDialog } from '@/components/Project/ProjectAlertsDialog';
import { Button } from '@/components/ui';
import { useDisclosure } from '@/hooks/useDisclosure';
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
	const alertsDialog = useDisclosure();
	const { data: capabilities } = useCapabilitiesQuery();
	const alertsAvailable =
		capabilities?.project_alerts?.available && canManageProject(project.your_role);
	return (
		<>
			<nav
				aria-label="Project settings"
				className="space-y-0.5 border-t border-sidebar-border pt-2"
			>
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
					<Button
						variant="unstyled"
						onPress={alertsDialog.open}
						aria-haspopup="dialog"
						className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
					>
						<Bell className="size-4 shrink-0" aria-hidden />
						Alerts
					</Button>
				)}
			</nav>
			{alertsDialog.isOpen && alertsAvailable && capabilities.project_alerts && (
				<ProjectAlertsDialog
					isOpen
					onClose={alertsDialog.close}
					projectId={project.id}
					selectableKinds={capabilities.project_alerts.selectable_kinds}
					maxDestinations={capabilities.project_alerts.max_destinations}
				/>
			)}
		</>
	);
}
