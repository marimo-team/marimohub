import { useId } from 'react';
import { UserAvatar } from '@/components/ui';
import type { UserDirectory } from '@/api/hooks';
import type { ProjectDetail, ProjectMember, ProjectRole, User } from '@/types';
import { isSelf, memberMatchesUser } from './memberIdentity';
import { OwnerBadge, RoleBadge } from './RoleControls';

export function ProjectCurrentAccess({
	project,
	user,
	members,
	users,
	descriptions,
}: {
	project: ProjectDetail;
	user: User | null;
	members: ProjectMember[];
	users: UserDirectory | undefined;
	descriptions: Record<ProjectRole, string>;
}) {
	const headingId = useId();
	const currentUserIsMember = members.some(
		(member) => isSelf(member, user) && member.role === project.your_role,
	);
	const viaGroup =
		user !== null &&
		members.some((member) => member.group !== undefined && memberMatchesUser(member, user));
	const accessSource =
		user?.id === project.owner
			? 'Project owner'
			: user?.is_super_admin
				? 'Deployment super admin'
				: currentUserIsMember
					? 'Project member'
					: viaGroup
						? 'Group membership'
						: 'Default access';
	const currentIdentity = user ? users?.[user.id] : undefined;
	const currentDisplayName = currentIdentity?.name || user?.email || 'You';

	return (
		<section aria-labelledby={headingId} className="rounded-lg border bg-muted/40 p-3.5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 max-w-full items-center gap-3">
					<UserAvatar
						pictureUrl={currentIdentity?.picture_url ?? user?.picture_url}
						label={currentDisplayName}
						className="size-9 text-xs"
					/>
					<div className="min-w-0">
						<h3 id={headingId} className="text-xs font-semibold text-muted-foreground">
							Your Access
						</h3>
						<p className="truncate font-medium">{currentDisplayName}</p>
						<p className="truncate text-xs text-muted-foreground">
							{currentIdentity?.name && user?.email ? (
								<>
									<span translate="no">{user.email}</span>
									<span aria-hidden="true"> · </span>
								</>
							) : null}
							{accessSource}
						</p>
					</div>
				</div>
				{user?.id === project.owner ? (
					<OwnerBadge label="Your role" />
				) : project.your_role ? (
					<RoleBadge
						value={project.your_role}
						descriptions={descriptions}
						label="Your role"
						legacyAdmin={
							project.your_role === 'admin' && currentUserIsMember && !user?.is_super_admin
						}
					/>
				) : (
					<span className="text-xs text-muted-foreground">No Project Role</span>
				)}
			</div>
		</section>
	);
}
