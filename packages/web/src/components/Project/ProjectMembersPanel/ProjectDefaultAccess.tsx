import { useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUpdateProject } from '@/api/hooks';
import { projectKeys } from '@/api/queryKeys';
import { canManageProject, defaultAccessSummary } from '@/lib/roles';
import type { Capabilities, ProjectDefaultRole, ProjectDetail } from '@/types';
import { assignableRoleOptions } from './roleOptions';

export function ProjectDefaultAccess({
	project,
	capabilities,
}: {
	project: ProjectDetail;
	capabilities: Capabilities | undefined;
}) {
	const headingId = useId();
	const queryClient = useQueryClient();
	const updateProject = useUpdateProject();
	const canManage = canManageProject(project.your_role);
	const pendingRole =
		updateProject.isPending && updateProject.variables.projectId === project.id
			? updateProject.variables.default_role
			: undefined;
	const defaultRole = pendingRole ?? project.default_role;
	const accessSummary = defaultAccessSummary(defaultRole, capabilities?.default_role);
	if (!canManage && !accessSummary) return null;

	return (
		<section aria-labelledby={headingId} className="rounded-lg border bg-card p-3">
			<h3 id={headingId} className="mb-1 text-xs font-semibold">
				Default access for signed-in users
			</h3>
			{canManage && (
				<select
					aria-label="Default access for signed-in users"
					value={defaultRole}
					disabled={updateProject.isPending}
					onChange={(event) =>
						updateProject.mutate(
							{
								projectId: project.id,
								default_role: event.target.value as ProjectDefaultRole,
							},
							{
								onSuccess: (updated) => {
									// Show the confirmed value now; the invalidated refetch may lag or fail.
									queryClient.setQueryData(projectKeys.detail(updated.id), updated);
									toast.success('Default access updated');
								},
							},
						)
					}
					className="mb-2 h-9 max-sm:h-11 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					<option value="inherit">Inherit deployment and sign-in defaults</option>
					<option value="none">Members only</option>
					{assignableRoleOptions}
				</select>
			)}
			{accessSummary && (
				<p className="text-xs leading-relaxed text-muted-foreground">{accessSummary}</p>
			)}
			<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
				Explicit user and group memberships take precedence. Owners and super admins retain access.
			</p>
		</section>
	);
}
