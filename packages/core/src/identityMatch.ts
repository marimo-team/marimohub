/**
 * Identity matching — the small, shared toolkit for comparing a caller against
 * an id and/or email. Every case-insensitive identity comparison in the domain
 * (super-admin lists, project membership, the identity directory) goes through
 * these so the trim/lowercase and id-vs-email rules live in exactly one place.
 */

import type { UserId } from './ids';

/** The authenticated caller reduced to what identity matching needs. */
export interface IdentitySubject {
	id: UserId;
	email: string;
}

/** A member reference: exactly one of a user id or an email. */
export interface MemberRef {
	user_id?: UserId;
	email?: string;
}

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

/**
 * Whether a member row (which carries either a `user_id` or an `email`) denotes
 * this subject: id rows by exact id, invite rows by case-insensitive email.
 */
export function memberRefMatchesSubject(member: MemberRef, subject: IdentitySubject): boolean {
	if (member.user_id !== undefined) return member.user_id === subject.id;
	return member.email !== undefined && emailsEqual(member.email, subject.email);
}

/**
 * Whether a member row denotes a single selector string (a path/API-supplied id
 * or email). The row's populated field decides which comparison applies: id rows
 * compare exactly, invite rows case-insensitively.
 */
export function memberRefMatchesSelector(member: MemberRef, selector: string): boolean {
	if (member.user_id !== undefined) return member.user_id === selector;
	return member.email !== undefined && emailsEqual(member.email, selector);
}
