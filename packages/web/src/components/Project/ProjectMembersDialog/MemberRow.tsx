import { Trash2, Users } from 'lucide-react';
import { IconButton, UserLabel } from '@/components/ui';
import type { UserDirectory } from '@/api/hooks';
import { cn } from '@/lib/utils';
import type { AssignableProjectRole, ProjectMember, ProjectRole } from '@/types';
import { memberLabel } from './memberIdentity';
import { MemberKindBadge, OwnerBadge, RoleBadge, RoleSelect } from './RoleControls';

interface MemberRowProps {
	member: ProjectMember;
	isOwner: boolean;
	isYou: boolean;
	canManage: boolean;
	disabled: boolean;
	users: UserDirectory | undefined;
	usersLoading: boolean;
	descriptions: Record<ProjectRole, string>;
	onRoleChange: (role: AssignableProjectRole) => void;
	onRemove: () => void;
}

export function MemberRow({
	member,
	isOwner,
	isYou,
	canManage,
	disabled,
	users,
	usersLoading,
	descriptions,
	onRoleChange,
	onRemove,
}: MemberRowProps) {
	const key = member.group !== undefined ? `group ${member.group}` : memberLabel(member);
	const user = member.user_id ? users?.[member.user_id] : undefined;
	return (
		<li
			data-testid="member-row"
			className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2.5"
		>
			<span
				className={cn('flex min-w-0 flex-1 items-center gap-2', !isOwner && 'max-sm:basis-full')}
			>
				{member.group !== undefined ? (
					<>
						<Users aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 wrap-anywhere select-text text-sm leading-5" translate="no">
							{member.group}
						</span>
						<MemberKindBadge kind="group" id={member.group} />
					</>
				) : member.user_id ? (
					<span className="flex min-w-0 flex-col">
						<UserLabel
							user={user}
							fallbackId={member.user_id}
							loading={usersLoading}
							className="min-w-0"
						/>
						{user?.name && user.email && user.name !== user.email ? (
							<span
								className="truncate text-xs text-muted-foreground"
								title={user.email}
								translate="no"
							>
								{user.email}
							</span>
						) : null}
					</span>
				) : (
					<>
						<span className="truncate" translate="no">
							{member.email}
						</span>
						<MemberKindBadge kind="invited" id={member.email ?? ''} />
					</>
				)}
				{isYou && (
					<span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
						You
					</span>
				)}
			</span>
			{isOwner ? (
				<OwnerBadge label={`Role for ${key}`} />
			) : canManage ? (
				<span className="flex shrink-0 items-center gap-1.5">
					<RoleSelect
						label={`Role for ${key}`}
						value={member.role}
						onChange={onRoleChange}
						descriptions={descriptions}
						disabled={disabled}
					/>
					<IconButton
						label={`Remove ${key}`}
						tooltip={member.group !== undefined ? 'Remove group' : 'Remove member'}
						className="max-sm:size-11"
						tone="danger"
						onPress={onRemove}
						isDisabled={disabled}
					>
						<Trash2 aria-hidden="true" className="size-4" />
					</IconButton>
				</span>
			) : (
				<RoleBadge
					value={member.role}
					descriptions={descriptions}
					label={`Role for ${key}`}
					legacyAdmin={member.role === 'admin'}
				/>
			)}
		</li>
	);
}
