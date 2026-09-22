import { getDomain } from 'tldts';

export function normalizeHostname(host: string): string {
	return new URL(`http://${host.trim()}`).hostname.toLowerCase().replace(/\.$/, '');
}

export function hostsShareCookieDomain(first: string, second: string): boolean {
	const a = normalizeHostname(first);
	const b = normalizeHostname(second);
	if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
	// Private suffixes keep unrelated github.io tenants in separate cookie domains.
	const domain = getDomain(a, { allowPrivateDomains: true });
	return domain !== null && domain === getDomain(b, { allowPrivateDomains: true });
}
