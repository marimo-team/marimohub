import { Bell } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useCapabilitiesQuery, useProjectQuery } from '@/api/hooks';
import { ProjectAlertsPanel } from '@/components/Project/ProjectAlertsPanel';
import { Button, EmptyState, Page } from '@/components/ui';
import { canManageProject } from '@/lib/roles';

export function ProjectAlertsPage() {
	const { pid = '' } = useParams();
	const { data: project } = useProjectQuery(pid);
	const capabilities = useCapabilitiesQuery();
	const alerts = capabilities.data?.project_alerts;
	return (
		<Page title="Alerts" context={project.name}>
			{!canManageProject(project.your_role) ? (
				<EmptyState
					icon={<Bell />}
					message="Alert management is not available"
					description="Only project managers and admins can manage alert destinations."
				/>
			) : capabilities.isPending ? (
				<output className="block text-sm text-muted-foreground">
					Checking alert availability…
				</output>
			) : capabilities.isError ? (
				<div role="alert" className="space-y-3 text-sm">
					<p>Could not check alert availability.</p>
					<Button onPress={() => void capabilities.refetch()}>Retry</Button>
				</div>
			) : !alerts?.available ? (
				<EmptyState
					icon={<Bell />}
					message="Alerts are not enabled"
					description="Project alerts are unavailable on this deployment."
				/>
			) : (
				<ProjectAlertsPanel
					key={pid}
					projectId={pid}
					selectableKinds={alerts.selectable_kinds}
					maxDestinations={alerts.max_destinations}
				/>
			)}
		</Page>
	);
}
