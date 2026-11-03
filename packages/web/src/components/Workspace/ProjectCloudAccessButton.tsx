import { Cloud } from 'lucide-react';
import { toast } from 'sonner';
import { useCapabilitiesQuery, useUpdateProject } from '@/api/hooks';
import { ProjectCloudAccessDialog } from '@/components/Project/ProjectCloudAccessDialog';
import type { CloudAccessSetting } from '@/components/Project/ProjectCloudAccessDialog';
import { Button } from '@/components/ui';
import { useDisclosure } from '@/hooks/useDisclosure';
import type { ProjectDetail } from '@/types';

export function ProjectCloudAccessButton({ project }: { project: ProjectDetail }) {
	const dialog = useDisclosure();
	const { data: capabilities, isError: capabilitiesError } = useCapabilitiesQuery();
	const updateProject = useUpdateProject();
	const saveCloudAccess = async (setting: CloudAccessSetting) => {
		await updateProject.mutateAsync({
			projectId: project.id,
			federation:
				setting === 'inherit' ? null : { ...project.federation, enabled: setting === 'enabled' },
		});
		toast.success(
			setting === 'inherit'
				? `Federated cloud access uses deployment default (${capabilities?.federation.default_enabled ? 'enabled' : 'disabled'})`
				: `Federated cloud access ${setting}`,
		);
	};
	return (
		<>
			<Button size="sm" variant="ghost" onPress={dialog.open} aria-haspopup="dialog">
				<Cloud className="size-4" aria-hidden />
				Cloud access
			</Button>
			{dialog.isOpen && (
				<ProjectCloudAccessDialog
					isOpen
					onClose={dialog.close}
					project={project}
					cloudAccessLoading={!capabilities && !capabilitiesError}
					cloudAccessAvailable={capabilities?.federation.available ?? false}
					cloudAccessDefaultEnabled={capabilities?.federation.default_enabled ?? false}
					isPending={updateProject.isPending}
					onSaveCloudAccess={saveCloudAccess}
				/>
			)}
		</>
	);
}
