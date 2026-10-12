import { useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, ConfirmDialog, DialogModal, displayName } from '@/components/ui';
import {
	projectQueryOptions,
	useAddMember,
	useCapabilitiesQuery,
	useProjectMembersQuery,
	useRemoveMember,
	useUpdateMemberRole,
	useUsersQuery,
} from '@/api/hooks';
import { isApiErrorCode, isNotFoundError } from '@/api/request';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useAuth } from '@/context/AuthContext';
import { canManageProject, PROJECT_ROLES, roleDescriptions, roleLabel } from '@/lib/roles';
import type { AssignableProjectRole, ProjectDetail, ProjectMember } from '@/types';
import { AddMemberForm } from './AddMemberForm';
import type { AddMemberHandler } from './AddMemberForm';
import {
	isSelf,
	memberKey,
	memberLabel,
	memberMatchesUser,
	memberSelector,
} from './memberIdentity';
import { MemberRow } from './MemberRow';
import { ProjectCurrentAccess } from './ProjectCurrentAccess';
import { ProjectDefaultAccess } from './ProjectDefaultAccess';

const SELF_ACCESS_WARNING = 'You may lose access to this project.';

const isDemotion = (from: ProjectMember['role'], to: AssignableProjectRole) =>
	PROJECT_ROLES.indexOf(to) < PROJECT_ROLES.indexOf(from);

export interface ProjectMembersDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
}

