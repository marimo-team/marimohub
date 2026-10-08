/**
 * Identity matching — the small, shared toolkit for comparing a caller against
 * an id and/or email. Every case-insensitive identity comparison in the domain
 * (super-admin lists, project membership, the identity directory) goes through
 * these so the trim/lowercase and id-vs-email rules live in exactly one place.
 */

import type { UserId } from './ids';
import type { AuthEntitlement } from './ports/auth';

/** The authenticated caller reduced to what identity matching needs. */
export interface IdentitySubject {
	id: UserId;
	email: string;
	entitlements?: readonly AuthEntitlement[];
	groups?: readonly string[];
}

/** A member names exactly one user id, email, or IdP group. */
export interface MemberRef {
	user_id?: UserId;
	email?: string;
	group?: string;
}

export type MemberSelector = string | { group: string };

/** Trim and lowercase — the canonical fold for any case-insensitive comparison. */
export function foldCase(value: string): string {
	return value.trim().toLowerCase();
}

/** Canonical form of an email for case- and whitespace-insensitive comparison. */
export const normalizeEmail = foldCase;

/** Whether two emails are equal, ignoring case and surrounding whitespace. */
export function emailsEqual(a: string, b: string): boolean {
	return normalizeEmail(a) === normalizeEmail(b);
}

/** Whether a bare reference string denotes an email (contains `@`) rather than a user id. */
export function isEmailRef(ref: string): boolean {
	return ref.includes('@');
}

/**
 * Whether a bare id-or-email reference denotes this subject.
 *
 * A reference containing `@` matches ONLY the subject's email (case- and
 * whitespace-insensitively, trusting the IdP-asserted login email); any other
 * reference matches ONLY the id, exactly. The disambiguation is load-bearing:
 * `UserId` is an opaque IdP `sub` that can be any non-empty string, so without
 * it an email reference would also elevate a subject whose *id* happens to equal
 * that email while their real email is attacker-controlled.
 */
export function refMatchesSubject(ref: string, subject: IdentitySubject): boolean {
	return isEmailRef(ref) ? emailsEqual(ref, subject.email) : ref === subject.id;
}

/** Whether ANY reference in the list denotes this subject (undefined/empty → false). */
export function anyRefMatchesSubject(
	refs: readonly string[] | undefined,
	subject: IdentitySubject,
): boolean {
	return refs?.some((ref) => refMatchesSubject(ref, subject)) ?? false;
}

/** Group ids and user ids match exactly; invite emails match case-insensitively. */
export function memberRefMatchesSubject(member: MemberRef, subject: IdentitySubject): boolean {
	if (member.group !== undefined)
		return (
			member.user_id === undefined &&
			member.email === undefined &&
			(subject.groups?.includes(member.group) ?? false)
		);
	if (member.user_id !== undefined) return member.user_id === subject.id;
	return member.email !== undefined && emailsEqual(member.email, subject.email);
}

/** Group selectors cannot address individual members, even when their names coincide. */
export function memberRefMatchesSelector(member: MemberRef, selector: MemberSelector): boolean {
	if (typeof selector !== 'string')
		return (
			member.user_id === undefined && member.email === undefined && member.group === selector.group
		);
	if (member.group !== undefined) return false;
	if (member.user_id !== undefined) return member.user_id === selector;
	return member.email !== undefined && emailsEqual(member.email, selector);
}
