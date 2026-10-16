export function normalizeEmailDomains(domains: readonly string[] | undefined): string[] {
	const entries = (domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
	if (
		(domains?.length && entries.length === 0) ||
		entries.some((domain) => domain === '@' || domain === '@*')
	) {
		throw new Error('Email-domain allowlist contains an empty or malformed domain');
	}
	return entries.map((domain) => domain.replace(/^@/, ''));
}

/** Domains must already be normalized; an empty list matches no domain. */
export function emailDomainAllowed(email: string, allowedDomains: readonly string[]): boolean {
	const at = email.lastIndexOf('@');
	return at !== -1 && allowedDomains.includes(email.slice(at + 1).toLowerCase());
}

/** Call only after validating the identity. An empty allowlist is unrestricted. */
export async function emailAllowedWithInvitations(
	email: string,
	allowedDomains: readonly string[],
	isEmailInvited?: (email: string) => Promise<boolean>,
): Promise<boolean> {
	return (
		allowedDomains.length === 0 ||
		emailDomainAllowed(email, allowedDomains) ||
		(await isEmailInvited?.(email)) === true
	);
}