export function ProjectMembersDialog({ isOpen, onClose, project }: ProjectMembersDialogProps) {
	const membersHeadingId = useId();
	const { user } = useAuth();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const canManage = canManageProject(project.your_role);
	const {
		data: members,
		isLoading,
		isError,
		isFetching,
		refetch,
	} = useProjectMembersQuery(project.id);
	const visibleMembers: ProjectMember[] = members ?? project.members ?? [];
	const { data: users, isLoading: usersLoading } = useUsersQuery([
		...visibleMembers.map((m) => m.user_id),
		user?.id,
	]);
	const { data: capabilities } = useCapabilitiesQuery();
	const descriptions = roleDescriptions(capabilities);
	const addMember = useAddMember(project.id);
	const updateRole = useUpdateMemberRole(project.id);
	const removeMember = useRemoveMember(project.id);
	const changingMember = updateRole.isPending || removeMember.isPending;
	const confirmRemove = useDialogTarget<ProjectMember>();
	const confirmDemote = useDialogTarget<{ member: ProjectMember; role: AssignableProjectRole }>();

	// A group row can be the caller's only access, so it is guarded like their own row.
	// Owners and super admins keep access whatever their member row says.
	const isGuardedSelf = (member: ProjectMember) =>
		user !== null &&
		memberMatchesUser(member, user) &&
		user.id !== project.owner &&
		!user.is_super_admin;

	const leaveIfAccessLost = async () => {
		try {
			await queryClient.fetchQuery({ ...projectQueryOptions(project.id), staleTime: 0 });
		} catch (err) {
			if (isApiErrorCode(err, 'FORBIDDEN') || isNotFoundError(err)) {
				onClose();
				void navigate('/');
			}
		}
	};

	const handleAdd: AddMemberHandler = (choice, role, onSuccess) => {
		addMember.mutate(
			{ ...choice, role },
			{
				onSuccess: () => {
					toast.success(
						'group' in choice ? 'Group added' : 'email' in choice ? 'Invite added' : 'Member added',
					);
					onSuccess();
				},
			},
		);
	};

	const changeRole = (member: ProjectMember, role: AssignableProjectRole, self: boolean) => {
		updateRole.mutate(
			{ selector: memberSelector(member), role },
			{
				onSuccess: () => {
					toast.success('Role updated');
					confirmDemote.close();
					if (self) void leaveIfAccessLost();
				},
			},
		);
	};

	const handleRoleChange = (member: ProjectMember, role: AssignableProjectRole) => {
		if (isGuardedSelf(member) && isDemotion(member.role, role)) {
			confirmDemote.open({ member, role });
			return;
		}
		changeRole(member, role, false);
	};

	const handleRemove = () => {
		const target = confirmRemove.target;
		if (!target) return;
		const self = isGuardedSelf(target);
		removeMember.mutate(memberSelector(target), {
			onSuccess: () => {
				toast.success(target.group !== undefined ? 'Group removed' : 'Member removed');
				confirmRemove.close();
				if (self) void leaveIfAccessLost();
			},
		});
	};

	const removeTarget = confirmRemove.target;
	const removeTargetName = removeTarget
		? displayName(
				removeTarget.user_id ? users?.[removeTarget.user_id] : undefined,
				memberLabel(removeTarget),
			)
		: '';
	const removingSelf = removeTarget !== null && isGuardedSelf(removeTarget);

	return (
		<>
			<DialogModal isOpen={isOpen} onClose={onClose} title="Project Access" width="lg">
				<div className="-m-1 max-h-[70dvh] overflow-y-auto overscroll-contain p-1">
					<div className="flex flex-col gap-5 text-sm">
						<ProjectCurrentAccess
							project={project}
							user={user}
							members={visibleMembers}
							users={users}
							descriptions={descriptions}
						/>

						<section aria-labelledby={membersHeadingId} className="flex flex-col gap-2">
							<div className="flex items-baseline justify-between gap-3">
								<h3 id={membersHeadingId} className="text-xs font-semibold">
									Members
								</h3>
								{!isLoading && (
									<span className="text-xs text-muted-foreground">{visibleMembers.length}</span>
								)}
							</div>

							{isError && (
								<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-3">
									<p role="alert" className="text-xs text-destructive">
										Could not refresh members. The list may be out of date.
									</p>
									<Button size="sm" onPress={() => void refetch()} isDisabled={isFetching}>
										Retry members
									</Button>
								</div>
							)}
							{isLoading ? (
								<output className="py-2 text-muted-foreground">Loading members…</output>
							) : visibleMembers.length === 0 ? (
								<p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
									No explicit project members
								</p>
							) : (
								<ul className="flex flex-col divide-y">
									{visibleMembers.map((member) => (
										<MemberRow
											key={memberKey(member)}
											member={member}
											isOwner={member.user_id === project.owner}
											isYou={isSelf(member, user)}
											canManage={canManage}
											disabled={isError || changingMember}
											users={users}
											usersLoading={usersLoading}
											descriptions={descriptions}
											onRoleChange={(role) => handleRoleChange(member, role)}
											onRemove={() => confirmRemove.open(member)}
										/>
									))}
								</ul>
							)}

							{canManage && (
								<AddMemberForm
									key={project.id}
									members={visibleMembers}
									projectGroupsAvailable={capabilities?.project_groups.available ?? false}
									groups={user?.groups ?? []}
									users={users}
									descriptions={descriptions}
									onAdd={handleAdd}
									isPending={isLoading || isError || addMember.isPending || changingMember}
								/>
							)}
						</section>

						<ProjectDefaultAccess project={project} capabilities={capabilities} />
					</div>
				</div>
			</DialogModal>

			<ConfirmDialog
				isOpen={confirmRemove.isOpen}
				onClose={confirmRemove.close}
				title={
					removingSelf
						? 'Remove Yourself'
						: removeTarget?.group !== undefined
							? 'Remove Group'
							: 'Remove Member'
				}
				description={
					removingSelf
						? `Remove yourself from “${project.name}”? ${SELF_ACCESS_WARNING}`
						: `Remove “${removeTargetName}” from “${project.name}”? This removes this membership. Other memberships, default access, or super-admin status may still give access.`
				}
				confirmLabel="Remove"
				pendingLabel="Removing…"
				isPending={removeMember.isPending}
				onConfirm={handleRemove}
			/>

			<ConfirmDialog
				isOpen={confirmDemote.isOpen}
				onClose={confirmDemote.close}
				title="Change Your Role"
				description={`Change your role in “${project.name}” to ${
					confirmDemote.target ? roleLabel(confirmDemote.target.role) : ''
				}? ${SELF_ACCESS_WARNING}`}
				confirmLabel="Change role"
				pendingLabel="Changing…"
				isPending={updateRole.isPending}
				onConfirm={() => {
					if (confirmDemote.target)
						changeRole(confirmDemote.target.member, confirmDemote.target.role, true);
				}}
			/>
		</>
	);
}
