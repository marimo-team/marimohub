import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Trash2, UserPlus } from 'lucide-react';
import {
	Button,
	ConfirmDialog,
	DialogModal,
	IconButton,
	Tooltip,
	UserLabel,
} from '@/components/ui';
import { requiredText, schemaValidators, useAppForm } from '@/components/form';
import {
	useAddMember,
	useProjectMembersQuery,
	useRemoveMember,
	useUpdateMemberRole,
	useUsersQuery,
} from '@/api/hooks';
import type { ProjectDetail, ProjectMember, ProjectRole } from '@/types';

const ROLES: ProjectRole[] = ['admin', 'editor', 'viewer'];

// Mirrors the API's role matrix: reads are open to any member; 'editor' gates
// notebook/session writes; 'admin' gates project settings and membership.
const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
	admin: 'Manage members and project settings, plus everything an editor can do',
	editor: 'Create, edit, and run notebooks',
	viewer: 'View projects and notebooks (read-only)',
};

const roleTooltip = (
	<div className="flex flex-col gap-1">
		{ROLES.map((role) => (
			<p key={role}>
				<span className="font-semibold">{role}</span> — {ROLE_DESCRIPTIONS[role]}
			</p>
		))}
	</div>
);

const addMemberSchema = z.object({
	userId: requiredText('User id'),
	role: z.enum(['admin', 'editor', 'viewer']),
});

interface RoleSelectProps {
	label: string;
	value: ProjectRole;
	onChange: (role: ProjectRole) => void;
	disabled?: boolean;
}

function RoleSelect({ label, value, onChange, disabled }: RoleSelectProps) {
	return (
		<Tooltip content={roleTooltip}>
			<select
				aria-label={label}
				value={value}
				onChange={(e) => onChange(e.target.value as ProjectRole)}
				disabled={disabled}
				className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			>
				{ROLES.map((role) => (
					<option key={role} value={role}>
						{role}
					</option>
				))}
			</select>
		</Tooltip>
	);
}

export interface ProjectMembersDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
}

/**
 * Member management for a project: the member list (visible to everyone), and —
 * for admins — a role select and remove control per member plus an add-member
 * form. The owner's row shows no controls: the API rejects changing or removing
 * the owner, so the UI doesn't offer it.
 */
export function ProjectMembersDialog({ isOpen, onClose, project }: ProjectMembersDialogProps) {
	const isAdmin = project.your_role === 'admin';
	const { data: members, isLoading } = useProjectMembersQuery(project.id);
	const { data: users, isLoading: usersLoading } = useUsersQuery(
		(members ?? []).map((m) => m.user_id),
	);
	const addMember = useAddMember(project.id);
	const updateRole = useUpdateMemberRole(project.id);
	const removeMember = useRemoveMember(project.id);
	const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);

	const form = useAppForm({
		defaultValues: { userId: '', role: 'editor' as ProjectRole },
		validators: schemaValidators(addMemberSchema),
		onSubmit: async ({ value }) => {
			try {
				await addMember.mutateAsync({ user_id: value.userId.trim(), role: value.role });
				toast.success('Member added');
				form.reset();
			} catch (err) {
				toast.error((err as Error).message);
			}
		},
	});

	const handleRoleChange = (member: ProjectMember, role: ProjectRole) => {
		updateRole.mutate(
			{ uid: member.user_id, role },
			{
				onSuccess: () => toast.success('Role updated'),
				onError: (err) => toast.error(err.message),
			},
		);
	};

	const handleRemove = () => {
		if (!removeTarget) return;
		removeMember.mutate(removeTarget.user_id, {
			onSuccess: () => {
				toast.success('Member removed');
				setRemoveTarget(null);
			},
			onError: (err) => toast.error(err.message),
		});
	};

	const removeTargetName = removeTarget
		? users?.[removeTarget.user_id]?.name ||
			users?.[removeTarget.user_id]?.email ||
			removeTarget.user_id
		: '';

	return (
		<>
			<DialogModal isOpen={isOpen} onClose={onClose} title="Members" width="md">
				<div className="flex flex-col gap-4 text-sm">
					{isLoading ? (
						<p className="text-muted-foreground">Loading members...</p>
					) : (
						<ul className="flex flex-col divide-y">
							{(members ?? []).map((member) => {
								const isOwner = member.user_id === project.owner;
								return (
									<li
										key={member.user_id}
										data-testid="member-row"
										className="flex items-center justify-between gap-3 py-2"
									>
										<UserLabel
											user={users?.[member.user_id]}
											fallbackId={member.user_id}
											loading={usersLoading}
											className="min-w-0 flex-1"
										/>
										{isOwner ? (
											<span className="shrink-0 text-xs text-muted-foreground">
												owner · {member.role}
											</span>
										) : isAdmin ? (
											<span className="flex shrink-0 items-center gap-1.5">
												<RoleSelect
													label={`Role for ${member.user_id}`}
													value={member.role}
													onChange={(role) => handleRoleChange(member, role)}
													disabled={updateRole.isPending}
												/>
												<IconButton
													label={`Remove ${member.user_id}`}
													tooltip="Remove member"
													tone="danger"
													onPress={() => setRemoveTarget(member)}
												>
													<Trash2 className="size-4" />
												</IconButton>
											</span>
										) : (
											<span className="shrink-0 text-xs text-muted-foreground">{member.role}</span>
										)}
									</li>
								);
							})}
						</ul>
					)}

					{isAdmin && (
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void form.handleSubmit();
							}}
							className="flex flex-col gap-3 border-t pt-4"
						>
							<span className="text-xs font-semibold">Add member</span>
							<form.AppField name="userId">
								{(f) => <f.TextField label="User id" placeholder="usr_..." />}
							</form.AppField>
							<div className="flex items-center gap-2">
								<form.AppField name="role">
									{(f) => (
										<RoleSelect
											label="New member role"
											value={f.state.value}
											onChange={f.handleChange}
										/>
									)}
								</form.AppField>
								<Button
									type="submit"
									variant="primary"
									isDisabled={addMember.isPending}
									className="ml-auto"
								>
									<UserPlus className="size-4" />
									{addMember.isPending ? 'Adding...' : 'Add member'}
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								There is no user search: ask your teammate for their user id — it's shown in the
								user menu at the top right ("Copy user id").
							</p>
						</form>
					)}
				</div>
			</DialogModal>

			<ConfirmDialog
				isOpen={!!removeTarget}
				onClose={() => setRemoveTarget(null)}
				title="Remove Member"
				description={`Remove "${removeTargetName}" from "${project.name}"? They lose access to all notebooks in this project.`}
				confirmLabel="Remove"
				pendingLabel="Removing..."
				isPending={removeMember.isPending}
				onConfirm={handleRemove}
			/>
		</>
	);
}
