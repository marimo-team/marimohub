import { useState } from 'react';
import { isAuthGroupId } from '@marimo-hub/core/ports/auth';
import { toast } from 'sonner';
import { z } from 'zod';
import { ChevronDown, Trash2, Users } from 'lucide-react';
import {
	Button,
	ComboBox,
	ConfirmDialog,
	DialogModal,
	displayName,
	IconButton,
	Tooltip,
	UserAvatar,
	UserLabel,
} from '@/components/ui';
import {
	useAddMember,
	useCapabilitiesQuery,
	useProjectMembersQuery,
	useRemoveMember,
	useUpdateMemberRole,
	useUpdateProject,
	useUserSearchQuery,
	useUsersQuery,
} from '@/api/hooks';
import type { UserDirectory } from '@/api/hooks';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import {
	ASSIGNABLE_ROLES,
	canManageProject,
	defaultAccessSummary,
	roleDescriptions,
	roleLabel,
} from '@/lib/roles';
import type {
	AssignableProjectRole,
	Capabilities,
	ProjectDetail,
	ProjectDefaultRole,
	ProjectMember,
	ProjectRole,
	ResolvedUser,
	User,
} from '@/types';

// Same validator the server's AddMemberBody uses, so the picker never offers
// an "Invite by email" option the API would 422.
const isEmail = (value: string) => z.email().safeParse(value).success;

function memberLabel(member: ProjectMember): string {
	return member.group ?? member.user_id ?? member.email ?? '';
}

function memberSelector(member: ProjectMember) {
	return member.group !== undefined ? { group: member.group } : memberLabel(member);
}

function memberKey(member: ProjectMember): string {
	return member.group !== undefined
		? `group:${member.group}`
		: member.user_id !== undefined
			? `user:${member.user_id}`
			: `email:${member.email}`;
}

function isCurrentUser(member: ProjectMember, user: User): boolean {
	return (
		member.user_id === user.id ||
		(member.email !== undefined && member.email.toLowerCase() === user.email.toLowerCase())
	);
}

const assignableRoleOptions = ASSIGNABLE_ROLES.map((role) => (
	<option key={role} value={role}>
		{roleLabel(role)}
	</option>
));

interface RoleBadgeProps {
	value: ProjectRole;
	descriptions: Record<ProjectRole, string>;
	label: string;
	legacyAdmin?: boolean;
}

function RoleBadge({ value, descriptions, label, legacyAdmin }: RoleBadgeProps) {
	const displayRole = value === 'admin' && legacyAdmin ? 'Admin (legacy)' : roleLabel(value);
	return (
		<Tooltip
			content={
				<div className="flex max-w-72 flex-col gap-1">
					<span className="font-semibold">{displayRole}</span>
					<span>{descriptions[value]}</span>
				</div>
			}
		>
			<button
				type="button"
				aria-label={`${label}: ${displayRole}`}
				className="inline-flex h-7 shrink-0 cursor-help items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 text-xs font-medium text-primary outline-none transition-colors hover:border-primary/40 hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				{displayRole}
			</button>
		</Tooltip>
	);
}

function OwnerBadge({ label }: { label: string }) {
	return (
		<span
			aria-label={`${label}: Owner`}
			className="inline-flex h-7 shrink-0 items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 text-xs font-medium text-primary"
		>
			Owner
		</span>
	);
}

interface RoleSelectProps {
	label: string;
	value: ProjectRole;
	onChange: (role: AssignableProjectRole) => void;
	descriptions: Record<ProjectRole, string>;
	disabled?: boolean;
}

function RoleSelect({ label, value, onChange, descriptions, disabled }: RoleSelectProps) {
	const tooltip = (
		<div className="flex flex-col gap-1">
			{value === 'admin' && (
				<p>
					<span className="font-semibold">admin (legacy)</span> — {descriptions.admin}
				</p>
			)}
			{ASSIGNABLE_ROLES.map((role) => (
				<p key={role}>
					<span className="font-semibold">{role}</span> — {descriptions[role]}
				</p>
			))}
		</div>
	);
	return (
		<span className="relative inline-flex shrink-0 items-center">
			<Tooltip content={tooltip}>
				<select
					aria-label={label}
					value={value}
					onChange={(e) => onChange(e.target.value as AssignableProjectRole)}
					disabled={disabled}
					className="peer h-8 max-sm:h-11 rounded-md border border-input bg-background appearance-none pl-2 pr-8 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					{value === 'admin' && (
						<option value="admin" disabled>
							Admin (legacy)
						</option>
					)}
					{assignableRoleOptions}
				</select>
			</Tooltip>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground peer-disabled:opacity-50"
			/>
		</span>
	);
}

