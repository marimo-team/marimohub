import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Trash2 } from 'lucide-react';
import {
	ComboBox,
	ConfirmDialog,
	DialogModal,
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
import { defaultAccessSummary, ROLES, roleDescriptions } from '@/lib/roles';
import type { ProjectDetail, ProjectMember, ProjectRole, ResolvedUser } from '@/types';

// Same validator the server's AddMemberBody uses, so the picker never offers
// an "Invite by email" option the API would 422.
const isEmail = (value: string) => z.email().safeParse(value).success;

/** The identifier the API keys a member row by: user id, or invite email. */
function memberKey(member: ProjectMember): string {
	return member.user_id ?? member.email ?? '';
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
						{role}
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
			<span className="text-xs font-semibold">Add member</span>
			<ComboBox
				aria-label="Search users"
				placeholder="Search by name or email, or paste a user id"
				inputValue={query}
				onInputChange={setQuery}
				options={options}
				isDisabled={isPending}
				emptyState={
					debounced.trim().length < 2
						? 'Type at least two characters to search'
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
	const isAdmin = project.your_role === 'admin';
	const { data: members, isLoading } = useProjectMembersQuery(project.id);
	const { data: users, isLoading: usersLoading } = useUsersQuery(
		(members ?? []).map((m) => m.user_id),
	);
	const { data: capabilities } = useCapabilitiesQuery();
	const descriptions = roleDescriptions(capabilities);
	const accessSummary = defaultAccessSummary(capabilities);
	const addMember = useAddMember(project.id);
	const updateRole = useUpdateMemberRole(project.id);
	const removeMember = useRemoveMember(project.id);
	const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);

	const handleAdd = async (choice: MemberChoice, role: ProjectRole) => {
		try {
			await addMember.mutateAsync({ ...choice, role });
			toast.success('email' in choice ? 'Invite added' : 'Member added');
			return true;
		} catch (err) {
			toast.error((err as Error).message);
			return false;
		}
	};

	const handleRoleChange = (member: ProjectMember, role: ProjectRole) => {
		updateRole.mutate(
			{ uid: memberKey(member), role },
			{
				onSuccess: () => toast.success('Role updated'),
				onError: (err) => toast.error(err.message),
			},
		);
	};

	const handleRemove = () => {
		if (!removeTarget) return;
		removeMember.mutate(memberKey(removeTarget), {
			onSuccess: () => {
				toast.success('Member removed');
				setRemoveTarget(null);
			},
			onError: (err) => toast.error(err.message),
		});
	};

	const removeTargetName = removeTarget
		? (removeTarget.user_id &&
				(users?.[removeTarget.user_id]?.name || users?.[removeTarget.user_id]?.email)) ||
			memberKey(removeTarget)
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
								const key = memberKey(member);
								const isOwner = member.user_id === project.owner;
								return (
									<li
										key={key}
										data-testid="member-row"
										className="flex items-center justify-between gap-3 py-2"
									>
										{member.user_id ? (
											<UserLabel
												user={users?.[member.user_id]}
												fallbackId={member.user_id}
												loading={usersLoading}
												className="min-w-0 flex-1"
											/>
										) : (
											<span className="flex min-w-0 flex-1 items-center gap-2">
												<span className="truncate">{member.email}</span>
												<Tooltip content="Invited by email — becomes active when they first sign in">
													<span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
														invited
													</span>
												</Tooltip>
											</span>
										)}
										{isOwner ? (
											<span className="shrink-0 text-xs text-muted-foreground">
												owner · {member.role}
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

					{accessSummary && <p className="text-xs text-muted-foreground">{accessSummary}</p>}

					{isAdmin && (
						<AddMemberPicker
							members={members ?? []}
							users={users}
							descriptions={descriptions}
							onAdd={handleAdd}
							isPending={addMember.isPending}
						/>
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
