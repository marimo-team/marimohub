import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Trash2 } from 'lucide-react';
import {
	ComboBox,
	ConfirmDialog,
	DialogModal,
	displayName,
	IconButton,
	Tooltip,
	UserLabel,
} from '@/components/ui';
import {
	useAddMember,
	useCapabilitiesQuery,
	useProjectMembersQuery,
	useRemoveMember,
	useUpdateMemberRole,
	useUserSearchQuery,
	useUsersQuery,
} from '@/api/hooks';
import type { UserDirectory } from '@/api/hooks';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDialogTarget } from '@/hooks/useDialogTarget';
import { useAuth } from '@/context/AuthContext';
import { toastError } from '@/lib/errors';
import { defaultAccessSummary, ROLES, roleDescriptions } from '@/lib/roles';
import type { ProjectDetail, ProjectMember, ProjectRole, ResolvedUser, User } from '@/types';

// Same validator the server's AddMemberBody uses, so the picker never offers
// an "Invite by email" option the API would 422.
const isEmail = (value: string) => z.email().safeParse(value).success;

/** The identifier the API keys a member row by: user id, or invite email. */
function memberKey(member: ProjectMember): string {
	return member.user_id ?? member.email ?? '';
}

function isCurrentUser(member: ProjectMember, user: User): boolean {
	return (
		member.user_id === user.id ||
		(member.email !== undefined && member.email.toLowerCase() === user.email.toLowerCase())
	);
}

function roleLabel(role: ProjectRole): string {
	return role[0].toUpperCase() + role.slice(1);
}

interface RoleBadgeProps {
	value: ProjectRole;
	descriptions: Record<ProjectRole, string>;
	label: string;
}

function RoleBadge({ value, descriptions, label }: RoleBadgeProps) {
	return (
		<Tooltip
			content={
				<div className="flex max-w-72 flex-col gap-1">
					<span className="font-semibold">{roleLabel(value)}</span>
					<span>{descriptions[value]}</span>
				</div>
			}
		>
			<button
				type="button"
				aria-label={`${label}: ${roleLabel(value)}`}
				className="inline-flex h-7 shrink-0 cursor-help items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 text-xs font-medium text-primary outline-none transition-colors hover:border-primary/40 hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				{roleLabel(value)}
			</button>
		</Tooltip>
	);
}

interface RoleSelectProps {
	label: string;
	value: ProjectRole;
	onChange: (role: ProjectRole) => void;
	descriptions: Record<ProjectRole, string>;
	disabled?: boolean;
}

function RoleSelect({ label, value, onChange, descriptions, disabled }: RoleSelectProps) {
	const tooltip = (
		<div className="flex flex-col gap-1">
			{ROLES.map((role) => (
				<p key={role}>
					<span className="font-semibold">{role}</span> — {descriptions[role]}
				</p>
			))}
		</div>
	);
	return (
		<Tooltip content={tooltip}>
			<select
				aria-label={label}
				value={value}
				onChange={(e) => onChange(e.target.value as ProjectRole)}
				disabled={disabled}
				className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
			>
				{ROLES.map((role) => (
					<option key={role} value={role}>
						{roleLabel(role)}
					</option>
				))}
			</select>
		</Tooltip>
	);
}

// What the picker submits: a directory hit / raw id, or an email invite.
type MemberChoice = { user_id: string } | { email: string };

type PickerOption = {
	id: string;
	textValue: string;
	choice: MemberChoice;
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
	onAdd: (choice: MemberChoice, role: ProjectRole) => Promise<boolean>;
	isPending: boolean;
}

/**
 * Search-driven member picker: results come from the user directory (anyone
 * who has signed in), minus existing members. Free text still works — an
 * email becomes an invite (granted on their first sign-in) and anything else
 * can be added as a raw user id, so people outside the directory aren't
 * blocked. Picking an option adds immediately at the selected role.
 */
