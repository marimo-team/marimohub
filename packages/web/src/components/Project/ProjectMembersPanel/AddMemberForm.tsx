import { useId, useState } from 'react';
import { isAuthGroupId, MAX_AUTH_GROUP_ID_LENGTH } from '@marimo-hub/core/ports/auth';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button, ComboBox } from '@/components/ui';
import { useUserSearchQuery } from '@/api/hooks';
import type { MemberChoice, UserDirectory } from '@/api/hooks';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { AssignableProjectRole, ProjectMember, ProjectRole, ResolvedUser } from '@/types';
import { RoleSelect } from './RoleControls';

// Same validator the server's AddMemberBody uses, so the picker never offers
// an "Invite by email" option the API would 422.
const isEmail = (value: string) => z.email().safeParse(value).success;

type PersonChoice = Exclude<MemberChoice, { group: string }>;
type MemberKind = 'person' | 'group';

export type AddMemberHandler = (
	choice: MemberChoice,
	role: AssignableProjectRole,
	onSuccess: () => void,
) => void;

type PickerOption = {
	id: string;
	textValue: string;
	choice: PersonChoice;
	user?: ResolvedUser;
	/** Label for the synthetic fallback rows ("Invite …", "Add by id …"). */
	action?: string;
};

interface PickerProps {
	members: ProjectMember[];
	onAdd: AddMemberHandler;
	isPending: boolean;
	role: AssignableProjectRole;
	inputValue: string;
	onInputChange: (value: string) => void;
}

function AddPersonPicker({
	members,
	users,
	onAdd,
	isPending,
	role,
	inputValue: query,
	onInputChange: setQuery,
}: PickerProps & {
	/** Resolved identities for the id-keyed member rows (email dedupe). */
	users: UserDirectory | undefined;
}) {
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
		isMember({ user_id: user.id }) || isMember({ email: user.email })
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
		onAdd(choice, role, () => setQuery(''));
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
}: PickerProps & { groups: readonly string[] }) {
	const helpId = useId();
	const errorId = useId();
	const memberGroups = new Set(members.map((member) => member.group));
	const duplicate = memberGroups.has(group);
	const valid = isAuthGroupId(group);
	const showError = !!group && (!valid || duplicate);
	const query = group.toLowerCase();
	const suggestions = groups.flatMap((value) =>
		value.toLowerCase().includes(query) && !memberGroups.has(value)
			? [{ id: value, textValue: value }]
			: [],
	);
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!valid || duplicate || isPending) return;
				onAdd({ group }, role, () => setGroup(''));
			}}
		>
			<p id={helpId} className="text-xs text-muted-foreground">
				Use an exact, case-sensitive group ID. Suggestions come from your sign-in; the hub cannot
				verify other groups.
			</p>
			<ComboBox
				label="IdP group ID"
				retainSelection
				inputClassName="max-sm:h-11 max-sm:text-base"
				autoCapitalize="none"
				spellCheck={false}
				aria-describedby={showError ? `${helpId} ${errorId}` : helpId}
				isInvalid={showError}
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
			{showError && (
				<p id={errorId} role="alert" className="text-xs text-destructive">
					{duplicate
						? 'This group is already a member.'
						: `Use 1–${MAX_AUTH_GROUP_ID_LENGTH} characters, without commas, control characters, or leading or trailing whitespace.`}
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

interface AddMemberFormProps {
	members: ProjectMember[];
	users: UserDirectory | undefined;
	descriptions: Record<ProjectRole, string>;
	onAdd: AddMemberHandler;
	isPending: boolean;
	projectGroupsAvailable: boolean;
	/** The caller's own IdP groups, offered as suggestions. */
	groups: readonly string[];
}

export function AddMemberForm({
	members,
	users,
	descriptions,
	onAdd,
	isPending,
	projectGroupsAvailable,
	groups,
}: AddMemberFormProps) {
	const [kind, setKind] = useState<MemberKind>('person');
	const [role, setRole] = useState<AssignableProjectRole>('editor');
	const [personQuery, setPersonQuery] = useState('');
	const [groupQuery, setGroupQuery] = useState('');
	const isGroup = projectGroupsAvailable && kind === 'group';
	const pickerProps = { members, onAdd, isPending, role };
	return (
		<div className="flex flex-col gap-3 border-t pt-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs font-semibold">Add Member</span>
				{projectGroupsAvailable && (
					<select
						aria-label="Member type"
						className="h-9 max-sm:h-11 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						value={kind}
						onChange={(event) => setKind(event.target.value as MemberKind)}
						disabled={isPending}
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
					descriptions={descriptions}
					disabled={isPending}
				/>
			</div>
			{isGroup ? (
				<AddGroupPicker
					{...pickerProps}
					groups={groups}
					inputValue={groupQuery}
					onInputChange={setGroupQuery}
				/>
			) : (
				<AddPersonPicker
					{...pickerProps}
					users={users}
					inputValue={personQuery}
					onInputChange={setPersonQuery}
				/>
			)}
		</div>
	);
}