type PersonChoice = { user_id: string } | { email: string };
type MemberChoice = PersonChoice | { group: string };

type PickerOption = {
	id: string;
	textValue: string;
	choice: PersonChoice;
	user?: ResolvedUser;
	/** Label for the synthetic fallback rows ("Invite …", "Add by id …"). */
	action?: string;
};

interface AddMemberPickerProps {
	members: ProjectMember[];
	/** Resolved identities for the id-keyed member rows (email dedupe). */
	users: UserDirectory | undefined;
	descriptions: Record<ProjectRole, string>;
	/** Resolves true on success (errors are toasted by the caller). */
	onAdd: (choice: MemberChoice, role: AssignableProjectRole) => Promise<boolean>;
	isPending: boolean;
}

interface MemberPickerInputProps {
	inputValue: string;
	onInputChange: (value: string) => void;
	role: AssignableProjectRole;
}

function AddMemberPicker({
	members,
	users,
	onAdd,
	isPending,
	role,
	inputValue: query,
	onInputChange: setQuery,
}: AddMemberPickerProps & MemberPickerInputProps) {
	const debounced = useDebouncedValue(query);
	const search = useUserSearchQuery(debounced);

	const trimmed = query.trim();
	// A member matches by id, by invite email, or by the email their id row
	// resolves to — so an existing member's address is never offered as an invite
	// (the server would resolve it to their id and 409).
	const isMember = (choice: PersonChoice) => {
		if ('user_id' in choice) return members.some((m) => m.user_id === choice.user_id);
		const email = choice.email.toLowerCase();
		return members.some(
			(m) =>
				m.email === email ||
				(m.user_id !== undefined && users?.[m.user_id]?.email.toLowerCase() === email),
		);
	};

	const results: PickerOption[] = (search.data ?? []).flatMap((user) =>
		isMember({ user_id: user.id })
			? []
			: [
					{
						id: `user:${user.id}`,
						textValue: user.name || user.email,
						choice: { user_id: user.id },
						user,
					},
				],
	);

	// Old results and premature fallbacks can add the wrong person while typing.
	const settled =
		debounced.trim() === trimmed &&
		!search.isFetching &&
		!search.isError &&
		!search.isPlaceholderData &&
		(search.data !== undefined || !trimmed);

	const options = settled ? [...results] : [];
	if (settled && isEmail(trimmed)) {
		const email = trimmed.toLowerCase();
		// Redundant next to a directory hit for the same address — the server
		// resolves it to the same user id anyway.
		const inDirectory = (search.data ?? []).some((u) => u.email.toLowerCase() === email);
		if (!inDirectory && !isMember({ email })) {
			options.push({
				id: `email:${email}`,
				textValue: trimmed,
				choice: { email },
				action: `Invite "${email}" by email`,
			});
		}
	} else if (settled && trimmed && !isEmail(trimmed)) {
		// Escape hatch for ids the directory can't find (user never signed in) —
		// offered below any results so an id that merely substring-matches other
		// entries stays addable, but never when the exact id is already known.
		const exactHit = (search.data ?? []).some((u) => u.id === trimmed);
		if (!exactHit && !isMember({ user_id: trimmed })) {
			options.push({
				id: `id:${trimmed}`,
				textValue: trimmed,
				choice: { user_id: trimmed },
				action: `Add "${trimmed}" by user id`,
			});
		}
	}

	const submit = (choice: PersonChoice) => {
		if (isMember(choice)) {
			toast.error('Already a member');
			return;
		}
		// Keep the typed query on failure so the user can retry or correct it.
		void onAdd(choice, role).then((added) => {
			if (added) setQuery('');
		});
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">
				Choose a role, then select a person to add them immediately.
			</p>
			<ComboBox
				aria-label="Search users"
				inputClassName="max-sm:h-11 max-sm:text-base"
				autoCapitalize="none"
				spellCheck={false}
				placeholder="Search by name or email, or paste a user ID…"
				inputValue={query}
				onInputChange={setQuery}
				options={trimmed ? options : []}
				isDisabled={isPending}
				emptyState={
					!trimmed || (search.isError && debounced.trim() === trimmed)
						? undefined
						: trimmed.length < 2
							? 'Type at least 2 characters to search'
							: !settled
								? 'Searching…'
								: 'No matching users'
				}
				onSelect={(id) => {
					const option = options.find((o) => o.id === id);
					if (option) submit(option.choice);
				}}
				renderOption={(option) =>
					option.user ? (
						<span className="flex min-w-0 items-baseline gap-2">
							<span className="truncate">{option.user.name}</span>
							<span className="truncate text-xs text-muted-foreground">{option.user.email}</span>
						</span>
					) : (
						<span className="truncate">{option.action}</span>
					)
				}
			/>
			{search.isError && trimmed.length >= 2 && debounced.trim() === trimmed && (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p role="alert" className="text-xs text-destructive">
						Could not search users. Try again.
					</p>
					<Button size="sm" onPress={() => void search.refetch()} isDisabled={search.isFetching}>
						Retry search
					</Button>
				</div>
			)}
		</div>
	);
}

