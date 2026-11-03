import { memberRefMatchesSubject } from '@marimo-hub/core/identity-match';
import type { MemberSelector } from '@marimo-hub/core/identity-match';
import type { UserId } from '@marimo-hub/core/ids';
import type { ProjectMember, User } from '@/types';

export function memberLabel(member: ProjectMember): string {
	return member.group ?? member.user_id ?? member.email ?? '';
}

export function memberSelector(member: ProjectMember): MemberSelector {
	return member.group !== undefined ? { group: member.group } : memberLabel(member);
}

export function memberKey(member: ProjectMember): string {
	return member.group !== undefined
		? `group:${member.group}`
		: member.user_id !== undefined
			? `user:${member.user_id}`
			: `email:${member.email}`;
}

// The API hands the web plain strings; core brands user ids.
export function memberMatchesUser(member: ProjectMember, user: User): boolean {
	return memberRefMatchesSubject(
		{ ...member, user_id: member.user_id as UserId | undefined },
		{ id: user.id as UserId, email: user.email, groups: user.groups },
	);
}

/** A group row can grant the caller access, but it is never "you". */
export function isSelf(member: ProjectMember, user: User | null): boolean {
	return user !== null && member.group === undefined && memberMatchesUser(member, user);
}