function AddMemberPicker({ members, users, descriptions, onAdd, isPending }: AddMemberPickerProps) {
	const [query, setQuery] = useState('');
	const [role, setRole] = useState<ProjectRole>('editor');
	const debounced = useDebouncedValue(query);
	const search = useUserSearchQuery(debounced);

	const trimmed = query.trim();
	// A member matches by id, by invite email, or by the email their id row
	// resolves to — so an existing member's address is never offered as an invite
	// (the server would resolve it to their id and 409).
	const isMember = (choice: MemberChoice) => {
		if ('user_id' in choice) return members.some((m) => m.user_id === choice.user_id);
		const email = choice.email.toLowerCase();
		return members.some(
			(m) =>
				m.email === email ||
				(m.user_id !== undefined && users?.[m.user_id]?.email.toLowerCase() === email),
		);
	};

	const results: PickerOption[] = (search.data ?? [])
		.filter((u) => !isMember({ user_id: u.id }))
		.map((u) => ({
			id: `user:${u.id}`,
			textValue: u.name || u.email,
			choice: { user_id: u.id },
			user: u,
		}));

	// Synthetic fallbacks only once the search for the CURRENT text has settled:
	// while the debounce or request is still pending, the directory might match,
	// and offering "add by id" early lets a mis-timed click persist garbage.
	const settled =
		debounced.trim() === trimmed && !search.isFetching && (search.data !== undefined || !trimmed);

	const options = [...results];
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

	const submit = (choice: MemberChoice) => {
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
		<div className="flex flex-col gap-3 border-t pt-4">
			<span className="text-xs font-semibold">Add Member</span>
			<ComboBox
				aria-label="Search users"
				placeholder="Search by name or email, or paste a user ID…"
				inputValue={query}
				onInputChange={setQuery}
				options={options}
				isDisabled={isPending}
				emptyState={
					debounced.trim().length < 2
						? 'Type at least 2 characters to search'
						: search.isFetching
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
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">New members join as</span>
				<RoleSelect
					label="New member role"
					value={role}
					onChange={setRole}
					descriptions={descriptions}
				/>
			</div>
		</div>
	);
}

export interface ProjectMembersDialogProps {
	isOpen: boolean;
	onClose: () => void;
	project: ProjectDetail;
}

/**
 * Member management for a project: the member list (visible to everyone), and —
 * for admins — a role select and remove control per member plus a search-driven
 * add-member picker. The owner's row shows no controls: the API rejects changing
 * or removing the owner, so the UI doesn't offer it.
 */
export function ProjectMembersDialog({ isOpen, onClose, project }: ProjectMembersDialogProps) {
	const { user } = useAuth();
	const isAdmin = project.your_role === 'admin';
	const { data: members, isLoading } = useProjectMembersQuery(project.id);
	const visibleMembers = members ?? project.members ?? [];
	const { data: users, isLoading: usersLoading } = useUsersQuery([
		...visibleMembers.map((m) => m.user_id),
		user?.id,
	]);
	const { data: capabilities } = useCapabilitiesQuery();
	const descriptions = roleDescriptions(capabilities);
	const accessSummary = defaultAccessSummary(capabilities);
	const addMember = useAddMember(project.id);
	const updateRole = useUpdateMemberRole(project.id);
	const removeMember = useRemoveMember(project.id);
	const confirmRemove = useDialogTarget<ProjectMember>();
	const currentUserIsMember = user
		? visibleMembers.some((member) => isCurrentUser(member, user))
		: false;
	const accessSource =
		user?.id === project.owner
			? 'Project owner'
			: currentUserIsMember
				? 'Project member'
				: user?.is_super_admin
					? 'Deployment super admin'
					: 'Default access';
	const currentIdentity = user ? users?.[user.id] : undefined;
	const currentDisplayName = currentIdentity?.name || user?.email || 'You';

	const handleAdd = async (choice: MemberChoice, role: ProjectRole) => {
		try {
			await addMember.mutateAsync({ ...choice, role });
			toast.success('email' in choice ? 'Invite added' : 'Member added');
			return true;
		} catch (err) {
			toastError(err);
			return false;
		}
	};

	const handleRoleChange = (member: ProjectMember, role: ProjectRole) => {
		updateRole.mutate(
			{ uid: memberKey(member), role },
			{
				onSuccess: () => toast.success('Role updated'),
				onError: toastError,
			},
		);
	};

	const handleRemove = () => {
		const target = confirmRemove.target;
		if (!target) return;
		removeMember.mutate(memberKey(target), {
			onSuccess: () => {
				toast.success('Member removed');
				confirmRemove.close();
			},
			onError: toastError,
		});
	};

	const removeTargetName = confirmRemove.target
		? displayName(
				confirmRemove.target.user_id ? users?.[confirmRemove.target.user_id] : undefined,
				memberKey(confirmRemove.target),
			)
		: '';

	return (
		<>
			<DialogModal isOpen={isOpen} onClose={onClose} title="Project Access" width="lg">
				<div className="max-h-[70dvh] overflow-y-auto overscroll-contain pr-1">
					<div className="flex flex-col gap-5 text-sm">
						<section
							aria-labelledby="your-access-heading"
							className="rounded-lg border bg-muted/40 p-3.5"
						>
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex min-w-0 items-center gap-3">
									<span
										aria-hidden="true"
										className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500/15 to-teal-600/25 text-xs font-semibold text-primary ring-1 ring-primary/20"
									>
										{currentDisplayName.charAt(0).toUpperCase()}
									</span>
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
								{project.your_role ? (
									<RoleBadge
										value={project.your_role}
										descriptions={descriptions}
										label="Your role"
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

							{isLoading ? (
								<p className="py-2 text-muted-foreground">Loading members…</p>
							) : visibleMembers.length === 0 ? (
								<p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
									No explicit project members
								</p>
							) : (
								<ul className="flex flex-col divide-y">
									{visibleMembers.map((member) => {
										const key = memberKey(member);
										const isOwner = member.user_id === project.owner;
										const isYou = user ? isCurrentUser(member, user) : false;
										return (
											<li
												key={key}
												data-testid="member-row"
												className="flex min-w-0 items-center justify-between gap-3 py-2.5"
											>
												<span className="flex min-w-0 flex-1 items-center gap-2">
													{member.user_id ? (
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
													<span className="flex shrink-0 items-center gap-2">
														<span className="text-xs text-muted-foreground">Owner</span>
														<RoleBadge
															value="admin"
															descriptions={descriptions}
															label={`Role for ${key}`}
														/>
													</span>
												) : isAdmin ? (
													<span className="flex shrink-0 items-center gap-1.5">
														<RoleSelect
															label={`Role for ${key}`}
															value={member.role}
															onChange={(role) => handleRoleChange(member, role)}
															descriptions={descriptions}
															disabled={updateRole.isPending}
														/>
														<IconButton
															label={`Remove ${key}`}
															tooltip="Remove member"
															tone="danger"
															onPress={() => confirmRemove.open(member)}
														>
															<Trash2 className="size-4" />
														</IconButton>
													</span>
												) : (
													<RoleBadge
														value={member.role}
														descriptions={descriptions}
														label={`Role for ${key}`}
													/>
												)}
											</li>
										);
									})}
								</ul>
							)}

							{isAdmin && (
								<AddMemberPicker
									members={visibleMembers}
									users={users}
									descriptions={descriptions}
									onAdd={handleAdd}
									isPending={addMember.isPending}
								/>
							)}
						</section>

						{accessSummary && (
							<section
								aria-labelledby="default-access-heading"
								className="rounded-lg border bg-card p-3"
							>
								<h3 id="default-access-heading" className="mb-1 text-xs font-semibold">
									Default Access
								</h3>
								<p className="text-xs leading-relaxed text-muted-foreground">{accessSummary}</p>
							</section>
						)}
					</div>
				</div>
			</DialogModal>

			<ConfirmDialog
				isOpen={confirmRemove.isOpen}
				onClose={confirmRemove.close}
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