function AddGroupPicker({
	members,
	role,
	onAdd,
	isPending,
	groups,
	inputValue: group,
	onInputChange: setGroup,
}: AddMemberPickerProps & MemberPickerInputProps & { groups: string[] }) {
	const duplicate = members.some((member) => member.group === group);
	const valid = isAuthGroupId(group);
	const suggestions = groups
		.filter(
			(value) =>
				value.toLowerCase().includes(group.toLowerCase()) &&
				!members.some((member) => member.group === value),
		)
		.map((value) => ({ id: value, textValue: value }));
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!valid || duplicate || isPending) return;
				void onAdd({ group }, role).then((added) => {
					if (added) setGroup('');
				});
			}}
		>
			<p id="group-member-help" className="text-xs text-muted-foreground">
				Use an exact, case-sensitive group ID. Suggestions come from your sign-in; the hub cannot
				verify other groups.
			</p>
			<ComboBox
				label="IdP group ID"
				retainSelection
				inputClassName="max-sm:h-11 max-sm:text-base"
				autoCapitalize="none"
				spellCheck={false}
				aria-describedby={
					group && (!valid || duplicate)
						? 'group-member-help group-member-error'
						: 'group-member-help'
				}
				isInvalid={!!group && (!valid || duplicate)}
				placeholder="/teams/data-science…"
				inputValue={group}
				onInputChange={setGroup}
				options={suggestions}
				isDisabled={isPending}
				onSelect={setGroup}
				renderOption={(option) => (
					<span className="wrap-anywhere" translate="no">
						{option.textValue}
					</span>
				)}
			/>
			{group && (!valid || duplicate) && (
				<p id="group-member-error" role="alert" className="text-xs text-destructive">
					{duplicate
						? 'This group is already a member.'
						: 'Use 1–128 characters, without commas, control characters, or leading or trailing whitespace.'}
				</p>
			)}
			<div className="flex justify-end">
				<Button
					type="submit"
					variant="primary"
					size="sm"
					isDisabled={!valid || duplicate || isPending}
				>
					{isPending ? 'Adding…' : 'Add group'}
				</Button>
			</div>
		</form>
	);
}

