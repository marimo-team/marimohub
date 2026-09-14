import { ASSIGNABLE_ROLES } from '@marimo-hub/core/constants';
import type { AssignableRole } from '@marimo-hub/core/constants';
import type { AuthEntitlement } from '@marimo-hub/core/ports/auth';

export type EmailVerificationPolicy = 'required' | 'trusted-issuer';

export interface OidcGroupPolicy {
	/** JSON Pointer locating the provider's group array, e.g. `/groups`. */
	claim: string;
	/** At least one exact group match is required to sign in. */
	allowed?: string[];
	/** Groups mapped to deployment super-admin. */
	superAdmin?: string[];
	/** Groups permitted to create projects. */
	projectCreation?: string[];
	/** Groups mapped to a per-user deployment-wide default project role. */
	defaultRoles?: Partial<Record<AssignableRole, string[]>>;
	/** Maximum accepted group count (default 200, maximum 200). */
	maxGroups?: number;
}

const MAX_SUBJECT_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 200;
const MAX_PICTURE_URL_INPUT_LENGTH = 2048;
const MAX_PICTURE_URL_BYTES = 2048;
export const MAX_GROUPS = 200;
const MAX_GROUP_LENGTH = 256;

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export function validSubject(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_SUBJECT_LENGTH &&
		!hasControlCharacters(value)
	);
}

export function validEmail(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_EMAIL_LENGTH ||
		hasControlCharacters(value) ||
		/\s/.test(value)
	) {
		return false;
	}
	const at = value.lastIndexOf('@');
	return at > 0 && at < value.length - 1;
}

export function displayNameClaim(value: unknown): string | undefined {
	if (typeof value !== 'string' || hasControlCharacters(value)) return undefined;
	const name = value.trim();
	return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : undefined;
}

export function pictureUrlClaim(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > MAX_PICTURE_URL_INPUT_LENGTH) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password) return undefined;
		const normalized = url.toString();
		return utf8ByteLength(normalized) <= MAX_PICTURE_URL_BYTES ? normalized : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve an RFC 6901 JSON Pointer without evaluating provider-controlled code. */
export function claimAtPointer(claims: unknown, pointer: string): unknown {
	if (!validJsonPointer(pointer)) return undefined;
	let value: unknown = claims;
	for (const rawSegment of pointer.slice(1).split('/')) {
		const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
		if (!Object.hasOwn(value, segment)) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

export function validJsonPointer(pointer: string): boolean {
	return (
		pointer.startsWith('/') &&
		pointer
			.slice(1)
			.split('/')
			.every((segment) => /^(?:[^~]|~[01])*$/.test(segment))
	);
}

function validGroup(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_GROUP_LENGTH &&
		!hasControlCharacters(value)
	);
}

export function validateGroupPolicy(policy: OidcGroupPolicy): void {
	const lists = [
		policy.allowed,
		policy.superAdmin,
		policy.projectCreation,
		...ASSIGNABLE_ROLES.map((role) => policy.defaultRoles?.[role]),
	].filter((list): list is string[] => list !== undefined);
	if (lists.length === 0) throw new Error('OIDC groups claim requires at least one group policy');
	for (const list of lists) {
		if (list.length === 0 || list.length > MAX_GROUPS || list.some((group) => !validGroup(group))) {
			throw new Error('OIDC group policies must contain 1 to 200 valid group ids');
		}
	}
}

export function parseGroups(value: unknown, maxGroups: number): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maxGroups) throw new Error('invalid groups claim');
	const groups: string[] = [];
	for (const group of value) {
		if (!validGroup(group)) {
			throw new Error('invalid groups claim');
		}
		groups.push(group);
	}
	return groups;
}

export function mappedEntitlements(
	groups: readonly string[],
	policy: OidcGroupPolicy,
): AuthEntitlement[] {
	const memberships = new Set(groups);
	const entitlements = new Set<AuthEntitlement>();
	if (policy.superAdmin?.some((group) => memberships.has(group))) {
		entitlements.add('super-admin');
	}
	if (policy.projectCreation?.some((group) => memberships.has(group))) {
		entitlements.add('project-creator');
	}
	for (const role of ASSIGNABLE_ROLES) {
		if (policy.defaultRoles?.[role]?.some((group) => memberships.has(group))) {
			entitlements.add(`default-role:${role}`);
		}
	}
	return [...entitlements];
}

export function normalizeEmailDomains(domains: readonly string[] | undefined): string[] {
	return (domains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

/** True when `email`'s domain is one of the (already-normalized) allowed domains. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
	const at = email.lastIndexOf('@');
	if (at === -1) return false;
	return allowedDomains.includes(email.slice(at + 1).toLowerCase());
}

export function emailVerificationAllowed(
	verified: unknown,
	sources: readonly unknown[],
	policy: EmailVerificationPolicy,
): boolean {
	return (
		sources.every((value) => value === undefined || value === true) &&
		(policy === 'trusted-issuer' || verified === true)
	);
}