function AddMemberForm(props: AddMemberPickerProps & { groupsCarried: boolean; groups: string[] }) {
	const [kind, setKind] = useState('person');
	const [role, setRole] = useState<AssignableProjectRole>('editor');
	const [personQuery, setPersonQuery] = useState('');
	const [groupQuery, setGroupQuery] = useState('');
	const isGroup = props.groupsCarried && kind === 'group';
	return (
		<div className="flex flex-col gap-3 border-t pt-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs font-semibold">Add Member</span>
				{props.groupsCarried && (
					<select
						aria-label="Member type"
						className="h-9 max-sm:h-11 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						value={kind}
						onChange={(event) => setKind(event.target.value)}
						disabled={props.isPending}
					>
						<option value="person">Person</option>
						<option value="group">IdP group</option>
					</select>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground">
					{isGroup ? 'Group members join as' : 'New members join as'}
				</span>
				<RoleSelect
					label={isGroup ? 'New group role' : 'New member role'}
					value={role}
					onChange={setRole}
					descriptions={props.descriptions}
					disabled={props.isPending}
				/>
			</div>
			{isGroup ? (
				<AddGroupPicker
					{...props}
					role={role}
					inputValue={groupQuery}
					onInputChange={setGroupQuery}
				/>
			) : (
				<AddMemberPicker
					{...props}
					role={role}
					inputValue={personQuery}
					onInputChange={setPersonQuery}
				/>
			)}
		</div>
	);
}

function ProjectDefaultAccess({
	project,
	capabilities,
}: {
	project: ProjectDetail;
	capabilities: Capabilities | undefined;
}) {
	const canManage = canManageProject(project.your_role);
	const projectDefaultRole = project.default_role ?? 'inherit';
	const [defaultAccess, setDefaultAccess] = useState({
		projectId: project.id,
		sourceRole: projectDefaultRole,
		updatedAt: project.updated_at,
		role: projectDefaultRole,
	});
	if (
		defaultAccess.projectId !== project.id ||
		defaultAccess.sourceRole !== projectDefaultRole ||
		defaultAccess.updatedAt !== project.updated_at
	) {
		setDefaultAccess({
			projectId: project.id,
			sourceRole: projectDefaultRole,
			updatedAt: project.updated_at,
			role: projectDefaultRole,
		});
	}
	const defaultRole = defaultAccess.role;
	const accessSummary = defaultAccessSummary(defaultRole, capabilities?.default_role);
	const updateProject = useUpdateProject();
	if (!canManage && !accessSummary) return null;

	return (
		<section aria-labelledby="default-access-heading" className="rounded-lg border bg-card p-3">
			<h3 id="default-access-heading" className="mb-1 text-xs font-semibold">
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
									setDefaultAccess((current) =>
										current.projectId === project.id
											? { ...current, role: updated.default_role ?? 'inherit' }
											: current,
									);
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

export interface ProjectMembersDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
}

export function ProjectMembersDialog({ isOpen, onClose, project }: ProjectMembersDialogProps) {
	const { user } = useAuth();
	const canManage = canManageProject(project.your_role);
	const {
		data: members,
		isLoading,
		isError,
		isFetching,
		refetch,
	} = useProjectMembersQuery(project.id);
	const visibleMembers = members ?? project.members ?? [];
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
	const currentUserIsMember = user
		? visibleMembers.some(
				(member) => isCurrentUser(member, user) && member.role === project.your_role,
			)
		: false;
	const accessSource =
		user?.id === project.owner
			? 'Project owner'
			: user?.is_super_admin
				? 'Deployment super admin'
				: currentUserIsMember
					? 'Project member'
					: visibleMembers.some(
								(member) => member.group !== undefined && user?.groups.includes(member.group),
						  )
						? 'Group membership'
						: 'Default access';
	const currentIdentity = user ? users?.[user.id] : undefined;
	const currentDisplayName = currentIdentity?.name || user?.email || 'You';

	const handleAdd = async (choice: MemberChoice, role: AssignableProjectRole) => {
		try {
			await addMember.mutateAsync({ ...choice, role });
			toast.success(
				'group' in choice ? 'Group added' : 'email' in choice ? 'Invite added' : 'Member added',
			);
			return true;
		} catch {
			return false;
		}
	};

	const handleRoleChange = (member: ProjectMember, role: AssignableProjectRole) => {
		updateRole.mutate(
			{ selector: memberSelector(member), role },
			{ onSuccess: () => toast.success('Role updated') },
		);
	};

	const handleRemove = () => {
		const target = confirmRemove.target;
		if (!target) return;
		const options = {
			onSuccess: () => {
				toast.success(target.group !== undefined ? 'Group removed' : 'Member removed');
				confirmRemove.close();
			},
		};
		removeMember.mutate(memberSelector(target), options);
	};

	const removeTargetName = confirmRemove.target
		? displayName(
				confirmRemove.target.user_id ? users?.[confirmRemove.target.user_id] : undefined,
				memberLabel(confirmRemove.target),
			)
		: '';

	return (
		<>
			<DialogModal isOpen={isOpen} onClose={onClose} title="Project Access" width="lg">
				<div className="-m-1 max-h-[70dvh] overflow-y-auto overscroll-contain p-1">
					<div className="flex flex-col gap-5 text-sm">
						<section
							aria-labelledby="your-access-heading"
							className="rounded-lg border bg-muted/40 p-3.5"
						>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex min-w-0 max-w-full items-center gap-3">
									<UserAvatar
										pictureUrl={currentIdentity?.picture_url ?? user?.picture_url}
										label={currentDisplayName}
										className="size-9 text-xs"
									/>
									<div className="min-w-0">
										<h3
											id="your-access-heading"
											className="text-xs font-semibold text-muted-foreground"
										>
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

						<section aria-labelledby="members-heading" className="flex flex-col gap-2">
							<div className="flex items-baseline justify-between gap-3">
								<h3 id="members-heading" className="text-xs font-semibold">
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
									{visibleMembers.map((member) => {
										const key =
											member.group !== undefined ? `group ${member.group}` : memberLabel(member);
										const isOwner = member.user_id === project.owner;
										const isYou = user ? isCurrentUser(member, user) : false;
										return (
											<li
												key={memberKey(member)}
												data-testid="member-row"
												className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2.5"
											>
												<span
													className={cn(
														'flex min-w-0 flex-1 items-center gap-2',
														!isOwner && 'max-sm:basis-full',
													)}
												>
													{member.group !== undefined ? (
														<>
															<Users
																aria-hidden="true"
																className="size-5 shrink-0 text-muted-foreground"
															/>
															<span
																className="min-w-0 wrap-anywhere select-text text-sm leading-5"
																translate="no"
															>
																{member.group}
															</span>
															<Tooltip content="Access applies to everyone whose authenticated IdP groups include this exact ID.">
																<button
																	type="button"
																	aria-label={`IdP group ${member.group}`}
																	className="shrink-0 cursor-help rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
																>
																	Group
																</button>
															</Tooltip>
														</>
													) : member.user_id ? (
														<UserLabel
															user={users?.[member.user_id]}
															fallbackId={member.user_id}
															loading={usersLoading}
															className="min-w-0"
														/>
													) : (
														<>
															<span className="truncate" translate="no">
																{member.email}
															</span>
															<Tooltip content="Invited by email — becomes active when they first sign in">
																<button
																	type="button"
																	aria-label={`Pending invitation for ${member.email}`}
																	className="shrink-0 cursor-help rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
																>
																	Invited
																</button>
															</Tooltip>
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
															onChange={(role) => handleRoleChange(member, role)}
															descriptions={descriptions}
															disabled={isError || changingMember}
														/>
														<IconButton
															label={`Remove ${key}`}
															tooltip={
																member.group !== undefined ? 'Remove group' : 'Remove member'
															}
															className="max-sm:size-11"
															tone="danger"
															onPress={() => confirmRemove.open(member)}
															isDisabled={isError || changingMember}
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
									})}
								</ul>
							)}

							{canManage && (
								<AddMemberForm
									key={project.id}
									members={visibleMembers}
									groupsCarried={capabilities?.groups_carried ?? false}
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
				title={confirmRemove.target?.group !== undefined ? 'Remove Group' : 'Remove Member'}
				description={`Remove “${removeTargetName}” from “${project.name}”? This removes this membership. Other memberships, default access, or super-admin status may still give access.`}
				confirmLabel="Remove"
				pendingLabel="Removing…"
				isPending={removeMember.isPending}
				onConfirm={handleRemove}
			/>
		</>
	);
}
